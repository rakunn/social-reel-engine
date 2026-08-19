import {describe, expect, it} from 'vitest';
import {
  buildPhotoCandidates,
  photoGradedFingerprintMaterial,
  photoProfile,
  selectPhotoCandidates,
} from '../../src/media/photos';
import {EditManifestSchema} from '../../src/contracts/schemas';

const edit = {
  schemaVersion: '1.0.0',
  reelName: 'photo-test',
  output: {width: 1080, height: 1920, fps: 30},
  clips: [
    {
      id: 'opening',
      sourceId: 'source-a',
      inSeconds: 0,
      outSeconds: 6,
      playbackRate: 1,
      crop: {
        start: {x: 0.4, y: 0.5, scale: 1.1},
        end: {x: 0.6, y: 0.5, scale: 1.2},
      },
      stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
      grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
      audio: {muted: true, gainDb: 0},
      transitionAfter: {type: 'fade', durationSeconds: 0.5},
    },
  ],
  titles: [],
  music: null,
  captions: null,
} as const;

describe('photo candidate policy', () => {
  it('maps supported profiles to social delivery dimensions and review requirements', () => {
    expect(photoProfile('9:16')).toEqual({width: 1080, height: 1920, requiresReview: false});
    expect(photoProfile('4:5')).toEqual({width: 1080, height: 1350, requiresReview: true});
    expect(photoProfile('1:1')).toEqual({width: 1080, height: 1080, requiresReview: true});
    expect(photoProfile('16:9')).toEqual({width: 1920, height: 1080, requiresReview: true});
  });

  it('samples seven unique interior frames and excludes the outgoing transition', () => {
    const candidates = buildPhotoCandidates(
      EditManifestSchema.parse({
        ...edit,
        clips: [
          edit.clips[0],
          {
            ...edit.clips[0],
            id: 'ending',
            sourceId: 'source-b',
            transitionAfter: {type: 'none', durationSeconds: 0},
          },
        ],
      }),
    ).filter((candidate) => candidate.clipId === 'opening');

    expect(candidates).toHaveLength(7);
    expect(new Set(candidates.map((candidate) => candidate.shotFrame)).size).toBe(7);
    expect(candidates.every((candidate) => candidate.shotFrame >= 18)).toBe(true);
    expect(candidates.every((candidate) => candidate.shotFrame < 165)).toBe(true);
    expect(candidates[0]).toMatchObject({clipId: 'opening', sourceId: 'source-a'});
  });

  it('excludes the incoming transition overlap even when it exceeds the outer safe margin', () => {
    const candidates = buildPhotoCandidates(
      EditManifestSchema.parse({
        ...edit,
        clips: [
          {...edit.clips[0], outSeconds: 2, transitionAfter: {type: 'fade', durationSeconds: 0.5}},
          {
            ...edit.clips[0],
            id: 'short-ending',
            sourceId: 'source-b',
            outSeconds: 2,
            transitionAfter: {type: 'none', durationSeconds: 0},
          },
        ],
      }),
    ).filter((candidate) => candidate.clipId === 'short-ending');

    expect(candidates).toHaveLength(7);
    expect(candidates.every((candidate) => candidate.shotFrame >= 15)).toBe(true);
  });

  it('prioritizes the highest-ranked distinct shots before selecting extra candidates', () => {
    const candidates = [
      {id: 'a-1', clipId: 'a'},
      {id: 'a-2', clipId: 'a'},
      {id: 'b-1', clipId: 'b'},
      {id: 'b-2', clipId: 'b'},
    ];

    expect(
      selectPhotoCandidates(candidates, 3, {
        'a-1': 100,
        'a-2': 95,
        'b-1': 90,
        'b-2': 80,
      }),
    ).toEqual(['a-1', 'b-1', 'a-2']);
  });

  it('binds photo freshness to stable graded intermediates rather than volatile report metadata', () => {
    const items = [
      {
        clipId: 'opening',
        sourceId: 'source-a',
        path: 'work/graded/opening.mov',
        checksumSha256: 'a'.repeat(64),
        fingerprint: 'b'.repeat(64),
        stabilization: 'disabled' as const,
        cached: false,
      },
    ];
    expect(photoGradedFingerprintMaterial({items})).toEqual(
      photoGradedFingerprintMaterial({items: [{...items[0], cached: true}]}),
    );
  });
});
