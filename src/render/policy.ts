export type RenderTarget = 'preview' | 'master';

export const renderOptionsFor = (target: RenderTarget) => {
  if (target === 'preview') {
    return {
      codec: 'h264' as const,
      width: 540 as const,
      height: 960 as const,
      fps: 30 as const,
      pixelFormat: 'yuv420p' as const,
      crf: 20,
      imageFormat: 'jpeg' as const,
      audioCodec: 'aac' as const,
      audioBitrate: '192k' as const,
      colorSpace: 'bt709' as const,
    };
  }
  return {
    codec: 'prores' as const,
    width: 1080 as const,
    height: 1920 as const,
    fps: 30 as const,
    pixelFormat: 'yuv422p10le' as const,
    imageFormat: 'png' as const,
    proResProfile: 'hq' as const,
    audioCodec: 'pcm-16' as const,
    sampleRate: 48_000 as const,
    colorSpace: 'bt709' as const,
  };
};

import type {LoudnormMeasurement} from '../media/qc';

export const deliveryFfmpegArgs = (
  masterPath: string,
  deliveryPath: string,
  measurement: LoudnormMeasurement | null,
): string[] => {
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
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '17',
    '-pix_fmt',
    'yuv420p',
    '-x264-params',
    'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-c:a',
    'aac',
    '-b:a',
    '256k',
    '-ar',
    '48000',
  ];
  if (measurement) {
    args.push(
      '-af',
      `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${measurement.inputIntegratedLufs}:` +
        `measured_TP=${measurement.inputTruePeakDbtp}:measured_LRA=${measurement.inputLoudnessRangeLu}:` +
        `measured_thresh=${measurement.inputThresholdLufs}:offset=${measurement.targetOffsetLu}:` +
        'linear=true:print_format=summary',
    );
  }
  args.push('-movflags', '+faststart', deliveryPath);
  return args;
};

export type OutputTarget = 'preview' | 'master' | 'delivery';

export const targetExpectations = (target: OutputTarget): Record<string, unknown> => {
  if (target === 'preview') {
    return {
      width: 540,
      height: 960,
      fps: 30,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      audioBitRate: 192_000,
      fastStart: true,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
    };
  }
  if (target === 'master') {
    return {
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'prores',
      videoProfile: 'HQ',
      pixelFormat: 'yuv422p10le',
      audioCodec: 'pcm_s16le',
      audioSampleRate: 48_000,
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
    };
  }
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    audioCodec: 'aac',
    audioSampleRate: 48_000,
    audioBitRate: 256_000,
    fastStart: true,
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorSpace: 'bt709',
    integratedLufs: -14,
    truePeakDbtp: -1.5,
  };
};
