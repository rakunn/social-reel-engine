import {bundle} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {assertFinalReadiness} from '../edit/approve';
import {validateEdit} from '../edit/validate';
import {runFfmpeg} from '../media/ffmpeg';
import {isSilentLoudness, parseLoudnormMeasurement} from '../media/qc';
import {deliveryFfmpegArgs, renderOptionsFor} from './policy';
import {prepareRenderProps} from './stage';
import {
  expectedRenderFingerprint,
  readRenderArtifactFreshness,
  recordRenderArtifact,
} from './artifacts';

let bundlePromise: Promise<string> | null = null;

const getBundle = async (engineRoot: string): Promise<string> => {
  bundlePromise ??= bundle({
    entryPoint: path.join(engineRoot, 'src/remotion/index.ts'),
    publicDir: path.join(engineRoot, 'public'),
    rootDir: engineRoot,
    enableCaching: true,
    symlinkPublicDir: true,
  });
  return await bundlePromise;
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
  const serveUrl = await getBundle(engineRoot);
  const composition = await selectComposition({
    serveUrl,
    id: 'SocialReel',
    inputProps: props as unknown as Record<string, unknown>,
    timeoutInMilliseconds: 120_000,
  });
  const options = renderOptionsFor(target);
  await mkdir(path.dirname(outputLocation), {recursive: true});
  const rawDirectory = path.join(projectPath, 'work/render');
  await mkdir(rawDirectory, {recursive: true});
  const rawOutput = path.join(
    rawDirectory,
    target === 'preview' ? 'preview-remotion.mp4' : 'master-remotion.mov',
  );
  await renderMedia({
    serveUrl,
    composition,
    inputProps: props as unknown as Record<string, unknown>,
    outputLocation: rawOutput,
    codec: options.codec,
    pixelFormat: options.pixelFormat,
    imageFormat: options.imageFormat,
    audioCodec: options.audioCodec,
    colorSpace: options.colorSpace,
    scale: target === 'preview' ? 0.5 : 1,
    overwrite: true,
    enforceAudioTrack: true,
    logLevel: 'info',
    timeoutInMilliseconds: 120_000,
    ...(target === 'preview'
      ? {crf: options.crf, audioBitrate: options.audioBitrate}
      : {proResProfile: options.proResProfile, sampleRate: options.sampleRate}),
  });
  await runFfmpeg([
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
  ]);
  await recordRenderArtifact(projectPath, target, outputLocation, fingerprint);
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
    'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
    '-f',
    'null',
    '-',
  ]);
  const measurement = parseLoudnormMeasurement(measurementRun.stderr);
  const silent = isSilentLoudness(measurementRun.stderr);
  if (!measurement && !silent) {
    throw new Error('Could not parse first-pass loudness measurement for delivery encoding');
  }
  await runFfmpeg(deliveryFfmpegArgs(master, delivery, silent ? null : measurement));
  await recordRenderArtifact(
    projectPath,
    'delivery',
    delivery,
    deliveryFingerprint,
  );
  return {master, delivery};
};
