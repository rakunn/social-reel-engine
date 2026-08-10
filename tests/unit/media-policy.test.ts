import {describe, expect, it} from 'vitest';
import {buildFfmpegColorGraph} from '../../src/media/color-ffmpeg';
import {buildProxyVideoFilter} from '../../src/media/proxy';
import {
  parseBlackFrames,
  parseFreezeSections,
  parseLoudness,
  parseLoudnormMeasurement,
  isSilentLoudness,
  summarizeProbe,
} from '../../src/media/qc';
import {stabilizationOutcome, validateStabilizedCrop} from '../../src/media/stabilize';
import * as previewStabilization from '../../src/media/preview-stabilize';

describe('FFmpeg color graph policy', () => {
  it('orders pre-transform, normalization, creative blend, and Rec.709 output', () => {
    const graph = buildFfmpegColorGraph(
      {
        operations: [
          {
            type: 'pre-transform',
            exposureStops: 0.25,
            whiteBalanceKelvin: 6000,
            tint: 0.05,
          },
          {
            type: 'technical-lut',
            lut: {
              id: 'technical',
              kind: 'technical',
              file: 'input/luts/technical/identity.cube',
              checksumSha256: 'a'.repeat(64),
              cameraModel: 'Synthetic',
              profileId: 'synthetic-log',
              inputGamma: 'Synthetic Log',
              inputGamut: 'Synthetic Gamut',
              inputColorSpace: 'Synthetic Log',
              outputColorSpace: 'Rec.709 Gamma 2.4',
              transformSemantics: 'normalization',
              defaultMix: 1,
            },
            mix: 1,
          },
          {
            type: 'creative-lut',
            lut: {
              id: 'creative',
              kind: 'creative',
              file: 'input/luts/creative/identity.cube',
              checksumSha256: 'b'.repeat(64),
              cameraModel: null,
              profileId: null,
              inputGamma: null,
              inputGamut: null,
              inputColorSpace: 'Rec.709 Gamma 2.4',
              outputColorSpace: 'Rec.709 Gamma 2.4',
              transformSemantics: 'look',
              defaultMix: 0.4,
            },
            mix: 0.4,
          },
          {
            type: 'rec709-output',
            primaries: 'bt709',
            transfer: 'bt709',
            matrix: 'bt709',
          },
        ],
      },
      '/tmp/project',
    );
    expect(graph.filterComplex.indexOf('exposure=')).toBeLessThan(
      graph.filterComplex.indexOf('technical/identity.cube'),
    );
    expect(graph.filterComplex.indexOf('technical/identity.cube')).toBeLessThan(
      graph.filterComplex.indexOf('creative/identity.cube'),
    );
    expect(graph.filterComplex).toContain('blend=all_expr');
    expect(graph.filterComplex).toContain('zscale=primaries=bt709');
    expect(graph.outputLabel).toBe('color_out');
  });

  it('converts normalized proxies to limited-range Rec.709 before scaling', () => {
    const filter = buildProxyVideoFilter(
      '/tmp/project',
      'input/luts/technical/identity.cube',
      960,
    );
    expect(filter).toContain('format=gbrp16le');
    expect(filter).toContain('zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=limited');
    expect(filter.indexOf('format=')).toBeLessThan(filter.indexOf('lut3d='));
    expect(filter.indexOf('lut3d=')).toBeLessThan(filter.indexOf('zscale='));
    expect(filter.indexOf('zscale=')).toBeLessThan(filter.lastIndexOf('scale='));
  });
});

describe('stabilization safeguards', () => {
  it('accepts bounded transforms and falls back when stabilization reveals edges', () => {
    expect(validateStabilizedCrop({zoom: 1.06, x: 0.5, y: 0.5})).toEqual({
      valid: true,
      reason: null,
    });
    expect(validateStabilizedCrop({zoom: 0.98, x: 0.5, y: 0.5})).toEqual({
      valid: false,
      reason: expect.stringMatching(/edge/i),
    });
    expect(validateStabilizedCrop({zoom: 1.2, x: 1.1, y: 0.5}).valid).toBe(false);
    expect(stabilizationOutcome(true, true)).toBe('applied');
    expect(stabilizationOutcome(false, true)).toBe('fallback');
    expect(() => stabilizationOutcome(false, false)).toThrow(/fallback is disabled/i);
  });

  it('changes the stabilized-preview cache identity when normalization LUT bytes change', () => {
    const fingerprint = (
      previewStabilization as typeof previewStabilization & {
        previewStabilizationFingerprint?: (input: {
          pipelineBuild: string;
          detectionSourceChecksumSha256: string;
          normalizationInputChecksumSha256: string | null;
          reviewVideoFilter: string;
          selection: {inSeconds: number; outSeconds: number};
          stabilization: {enabled: boolean; strength: number; fallbackToUnstabilized: boolean};
          normalized: boolean;
        }) => string;
      }
    ).previewStabilizationFingerprint;
    const input = {
      pipelineBuild: 'pipeline-build',
      detectionSourceChecksumSha256: 'a'.repeat(64),
      reviewVideoFilter: 'lut3d=file=/project/input/luts/technical/normalizer.cube',
      selection: {inSeconds: 1, outSeconds: 2},
      stabilization: {enabled: true, strength: 0.2, fallbackToUnstabilized: false},
      normalized: true,
    };

    expect(fingerprint).toBeTypeOf('function');
    expect(
      fingerprint?.({...input, normalizationInputChecksumSha256: 'b'.repeat(64)}),
    ).not.toBe(
      fingerprint?.({...input, normalizationInputChecksumSha256: 'c'.repeat(64)}),
    );
  });
});

describe('QC parsing', () => {
  it('parses black, freeze, and loudness diagnostics', () => {
    expect(
      parseBlackFrames(
        '[blackdetect @ 0x1] black_start:0 black_end:0.48 black_duration:0.48\n' +
          '[blackdetect @ 0x1] black_start:8.1 black_end:8.7 black_duration:0.6',
      ),
    ).toEqual([
      {startSeconds: 0, endSeconds: 0.48, durationSeconds: 0.48},
      {startSeconds: 8.1, endSeconds: 8.7, durationSeconds: 0.6},
    ]);
    expect(
      parseFreezeSections(
        '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 3.2\n' +
          '[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 2.4\n' +
          '[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 5.6',
      ),
    ).toEqual([{startSeconds: 3.2, endSeconds: 5.6, durationSeconds: 2.4}]);
    expect(
      parseLoudness('noise\n{"input_i":"-14.1","input_tp":"-1.4","input_lra":"5.2"}\n'),
    ).toEqual({integratedLufs: -14.1, truePeakDbtp: -1.4, loudnessRangeLu: 5.2});
    expect(
      parseLoudnormMeasurement(
        '{"input_i":"-20.55","input_tp":"-9.07","input_lra":"0.00","input_thresh":"-30.55","target_offset":"-0.89"}',
      ),
    ).toEqual({
      inputIntegratedLufs: -20.55,
      inputTruePeakDbtp: -9.07,
      inputLoudnessRangeLu: 0,
      inputThresholdLufs: -30.55,
      targetOffsetLu: -0.89,
    });
    expect(
      isSilentLoudness('{"input_i":"-inf","input_tp":"-inf","target_offset":"inf"}'),
    ).toBe(true);
  });

  it('normalizes the relevant ffprobe properties', () => {
    expect(
      summarizeProbe({
        format: {duration: '25.033', format_name: 'mov,mp4,m4a,3gp,3g2,mj2'},
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1080,
            height: 1920,
            avg_frame_rate: '30/1',
            pix_fmt: 'yuv420p',
            color_primaries: 'bt709',
            color_transfer: 'bt709',
            color_space: 'bt709',
          },
          {codec_type: 'audio', codec_name: 'aac', sample_rate: '48000'},
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        durationSeconds: 25.033,
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        audioCodec: 'aac',
        audioSampleRate: 48000,
      }),
    );
  });
});
