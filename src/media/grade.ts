import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {access, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
  LutDefinitionSchema,
  type LutDefinition,
  type SourceEntry,
} from '../contracts/schemas';
import {buildColorChain, type ColorChainInput} from '../core/color';
import {
  assertLutCompatibleWithSource,
} from '../core/lut-compatibility';
import {isCanonicalRec709ColorSpace} from '../core/color-spaces';
import {createColorHash, createEditHash} from '../core/approvals';
import {artifactFingerprint} from '../project/artifacts';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {buildFfmpegColorGraph} from './color-ffmpeg';
import {runFfmpeg} from './ffmpeg';
import {stabilizationOutcome} from './stabilize';
import {readValidatedSourceManifest} from './source-integrity';
import {pipelineBuildFingerprint} from '../render/artifacts';

type GradeSelection = {
  exposureStops?: number;
  whiteBalanceKelvin?: number;
  tint?: number;
  technicalLutId?: string | null;
  creativeLutId?: string | null;
  combinedLutId?: string | null;
  creativeMix?: number;
};

const fileSha256Sync = (filePath: string): string =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

const readLutsSync = (projectPath: string): LutDefinition[] => {
  const config = JSON.parse(readFileSync(path.join(projectPath, 'config/luts.json'), 'utf8')) as {
    luts?: unknown[];
  };
  return (config.luts ?? []).map((lut) => LutDefinitionSchema.parse(lut));
};

export const resolveClipColor = (
  projectPath: string,
  source: SourceEntry,
  grade: GradeSelection,
) => {
  if (!source.camera.confirmed || !source.camera.profileId) {
    throw new Error(`${source.relativePath}: camera gamma/gamut profile is unconfirmed`);
  }
  const luts = readLutsSync(projectPath);
  const lookup = (
    id: string | null | undefined,
    role: 'technical' | 'creative' | 'combined',
  ): LutDefinition | undefined => {
    if (!id) return undefined;
    const lut = luts.find((candidate) => candidate.id === id);
    if (!lut) throw new Error(`${source.relativePath}: selected ${role} LUT ${id} is not declared`);
    if (lut.kind !== role) {
      throw new Error(`${source.relativePath}: LUT ${id} is ${lut.kind}, not ${role}`);
    }
    return lut;
  };
  const technical = lookup(grade.technicalLutId, 'technical');
  const creative = lookup(grade.creativeLutId, 'creative');
  const combined = lookup(grade.combinedLutId, 'combined');
  const normalizer = combined ?? technical;
  if (!normalizer) {
    throw new Error(`${source.relativePath}: edit must explicitly select an exact technical or combined LUT`);
  }
  assertLutCompatibleWithSource(source, normalizer);
  if (
    creative &&
    (!isCanonicalRec709ColorSpace(creative.inputColorSpace) ||
      !isCanonicalRec709ColorSpace(creative.outputColorSpace))
  ) {
    throw new Error(`${source.relativePath}: creative LUT input and output must be declared as Rec.709`);
  }
  for (const lut of [normalizer, creative].filter(Boolean) as LutDefinition[]) {
    const lutPath = resolveInside(projectPath, lut.file);
    if (!existsSync(lutPath)) {
      throw new Error(`Configured LUT file is missing: ${lut.file}`);
    }
    if (fileSha256Sync(lutPath) !== lut.checksumSha256) {
      throw new Error(`Configured LUT checksum no longer matches: ${lut.file}`);
    }
  }
  const input: ColorChainInput = {
    exposureStops: grade.exposureStops ?? 0,
    whiteBalanceKelvin: grade.whiteBalanceKelvin ?? 6500,
    tint: grade.tint ?? 0,
    technical,
    creative,
    combined,
    creativeMix: grade.creativeMix,
  };
  return buildColorChain(input);
};

export const generateGradedStills = async (
  projectPath: string,
  now = new Date(),
): Promise<{
  schemaVersion: '1.0.0';
  generatedAt: string;
  editManifestHash: string;
  editReviewHash: string;
  colorManifestHash: string;
  stills: string[];
  checksums: Record<string, string>;
}> => {
  let edit;
  try {
    edit = EditManifestSchema.parse(await readJson(path.join(projectPath, 'edits/edit.json')));
  } catch (error) {
    throw new Error(`Cannot generate graded stills without a valid edit: ${(error as Error).message}`);
  }
  const {assertEditApproval} = await import('../edit/approve');
  const editReviewHash = await assertEditApproval(projectPath);
  const manifest = await readValidatedSourceManifest(projectPath);
  await mkdir(path.join(projectPath, 'previews/graded-stills'), {recursive: true});
  const stills: string[] = [];
  const checksums: Record<string, string> = {};
  for (const clip of edit.clips) {
    const source = manifest.sources.find((entry) => entry.id === clip.sourceId);
    if (!source) {
      throw new Error(`Edit references missing source ${clip.sourceId}`);
    }
    const chain = resolveClipColor(projectPath, source, clip.grade);
    const graph = buildFfmpegColorGraph(chain, projectPath);
    const relativeOutput = `previews/graded-stills/${clip.id}.png`;
    await runFfmpeg([
      '-ss',
      ((clip.inSeconds + clip.outSeconds) / 2).toFixed(3),
      '-i',
      resolveInside(projectPath, source.relativePath),
      '-filter_complex',
      graph.filterComplex,
      '-map',
      `[${graph.outputLabel}]`,
      '-frames:v',
      '1',
      '-c:v',
      'png',
      resolveInside(projectPath, relativeOutput),
    ]);
    stills.push(relativeOutput);
    checksums[relativeOutput] = await hashFile(resolveInside(projectPath, relativeOutput));
  }
  const lutsConfig = await readJson<{luts?: unknown[]}>(path.join(projectPath, 'config/luts.json'));
  const luts = (lutsConfig.luts ?? []).map((lut) => LutDefinitionSchema.parse(lut));
  const result = {
    schemaVersion: '1.0.0' as const,
    generatedAt: now.toISOString(),
    editManifestHash: createEditHash(edit),
    editReviewHash,
    colorManifestHash: createColorHash(edit, luts),
    stills,
    checksums,
  };
  await writeJson(path.join(projectPath, 'analysis/graded-stills.json'), result);
  return result;
};

export type GradedClipReport = {
  schemaVersion: '1.0.0';
  generatedAt: string;
  editHash: string;
  colorHash: string;
  items: Array<{
    clipId: string;
    sourceId: string;
    path: string;
    checksumSha256: string;
    fingerprint: string;
    cached: boolean;
    stabilization: 'disabled' | 'applied' | 'fallback';
  }>;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const escapeFilterValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll(':', '\\:').replaceAll("'", "\\'");

export const gradeSelectedClips = async (
  projectPath: string,
  now = new Date(),
): Promise<GradedClipReport> => {
  const {assertRenderApprovals} = await import('../edit/approve');
  await assertRenderApprovals(projectPath);
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  const manifest = await readValidatedSourceManifest(projectPath);
  const lutsConfig = await readJson<{luts?: unknown[]}>(path.join(projectPath, 'config/luts.json'));
  const luts = (lutsConfig.luts ?? []).map((lut) => LutDefinitionSchema.parse(lut));
  const reportPath = path.join(projectPath, 'analysis/graded-clips.json');
  let previous: GradedClipReport | null = null;
  try {
    previous = await readJson<GradedClipReport>(reportPath);
  } catch {
    previous = null;
  }
  await mkdir(path.join(projectPath, 'work/graded'), {recursive: true});
  await mkdir(path.join(projectPath, 'work/stabilization'), {recursive: true});
  const items: GradedClipReport['items'] = [];
  const pipelineBuild = await pipelineBuildFingerprint();

  for (const clip of edit.clips) {
    const source = manifest.sources.find((entry) => entry.id === clip.sourceId);
    if (!source) {
      throw new Error(`Edit references missing source ${clip.sourceId}`);
    }
    const chain = resolveClipColor(projectPath, source, clip.grade);
    const fingerprint = artifactFingerprint({
      version: 1,
      pipelineBuild,
      source: source.checksumSha256,
      selection: {
        inSeconds: clip.inSeconds,
        outSeconds: clip.outSeconds,
        stabilization: clip.stabilization,
      },
      chain,
      luts,
      encoder: {codec: 'prores_ks', profile: 3, pixelFormat: 'yuv422p10le'},
    });
    const relativeOutput = `work/graded/${clip.id}-${fingerprint.slice(0, 12)}.mov`;
    const outputPath = resolveInside(projectPath, relativeOutput);
    const prior = previous?.items.find((item) => item.clipId === clip.id);
    if (
      prior?.fingerprint === fingerprint &&
      prior.path === relativeOutput &&
      (await fileExists(outputPath)) &&
      (await hashFile(outputPath)) === prior.checksumSha256
    ) {
      items.push({...prior, cached: true});
      continue;
    }

    const inputPath = resolveInside(projectPath, source.relativePath);
    const duration = clip.outSeconds - clip.inSeconds;
    let graphInput = '0:v';
    let stabilization: GradedClipReport['items'][number]['stabilization'] = 'disabled';
    let stabilizationPrefix = '';
    if (clip.stabilization.enabled) {
      const transformsPath = path.join(
        projectPath,
        'work/stabilization',
        `${clip.id}-${fingerprint.slice(0, 12)}.trf`,
      );
      const detection = await runFfmpeg(
        [
          '-ss',
          clip.inSeconds.toFixed(3),
          '-t',
          duration.toFixed(3),
          '-i',
          inputPath,
          '-vf',
          `vidstabdetect=shakiness=${Math.max(1, Math.round(clip.stabilization.strength * 10))}:accuracy=15:result='${escapeFilterValue(transformsPath)}'`,
          '-f',
          'null',
          '-',
        ],
        {allowFailure: true},
      );
      const detected = detection.exitCode === 0 && existsSync(transformsPath);
      const outcome = stabilizationOutcome(
        detected,
        clip.stabilization.fallbackToUnstabilized,
      );
      if (outcome === 'applied') {
        graphInput = 'stabilized';
        stabilization = 'applied';
        const smoothing = Math.max(5, Math.round(5 + clip.stabilization.strength * 25));
        stabilizationPrefix =
          `[0:v]vidstabtransform=input='${escapeFilterValue(transformsPath)}':` +
          `smoothing=${smoothing}:zoom=5:optzoom=1:interpol=bicubic[stabilized];`;
      } else {
        stabilization = 'fallback';
      }
    }
    const colorGraph = buildFfmpegColorGraph(chain, projectPath, graphInput);
    await runFfmpeg([
      '-ss',
      clip.inSeconds.toFixed(3),
      '-t',
      duration.toFixed(3),
      '-i',
      inputPath,
      '-filter_complex',
      `${stabilizationPrefix}${colorGraph.filterComplex}`,
      '-map',
      `[${colorGraph.outputLabel}]`,
      '-map',
      '0:a?',
      '-c:v',
      'prores_ks',
      '-profile:v',
      '3',
      '-pix_fmt',
      'yuv422p10le',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      outputPath,
    ]);
    items.push({
      clipId: clip.id,
      sourceId: source.id,
      path: relativeOutput,
      checksumSha256: await hashFile(outputPath),
      fingerprint,
      cached: false,
      stabilization,
    });
  }

  const report: GradedClipReport = {
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    editHash: createEditHash(edit),
    colorHash: createColorHash(edit, luts),
    items,
  };
  await writeJson(reportPath, report);
  return report;
};
