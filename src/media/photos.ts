import {copyFile, mkdir, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {
  EditManifestSchema,
  PhotoConfigSchema,
  PhotoProfileSchema,
  QcReportSchema,
  type EditManifest,
  type PhotoConfig,
  type PhotoProfile,
} from '../contracts/schemas';
import {hashFile, hashValue} from '../core/hash';
import {implementationFingerprint} from '../core/implementation-fingerprint';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {interpolateCrop, clipDurationSeconds, secondsToFrames} from '../core/timeline';
import {assertFinalReadiness} from '../edit/approve';
import {gradeSelectedClips, type GradedClipReport} from './grade';
import {probeFile, runFfmpeg} from './ffmpeg';
import {runProcess} from './process';
import {writeAtomically} from './atomic-output';
import {
  createSourceIntegrityContext,
  type SourceIntegrityContext,
} from './source-integrity';
import {
  readRenderArtifactFreshness,
  readRenderArtifactRecord,
  type RenderArtifactRecord,
} from '../render/artifacts';
import {readRenderSettings} from '../render/policy';
import {prepareRenderProps} from '../render/stage';
import {withDisposableRenderStage} from '../render/scratch';
import {superviseRemotionRender} from '../render/remotion-supervisor';

export type PhotoProfileDetails = {
  width: number;
  height: number;
  requiresReview: boolean;
};

const PHOTO_PROFILES: Record<PhotoProfile, PhotoProfileDetails> = {
  '9:16': {width: 1080, height: 1920, requiresReview: false},
  '4:5': {width: 1080, height: 1350, requiresReview: true},
  '1:1': {width: 1080, height: 1080, requiresReview: true},
  '16:9': {width: 1920, height: 1080, requiresReview: true},
};

export const photoProfile = (profile: PhotoProfile): PhotoProfileDetails => PHOTO_PROFILES[profile];

export type PhotoCandidate = {
  id: string;
  clipId: string;
  sourceId: string;
  shotFrame: number;
  sourceSeconds: number;
  crop: {x: number; y: number; scale: number};
};

const uniqueEvenlySpacedFrames = (start: number, end: number, count: number): number[] => {
  if (end < start) return [];
  const available = end - start + 1;
  if (available <= count) return Array.from({length: available}, (_, index) => start + index);
  const frames = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    frames.add(Math.round(start + ((end - start) * index) / (count - 1)));
  }
  return [...frames].sort((left, right) => left - right);
};

export const buildPhotoCandidates = (
  edit: Pick<EditManifest, 'clips' | 'output'>,
  samplesPerShot = 7,
): PhotoCandidate[] =>
  edit.clips.flatMap((clip, index) => {
    const durationInFrames = secondsToFrames(clipDurationSeconds(clip), edit.output.fps);
    const outerMargin = Math.ceil(durationInFrames * 0.1);
    const incomingTransitionFrames =
      index === 0
        ? 0
        : secondsToFrames(edit.clips[index - 1].transitionAfter.durationSeconds, edit.output.fps);
    const transitionFrames = secondsToFrames(clip.transitionAfter.durationSeconds, edit.output.fps);
    const firstFrame = Math.min(durationInFrames - 1, Math.max(outerMargin, incomingTransitionFrames));
    const lastFrame = Math.max(
      firstFrame,
      durationInFrames - 1 - outerMargin - transitionFrames,
    );
    return uniqueEvenlySpacedFrames(firstFrame, lastFrame, samplesPerShot).map((shotFrame) => {
      const progress = durationInFrames <= 1 ? 0 : shotFrame / (durationInFrames - 1);
      return {
        id: `${clip.id}-f${shotFrame}`,
        clipId: clip.id,
        sourceId: clip.sourceId,
        shotFrame,
        sourceSeconds: (shotFrame / edit.output.fps) * clip.playbackRate,
        crop: interpolateCrop(clip.crop, progress),
      };
    });
  });

export const selectPhotoCandidates = <Candidate extends {id: string; clipId: string}>(
  candidates: readonly Candidate[],
  count: number,
  scores: Readonly<Record<string, number>>,
): string[] => {
  const ranked = [...candidates].sort(
    (left, right) =>
      (scores[right.id] ?? Number.NEGATIVE_INFINITY) -
        (scores[left.id] ?? Number.NEGATIVE_INFINITY) ||
      left.id.localeCompare(right.id),
  );
  const selected: string[] = [];
  const clips = new Set<string>();
  for (const candidate of ranked) {
    if (selected.length >= count) break;
    if (clips.has(candidate.clipId)) continue;
    clips.add(candidate.clipId);
    selected.push(candidate.id);
  }
  for (const candidate of ranked) {
    if (selected.length >= count) break;
    if (!selected.includes(candidate.id)) selected.push(candidate.id);
  }
  return selected;
};

export const DEFAULT_PHOTO_CONFIG: PhotoConfig = {
  schemaVersion: '1.0.0',
  enabled: false,
  profiles: [],
  count: 5,
  jpegQuality: 95,
};

export const photoGradedFingerprintMaterial = (
  graded: Pick<GradedClipReport, 'items'>,
) =>
  graded.items.map((item) => ({
    clipId: item.clipId,
    sourceId: item.sourceId,
    path: item.path,
    checksumSha256: item.checksumSha256,
    fingerprint: item.fingerprint,
    stabilization: item.stabilization,
  }));

const photoConfigPath = (projectPath: string): string => path.join(projectPath, 'config/photos.json');
const photoPackagePath = (projectPath: string): string => path.join(projectPath, 'analysis/photos.json');
const photoApprovalPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/photo-approval.json');
const photoQcJsonPath = (projectPath: string): string => path.join(projectPath, 'analysis/photo-qc.json');
const photoQcMarkdownPath = (projectPath: string): string => path.join(projectPath, 'analysis/photo-qc.md');
const SIPS = process.env.REEL_SIPS_PATH || 'sips';
const SRGB_PROFILE =
  process.env.REEL_SRGB_PROFILE_PATH || '/System/Library/ColorSync/Profiles/sRGB Profile.icc';

const profileDirectory = (profile: PhotoProfile): string => profile.replace(':', 'x');

const PhotoOutputSchema = z.object({
  profile: PhotoProfileSchema,
  candidateFiles: z.array(z.string()),
  candidateChecksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  contactSheet: z.string().nullable(),
  contactSheetChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  outputFiles: z.array(z.string()),
  outputChecksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

const PhotoPackageSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  generatedAt: z.string().datetime({offset: true}),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  candidateReviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  config: PhotoConfigSchema,
  candidates: z.array(
    z.object({
      id: z.string().min(1),
      clipId: z.string().min(1),
      sourceId: z.string().min(1),
      shotFrame: z.number().int().nonnegative(),
      sourceSeconds: z.number().nonnegative(),
      crop: z.object({x: z.number(), y: z.number(), scale: z.number()}),
      score: z.number(),
    }),
  ),
  selectedIds: z.array(z.string().min(1)),
  outputs: z.array(PhotoOutputSchema),
});

const PhotoApprovalSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  approvedAt: z.string().datetime({offset: true}),
  approvedBy: z.string().min(1),
});

type PhotoPackage = z.infer<typeof PhotoPackageSchema>;

type PhotoReadiness = {
  master: RenderArtifactRecord;
  delivery: RenderArtifactRecord;
};

const checkedFile = async (projectPath: string, relativePath: string, checksum: string): Promise<boolean> => {
  try {
    const absolute = resolveInside(projectPath, relativePath);
    return (await hashFile(absolute)) === checksum;
  } catch {
    return false;
  }
};

const readPhotoPackage = async (projectPath: string): Promise<PhotoPackage | null> => {
  try {
    return await readJson(photoPackagePath(projectPath), PhotoPackageSchema);
  } catch {
    return null;
  }
};

const readPhotoApproval = async (projectPath: string) => {
  try {
    return await readJson(photoApprovalPath(projectPath), PhotoApprovalSchema);
  } catch {
    return null;
  }
};

export const readPhotoConfig = async (projectPath: string): Promise<PhotoConfig> => {
  try {
    return await readJson(photoConfigPath(projectPath), PhotoConfigSchema);
  } catch {
    return DEFAULT_PHOTO_CONFIG;
  }
};

export const configurePhotoOutput = async (
  projectPath: string,
  next: Pick<PhotoConfig, 'profiles' | 'count'> & {jpegQuality?: number},
): Promise<PhotoConfig> => {
  const current = await readPhotoConfig(projectPath);
  const config = PhotoConfigSchema.parse({
    ...current,
    enabled: true,
    profiles: next.profiles,
    count: next.count,
    jpegQuality: next.jpegQuality ?? current.jpegQuality,
  });
  await writeJson(photoConfigPath(projectPath), config);
  return config;
};

const assertCurrentQc = async (
  projectPath: string,
  target: 'master' | 'delivery',
  artifact: RenderArtifactRecord,
): Promise<void> => {
  const report = await readJson(path.join(projectPath, `analysis/qc-${target}.json`), QcReportSchema);
  if (
    report.renderArtifact?.fingerprint !== artifact.fingerprint ||
    report.renderArtifact?.checksumSha256 !== artifact.checksumSha256 ||
    report.renderArtifact?.sizeBytes !== artifact.sizeBytes
  ) {
    throw new Error(`Current ${target} QC report is missing or stale; rerun qc --target ${target}`);
  }
  if (report.failures.length > 0) {
    throw new Error(`Photo export is blocked by ${target} QC failures: ${report.failures.join('; ')}`);
  }
};

const assertPhotoReadiness = async (
  projectPath: string,
  integrity: SourceIntegrityContext,
): Promise<PhotoReadiness> => {
  await assertFinalReadiness(projectPath, {integrity});
  const [masterFreshness, deliveryFreshness] = await Promise.all([
    readRenderArtifactFreshness(projectPath, 'master', {integrity}),
    readRenderArtifactFreshness(projectPath, 'delivery', {integrity}),
  ]);
  if (!masterFreshness.fresh || !deliveryFreshness.fresh) {
    throw new Error('Photo export requires fresh master and delivery renders');
  }
  const [master, delivery] = await Promise.all([
    readRenderArtifactRecord(projectPath, 'master'),
    readRenderArtifactRecord(projectPath, 'delivery'),
  ]);
  if (!master || !delivery) throw new Error('Photo export requires current master and delivery artifacts');
  await Promise.all([
    assertCurrentQc(projectPath, 'master', master),
    assertCurrentQc(projectPath, 'delivery', delivery),
  ]);
  return {master, delivery};
};

const expectedPhotoFingerprint = async (
  projectPath: string,
  config: PhotoConfig,
  graded: GradedClipReport,
  readiness: PhotoReadiness,
): Promise<string> => {
  const [edit, build] = await Promise.all([
    readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema),
    implementationFingerprint('photos'),
  ]);
  return hashValue({
    contractVersion: '1.0.0',
    build,
    config,
    edit,
    graded: photoGradedFingerprintMaterial(graded),
    master: {
      fingerprint: readiness.master.fingerprint,
      checksumSha256: readiness.master.checksumSha256,
    },
    delivery: {
      fingerprint: readiness.delivery.fingerprint,
      checksumSha256: readiness.delivery.checksumSha256,
    },
  });
};

const photoMetricScore = async (gradedPath: string, sourceSeconds: number): Promise<number> => {
  const result = await runFfmpeg(
    [
      '-ss',
      sourceSeconds.toFixed(3),
      '-i',
      gradedPath,
      '-frames:v',
      '1',
      '-vf',
      'signalstats,blurdetect=block_width=32:block_height=32:block_pct=80,metadata=print',
      '-f',
      'null',
      '-',
    ],
    {allowFailure: true},
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const value = (name: string): number | null => {
    const match = output.match(new RegExp(`${name}=([\\d.]+)`));
    return match ? Number(match[1]) : null;
  };
  const luma = value('lavfi.signalstats.YAVG');
  const blur = value('lavfi.blur');
  return (luma === null ? 0 : 1_000 - Math.abs(luma - 128) * 4) - (blur ?? 0) * 100;
};

const copyAtomically = async (source: string, destination: string): Promise<void> => {
  await writeAtomically(
    destination,
    async (temporaryOutput) => await copyFile(source, temporaryOutput),
    async (temporaryOutput) => {
      await probeFile(temporaryOutput);
    },
  );
};

const srgbProfileName = async (filePath: string): Promise<string | null> => {
  const result = await runProcess(SIPS, ['-g', 'profile', filePath], {
    allowFailure: true,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.match(/profile:\s*(.+)/i)?.[1]?.trim() ?? null;
};

const isSrgbTagged = (profile: string | null): boolean =>
  profile !== null && /srgb|iec61966-2\.1/i.test(profile);

const writeSrgbJpegAtomically = async (
  source: string,
  destination: string,
  quality: number,
): Promise<void> => {
  await writeAtomically(
    destination,
    async (temporaryOutput) => {
      await runProcess(
        SIPS,
        [
          '-m',
          SRGB_PROFILE,
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          String(quality),
          source,
          '--out',
          temporaryOutput,
        ],
        {timeoutMs: 2 * 60_000},
      );
    },
    async (temporaryOutput) => {
      const [probe, profile] = await Promise.all([probeFile(temporaryOutput), srgbProfileName(temporaryOutput)]);
      const video = probe.streams?.find((stream) => stream.codec_type === 'video');
      if (video?.codec_name !== 'mjpeg' || !isSrgbTagged(profile)) {
        throw new Error('Photo JPEG must be readable and tagged with an sRGB color profile');
      }
    },
  );
};

const createContactSheet = async (
  projectPath: string,
  profile: PhotoProfile,
  candidateFiles: readonly string[],
): Promise<{file: string; checksum: string}> => {
  const relativeOutput = `previews/photo-candidates/${profileDirectory(profile)}/contact-sheet.jpg`;
  const output = resolveInside(projectPath, relativeOutput);
  const directory = path.dirname(resolveInside(projectPath, candidateFiles[0]));
  await writeAtomically(
    output,
    async (temporaryOutput) =>
      await runFfmpeg([
        '-pattern_type',
        'glob',
        '-i',
        path.join(directory, '*.jpg'),
        '-vf',
        'scale=360:-2,tile=3x2:padding=8:margin=8',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        temporaryOutput,
      ]),
    async (temporaryOutput) => {
      await probeFile(temporaryOutput);
    },
  );
  return {file: relativeOutput, checksum: await hashFile(output)};
};

const candidateFilesFor = (profile: PhotoProfile, count: number): string[] =>
  Array.from(
    {length: count},
    (_unused, index) =>
      `previews/photo-candidates/${profileDirectory(profile)}/${String(index + 1).padStart(2, '0')}.jpg`,
  );

const outputFilesFor = (profile: PhotoProfile, count: number): string[] =>
  Array.from(
    {length: count},
    (_unused, index) => `output/photos/${profileDirectory(profile)}/${String(index + 1).padStart(2, '0')}.jpg`,
  );

const isPackageFresh = async (
  projectPath: string,
  packageRecord: PhotoPackage,
  fingerprint: string,
): Promise<boolean> => {
  if (packageRecord.fingerprint !== fingerprint) return false;
  for (const output of packageRecord.outputs) {
    for (const file of output.candidateFiles) {
      const checksum = output.candidateChecksums[file];
      if (!checksum || !(await checkedFile(projectPath, file, checksum))) return false;
    }
    if (
      output.contactSheet &&
      (!output.contactSheetChecksum ||
        !(await checkedFile(projectPath, output.contactSheet, output.contactSheetChecksum)))
    ) {
      return false;
    }
  }
  return true;
};

const photoApprovalIsCurrent = async (projectPath: string, packageRecord: PhotoPackage): Promise<boolean> =>
  (await readPhotoApproval(projectPath))?.hash === packageRecord.candidateReviewHash;

const publishProfile = async (
  projectPath: string,
  output: z.infer<typeof PhotoOutputSchema>,
): Promise<z.infer<typeof PhotoOutputSchema>> => {
  const outputFiles = outputFilesFor(output.profile, output.candidateFiles.length);
  const outputChecksums: Record<string, string> = {};
  for (const [index, candidateFile] of output.candidateFiles.entries()) {
    const destination = resolveInside(projectPath, outputFiles[index]);
    await copyAtomically(resolveInside(projectPath, candidateFile), destination);
    outputChecksums[outputFiles[index]] = await hashFile(destination);
  }
  return {...output, outputFiles, outputChecksums};
};

const allOutputsPublished = async (projectPath: string, packageRecord: PhotoPackage): Promise<boolean> =>
  await Promise.all(
    packageRecord.outputs.map(async (output) => {
      if (output.outputFiles.length !== output.candidateFiles.length) return false;
      return (await Promise.all(
        output.outputFiles.map(async (file) => {
          const checksum = output.outputChecksums[file];
          return Boolean(checksum && (await checkedFile(projectPath, file, checksum)));
        }),
      )).every(Boolean);
    }),
  ).then((states) => states.every(Boolean));

const writePhotoQc = async (projectPath: string, packageRecord: PhotoPackage): Promise<void> => {
  const checks = await Promise.all(
    packageRecord.outputs.flatMap((output) => {
      const profile = photoProfile(output.profile);
      return output.outputFiles.map(async (file) => {
        const absolute = resolveInside(projectPath, file);
        try {
          const [probe, fileStat, colorProfile] = await Promise.all([
            probeFile(absolute),
            stat(absolute),
            srgbProfileName(absolute),
          ]);
          const video = probe.streams?.find((stream) => stream.codec_type === 'video') ?? {};
          const dimensionsMatch = Number(video.width) === profile.width && Number(video.height) === profile.height;
          const jpeg = String(video.codec_name ?? '').includes('mjpeg');
          const srgb = isSrgbTagged(colorProfile);
          return {
            file,
            profile: output.profile,
            colorProfile,
            status: dimensionsMatch && jpeg && srgb && fileStat.size > 0 ? 'pass' : 'fail',
            message:
              dimensionsMatch && jpeg && srgb && fileStat.size > 0
                ? 'Readable JPEG has the requested dimensions and an sRGB color profile'
                : `Expected sRGB-tagged JPEG ${profile.width}x${profile.height}`,
          };
        } catch {
          return {file, profile: output.profile, status: 'fail', message: 'Output is missing or unreadable'};
        }
      });
    }),
  );
  const failures = checks.filter((check) => check.status === 'fail').map((check) => `${check.file}: ${check.message}`);
  const report = {
    schemaVersion: '1.0.0' as const,
    generatedAt: new Date().toISOString(),
    fingerprint: packageRecord.fingerprint,
    checks,
    warnings: [] as string[],
    failures,
  };
  await writeJson(photoQcJsonPath(projectPath), report);
  await writeAtomically(photoQcMarkdownPath(projectPath), async (temporaryOutput) => {
    await writeFile(
      temporaryOutput,
      `# Photo QC report\n\n- Result: ${failures.length ? 'FAIL' : 'PASS'}\n\n${checks
        .map((check) => `- ${check.status.toUpperCase()}: ${check.file} — ${check.message}`)
        .join('\n')}\n`,
      'utf8',
    );
  });
  if (failures.length) throw new Error(`Photo QC failed:\n- ${failures.join('\n- ')}`);
};

const renderCandidateFiles = async (
  projectPath: string,
  engineRoot: string,
  profile: PhotoProfile,
  selected: Array<PhotoCandidate & {score: number}>,
  jpegQuality: number,
  integrity: SourceIntegrityContext,
): Promise<z.infer<typeof PhotoOutputSchema>> => {
  const {props, stageRoot} = await prepareRenderProps(projectPath, engineRoot, 'master', {integrity});
  const publicRoot = path.join(engineRoot, 'public');
  const stagePublicPath = path.relative(publicRoot, stageRoot).split(path.sep).join('/');
  if (
    stagePublicPath === '' ||
    stagePublicPath === '..' ||
    stagePublicPath.startsWith('../') ||
    path.isAbsolute(stagePublicPath)
  ) {
    throw new Error(`Photo render stage is outside the engine public directory: ${stageRoot}`);
  }
  const files = candidateFilesFor(profile, selected.length);
  const details = photoProfile(profile);
  const stagingDirectory = path.join(
    projectPath,
    'work/photo-staging',
    profileDirectory(profile),
    hashValue(selected).slice(0, 16),
  );
  const stagedFiles = selected.map((candidate, index) =>
    path.join(stagingDirectory, `${String(index + 1).padStart(2, '0')}.jpg`),
  );
  try {
    await rm(path.dirname(resolveInside(projectPath, files[0])), {recursive: true, force: true});
    await withDisposableRenderStage(engineRoot, stageRoot, async () => {
      await mkdir(stagingDirectory, {recursive: true});
      await superviseRemotionRender({
        schemaVersion: '1.0.0',
        engineRoot,
        publicDir: publicRoot,
        target: 'photo',
        rawOutput: path.join(stagingDirectory, 'photo-render.marker'),
        inputProps: {},
        settings: await readRenderSettings(projectPath),
        photoOutputs: selected.map((candidate, index) => {
          const media = props.media[candidate.clipId];
          if (!media) throw new Error(`No staged graded media for photo candidate ${candidate.id}`);
          return {
            output: stagedFiles[index],
            jpegQuality,
            inputProps: {
              media: `${stagePublicPath}/${media}`,
              trimBeforeFrames: Math.round(candidate.sourceSeconds * props.edit.output.fps),
              crop: candidate.crop,
              width: details.width,
              height: details.height,
            },
          };
        }),
      });
      for (const [index, stagedFile] of stagedFiles.entries()) {
        await writeSrgbJpegAtomically(stagedFile, resolveInside(projectPath, files[index]), jpegQuality);
      }
    });
  } finally {
    await rm(stagingDirectory, {recursive: true, force: true});
  }
  const candidateChecksums = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, await hashFile(resolveInside(projectPath, file))] as const),
    ),
  );
  const review = details.requiresReview
    ? await createContactSheet(projectPath, profile, files)
    : {file: null, checksum: null};
  return {
    profile,
    candidateFiles: files,
    candidateChecksums,
    contactSheet: review.file,
    contactSheetChecksum: review.checksum,
    outputFiles: [],
    outputChecksums: {},
  };
};

const completePackage = async (
  projectPath: string,
  packageRecord: PhotoPackage,
): Promise<PhotoPackage> => {
  const approvalCurrent = await photoApprovalIsCurrent(projectPath, packageRecord);
  const outputs = await Promise.all(
    packageRecord.outputs.map(async (output) =>
      photoProfile(output.profile).requiresReview && !approvalCurrent
        ? output
        : await publishProfile(projectPath, output),
    ),
  );
  const next = {...packageRecord, outputs};
  await writeJson(photoPackagePath(projectPath), next);
  if (await allOutputsPublished(projectPath, next)) {
    await writePhotoQc(projectPath, next);
  }
  return next;
};

export type GeneratePhotosResult = {
  package: PhotoPackage;
  awaitingApproval: boolean;
  completed: boolean;
  outputs: string[];
};

export const generatePhotos = async (
  projectPath: string,
  engineRoot: string,
  options: {integrity?: SourceIntegrityContext} = {},
): Promise<GeneratePhotosResult> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const config = await readPhotoConfig(projectPath);
  if (!config.enabled) throw new Error('Photo output is disabled; run photos with at least one --aspect');
  const readiness = await assertPhotoReadiness(projectPath, integrity);
  const graded = await gradeSelectedClips(projectPath, new Date(), {integrity});
  const fingerprint = await expectedPhotoFingerprint(projectPath, config, graded, readiness);
  const existing = await readPhotoPackage(projectPath);
  if (existing && (await isPackageFresh(projectPath, existing, fingerprint))) {
    const completed = await allOutputsPublished(projectPath, existing);
    const packageRecord = completed ? existing : await completePackage(projectPath, existing);
    const isCompleted = await allOutputsPublished(projectPath, packageRecord);
    return {
      package: packageRecord,
      awaitingApproval: !isCompleted && packageRecord.outputs.some((output) => photoProfile(output.profile).requiresReview),
      completed: isCompleted,
      outputs: packageRecord.outputs.flatMap((output) => output.outputFiles),
    };
  }

  const edit = EditManifestSchema.parse(await readJson(path.join(projectPath, 'edits/edit.json')));
  const candidates = buildPhotoCandidates(edit);
  const gradedByClip = new Map(graded.items.map((item) => [item.clipId, item.path]));
  const scores: Record<string, number> = {};
  await Promise.all(
    candidates.map(async (candidate) => {
      const gradedPath = gradedByClip.get(candidate.clipId);
      scores[candidate.id] = gradedPath
        ? await photoMetricScore(resolveInside(projectPath, gradedPath), candidate.sourceSeconds)
        : Number.NEGATIVE_INFINITY;
    }),
  );
  const selectedIds = selectPhotoCandidates(candidates, config.count, scores);
  if (selectedIds.length < config.count) {
    throw new Error(`Only ${selectedIds.length} safe photo candidates are available; requested ${config.count}`);
  }
  const selected = selectedIds.map((id) => {
    const candidate = candidates.find((entry) => entry.id === id);
    if (!candidate) throw new Error(`Selected photo candidate is missing: ${id}`);
    return {...candidate, score: scores[id] ?? Number.NEGATIVE_INFINITY};
  });
  const outputs = [];
  for (const profile of config.profiles) {
    outputs.push(
      await renderCandidateFiles(projectPath, engineRoot, profile, selected, config.jpegQuality, integrity),
    );
  }
  const candidateReviewHash = hashValue({fingerprint, selected, outputs: outputs.map((output) => ({
    profile: output.profile,
    candidateFiles: output.candidateFiles,
    candidateChecksums: output.candidateChecksums,
    contactSheet: output.contactSheet,
    contactSheetChecksum: output.contactSheetChecksum,
  }))});
  const packageRecord = PhotoPackageSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    fingerprint,
    candidateReviewHash,
    config,
    candidates: selected,
    selectedIds,
    outputs,
  });
  await writeJson(photoPackagePath(projectPath), packageRecord);
  const completedPackage = await completePackage(projectPath, packageRecord);
  const completed = await allOutputsPublished(projectPath, completedPackage);
  return {
    package: completedPackage,
    awaitingApproval: !completed && outputs.some((output) => photoProfile(output.profile).requiresReview),
    completed,
    outputs: completedPackage.outputs.flatMap((output) => output.outputFiles),
  };
};

export const approvePhotoReframes = async (
  projectPath: string,
  now = new Date(),
): Promise<z.infer<typeof PhotoApprovalSchema>> => {
  const packageRecord = await readPhotoPackage(projectPath);
  if (!packageRecord) throw new Error('Photo candidates are missing; run photos first');
  const reviewOutputs = packageRecord.outputs.filter((output) => photoProfile(output.profile).requiresReview);
  if (reviewOutputs.length === 0) throw new Error('No non-9:16 photo reframes require approval');
  for (const output of reviewOutputs) {
    if (
      !output.contactSheet ||
      !output.contactSheetChecksum ||
      !(await checkedFile(projectPath, output.contactSheet, output.contactSheetChecksum))
    ) {
      throw new Error(`Photo contact sheet is missing or stale for ${output.profile}; rerun photos`);
    }
  }
  const approval = PhotoApprovalSchema.parse({
    schemaVersion: '1.0.0',
    hash: packageRecord.candidateReviewHash,
    approvedAt: now.toISOString(),
    approvedBy: 'user',
  });
  await writeJson(photoApprovalPath(projectPath), approval);
  return approval;
};

export const readPhotoOutputStatus = async (
  projectPath: string,
): Promise<'disabled' | 'ready' | 'awaiting-approval' | 'rendered'> => {
  const config = await readPhotoConfig(projectPath);
  if (!config.enabled) return 'disabled';
  const packageRecord = await readPhotoPackage(projectPath);
  if (!packageRecord) return 'ready';
  if (hashValue(packageRecord.config) !== hashValue(config)) return 'ready';
  try {
    const [master, delivery, graded] = await Promise.all([
      readRenderArtifactRecord(projectPath, 'master'),
      readRenderArtifactRecord(projectPath, 'delivery'),
      readJson<GradedClipReport>(path.join(projectPath, 'analysis/graded-clips.json')),
    ]);
    if (!master || !delivery) return 'ready';
    if (
      !(await Promise.all(
        graded.items.map((item) => checkedFile(projectPath, item.path, item.checksumSha256)),
      )).every(Boolean)
    ) {
      return 'ready';
    }
    await Promise.all([
      assertCurrentQc(projectPath, 'master', master),
      assertCurrentQc(projectPath, 'delivery', delivery),
    ]);
    const fingerprint = await expectedPhotoFingerprint(projectPath, config, graded, {master, delivery});
    if (!(await isPackageFresh(projectPath, packageRecord, fingerprint))) return 'ready';
  } catch {
    return 'ready';
  }
  if (packageRecord.outputs.some((output) => photoProfile(output.profile).requiresReview)) {
    if (!(await photoApprovalIsCurrent(projectPath, packageRecord))) return 'awaiting-approval';
  }
  return (await allOutputsPublished(projectPath, packageRecord)) ? 'rendered' : 'ready';
};
