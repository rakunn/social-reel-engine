import {existsSync} from 'node:fs';
import {access, mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {EditClip} from '../contracts/schemas';
import {hashFile} from '../core/hash';
import {implementationFingerprint} from '../core/implementation-fingerprint';
import {artifactFingerprint} from '../project/artifacts';
import {resolveInside} from '../core/paths';
import {probeFile, runFfmpeg} from './ffmpeg';
import {stabilizationOutcome, validateStabilizedCrop} from './stabilize';
import {escapeFfmpegFilterValue} from './filter-escape';
import {REC709_OUTPUT_METADATA_ARGS} from './color-ffmpeg';
import {writeAtomically} from './atomic-output';

export type PreviewStabilizationItem = {
  clipId: string;
  fingerprint: string;
  path: string | null;
  checksumSha256: string | null;
  detectionSourceChecksumSha256: string | null;
  transformPath: string | null;
  transformChecksumSha256: string | null;
  stabilization: 'disabled' | 'applied' | 'fallback';
  cached: boolean;
};

export type PreviewStabilizationReport = {
  schemaVersion: '1.0.0';
  generatedAt: string;
  items: PreviewStabilizationItem[];
};

export type PreviewStabilizationOptions = {
  detectionSourceChecksumSha256?: string;
};

export const previewStabilizationFingerprint = (input: {
  pipelineBuild: string;
  detectionSourceChecksumSha256: string;
  normalizationInputChecksumSha256: string | null;
  reviewVideoFilter: string;
  selection: {inSeconds: number; outSeconds: number};
  stabilization: EditClip['stabilization'];
  normalized: boolean;
}): string =>
  artifactFingerprint({
    version: 2,
    pipelineBuild: input.pipelineBuild,
    detectionSourceChecksumSha256: input.detectionSourceChecksumSha256,
    normalizationInputChecksumSha256: input.normalizationInputChecksumSha256,
    reviewVideoFilter: input.reviewVideoFilter,
    selection: input.selection,
    stabilization: input.stabilization,
    encoder: {
      codec: 'libx264',
      crf: 23,
      pixelFormat: 'yuv420p',
      colorMetadata: input.normalized ? 'bt709' : null,
    },
  });

export const preparePreviewStabilizedClip = async (
  projectPath: string,
  clip: EditClip,
  proxyPath: string,
  originalPath: string,
  reviewVideoFilter: string,
  normalizationInputChecksumSha256: string | null,
  normalized: boolean,
  prior?: PreviewStabilizationItem,
  options: PreviewStabilizationOptions = {},
): Promise<{item: PreviewStabilizationItem; sourcePath: string}> => {
  if (!clip.stabilization.enabled) {
    return {
      item: {
        clipId: clip.id,
        fingerprint: artifactFingerprint({clipId: clip.id, stabilization: 'disabled'}),
        path: null,
        checksumSha256: null,
        detectionSourceChecksumSha256: null,
        transformPath: null,
        transformChecksumSha256: null,
        stabilization: 'disabled',
        cached: true,
      },
      sourcePath: proxyPath,
    };
  }

  for (const crop of [clip.crop.start, clip.crop.end]) {
    const guard = validateStabilizedCrop({zoom: 1.05, x: crop.x, y: crop.y});
    if (!guard.valid) throw new Error(`${clip.id}: ${guard.reason}`);
  }

  const detectionSourceChecksumSha256 =
    options.detectionSourceChecksumSha256 ?? (await hashFile(originalPath));
  const pipelineBuild = await implementationFingerprint('stabilize');
  const fingerprint = previewStabilizationFingerprint({
    pipelineBuild,
    detectionSourceChecksumSha256,
    normalizationInputChecksumSha256,
    reviewVideoFilter,
    selection: {inSeconds: clip.inSeconds, outSeconds: clip.outSeconds},
    stabilization: clip.stabilization,
    normalized,
  });
  const relativeOutput = `work/preview-stabilized/${clip.id}-${fingerprint.slice(0, 12)}.mp4`;
  const outputPath = resolveInside(projectPath, relativeOutput);
  const relativeTransforms = `work/stabilization/preview-${clip.id}-${fingerprint.slice(0, 12)}.trf`;
  const transformsPath = resolveInside(projectPath, relativeTransforms);
  if (
    prior?.fingerprint === fingerprint &&
    prior.path === relativeOutput &&
    prior.checksumSha256 &&
    prior.detectionSourceChecksumSha256 === detectionSourceChecksumSha256 &&
    prior.transformPath === relativeTransforms &&
    prior.transformChecksumSha256 &&
    existsSync(outputPath) &&
    existsSync(transformsPath) &&
    (await hashFile(outputPath)) === prior.checksumSha256 &&
    (await hashFile(transformsPath)) === prior.transformChecksumSha256
  ) {
    return {item: {...prior, cached: true}, sourcePath: outputPath};
  }

  await mkdir(path.join(projectPath, 'work/preview-stabilized'), {recursive: true});
  await mkdir(path.join(projectPath, 'work/stabilization'), {recursive: true});
  const duration = clip.outSeconds - clip.inSeconds;
  let detectionSucceeded = false;
  try {
    await writeAtomically(
      transformsPath,
      async (temporaryOutput) =>
        await runFfmpeg([
          '-ss',
          clip.inSeconds.toFixed(3),
          '-t',
          duration.toFixed(3),
          '-i',
          originalPath,
          '-vf',
          `vidstabdetect=shakiness=${Math.max(1, Math.round(clip.stabilization.strength * 10))}:accuracy=15:result=${escapeFfmpegFilterValue(temporaryOutput)}`,
          '-f',
          'null',
          '-',
        ]),
      async (temporaryOutput) => {
        await access(temporaryOutput);
      },
    );
    detectionSucceeded = true;
  } catch {
    detectionSucceeded = false;
  }
  const outcome = stabilizationOutcome(detectionSucceeded, clip.stabilization.fallbackToUnstabilized);
  if (outcome === 'fallback') {
    return {
      item: {
        clipId: clip.id,
        fingerprint,
        path: null,
        checksumSha256: null,
        detectionSourceChecksumSha256,
        transformPath: null,
        transformChecksumSha256: null,
        stabilization: 'fallback',
        cached: false,
      },
      sourcePath: proxyPath,
    };
  }

  const smoothing = Math.max(5, Math.round(5 + clip.stabilization.strength * 25));
  let transformationSucceeded = false;
  try {
    await writeAtomically(
      outputPath,
      async (temporaryOutput) =>
        await runFfmpeg([
          '-ss',
          clip.inSeconds.toFixed(3),
          '-t',
          duration.toFixed(3),
          '-i',
          originalPath,
          '-map',
          '0:v:0',
          '-map',
          '0:a?',
          '-vf',
          `vidstabtransform=input=${escapeFfmpegFilterValue(transformsPath)}:smoothing=${smoothing}:zoom=5:optzoom=1:interpol=bicubic,${reviewVideoFilter}`,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          ...(normalized ? REC709_OUTPUT_METADATA_ARGS : []),
          '-movflags',
          '+faststart',
          temporaryOutput,
        ]),
      async (temporaryOutput) => {
        await probeFile(temporaryOutput);
      },
    );
    transformationSucceeded = true;
  } catch {
    transformationSucceeded = false;
  }
  const transformationOutcome = stabilizationOutcome(
    transformationSucceeded,
    clip.stabilization.fallbackToUnstabilized,
  );
  if (transformationOutcome === 'fallback') {
    return {
      item: {
        clipId: clip.id,
        fingerprint,
        path: null,
        checksumSha256: null,
        detectionSourceChecksumSha256,
        transformPath: null,
        transformChecksumSha256: null,
        stabilization: 'fallback',
        cached: false,
      },
      sourcePath: proxyPath,
    };
  }
  const checksumSha256 = await hashFile(outputPath);
  const transformChecksumSha256 = await hashFile(transformsPath);
  return {
    item: {
      clipId: clip.id,
      fingerprint,
      path: relativeOutput,
      checksumSha256,
      detectionSourceChecksumSha256,
      transformPath: relativeTransforms,
      transformChecksumSha256,
      stabilization: 'applied',
      cached: false,
    },
    sourcePath: outputPath,
  };
};
