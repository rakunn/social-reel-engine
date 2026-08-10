import {describe, expect, it} from 'vitest';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  LutDefinitionSchema,
  QcReportSchema,
  ReelBriefSchema,
  SourceManifestSchema,
} from '../../src/contracts/schemas';
import {assertSafeReelName, resolveProjectPath} from '../../src/core/paths';
import {
  interpolateCrop,
  timelineDurationFrames,
  timelineDurationSeconds,
  validatePlaybackRate,
} from '../../src/core/timeline';
import {snapToNearestBeat} from '../../src/core/beats';
import {buildColorChain} from '../../src/core/color';
import {
  approvalStatus,
  createColorHash,
  createColorReviewHash,
  createEditHash,
  createEditReviewHash,
} from '../../src/core/approvals';

const brief = {
  schemaVersion: '1.0.0',
  identity: {
    reelName: 'island-sunrise',
    title: 'Island Sunrise',
    createdAt: '2026-08-10T00:00:00.000Z',
  },
  target: {minSeconds: 20, idealSeconds: 25, maxSeconds: 30},
  output: {width: 1080, height: 1920, fps: 30},
  style: 'cinematic-minimal',
  options: {music: true, captions: false, cameraAudio: false},
  rightsConfirmed: false,
} as const;

const edit = {
  schemaVersion: '1.0.0',
  reelName: 'island-sunrise',
  output: {width: 1080, height: 1920, fps: 30},
  clips: [
    {
      id: 'shot-1',
      sourceId: 'source-1',
      inSeconds: 1,
      outSeconds: 7,
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
    {
      id: 'shot-2',
      sourceId: 'source-2',
      inSeconds: 2,
      outSeconds: 8,
      playbackRate: 0.5,
      crop: {
        start: {x: 0.5, y: 0.5, scale: 1},
        end: {x: 0.5, y: 0.5, scale: 1},
      },
      stabilization: {enabled: true, strength: 0.25, fallbackToUnstabilized: true},
      grade: {exposureStops: 0.25, whiteBalanceKelvin: 6000, tint: 0.05},
      audio: {muted: false, gainDb: -6},
      transitionAfter: {type: 'none', durationSeconds: 0},
    },
  ],
  titles: [],
  music: null,
  captions: null,
} as const;

describe('versioned public contracts', () => {
  it('accepts a canonical reel brief and rejects non-vertical output', () => {
    expect(ReelBriefSchema.parse(brief).target.idealSeconds).toBe(25);
    expect(() =>
      ReelBriefSchema.parse({...brief, output: {...brief.output, width: 1920}}),
    ).toThrow();
  });

  it('allows unconfirmed source profiles but requires an ID when confirmed', () => {
    const baseSource = {
      id: 'source-1',
      relativePath: 'input/clips/DJI_0001.MP4',
      checksumSha256: 'a'.repeat(64),
      sizeBytes: 123,
      mediaType: 'video',
      ffprobe: {format: {duration: '8.0'}, streams: []},
      camera: {confirmed: false, profileId: null},
    };
    expect(
      SourceManifestSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-10T00:00:00.000Z',
        sources: [baseSource],
      }).sources,
    ).toHaveLength(1);
    expect(() =>
      SourceManifestSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-10T00:00:00.000Z',
        sources: [{...baseSource, camera: {confirmed: true, profileId: null}}],
      }),
    ).toThrow();
    expect(() =>
      SourceManifestSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-10T00:00:00.000Z',
        sources: [
          {
            ...baseSource,
            camera: {
              confirmed: true,
              profileId: 'dji-mini-4-pro-d-log-m',
              model: null,
              gamma: null,
              gamut: null,
            },
          },
        ],
      }),
    ).toThrow(/model|gamma|gamut/i);
  });

  it('validates LUT semantics, edit, approval, and QC contracts', () => {
    expect(
      LutDefinitionSchema.parse({
        id: 'sony-slog3-sgamut3cine',
        kind: 'technical',
        file: 'input/luts/technical/sony.cube',
        checksumSha256: 'b'.repeat(64),
        cameraModel: 'Sony A7 IV',
        profileId: 'sony-slog3-sgamut3cine',
        inputGamma: 'S-Log3',
        inputGamut: 'S-Gamut3.Cine',
        inputColorSpace: 'S-Log3/S-Gamut3.Cine',
        outputColorSpace: 'Rec.709 Gamma 2.4',
        transformSemantics: 'normalization',
        defaultMix: 1,
      }).kind,
    ).toBe('technical');
    expect(() =>
      LutDefinitionSchema.parse({
        id: 'missing-checksum',
        kind: 'technical',
        file: 'input/luts/technical/missing.cube',
        cameraModel: 'Camera',
        profileId: 'profile',
        inputGamma: 'Log',
        inputGamut: 'Wide',
        inputColorSpace: 'Log/Wide',
        outputColorSpace: 'Rec.709',
        transformSemantics: 'normalization',
        defaultMix: 1,
      }),
    ).toThrow(/checksum/i);
    expect(() =>
      LutDefinitionSchema.parse({
        id: 'misleading-output',
        kind: 'technical',
        file: 'input/luts/technical/misleading.cube',
        checksumSha256: 'c'.repeat(64),
        cameraModel: 'Camera',
        profileId: 'profile',
        inputGamma: 'Log',
        inputGamut: 'Wide',
        inputColorSpace: 'Log/Wide',
        outputColorSpace: 'Rec.709 to Display P3',
        transformSemantics: 'normalization',
        defaultMix: 1,
      }),
    ).toThrow(/canonical Rec\.709/i);
    expect(() =>
      LutDefinitionSchema.parse({
        id: 'misleading-creative-input',
        kind: 'creative',
        file: 'input/luts/creative/misleading.cube',
        checksumSha256: 'd'.repeat(64),
        inputColorSpace: 'Display P3 converted from Rec.709',
        outputColorSpace: 'Rec.709',
        transformSemantics: 'look',
        defaultMix: 0.5,
      }),
    ).toThrow(/canonical Rec\.709/i);
    expect(EditManifestSchema.parse(edit).clips).toHaveLength(2);
    expect(
      ApprovalStateSchema.parse({schemaVersion: '1.0.0', edit: null, color: null}),
    ).toBeTruthy();
    expect(
      QcReportSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-10T00:00:00.000Z',
        target: 'delivery',
        readable: true,
        approvals: {edit: true, color: true},
        expected: {},
        observed: {},
        checks: [],
        warnings: [],
        failures: [],
      }).readable,
    ).toBe(true);
  });

  it('rejects a combined LUT stacked with a creative LUT', () => {
    expect(() =>
      EditManifestSchema.parse({
        ...edit,
        clips: [
          {
            ...edit.clips[0],
            grade: {
              ...edit.clips[0].grade,
              technicalLutId: null,
              combinedLutId: 'combined-look',
              creativeLutId: 'second-look',
              creativeMix: 0.4,
            },
          },
          ...edit.clips.slice(1),
        ],
      }),
    ).toThrow(/combined.*creative|creative.*combined/i);
  });

  it('rejects clip selections that round to zero output frames', () => {
    expect(() =>
      EditManifestSchema.parse({
        ...edit,
        clips: [
          {
            ...edit.clips[0],
            inSeconds: 1,
            outSeconds: 1.01,
            playbackRate: 2,
          },
          ...edit.clips.slice(1),
        ],
      }),
    ).toThrow(/output frame/i);
  });

  it('rejects exposure corrections outside FFmpeg\'s supported range', () => {
    for (const exposureStops of [-3.01, 3.01]) {
      expect(() =>
        EditManifestSchema.parse({
          ...edit,
          clips: [
            {
              ...edit.clips[0],
              grade: {...edit.clips[0].grade, exposureStops},
            },
            ...edit.clips.slice(1),
          ],
        }),
      ).toThrow(/exposure|3/i);
    }
  });

  it('rejects a transition configured after the final clip', () => {
    expect(() =>
      EditManifestSchema.parse({
        ...edit,
        clips: [
          ...edit.clips.slice(0, -1),
          {
            ...edit.clips.at(-1)!,
            transitionAfter: {type: 'fade', durationSeconds: 0.5},
          },
        ],
      }),
    ).toThrow(/final.*transition|transition.*final/i);
  });

  it('rejects titles too short for monotonic fade ranges at 30 fps', () => {
    expect(() =>
      EditManifestSchema.parse({
        ...edit,
        titles: [
          {
            text: 'Flash',
            startSeconds: 0,
            durationSeconds: 1 / 3,
            position: 'center',
          },
        ],
      }),
    ).toThrow(/title.*duration|11 output frames/i);
  });
});

describe('path safety', () => {
  it('accepts slugs and rejects traversal or ambiguous names', () => {
    expect(assertSafeReelName('island-sunrise')).toBe('island-sunrise');
    for (const value of ['../escape', 'Island Sunrise', '.hidden', 'a/b', '']) {
      expect(() => assertSafeReelName(value)).toThrow();
    }
  });

  it('resolves jobs only under the projects root', () => {
    const root = '/tmp/reel-engine';
    expect(resolveProjectPath(root, 'island-sunrise')).toBe(
      '/tmp/reel-engine/projects/island-sunrise',
    );
  });
});

describe('timeline primitives', () => {
  it('calculates playback-adjusted duration with transition overlap', () => {
    const parsed = EditManifestSchema.parse(edit);
    expect(timelineDurationSeconds(parsed)).toBe(17.5);
    expect(timelineDurationFrames(parsed)).toBe(525);
  });

  it('snaps only to a sufficiently close beat', () => {
    expect(snapToNearestBeat(4.12, [1, 2.5, 4, 6], 0.15)).toBe(4);
    expect(snapToNearestBeat(4.3, [1, 2.5, 4, 6], 0.15)).toBe(4.3);
  });

  it('interpolates animated vertical crops and clamps progress', () => {
    const crop = EditManifestSchema.parse(edit).clips[0].crop;
    expect(interpolateCrop(crop, 0.5)).toEqual({x: 0.5, y: 0.5, scale: 1.15});
    expect(interpolateCrop(crop, 2)).toEqual(crop.end);
  });

  it('rejects unsafe rates and slow motion without enough source frames', () => {
    expect(validatePlaybackRate(0.5, 60, 30)).toEqual({valid: true, reason: null});
    expect(validatePlaybackRate(0.5, 30, 30).valid).toBe(false);
    expect(validatePlaybackRate(2.01, 120, 30).valid).toBe(false);
  });
});

describe('color and approvals', () => {
  const technical = {
    id: 'dlogm-rec709',
    kind: 'technical' as const,
    file: 'input/luts/technical/dlogm.cube',
    checksumSha256: 'c'.repeat(64),
    cameraModel: 'DJI Mini 4 Pro',
    profileId: 'dji-mini4pro-dlogm',
    inputGamma: 'D-Log M',
    inputGamut: 'D-Gamut',
    inputColorSpace: 'D-Log M/D-Gamut',
    outputColorSpace: 'Rec.709 Gamma 2.4',
    transformSemantics: 'normalization' as const,
    defaultMix: 1,
  };
  const creative = {
    id: 'warm-film',
    kind: 'creative' as const,
    file: 'input/luts/creative/warm.cube',
    checksumSha256: 'd'.repeat(64),
    cameraModel: null,
    profileId: null,
    inputColorSpace: 'Rec.709 Gamma 2.4',
    outputColorSpace: 'Rec.709 Gamma 2.4',
    transformSemantics: 'look' as const,
    defaultMix: 0.35,
  };

  it('constructs the required order and never double-normalizes combined LUTs', () => {
    expect(
      buildColorChain({
        exposureStops: 0.25,
        whiteBalanceKelvin: 6000,
        tint: 0.05,
        technical,
        creative,
        creativeMix: 0.3,
      }).operations.map((operation) => operation.type),
    ).toEqual(['pre-transform', 'technical-lut', 'creative-lut', 'rec709-output']);

    const combined = {
      ...technical,
      id: 'dlogm-film-combined',
      kind: 'combined' as const,
      transformSemantics: 'normalization-and-look' as const,
    };
    expect(() =>
      buildColorChain({
        exposureStops: 0,
        whiteBalanceKelvin: 6500,
        tint: 0,
        technical,
        combined,
      }),
    ).toThrow(/replace/i);
    expect(
      buildColorChain({
        exposureStops: 0,
        whiteBalanceKelvin: 6500,
        tint: 0,
        combined,
      }).operations.map((operation) => operation.type),
    ).toEqual(['pre-transform', 'combined-lut', 'rec709-output']);
  });

  it('binds approvals to canonical edit and color hashes', () => {
    const parsedEdit = EditManifestSchema.parse(edit);
    const preview = {
      fingerprint: 'preview-fingerprint',
      checksumSha256: 'e'.repeat(64),
      reviewContextHash: 'd'.repeat(64),
    };
    const editHash = createEditReviewHash(createEditHash(parsedEdit), preview);
    expect(
      createEditReviewHash(createEditHash(parsedEdit), {
        ...preview,
        reviewContextHash: 'c'.repeat(64),
      }),
    ).not.toBe(editHash);
    const reviewedStills = parsedEdit.clips.map((clip) => ({
      clipId: clip.id,
      file: `previews/graded-stills/${clip.id}.png`,
      checksumSha256: 'f'.repeat(64),
    }));
    const colorHash = createColorReviewHash(
      editHash,
      createColorHash(parsedEdit, [technical, creative]),
      reviewedStills,
    );
    const state = ApprovalStateSchema.parse({
      schemaVersion: '1.0.0',
      edit: {hash: editHash, approvedAt: '2026-08-10T00:00:00.000Z'},
      color: {
        hash: colorHash,
        editHash,
        approvedAt: '2026-08-10T00:01:00.000Z',
      },
    });
    expect(approvalStatus(state, editHash, colorHash)).toEqual({
      editApproved: true,
      colorApproved: true,
    });
    const changed = {
      ...parsedEdit,
      clips: [
        {...parsedEdit.clips[0], outSeconds: 6.5},
        ...parsedEdit.clips.slice(1),
      ],
    };
    const changedEditHash = createEditReviewHash(createEditHash(changed), preview);
    const changedColorHash = createColorReviewHash(
      changedEditHash,
      createColorHash(changed, [technical, creative]),
      reviewedStills,
    );
    expect(approvalStatus(state, changedEditHash, changedColorHash)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
  });
});
