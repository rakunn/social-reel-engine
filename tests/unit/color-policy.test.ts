import {describe, expect, it} from 'vitest';
import {EditManifestSchema, LutDefinitionSchema} from '../../src/contracts/schemas';
import {createColorHash} from '../../src/core/approvals';

const edit = EditManifestSchema.parse({
  schemaVersion: '1.0.0',
  reelName: 'color-policy',
  output: {width: 1080, height: 1920, fps: 30},
  clips: [
    {
      id: 'shot-1',
      sourceId: 'source-one',
      inSeconds: 2,
      outSeconds: 27,
      playbackRate: 1,
      crop: {
        start: {x: 0.5, y: 0.5, scale: 1},
        end: {x: 0.5, y: 0.5, scale: 1},
      },
      stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: false},
      grade: {
        exposureStops: 0.3,
        whiteBalanceKelvin: 6500,
        tint: 0,
        technicalLutId: 'normalizer',
        creativeLutId: 'look',
        combinedLutId: null,
        creativeMix: 0.35,
      },
      audio: {muted: true, gainDb: -60},
      textOverlay: null,
      transitionAfter: {type: 'none', durationSeconds: 0},
    },
  ],
  titles: [],
  music: null,
  captions: null,
});

const luts = [
  LutDefinitionSchema.parse({
    id: 'normalizer',
    kind: 'technical',
    file: 'input/luts/technical/normalizer.cube',
    checksumSha256: 'a'.repeat(64),
    cameraModel: 'Camera',
    profileId: 'camera-log',
    inputGamma: 'Log',
    inputGamut: 'Wide',
    inputColorSpace: 'Log/Wide',
    outputColorSpace: 'Rec.709',
    transformSemantics: 'normalization',
    defaultMix: 1,
  }),
  LutDefinitionSchema.parse({
    id: 'look',
    kind: 'creative',
    file: 'input/luts/creative/look.cube',
    checksumSha256: 'b'.repeat(64),
    cameraModel: null,
    profileId: null,
    inputColorSpace: 'Rec.709',
    outputColorSpace: 'Rec.709',
    transformSemantics: 'look',
    defaultMix: 0.35,
  }),
];

describe('color approval identity', () => {
  it.each([
    {
      label: 'card text',
      change: {
        clips: [
          {
            ...edit.clips[0],
            textOverlay: {
              heading: 'CHOCOLATE HILLS',
              subheading: 'Bohol, Philippines',
              placement: 'lower-left' as const,
            },
          },
        ],
      },
    },
    {
      label: 'audio',
      change: {clips: [{...edit.clips[0], audio: {muted: false, gainDb: -12}}]},
    },
    {
      label: 'timeline title',
      change: {
        titles: [{text: 'Location', startSeconds: 0, durationSeconds: 2, position: 'bottom' as const}],
      },
    },
  ])('retains approved color when only $label changes', ({change}) => {
    const changed = EditManifestSchema.parse({...edit, ...change});
    expect(createColorHash(changed, luts, [])).toBe(createColorHash(edit, luts, []));
  });

  it.each([
    {
      label: 'source interval',
      clip: {...edit.clips[0], inSeconds: 3, outSeconds: 28},
    },
    {
      label: 'crop',
      clip: {
        ...edit.clips[0],
        crop: {
          start: {x: 0.45, y: 0.5, scale: 1.1},
          end: {x: 0.45, y: 0.5, scale: 1.1},
        },
      },
    },
    {
      label: 'stabilization',
      clip: {
        ...edit.clips[0],
        stabilization: {enabled: true, strength: 0.2, fallbackToUnstabilized: false},
      },
    },
    {
      label: 'grade',
      clip: {...edit.clips[0], grade: {...edit.clips[0].grade, exposureStops: 0.5}},
    },
  ])('invalidates approved color when the $label changes', ({clip}) => {
    const changed = EditManifestSchema.parse({...edit, clips: [clip]});
    expect(createColorHash(changed, luts, [])).not.toBe(createColorHash(edit, luts, []));
  });

  it('invalidates approved color when selected LUT bytes change', () => {
    const changedLuts = [luts[0], {...luts[1], checksumSha256: 'c'.repeat(64)}];
    expect(createColorHash(edit, changedLuts, [])).not.toBe(createColorHash(edit, luts, []));
  });
});
