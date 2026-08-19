import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {EditManifestSchema, ReelBriefSchema} from '../contracts/schemas';
import {readJson} from '../core/json';
import {assertFinalReadiness} from '../edit/approve';
import {validateEdit} from '../edit/validate';
import {probeFile, runFfmpeg} from '../media/ffmpeg';
import {writeAtomically} from '../media/atomic-output';
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
import type {RemotionWorkerRequest} from './remotion-protocol';
import {checkRemotionRuntime} from './remotion-runtime';
import {
  pruneRenderStages,
  rawRenderOutputPath,
  removePublishedRawRender,
  withDisposableRenderStage,
} from './scratch';
import {
  createSourceIntegrityContext,
  type SourceIntegrityContext,
} from '../media/source-integrity';

export type RenderOperationOptions = {
  integrity?: SourceIntegrityContext;
  onActivity?: (activity: {
    phase: string;
    progress?: {completed: number; total: number; label: string} | null;
  }) => Promise<void> | void;
};

export type FinalizeRawRenderInput = {
  projectPath: string;
  target: 'preview' | 'master';
  rawOutput: string;
  outputLocation: string;
  fingerprint: string;
  workerRequest: RemotionWorkerRequest;
  workerEnvironment?: NodeJS.ProcessEnv;
  integrity?: SourceIntegrityContext;
};

export type FinalizeRawRenderDependencies = {
  supervise: typeof superviseRemotionRender;
  runFfmpeg: typeof runFfmpeg;
  probeFile: typeof probeFile;
  recordArtifact: typeof recordRenderArtifact;
};

const defaultFinalizeDependencies: FinalizeRawRenderDependencies = {
  supervise: superviseRemotionRender,
  runFfmpeg,
  probeFile,
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
  dependencyOverrides: Partial<FinalizeRawRenderDependencies> = {},
): Promise<void> => {
  const dependencies = {...defaultFinalizeDependencies, ...dependencyOverrides};
  await writeAtomically(
    input.rawOutput,
    async (temporaryOutput) =>
      await dependencies.supervise(
        {...input.workerRequest, rawOutput: temporaryOutput},
        {environment: input.workerEnvironment},
      ),
    async (temporaryOutput) => {
      await dependencies.probeFile(temporaryOutput);
    },
  );
  await writeAtomically(
    input.outputLocation,
    async (temporaryOutput) =>
      await dependencies.runFfmpeg(
        postProcessArgs(input.target, input.rawOutput, temporaryOutput),
      ),
    async (temporaryOutput) => {
      await dependencies.probeFile(temporaryOutput);
    },
  );
  await dependencies.recordArtifact(
    input.projectPath,
    input.target,
    input.outputLocation,
    input.fingerprint,
    undefined,
    {integrity: input.integrity},
  );
  await removePublishedRawRender(input.projectPath, input.rawOutput);
};

const renderTarget = async (
  projectPath: string,
  engineRoot: string,
  target: 'preview' | 'master',
  options: RenderOperationOptions = {},
): Promise<string> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const [edit, settings] = await Promise.all([
    readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema),
    readRenderSettings(projectPath),
  ]);
  if (
    settings.master.width !== edit.output.width ||
    settings.master.height !== edit.output.height ||
    settings.master.fps !== edit.output.fps
  ) {
    throw new Error('Render settings do not match the approved edit output');
  }
  const validation = await validateEdit(projectPath, edit, {integrity});
  if (!validation.valid) {
    throw new Error(`Edit is not valid:\n- ${validation.failures.join('\n- ')}`);
  }
  if (target === 'master') {
    await assertFinalReadiness(projectPath, {integrity});
  }
  const outputLocation =
    target === 'preview'
      ? path.join(projectPath, 'previews/preview.mp4')
      : path.join(projectPath, 'output/master.mov');
  const fingerprint = await expectedRenderFingerprint(projectPath, target, {integrity});
  const current = await readRenderArtifactFreshness(projectPath, target, {
    expectedFingerprint: fingerprint,
    integrity,
  });
  const rawOutput = rawRenderOutputPath(projectPath, target);
  if (current.fresh) {
    const cleanupResults = await Promise.allSettled([
      removePublishedRawRender(projectPath, rawOutput),
      pruneRenderStages(engineRoot, edit.reelName),
    ]);
    const cleanupFailures = cleanupResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) {
      throw new AggregateError(
        cleanupFailures,
        'Fresh render scratch outputs and disposable stages could not be removed',
      );
    }
    return outputLocation;
  }

  await options.onActivity?.({phase: 'preflighting-remotion', progress: null});
  const remotionRuntime = await checkRemotionRuntime(engineRoot);
  if (!remotionRuntime.ok || !remotionRuntime.runtime) {
    throw new Error(`Remotion runtime preflight failed: ${remotionRuntime.message}`);
  }
  const workerEnvironment = remotionRuntime.runtime.workerEnvironment;

  await options.onActivity?.({
    phase: target === 'preview' ? 'preparing-proxies' : 'grading-selected-clips',
    progress: null,
  });
  const {props, stageRoot} = await prepareRenderProps(projectPath, engineRoot, target, {
    integrity,
    onProgress: async (progress) =>
      await options.onActivity?.({
        phase: target === 'preview' ? 'preparing-proxies' : 'grading-selected-clips',
        progress,
      }),
  });
  return await withDisposableRenderStage(engineRoot, stageRoot, async () => {
    await mkdir(path.dirname(outputLocation), {recursive: true});
    await mkdir(path.dirname(rawOutput), {recursive: true});
    const workerRequest: RemotionWorkerRequest = {
      schemaVersion: '1.0.0',
      engineRoot,
      publicDir: stageRoot,
      target,
      rawOutput,
      inputProps: props as unknown as Record<string, unknown>,
      settings,
    };
    await options.onActivity?.({
      phase: target === 'preview' ? 'rendering-preview' : 'rendering-master',
      progress: null,
    });
    await finalizeRawRender({
      projectPath,
      target,
      rawOutput,
      outputLocation,
      fingerprint,
      workerRequest,
      workerEnvironment,
      integrity,
    });
    return outputLocation;
  });
};

export const renderPreview = async (
  projectPath: string,
  engineRoot: string,
  options: RenderOperationOptions = {},
): Promise<string> => await renderTarget(projectPath, engineRoot, 'preview', options);

export const renderMasterAndDelivery = async (
  projectPath: string,
  engineRoot: string,
  options: RenderOperationOptions = {},
): Promise<{master: string; delivery: string}> => {
  const brief = await readJson(path.join(projectPath, 'brief.json'), ReelBriefSchema);
  if (brief.projectType !== 'reel') {
    throw new Error(
      'Standard render is available only for reel projects; use render-carousel for carousel projects',
    );
  }
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const master = await renderTarget(projectPath, engineRoot, 'master', {...options, integrity});
  const delivery = path.join(projectPath, 'output/delivery.mp4');
  const settings = await readRenderSettings(projectPath);
  const deliveryFingerprint = await expectedRenderFingerprint(projectPath, 'delivery', {integrity});
  const current = await readRenderArtifactFreshness(projectPath, 'delivery', {
    expectedFingerprint: deliveryFingerprint,
    integrity,
  });
  if (current.fresh) return {master, delivery};

  await options.onActivity?.({phase: 'measuring-delivery-loudness', progress: null});
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
  await options.onActivity?.({phase: 'encoding-delivery', progress: null});
  await writeAtomically(
    delivery,
    async (temporaryOutput) =>
      await runFfmpeg(
        deliveryFfmpegArgs(master, temporaryOutput, silent ? null : measurement, settings),
      ),
    async (temporaryOutput) => {
      await probeFile(temporaryOutput);
    },
  );
  await recordRenderArtifact(
    projectPath,
    'delivery',
    delivery,
    deliveryFingerprint,
    undefined,
    {integrity},
  );
  return {master, delivery};
};
