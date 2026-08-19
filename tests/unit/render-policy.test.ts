import {describe, expect, it} from 'vitest';
import {
  deliveryFfmpegArgs,
  renderOptionsFor,
  targetExpectations,
} from '../../src/render/policy';

const settings = {
  schemaVersion: '1.0.0',
  proxy: {width: 540, height: 960, crf: 23},
  preview: {width: 540, height: 960, crf: 18, audioBitrate: '160k'},
  master: {
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'prores_ks',
    profile: 3,
    pixelFormat: 'yuv422p10le',
    audioCodec: 'pcm_s16le',
    audioSampleRate: 48000,
  },
  delivery: {
    videoCodec: 'libx264',
    pixelFormat: 'yuv420p',
    crf: 19,
    audioCodec: 'aac',
    audioBitrate: '192k',
    integratedLufs: -16,
    truePeakDbtp: -2,
  },
} as const;

describe('render policy', () => {
  it('pins the preview and master encodes to the approved formats', () => {
    expect(renderOptionsFor('preview')).toEqual(
      expect.objectContaining({
        codec: 'h264',
        width: 540,
        height: 960,
        pixelFormat: 'yuv420p',
        crf: 20,
        audioCodec: 'aac',
        colorSpace: 'bt709',
      }),
    );
    expect(renderOptionsFor('master')).toEqual(
      expect.objectContaining({
        codec: 'prores',
        width: 1080,
        height: 1920,
        pixelFormat: 'yuv422p10le',
        imageFormat: 'png',
        proResProfile: 'hq',
        audioCodec: 'pcm-16',
        sampleRate: 48000,
        colorSpace: 'bt709',
      }),
    );
  });

  it('creates a BT.709 fast-start delivery normalized to −14 LUFS and −1.5 dBTP', () => {
    const args = deliveryFfmpegArgs('/tmp/master.mov', '/tmp/delivery.mp4', {
      inputIntegratedLufs: -20.55,
      inputTruePeakDbtp: -9.07,
      inputLoudnessRangeLu: 0,
      inputThresholdLufs: -30.55,
      targetOffsetLu: -0.89,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        'libx264',
        '17',
        'yuv420p',
        'aac',
        '256k',
        '+faststart',
        'bt709',
      ]),
    );
    expect(args.join(' ')).toContain('loudnorm=I=-14:TP=-1.5:LRA=11');
    expect(args.join(' ')).toContain('measured_I=-20.55');
    expect(args).toContain(
      'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    );
  });

  it('keeps the AAC delivery contract for intentional silence without invalid loudnorm values', () => {
    const args = deliveryFfmpegArgs('/tmp/master.mov', '/tmp/delivery.mp4', null);
    expect(args).toEqual(expect.arrayContaining(['aac', '256k', '+faststart']));
    expect(args.join(' ')).not.toContain('loudnorm=');
  });

  it('defines machine-checkable properties for every output target', () => {
    expect(targetExpectations('preview')).toEqual(
      expect.objectContaining({
        width: 540,
        height: 960,
        fps: 30,
        videoCodec: 'h264',
        audioCodec: 'aac',
        fastStart: true,
      }),
    );
    expect(targetExpectations('master')).toEqual(
      expect.objectContaining({
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: 'prores',
        videoProfile: 'HQ',
        pixelFormat: 'yuv422p10le',
        audioCodec: 'pcm_s16le',
      }),
    );
  });

  it('applies supported project render settings to encoders and QC expectations', () => {
    expect(renderOptionsFor('preview', settings)).toEqual(
      expect.objectContaining({crf: 18, audioBitrate: '160k'}),
    );
    const deliveryArgs = deliveryFfmpegArgs(
      '/tmp/master.mov',
      '/tmp/delivery.mp4',
      {
        inputIntegratedLufs: -20.55,
        inputTruePeakDbtp: -9.07,
        inputLoudnessRangeLu: 0,
        inputThresholdLufs: -30.55,
        targetOffsetLu: -0.89,
      },
      settings,
    );
    expect(deliveryArgs).toEqual(expect.arrayContaining(['19', '192k']));
    expect(deliveryArgs.join(' ')).toContain('loudnorm=I=-16:TP=-2');
    expect(targetExpectations('delivery', settings)).toEqual(
      expect.objectContaining({audioBitRate: 192_000, integratedLufs: -16, truePeakDbtp: -2}),
    );
  });

  it('derives exact 1.91:1 preview, master, and delivery dimensions from carousel settings', () => {
    const carouselSettings = {
      ...settings,
      preview: {...settings.preview, width: 764, height: 400},
      master: {...settings.master, width: 1910, height: 1000},
    } as const;
    expect(renderOptionsFor('preview', carouselSettings)).toEqual(
      expect.objectContaining({width: 764, height: 400, scale: 0.4}),
    );
    expect(renderOptionsFor('master', carouselSettings)).toEqual(
      expect.objectContaining({width: 1910, height: 1000, scale: 1}),
    );
    expect(targetExpectations('delivery', carouselSettings)).toEqual(
      expect.objectContaining({width: 1910, height: 1000, fps: 30}),
    );
  });
});
