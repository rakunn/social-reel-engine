import {describe, expect, it} from 'vitest';
import {EditManifestSchema} from '../../src/contracts/schemas';
import {
  buildShotTimings,
  calculateReelMetadata,
  captionFrameRange,
  cropTransform,
  secondsToMediaFrames,
  type ReelRenderProps,
} from '../../src/remotion/model';
import * as remotionModel from '../../src/remotion/model';

const edit = EditManifestSchema.parse({
  schemaVersion: '1.0.0',
  reelName: 'remotion-test',
  output: {width: 1080, height: 1920, fps: 30},
  clips: [
    {
      id: 'one',
      sourceId: 'source-one',
      inSeconds: 0,
      outSeconds: 6,
      playbackRate: 1,
      crop: {
        start: {x: 0.25, y: 0.5, scale: 1},
        end: {x: 0.75, y: 0.5, scale: 1.2},
      },
      stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
      grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
      audio: {muted: true, gainDb: 0},
      transitionAfter: {type: 'fade', durationSeconds: 0.5},
    },
    {
      id: 'two',
      sourceId: 'source-two',
      inSeconds: 0,
      outSeconds: 6,
      playbackRate: 0.5,
      crop: {
        start: {x: 0.5, y: 0.5, scale: 1},
        end: {x: 0.5, y: 0.5, scale: 1},
      },
      stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
      grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
      audio: {muted: false, gainDb: -6},
      transitionAfter: {type: 'none', durationSeconds: 0},
    },
  ],
  titles: [],
  music: null,
  captions: null,
});

const props: ReelRenderProps = {
  edit,
  media: {
    'source-one': 'jobs/remotion-test/one.mov',
    'source-two': 'jobs/remotion-test/two.mov',
  },
  music: null,
  captions: [],
  watermark: null,
};

describe('data-driven Remotion model', () => {
  it('uses frame-safe transition overlap and dynamic composition metadata', () => {
    expect(buildShotTimings(edit)).toEqual([
      expect.objectContaining({id: 'one', startFrame: 0, durationInFrames: 180, transitionFrames: 15}),
      expect.objectContaining({id: 'two', startFrame: 165, durationInFrames: 360, transitionFrames: 0}),
    ]);
    expect(calculateReelMetadata(props)).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      durationInFrames: 525,
      props,
    });
  });

  it('interpolates a bounded animated crop without frame-dependent randomness', () => {
    expect(cropTransform(edit.clips[0].crop, 90, 180)).toEqual({
      transform: 'scale(1.1)',
      transformOrigin: '50% 50%',
      objectPosition: '50% 50%',
    });
  });

  it('maps supplied caption milliseconds to integer frames', () => {
    expect(
      captionFrameRange({text: 'Hello', startMs: 500, endMs: 1750, timestampMs: null, confidence: null}, 30),
    ).toEqual({from: 15, durationInFrames: 38});
  });

  it('converts source and music trim offsets from seconds to Remotion frames', () => {
    expect(secondsToMediaFrames(10, 30)).toBe(300);
    expect(secondsToMediaFrames(0.25, 30)).toBe(8);
  });

  it('quotes custom-font URLs so apostrophes cannot break the font-face rule', () => {
    const fontFaceRule = (
      remotionModel as typeof remotionModel & {fontFaceRule?: (url: string) => string}
    ).fontFaceRule;

    expect(fontFaceRule).toBeTypeOf('function');
    expect(fontFaceRule?.("/fonts/Director's Cut.ttf")).toBe(
      `@font-face{font-family:ReelCustom;src:url("/fonts/Director's Cut.ttf");font-display:block;}`,
    );
  });
});
