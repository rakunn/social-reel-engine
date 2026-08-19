import {rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
  ReelBriefSchema,
  type EditManifest,
  type RenderSettings,
} from '../contracts/schemas';
import {z} from 'zod';
import {clipDurationSeconds} from '../core/timeline';
import {hashFile, hashValue} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {implementationFingerprint} from '../core/implementation-fingerprint';
import {writeAtomically} from '../media/atomic-output';
import {probeFile, runFfmpeg} from '../media/ffmpeg';
import {isSilentLoudness, parseLoudnormMeasurement} from '../media/qc';
import {
  assertVerifiedInputSnapshotUnchanged,
  createSourceIntegrityContext,
  type SourceIntegrityContext,
} from '../media/source-integrity';
import type {ReelRenderProps} from '../remotion/model';
import {assertFinalReadiness} from '../edit/approve';
import {validateEdit} from '../edit/validate';
import {deliveryFfmpegArgs, deliveryLoudnormAnalysisFilter} from './policy';
import {expectedRenderFingerprint} from './artifacts';
import {readRenderSettings} from './policy';
import type {RemotionWorkerRequest} from './remotion-protocol';
import {superviseRemotionRender} from './remotion-supervisor';
import {checkRemotionRuntime} from './remotion-runtime';
import {prepareRenderProps} from './stage';
import {withDisposableRenderStage} from './scratch';

const CARD_ID_PATTERN = /^[a-zA-Z0-9]+(?:[._-][a-zA-Z0-9]+)*$/;

export const CarouselPackageRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    generatedAt: z.string().datetime({offset: true}),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    aspectRatio: z.literal('1.91:1'),
    cards: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        clipId: z.string().regex(CARD_ID_PATTERN),
        file: z.string().min(1),
        checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().nonnegative(),
        durationSeconds: z.number().positive(),
      }),
    ).min(2),
  })
  .strict();

export type CarouselPackageRecord = z.infer<typeof CarouselPackageRecordSchema>;
export type CarouselPackageFreshness = {fresh: boolean; reason: string | null};
export type CarouselOutputStatus = 'ready' | 'awaiting-qc' | 'rendered';

export const evaluateCarouselOutputStatus = (
  packageFresh: boolean,
  packageFingerprint: string | null,
  qcPackageFingerprint: string | null,
  qcFailures: readonly string[],
): CarouselOutputStatus => {
  if (!packageFresh || !packageFingerprint) return 'ready';
  if (qcPackageFingerprint !== packageFingerprint || qcFailures.length > 0) {
    return 'awaiting-qc';
  }
  return 'rendered';
};

export const evaluateCarouselPackageRecord = (
  record: CarouselPackageRecord,
  expectedFingerprint: string,
  observed: Record<string, {checksumSha256: string; sizeBytes: number} | undefined>,
): CarouselPackageFreshness => {
  if (record.fingerprint !== expectedFingerprint) {
    return {fresh: false, reason: 'Carousel package fingerprint does not match the current project'};
  }
  for (const card of record.cards) {
    const file = observed[card.file];
    if (!file) {
      return {fresh: false, reason: `Carousel card is missing: ${card.file}`};
    }
    if (file.sizeBytes !== card.sizeBytes) {
      return {fresh: false, reason: `Carousel card size does not match its record: ${card.file}`};
    }
    if (file.checksumSha256 !== card.checksumSha256) {
      return {fresh: false, reason: `Carousel card checksum does not match its record: ${card.file}`};
    }
  }
  return {fresh: true, reason: null};
};

export const expectedCarouselFingerprint = async (
  projectPath: string,
  options: {integrity?: SourceIntegrityContext} = {},
): Promise<string> => {
  const [brief, edit, deliveryFingerprint, build] = await Promise.all([
    readJson(path.join(projectPath, 'brief.json'), ReelBriefSchema),
    readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema),
    expectedRenderFingerprint(projectPath, 'delivery', {integrity: options.integrity}),
    implementationFingerprint('carousel'),
  ]);
  if (brief.projectType !== 'carousel') {
    throw new Error('Carousel output requires a carousel project');
  }
  return hashValue({
    contractVersion: '1.0.0',
    build,
    aspectRatio: '1.91:1',
    edit,
    deliveryFingerprint,
  });
};

export const readCarouselPackageRecord = async (
  projectPath: string,
): Promise<CarouselPackageRecord | null> => {
  try {
    return await readJson(
      path.join(projectPath, 'analysis/carousel.json'),
      CarouselPackageRecordSchema,
    );
  } catch {
    return null;
  }
};

export const readCarouselPackageFreshness = async (
  projectPath: string,
  options: {expectedFingerprint?: string} = {},
): Promise<CarouselPackageFreshness> => {
  const record = await readCarouselPackageRecord(projectPath);
  if (!record) return {fresh: false, reason: 'No carousel package record exists'};
  const expectedFingerprint =
    options.expectedFingerprint ?? (await expectedCarouselFingerprint(projectPath));
  const observed: Record<string, {checksumSha256: string; sizeBytes: number} | undefined> = {};
  for (const card of record.cards) {
    try {
      const cardPath = resolveInside(projectPath, card.file);
      observed[card.file] = {
        checksumSha256: await hashFile(cardPath),
        sizeBytes: (await stat(cardPath)).size,
      };
    } catch {
      observed[card.file] = undefined;
    }
  }
  return evaluateCarouselPackageRecord(record, expectedFingerprint, observed);
};

export const carouselCardFilename = (index: number, cardId: string): string => {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Carousel card index must be a non-negative integer: ${index}`);
  }
  if (!CARD_ID_PATTERN.test(cardId)) {
    throw new Error(`Invalid carousel card ID: ${cardId}`);
  }
  return `${String(index + 1).padStart(2, '0')}-${cardId}.mp4`;
};

export const buildCarouselCardEdit = (
  edit: EditManifest,
  cardIndex: number,
): EditManifest => {
  const clip = edit.clips[cardIndex];
  if (!clip) {
    throw new Error(`Carousel card index ${cardIndex} is outside the edit`);
  }
  return EditManifestSchema.parse({
    ...edit,
    clips: [
      {
        ...clip,
        transitionAfter: {type: 'none', durationSeconds: 0},
      },
    ],
    titles: [],
    music: null,
    captions: null,
  });
};

export type PublishCarouselCardsInput = {
  projectPath: string;
  engineRoot: string;
  publicDir: string;
  fingerprint: string;
  props: ReelRenderProps;
  settings: RenderSettings;
  workerEnvironment?: NodeJS.ProcessEnv;
  onProgress?: (progress: {completed: number; total: number; label: string}) => Promise<void> | void;
};

export type CarouselPublishDependencies = {
  supervise: typeof superviseRemotionRender;
  runFfmpeg: typeof runFfmpeg;
  probeFile: typeof probeFile;
};

const defaultPublishDependencies: CarouselPublishDependencies = {
  supervise: superviseRemotionRender,
  runFfmpeg,
  probeFile,
};

export const publishCarouselCards = async (
  input: PublishCarouselCardsInput,
  dependencyOverrides: Partial<CarouselPublishDependencies> = {},
  now = new Date(),
): Promise<CarouselPackageRecord> => {
  const dependencies = {...defaultPublishDependencies, ...dependencyOverrides};
  const fingerprintDirectory = input.fingerprint.slice(0, 16);
  const cards: CarouselPackageRecord['cards'] = [];
  for (const [index, clip] of input.props.edit.clips.entries()) {
    await input.onProgress?.({
      completed: index,
      total: input.props.edit.clips.length,
      label: clip.id,
    });
    const filename = carouselCardFilename(index, clip.id);
    const relativeFile = `output/carousel/${fingerprintDirectory}/${filename}`;
    const outputPath = path.join(input.projectPath, ...relativeFile.split('/'));
    const rawMaster = path.join(
      input.projectPath,
      'work',
      'carousel',
      fingerprintDirectory,
      filename.replace(/\.mp4$/i, '.mov'),
    );
    const cardProps: ReelRenderProps = {
      ...input.props,
      edit: buildCarouselCardEdit(input.props.edit, index),
      music: null,
      captions: [],
    };
    const workerRequest: RemotionWorkerRequest = {
      schemaVersion: '1.0.0',
      engineRoot: input.engineRoot,
      publicDir: input.publicDir,
      target: 'master',
      rawOutput: rawMaster,
      inputProps: cardProps as unknown as Record<string, unknown>,
      settings: input.settings,
    };
    await writeAtomically(
      rawMaster,
      async (temporaryOutput) =>
        await dependencies.supervise(
          {...workerRequest, rawOutput: temporaryOutput},
          {environment: input.workerEnvironment},
        ),
      async (temporaryOutput) => {
        await dependencies.probeFile(temporaryOutput);
      },
    );
    const measurementRun = await dependencies.runFfmpeg([
      '-i',
      rawMaster,
      '-vn',
      '-af',
      deliveryLoudnormAnalysisFilter(input.settings),
      '-f',
      'null',
      '-',
    ]);
    const measurement = parseLoudnormMeasurement(measurementRun.stderr);
    const silent = isSilentLoudness(measurementRun.stderr);
    if (!measurement && !silent) {
      throw new Error(`Could not measure carousel card loudness: ${clip.id}`);
    }
    await writeAtomically(
      outputPath,
      async (temporaryOutput) =>
        await dependencies.runFfmpeg(
          deliveryFfmpegArgs(
            rawMaster,
            temporaryOutput,
            silent ? null : measurement,
            input.settings,
          ),
        ),
      async (temporaryOutput) => {
        await dependencies.probeFile(temporaryOutput);
      },
    );
    const outputStat = await stat(outputPath);
    cards.push({
      index,
      clipId: clip.id,
      file: relativeFile,
      checksumSha256: await hashFile(outputPath),
      sizeBytes: outputStat.size,
      durationSeconds: clipDurationSeconds(clip),
    });
    await rm(rawMaster, {force: true});
    await input.onProgress?.({
      completed: index + 1,
      total: input.props.edit.clips.length,
      label: clip.id,
    });
  }
  const record = CarouselPackageRecordSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    fingerprint: input.fingerprint,
    aspectRatio: '1.91:1',
    cards,
  });
  await writeJson(path.join(input.projectPath, 'analysis/carousel.json'), record);
  return record;
};

export type RenderCarouselOptions = {
  integrity?: SourceIntegrityContext;
  onActivity?: (activity: {
    phase: string;
    progress?: {completed: number; total: number; label: string} | null;
  }) => Promise<void> | void;
};

export const renderCarouselPackage = async (
  projectPath: string,
  engineRoot: string,
  options: RenderCarouselOptions = {},
): Promise<CarouselPackageRecord> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const [brief, edit] = await Promise.all([
    readJson(path.join(projectPath, 'brief.json'), ReelBriefSchema),
    readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema),
  ]);
  if (brief.projectType !== 'carousel') {
    throw new Error('Carousel output requires a carousel project');
  }
  const validation = await validateEdit(projectPath, edit, {integrity});
  if (!validation.valid) {
    throw new Error(`Edit is not valid:\n- ${validation.failures.join('\n- ')}`);
  }
  await assertFinalReadiness(projectPath, {integrity});
  const fingerprint = await expectedCarouselFingerprint(projectPath, {integrity});
  const freshness = await readCarouselPackageFreshness(projectPath, {
    expectedFingerprint: fingerprint,
  });
  if (freshness.fresh) {
    const current = await readCarouselPackageRecord(projectPath);
    if (!current) throw new Error('Fresh carousel package record disappeared');
    return current;
  }

  await options.onActivity?.({phase: 'preflighting-remotion', progress: null});
  const remotionRuntime = await checkRemotionRuntime(engineRoot);
  if (!remotionRuntime.ok || !remotionRuntime.runtime) {
    throw new Error(`Remotion runtime preflight failed: ${remotionRuntime.message}`);
  }
  const workerEnvironment = remotionRuntime.runtime.workerEnvironment;
  await options.onActivity?.({phase: 'grading-carousel-cards', progress: null});
  const settings = await readRenderSettings(projectPath);
  const {props, stageRoot} = await prepareRenderProps(projectPath, engineRoot, 'master', {
    integrity,
    onProgress: async (progress) =>
      await options.onActivity?.({phase: 'grading-carousel-cards', progress}),
  });
  if (
    settings.master.width !== edit.output.width ||
    settings.master.height !== edit.output.height ||
    settings.master.fps !== edit.output.fps
  ) {
    throw new Error('Carousel render settings do not match the approved edit output');
  }
  const record = await withDisposableRenderStage(engineRoot, stageRoot, async () =>
    await publishCarouselCards({
      projectPath,
      engineRoot,
      publicDir: stageRoot,
      fingerprint,
      props,
      settings,
      workerEnvironment,
      onProgress: async (progress) =>
        await options.onActivity?.({phase: 'rendering-carousel-cards', progress}),
    }),
  );
  await assertVerifiedInputSnapshotUnchanged(projectPath, integrity);
  return record;
};
