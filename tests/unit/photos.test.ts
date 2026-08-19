import {access, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
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

  it('sizes a contact-sheet grid to include every requested candidate', async () => {
    const photos = await import('../../src/media/photos');
    const contactSheetGrid = Reflect.get(photos, 'contactSheetGrid');

    expect(contactSheetGrid).toEqual(expect.any(Function));
    expect(contactSheetGrid(1)).toEqual({columns: 1, rows: 1});
    expect(contactSheetGrid(7)).toEqual({columns: 4, rows: 2});
    expect(contactSheetGrid(20)).toEqual({columns: 4, rows: 5});
  });

  it('rejects photo export for carousel projects before render readiness checks', async () => {
    const photos = await import('../../src/media/photos');
    const assertPhotoProjectType = Reflect.get(photos, 'assertPhotoProjectType');

    expect(assertPhotoProjectType).toEqual(expect.any(Function));
    expect(() => assertPhotoProjectType({projectType: 'reel'})).not.toThrow();
    expect(() => assertPhotoProjectType({projectType: 'carousel'})).toThrow(/reel projects/i);
  });

  it('treats photo QC as current only when it passes for every published output', async () => {
    const photos = await import('../../src/media/photos');
    const photoQcReportIsCurrent = Reflect.get(photos, 'photoQcReportIsCurrent');
    const fingerprint = 'a'.repeat(64);
    const packageRecord = {
      fingerprint,
      outputs: [{outputFiles: ['output/photos/9x16/01.jpg']}],
    };
    const passing = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-19T00:00:00.000Z',
      fingerprint,
      checks: [{file: 'output/photos/9x16/01.jpg', status: 'pass'}],
      warnings: [],
      failures: [],
    };

    expect(photoQcReportIsCurrent).toEqual(expect.any(Function));
    expect(photoQcReportIsCurrent(packageRecord, passing)).toBe(true);
    expect(photoQcReportIsCurrent(packageRecord, {...passing, checks: []})).toBe(false);
    expect(photoQcReportIsCurrent(packageRecord, {...passing, failures: ['bad dimensions']})).toBe(false);
    expect(photoQcReportIsCurrent(packageRecord, {...passing, fingerprint: 'b'.repeat(64)})).toBe(false);
  });

  it('prunes obsolete photos and removed profile directories after publication', async () => {
    const photos = await import('../../src/media/photos');
    const prunePublishedPhotoOutputs = Reflect.get(photos, 'prunePublishedPhotoOutputs');
    const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-photo-prune-'));
    const keep = path.join(projectPath, 'output/photos/9x16/01.jpg');
    const staleCount = path.join(projectPath, 'output/photos/9x16/02.jpg');
    const staleProfile = path.join(projectPath, 'output/photos/4x5/01.jpg');
    try {
      await mkdir(path.dirname(keep), {recursive: true});
      await mkdir(path.dirname(staleProfile), {recursive: true});
      await Promise.all([
        writeFile(keep, 'keep'),
        writeFile(staleCount, 'stale'),
        writeFile(staleProfile, 'stale'),
      ]);

      expect(prunePublishedPhotoOutputs).toEqual(expect.any(Function));
      await prunePublishedPhotoOutputs(projectPath, ['output/photos/9x16/01.jpg']);

      await expect(access(keep)).resolves.toBeUndefined();
      await expect(access(staleCount)).rejects.toThrow();
      await expect(access(staleProfile)).rejects.toThrow();
    } finally {
      await rm(projectPath, {recursive: true, force: true});
    }
  });
});
