import {loadFont} from '@remotion/fonts';
import {describe, expect, it, vi} from 'vitest';
import {EditManifestSchema} from '../../src/contracts/schemas';
import {
  buildShotTimings,
  calculateReelMetadata,
  captionFrameRange,
  cropTransform,
  photoCropStyle,
  secondsToMediaFrames,
  type ReelRenderProps,
} from '../../src/remotion/model';
import * as remotionModel from '../../src/remotion/model';
import * as remotionReel from '../../src/remotion/Reel';

vi.mock('@remotion/fonts', () => ({
  loadFont: vi.fn(async () => undefined),
}));

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
    expect(cropTransform(edit.clips[0].crop, 90, 181)).toEqual({
      transform: 'scale(1.1)',
      transformOrigin: '50% 50%',
      objectPosition: '50% 50%',
    });

    expect(cropTransform(edit.clips[0].crop, 1, 2)).toEqual({
      transform: 'scale(1.2)',
      transformOrigin: '75% 50%',
      objectPosition: '75% 50%',
    });

    expect(cropTransform(edit.clips[0].crop, 0, 1)).toEqual({
      transform: 'scale(1)',
      transformOrigin: '25% 50%',
      objectPosition: '25% 50%',
    });
  });

  it('uses the selected approved crop for a clean photo still', () => {
    expect(photoCropStyle({x: 0.4, y: 0.65, scale: 1.25})).toEqual({
      transform: 'scale(1.25)',
      transformOrigin: '40% 65%',
      objectPosition: '40% 65%',
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

  it('blocks Remotion rendering until a staged custom font has loaded', () => {
    const mockedLoadFont = vi.mocked(loadFont);
    mockedLoadFont.mockClear();

    remotionReel.SocialReel({
      ...props,
      fontUrl: "jobs/remotion-test/fonts/Director's Cut.ttf",
    });

    expect(mockedLoadFont).toHaveBeenCalledTimes(1);
    expect(mockedLoadFont).toHaveBeenCalledWith({
      family: 'ReelCustom',
      url: "/jobs/remotion-test/fonts/Director%27s%20Cut.ttf",
      display: 'block',
    });
  });

  it('fades a title to zero on its final rendered frame', () => {
    const titleOpacity = (
      remotionModel as typeof remotionModel & {
        titleOpacity?: (frame: number, durationInFrames: number) => number;
      }
    ).titleOpacity;

    expect(titleOpacity).toBeTypeOf('function');
    expect(titleOpacity?.(0, 11)).toBe(0);
    expect(titleOpacity?.(5, 11)).toBeGreaterThan(0);
    expect(titleOpacity?.(10, 11)).toBe(0);
    expect(titleOpacity?.(0, 1)).toBe(0);
  });

  it('keeps a schema-valid unbroken card label inside the safe area', () => {
    expect(remotionModel.cardTextContainerStyle()).toEqual(
      expect.objectContaining({
        maxWidth: '100%',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }),
    );
  });
});
