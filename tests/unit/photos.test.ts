import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

  it('scales per-clip sampling to satisfy photo counts above seven', async () => {
    const photos = await import('../../src/media/photos');
    const buildPhotoCandidatesForCount = Reflect.get(photos, 'buildPhotoCandidatesForCount');
    const parsed = EditManifestSchema.parse({
      ...edit,
      clips: [
        {...edit.clips[0], transitionAfter: {type: 'none', durationSeconds: 0}},
      ],
    });

    expect(buildPhotoCandidatesForCount).toEqual(expect.any(Function));
    if (typeof buildPhotoCandidatesForCount !== 'function') return;
    expect(buildPhotoCandidatesForCount(parsed, 5)).toHaveLength(7);
    expect(buildPhotoCandidatesForCount(parsed, 20)).toHaveLength(20);
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

  it('bounds concurrent photo metric scoring', async () => {
    const photos = await import('../../src/media/photos');
    const scorePhotoCandidates = Reflect.get(photos, 'scorePhotoCandidates');
    const candidates = Array.from({length: 12}, (_, index) => ({
      id: `opening-f${index}`,
      clipId: 'opening',
      sourceSeconds: index,
    }));
    let active = 0;
    let maximumActive = 0;

    expect(scorePhotoCandidates).toEqual(expect.any(Function));
    if (typeof scorePhotoCandidates !== 'function') return;
    const scores = await scorePhotoCandidates(
      '/synthetic-project',
      candidates,
      new Map([['opening', 'work/graded/opening.mov']]),
      async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return 100;
      },
    );

    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(Object.keys(scores)).toHaveLength(12);
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

  it.each([
    ['malformed JSON', '{'],
    [
      'schema-invalid JSON',
      JSON.stringify({
        schemaVersion: '1.0.0',
        enabled: 'yes',
        profiles: ['9:16'],
        count: 5,
        jpegQuality: 95,
      }),
    ],
  ])('surfaces an existing %s photo configuration', async (_label, contents) => {
    const photos = await import('../../src/media/photos');
    const readPhotoConfig = Reflect.get(photos, 'readPhotoConfig');
    const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-invalid-photo-config-'));
    try {
      await mkdir(path.join(projectPath, 'config'), {recursive: true});
      await writeFile(path.join(projectPath, 'config/photos.json'), contents);

      expect(readPhotoConfig).toEqual(expect.any(Function));
      if (typeof readPhotoConfig !== 'function') return;
      await expect(readPhotoConfig(projectPath)).rejects.toThrow();
    } finally {
      await rm(projectPath, {recursive: true, force: true});
    }
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

  it('refuses a symlinked photo output root without deleting its target', async () => {
    const photos = await import('../../src/media/photos');
    const prunePublishedPhotoOutputs = Reflect.get(photos, 'prunePublishedPhotoOutputs');
    const root = await mkdtemp(path.join(tmpdir(), 'reel-photo-prune-symlink-'));
    const projectPath = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    const sentinel = path.join(outside, 'sentinel.txt');
    try {
      await mkdir(path.join(projectPath, 'output'), {recursive: true});
      await mkdir(outside, {recursive: true});
      await writeFile(sentinel, 'keep');
      await symlink(outside, path.join(projectPath, 'output/photos'), 'dir');

      expect(prunePublishedPhotoOutputs).toEqual(expect.any(Function));
      await expect(prunePublishedPhotoOutputs(projectPath, [])).rejects.toThrow(
        /symlink|outside|boundary|real directory/i,
      );
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('refuses a symlinked profile directory before publishing any photo', async () => {
    const photos = await import('../../src/media/photos');
    const publishProfile = Reflect.get(photos, 'publishProfile');
    const root = await mkdtemp(path.join(tmpdir(), 'reel-photo-publish-symlink-'));
    const projectPath = path.join(root, 'project');
    const candidate = path.join(projectPath, 'previews/photo-candidates/9x16/01.jpg');
    const outside = path.join(root, 'outside');
    const sentinel = path.join(outside, 'sentinel.txt');
    try {
      await mkdir(path.dirname(candidate), {recursive: true});
      await mkdir(path.join(projectPath, 'output/photos'), {recursive: true});
      await mkdir(outside, {recursive: true});
      await writeFile(candidate, 'candidate');
      await writeFile(sentinel, 'keep');
      await symlink(outside, path.join(projectPath, 'output/photos/9x16'), 'dir');

      expect(publishProfile).toEqual(expect.any(Function));
      if (typeof publishProfile !== 'function') return;
      await expect(
        publishProfile(projectPath, {
          profile: '9:16',
          candidateFiles: ['previews/photo-candidates/9x16/01.jpg'],
          candidateChecksums: {},
          contactSheet: null,
          contactSheetChecksum: null,
          outputFiles: [],
          outputChecksums: {},
        }),
      ).rejects.toThrow(/symlink|outside|boundary|real directory/i);
      await expect(access(path.join(outside, '01.jpg'))).rejects.toThrow();
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
