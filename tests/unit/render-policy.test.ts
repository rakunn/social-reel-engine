import {describe, expect, it} from 'vitest';
import {
  deliveryFfmpegArgs,
  renderOptionsFor,
  targetExpectations,
} from '../../src/render/policy';

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
});
