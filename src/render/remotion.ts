import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {assertFinalReadiness} from '../edit/approve';
import {validateEdit} from '../edit/validate';
import {runFfmpeg} from '../media/ffmpeg';
import {isSilentLoudness, parseLoudnormMeasurement} from '../media/qc';
import {
  deliveryFfmpegArgs,
  deliveryLoudnormAnalysisFilter,
  readRenderSettings,
} from './policy';
import {prepareRenderProps} from './stage';
import {
  expectedRenderFingerprint,
  readRenderArtifactFreshness,
  recordRenderArtifact,
} from './artifacts';
import {superviseRemotionRender} from './remotion-supervisor';
import type {RemotionWorkerRequest} from './remotion-worker';

export type FinalizeRawRenderInput = {
  projectPath: string;
  target: 'preview' | 'master';
  rawOutput: string;
  outputLocation: string;
  fingerprint: string;
  workerRequest: RemotionWorkerRequest;
};

export type FinalizeRawRenderDependencies = {
  supervise: typeof superviseRemotionRender;
  runFfmpeg: typeof runFfmpeg;
  recordArtifact: typeof recordRenderArtifact;
};

const defaultFinalizeDependencies: FinalizeRawRenderDependencies = {
  supervise: superviseRemotionRender,
  runFfmpeg,
  recordArtifact: recordRenderArtifact,
};

const postProcessArgs = (
  target: 'preview' | 'master',
  rawOutput: string,
  outputLocation: string,
): string[] => [
  '-i',
  rawOutput,
  '-map',
  '0',
  '-c',
  'copy',
  ...(target === 'preview'
    ? [
        '-bsf:v',
        'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1',
      ]
    : []),
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-colorspace',
  'bt709',
  ...(target === 'preview' ? ['-movflags', '+faststart'] : []),
  outputLocation,
];

export const finalizeRawRender = async (
  input: FinalizeRawRenderInput,
  dependencies: FinalizeRawRenderDependencies = defaultFinalizeDependencies,
): Promise<void> => {
  await dependencies.supervise(input.workerRequest);
  await dependencies.runFfmpeg(
    postProcessArgs(input.target, input.rawOutput, input.outputLocation),
  );
  await dependencies.recordArtifact(
    input.projectPath,
    input.target,
    input.outputLocation,
    input.fingerprint,
  );
};

const renderTarget = async (
  projectPath: string,
  engineRoot: string,
  target: 'preview' | 'master',
): Promise<string> => {
  const validation = await validateEdit(projectPath);
  if (!validation.valid) {
    throw new Error(`Edit is not valid:\n- ${validation.failures.join('\n- ')}`);
  }
  if (target === 'master') {
    await assertFinalReadiness(projectPath);
  }
  const outputLocation =
    target === 'preview'
      ? path.join(projectPath, 'previews/preview.mp4')
      : path.join(projectPath, 'output/master.mov');
  const fingerprint = await expectedRenderFingerprint(projectPath, target);
  const current = await readRenderArtifactFreshness(projectPath, target, {
    expectedFingerprint: fingerprint,
  });
  if (current.fresh) return outputLocation;

  const {props} = await prepareRenderProps(projectPath, engineRoot, target);
  const settings = await readRenderSettings(projectPath);
  await mkdir(path.dirname(outputLocation), {recursive: true});
  const rawDirectory = path.join(projectPath, 'work/render');
  await mkdir(rawDirectory, {recursive: true});
  const rawOutput = path.join(
    rawDirectory,
    target === 'preview' ? 'preview-remotion.mp4' : 'master-remotion.mov',
  );
  const workerRequest: RemotionWorkerRequest = {
    schemaVersion: '1.0.0',
    engineRoot,
    target,
    rawOutput,
    inputProps: props as unknown as Record<string, unknown>,
    settings,
  };
  await finalizeRawRender({
    projectPath,
    target,
    rawOutput,
    outputLocation,
    fingerprint,
    workerRequest,
  });
  return outputLocation;
};

export const renderPreview = async (
  projectPath: string,
  engineRoot: string,
): Promise<string> => await renderTarget(projectPath, engineRoot, 'preview');

export const renderMasterAndDelivery = async (
  projectPath: string,
  engineRoot: string,
): Promise<{master: string; delivery: string}> => {
  const master = await renderTarget(projectPath, engineRoot, 'master');
  const delivery = path.join(projectPath, 'output/delivery.mp4');
  const settings = await readRenderSettings(projectPath);
  const deliveryFingerprint = await expectedRenderFingerprint(projectPath, 'delivery');
  const current = await readRenderArtifactFreshness(projectPath, 'delivery', {
    expectedFingerprint: deliveryFingerprint,
  });
  if (current.fresh) return {master, delivery};

  const measurementRun = await runFfmpeg([
    '-i',
    master,
    '-vn',
    '-af',
    deliveryLoudnormAnalysisFilter(settings),
    '-f',
    'null',
    '-',
  ]);
  const measurement = parseLoudnormMeasurement(measurementRun.stderr);
  const silent = isSilentLoudness(measurementRun.stderr);
  if (!measurement && !silent) {
    throw new Error('Could not parse first-pass loudness measurement for delivery encoding');
  }
  await runFfmpeg(
    deliveryFfmpegArgs(master, delivery, silent ? null : measurement, settings),
  );
  await recordRenderArtifact(
    projectPath,
    'delivery',
    delivery,
    deliveryFingerprint,
  );
  return {master, delivery};
};
