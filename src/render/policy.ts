import path from 'node:path';
import {
  RenderSettingsSchema,
  type RenderSettings,
} from '../contracts/schemas';
import {readJson} from '../core/json';
import type {LoudnormMeasurement} from '../media/qc';

export type RenderTarget = 'preview' | 'master';
export type OutputTarget = RenderTarget | 'delivery';

export const DEFAULT_RENDER_SETTINGS: RenderSettings = RenderSettingsSchema.parse({
  schemaVersion: '1.0.0',
  proxy: {width: 540, height: 960, crf: 23},
  preview: {width: 540, height: 960, crf: 20, audioBitrate: '192k'},
  master: {
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'prores_ks',
    profile: 3,
    pixelFormat: 'yuv422p10le',
    audioCodec: 'pcm_s16le',
    audioSampleRate: 48_000,
  },
  delivery: {
    videoCodec: 'libx264',
    pixelFormat: 'yuv420p',
    crf: 17,
    audioCodec: 'aac',
    audioBitrate: '256k',
    integratedLufs: -14,
    truePeakDbtp: -1.5,
  },
});

export const readRenderSettings = async (projectPath: string): Promise<RenderSettings> => {
  const raw = await readJson<Record<string, unknown>>(
    path.join(projectPath, 'config/settings.json'),
  );
  const section = (key: 'proxy' | 'preview' | 'master' | 'delivery') => {
    const value = raw[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  return RenderSettingsSchema.parse({
    ...DEFAULT_RENDER_SETTINGS,
    ...raw,
    proxy: {...DEFAULT_RENDER_SETTINGS.proxy, ...section('proxy')},
    preview: {...DEFAULT_RENDER_SETTINGS.preview, ...section('preview')},
    master: {...DEFAULT_RENDER_SETTINGS.master, ...section('master')},
    delivery: {...DEFAULT_RENDER_SETTINGS.delivery, ...section('delivery')},
  });
};

const bitrateBitsPerSecond = (bitrate: string): number => {
  const match = bitrate.match(/^([1-9]\d*(?:\.\d+)?)([kKmM])$/);
  if (!match) throw new Error(`Unsupported encoder bitrate: ${bitrate}`);
  return Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000);
};

export const renderOptionsFor = (
  target: RenderTarget,
  settings: RenderSettings = DEFAULT_RENDER_SETTINGS,
) => {
  if (target === 'preview') {
    return {
      codec: 'h264' as const,
      width: settings.preview.width,
      height: settings.preview.height,
      fps: settings.master.fps,
      pixelFormat: 'yuv420p' as const,
      crf: settings.preview.crf,
      imageFormat: 'jpeg' as const,
      audioCodec: 'aac' as const,
      audioBitrate: settings.preview.audioBitrate,
      colorSpace: 'bt709' as const,
      scale: settings.preview.width / settings.master.width,
    };
  }
  return {
    codec: 'prores' as const,
    width: settings.master.width,
    height: settings.master.height,
    fps: settings.master.fps,
    pixelFormat: settings.master.pixelFormat,
    imageFormat: 'png' as const,
    proResProfile: 'hq' as const,
    audioCodec: 'pcm-16' as const,
    sampleRate: settings.master.audioSampleRate,
    colorSpace: 'bt709' as const,
    scale: 1,
  };
};

export const deliveryLoudnormAnalysisFilter = (
  settings: RenderSettings = DEFAULT_RENDER_SETTINGS,
): string =>
  `loudnorm=I=${settings.delivery.integratedLufs}:TP=${settings.delivery.truePeakDbtp}:LRA=11:print_format=json`;

export const deliveryFfmpegArgs = (
  masterPath: string,
  deliveryPath: string,
  measurement: LoudnormMeasurement | null,
  settings: RenderSettings = DEFAULT_RENDER_SETTINGS,
): string[] => {
  const delivery = settings.delivery;
  const args = [
    '-i',
    masterPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-c:v',
    delivery.videoCodec,
    '-preset',
    'slow',
    '-crf',
    String(delivery.crf),
    '-pix_fmt',
    delivery.pixelFormat,
    '-x264-params',
    'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-c:a',
    delivery.audioCodec,
    '-b:a',
    delivery.audioBitrate,
    '-ar',
    String(settings.master.audioSampleRate),
  ];
  if (measurement) {
    args.push(
      '-af',
      `loudnorm=I=${delivery.integratedLufs}:TP=${delivery.truePeakDbtp}:LRA=11:` +
        `measured_I=${measurement.inputIntegratedLufs}:` +
        `measured_TP=${measurement.inputTruePeakDbtp}:measured_LRA=${measurement.inputLoudnessRangeLu}:` +
        `measured_thresh=${measurement.inputThresholdLufs}:offset=${measurement.targetOffsetLu}:` +
        'linear=true:print_format=summary',
    );
  }
  args.push('-movflags', '+faststart', deliveryPath);
  return args;
};

export const targetExpectations = (
  target: OutputTarget,
  settings: RenderSettings = DEFAULT_RENDER_SETTINGS,
): Record<string, unknown> => {
  if (target === 'preview') {
    return {
      width: settings.preview.width,
      height: settings.preview.height,
      fps: settings.master.fps,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
      audioSampleRate: settings.master.audioSampleRate,
      audioBitRate: bitrateBitsPerSecond(settings.preview.audioBitrate),
      fastStart: true,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
    };
  }
  if (target === 'master') {
    return {
      width: settings.master.width,
      height: settings.master.height,
      fps: settings.master.fps,
      videoCodec: 'prores',
      videoProfile: 'HQ',
      pixelFormat: settings.master.pixelFormat,
      audioCodec: settings.master.audioCodec,
      audioSampleRate: settings.master.audioSampleRate,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
    };
  }
  return {
    width: settings.master.width,
    height: settings.master.height,
    fps: settings.master.fps,
    videoCodec: 'h264',
    pixelFormat: settings.delivery.pixelFormat,
    audioCodec: settings.delivery.audioCodec,
    audioSampleRate: settings.master.audioSampleRate,
    audioBitRate: bitrateBitsPerSecond(settings.delivery.audioBitrate),
    fastStart: true,
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorSpace: 'bt709',
    integratedLufs: settings.delivery.integratedLufs,
    truePeakDbtp: settings.delivery.truePeakDbtp,
  };
};
