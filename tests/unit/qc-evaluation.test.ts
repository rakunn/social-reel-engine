import {describe, expect, it} from 'vitest';
import {evaluateQc} from '../../src/media/qc-report';

describe('QC evaluation', () => {
  it('fails black and freeze checks when the detectors did not complete', () => {
    const report = evaluateQc({
      target: 'preview',
      now: new Date('2026-08-10T00:00:00.000Z'),
      readable: true,
      renderFresh: true,
      silenceAllowed: true,
      observedSilent: true,
      approvals: {editApproved: false, colorApproved: false},
      expectedDurationSeconds: 1,
      observed: {
        durationSeconds: 1,
        width: 540,
        height: 960,
        fps: 30,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        audioCodec: 'aac',
        audioSampleRate: 48000,
        audioBitRate: 128000,
        colorPrimaries: 'bt709',
        colorTransfer: 'bt709',
        colorSpace: 'bt709',
        fastStart: true,
      },
      missingMedia: [],
      blackFrames: [],
      freezeSections: [],
      blackDetectionSucceeded: false,
      freezeDetectionSucceeded: false,
      loudness: null,
    });

    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/black.*detector/i),
        expect.stringMatching(/freeze.*detector/i),
      ]),
    );
  });

  it('passes a readable approved master with exact expected properties', () => {
    const report = evaluateQc({
      target: 'master',
      now: new Date('2026-08-10T00:00:00.000Z'),
      readable: true,
      renderFresh: true,
      renderArtifact: {
        fingerprint: 'a'.repeat(64),
        checksumSha256: 'b'.repeat(64),
        sizeBytes: 123,
      },
      silenceAllowed: false,
      observedSilent: false,
      approvals: {editApproved: true, colorApproved: true},
      expectedDurationSeconds: 25,
      observed: {
        durationSeconds: 25.001,
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: 'prores',
        videoProfile: 'HQ',
        pixelFormat: 'yuv422p10le',
        audioCodec: 'pcm_s16le',
        audioSampleRate: 48000,
        colorPrimaries: 'bt709',
        colorTransfer: 'bt709',
        colorSpace: 'bt709',
      },
      missingMedia: [],
      blackFrames: [],
      freezeSections: [],
      blackDetectionSucceeded: true,
      freezeDetectionSucceeded: true,
      loudness: {integratedLufs: -14.2, truePeakDbtp: -1.6, loudnessRangeLu: 5},
    });
    expect(report.failures).toEqual([]);
    expect(report.renderArtifact).toEqual({
      fingerprint: 'a'.repeat(64),
      checksumSha256: 'b'.repeat(64),
      sizeBytes: 123,
    });
    expect(report.checks.every((check) => check.status !== 'fail')).toBe(true);
  });

  it('fails stale approvals and format mismatches while reporting diagnostic warnings', () => {
    const report = evaluateQc({
      target: 'delivery',
      now: new Date('2026-08-10T00:00:00.000Z'),
      readable: true,
      renderFresh: false,
      silenceAllowed: false,
      observedSilent: false,
      approvals: {editApproved: false, colorApproved: false},
      expectedDurationSeconds: 25,
      observed: {
        durationSeconds: 24,
        width: 720,
        height: 1280,
        fps: 29.97,
        videoCodec: 'hevc',
        pixelFormat: 'yuv420p10le',
        audioCodec: null,
        audioSampleRate: null,
        colorPrimaries: null,
        colorTransfer: null,
        colorSpace: null,
      },
      missingMedia: ['shot-2: source missing'],
      blackFrames: [{startSeconds: 0, endSeconds: 0.7, durationSeconds: 0.7}],
      freezeSections: [{startSeconds: 4, endSeconds: 7, durationSeconds: 3}],
      blackDetectionSucceeded: true,
      freezeDetectionSucceeded: true,
      loudness: null,
    });
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/approval/i),
        expect.stringMatching(/current manifest|fresh/i),
        expect.stringMatching(/width/i),
        expect.stringMatching(/missing/i),
        expect.stringMatching(/loudness/i),
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/black/i), expect.stringMatching(/frozen/i)]),
    );
  });

  it('accepts an explicitly silent delivery while retaining the audio container contract', () => {
    const report = evaluateQc({
      target: 'delivery',
      now: new Date('2026-08-10T00:00:00.000Z'),
      readable: true,
      renderFresh: true,
      silenceAllowed: true,
      observedSilent: true,
      approvals: {editApproved: true, colorApproved: true},
      expectedDurationSeconds: 25,
      observed: {
        durationSeconds: 25,
        width: 1080,
        height: 1920,
        fps: 30,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        audioCodec: 'aac',
        audioSampleRate: 48000,
        audioBitRate: 2000,
        colorPrimaries: 'bt709',
        colorTransfer: 'bt709',
        colorSpace: 'bt709',
        fastStart: true,
      },
      missingMedia: [],
      blackFrames: [],
      freezeSections: [],
      blackDetectionSucceeded: true,
      freezeDetectionSucceeded: true,
      loudness: null,
    });
    expect(report.failures).toEqual([]);
    expect(report.checks.find((check) => check.id === 'loudness')?.status).toBe('pass');
  });

  it('allows AAC container padding and reports short-clip average bitrate as a warning', () => {
    const report = evaluateQc({
      target: 'preview',
      now: new Date('2026-08-10T00:00:00.000Z'),
      readable: true,
      renderFresh: true,
      silenceAllowed: false,
      observedSilent: false,
      approvals: {editApproved: false, colorApproved: false},
      expectedDurationSeconds: 3.7,
      observed: {
        durationSeconds: 3.754667,
        width: 540,
        height: 960,
        fps: 30,
        videoCodec: 'h264',
        pixelFormat: 'yuv420p',
        audioCodec: 'aac',
        audioSampleRate: 48000,
        audioBitRate: 26891,
        colorPrimaries: 'bt709',
        colorTransfer: 'bt709',
        colorSpace: 'bt709',
        fastStart: true,
      },
      missingMedia: [],
      blackFrames: [],
      freezeSections: [],
      blackDetectionSucceeded: true,
      freezeDetectionSucceeded: true,
      loudness: null,
    });
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([
      expect.stringMatching(/content-dependent average/i),
    ]);
  });
});
