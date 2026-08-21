import {afterEach, describe, expect, it} from 'vitest';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hashFile} from '../../src/core/hash';
import type {CarouselPackageRecord} from '../../src/render/carousel';

const temporaryRoots: string[] = [];

const loadShareModule = async (): Promise<Record<string, unknown>> => {
  const modulePath = '../../src/render/carousel-share';
  return await import(modulePath).catch(() => ({}));
};

const createPackageFixture = async (
  projectPath: string,
): Promise<{packageRecord: CarouselPackageRecord; canonicalFiles: string[]}> => {
  const canonicalDirectory = path.join(projectPath, 'output/carousel/aaaaaaaaaaaaaaaa');
  await mkdir(canonicalDirectory, {recursive: true});
  await mkdir(path.join(projectPath, 'analysis'), {recursive: true});
  const canonicalFiles = [
    path.join(canonicalDirectory, '01-hero.mp4'),
    path.join(canonicalDirectory, '02-closer.mp4'),
  ];
  await writeFile(canonicalFiles[0], 'approved-hero-card');
  await writeFile(canonicalFiles[1], 'approved-closer-card');
  return {
    canonicalFiles,
    packageRecord: {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-20T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: await Promise.all(
        [
          {index: 0, clipId: 'hero', file: canonicalFiles[0]},
          {index: 1, clipId: 'closer', file: canonicalFiles[1]},
        ].map(async ({index, clipId, file}) => ({
          index,
          clipId,
          file: `output/carousel/aaaaaaaaaaaaaaaa/${path.basename(file)}`,
          checksumSha256: await hashFile(file),
          sizeBytes: (await stat(file)).size,
          durationSeconds: 4.5,
        })),
      ),
    },
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (temporaryRoot) =>
      await rm(temporaryRoot, {recursive: true, force: true}),
    ),
  );
});

describe('carousel ready-to-share publication', () => {
  it('replaces stale cards with byte-identical current package files and records them', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-'));
    temporaryRoots.push(projectPath);
    const canonicalDirectory = path.join(projectPath, 'output/carousel/aaaaaaaaaaaaaaaa');
    const shareDirectory = path.join(projectPath, 'output/carousel/ready-to-share');
    await mkdir(canonicalDirectory, {recursive: true});
    await mkdir(shareDirectory, {recursive: true});
    await mkdir(path.join(projectPath, 'analysis'), {recursive: true});

    const canonicalFiles = [
      path.join(canonicalDirectory, '01-hero.mp4'),
      path.join(canonicalDirectory, '02-closer.mp4'),
    ];
    await writeFile(canonicalFiles[0], 'approved-hero-card');
    await writeFile(canonicalFiles[1], 'approved-closer-card');
    await writeFile(path.join(shareDirectory, '00-stale.mp4'), 'stale-card');

    const packageRecord: CarouselPackageRecord = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-20T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: [
        {
          index: 0,
          clipId: 'hero',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4',
          checksumSha256: await hashFile(canonicalFiles[0]),
          sizeBytes: (await stat(canonicalFiles[0])).size,
          durationSeconds: 4.5,
        },
        {
          index: 1,
          clipId: 'closer',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/02-closer.mp4',
          checksumSha256: await hashFile(canonicalFiles[1]),
          sizeBytes: (await stat(canonicalFiles[1])).size,
          durationSeconds: 4.5,
        },
      ],
    };

    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    if (typeof publishCarouselSharePackage !== 'function') return;

    const record = await publishCarouselSharePackage(
      projectPath,
      packageRecord,
      new Date('2026-08-20T00:01:00.000Z'),
    );

    expect(await readdir(shareDirectory)).toEqual(['01-hero.mp4', '02-closer.mp4']);
    await expect(readFile(path.join(shareDirectory, '01-hero.mp4'), 'utf8')).resolves.toBe(
      'approved-hero-card',
    );
    await expect(readFile(path.join(shareDirectory, '02-closer.mp4'), 'utf8')).resolves.toBe(
      'approved-closer-card',
    );
    expect(record).toEqual({
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-20T00:01:00.000Z',
      packageFingerprint: 'a'.repeat(64),
      directory: 'output/carousel/ready-to-share',
      cards: [
        {
          index: 0,
          clipId: 'hero',
          sourceFile: 'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4',
          file: 'output/carousel/ready-to-share/01-hero.mp4',
          checksumSha256: packageRecord.cards[0].checksumSha256,
          sizeBytes: packageRecord.cards[0].sizeBytes,
        },
        {
          index: 1,
          clipId: 'closer',
          sourceFile: 'output/carousel/aaaaaaaaaaaaaaaa/02-closer.mp4',
          file: 'output/carousel/ready-to-share/02-closer.mp4',
          checksumSha256: packageRecord.cards[1].checksumSha256,
          sizeBytes: packageRecord.cards[1].sizeBytes,
        },
      ],
    });
    await expect(
      readFile(path.join(projectPath, 'analysis/carousel-share.json'), 'utf8'),
    ).resolves.toContain('output/carousel/ready-to-share/01-hero.mp4');
  });

  it('reports a share package stale when a visible MP4 no longer matches its checksum', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-freshness-'));
    temporaryRoots.push(projectPath);
    const canonicalDirectory = path.join(projectPath, 'output/carousel/aaaaaaaaaaaaaaaa');
    await mkdir(canonicalDirectory, {recursive: true});
    await mkdir(path.join(projectPath, 'analysis'), {recursive: true});
    const canonicalFiles = [
      path.join(canonicalDirectory, '01-hero.mp4'),
      path.join(canonicalDirectory, '02-closer.mp4'),
    ];
    await writeFile(canonicalFiles[0], 'approved-hero-card');
    await writeFile(canonicalFiles[1], 'approved-closer-card');
    const packageRecord: CarouselPackageRecord = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-20T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: await Promise.all(
        [
          {index: 0, clipId: 'hero', file: canonicalFiles[0]},
          {index: 1, clipId: 'closer', file: canonicalFiles[1]},
        ].map(async ({index, clipId, file}) => ({
          index,
          clipId,
          file: `output/carousel/aaaaaaaaaaaaaaaa/${path.basename(file)}`,
          checksumSha256: await hashFile(file),
          sizeBytes: (await stat(file)).size,
          durationSeconds: 4.5,
        })),
      ),
    };
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    const readCarouselSharePackageFreshness = Reflect.get(
      shareModule,
      'readCarouselSharePackageFreshness',
    );
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    expect(readCarouselSharePackageFreshness).toEqual(expect.any(Function));
    if (
      typeof publishCarouselSharePackage !== 'function' ||
      typeof readCarouselSharePackageFreshness !== 'function'
    ) {
      return;
    }

    await publishCarouselSharePackage(projectPath, packageRecord);
    await expect(
      readCarouselSharePackageFreshness(projectPath, packageRecord),
    ).resolves.toEqual({fresh: true, reason: null});

    await writeFile(
      path.join(projectPath, 'output/carousel/ready-to-share/01-hero.mp4'),
      'tampered-visible-card',
    );
    await expect(
      readCarouselSharePackageFreshness(projectPath, packageRecord),
    ).resolves.toEqual(
      expect.objectContaining({fresh: false, reason: expect.stringMatching(/size|checksum/i)}),
    );
  });

  it('removes a previously shareable package when current carousel QC fails', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-failed-qc-'));
    temporaryRoots.push(projectPath);
    const canonicalDirectory = path.join(projectPath, 'output/carousel/aaaaaaaaaaaaaaaa');
    await mkdir(canonicalDirectory, {recursive: true});
    await mkdir(path.join(projectPath, 'analysis'), {recursive: true});
    const canonicalFiles = [
      path.join(canonicalDirectory, '01-hero.mp4'),
      path.join(canonicalDirectory, '02-closer.mp4'),
    ];
    await writeFile(canonicalFiles[0], 'approved-hero-card');
    await writeFile(canonicalFiles[1], 'approved-closer-card');
    const packageRecord: CarouselPackageRecord = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-20T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: await Promise.all(
        [
          {index: 0, clipId: 'hero', file: canonicalFiles[0]},
          {index: 1, clipId: 'closer', file: canonicalFiles[1]},
        ].map(async ({index, clipId, file}) => ({
          index,
          clipId,
          file: `output/carousel/aaaaaaaaaaaaaaaa/${path.basename(file)}`,
          checksumSha256: await hashFile(file),
          sizeBytes: (await stat(file)).size,
          durationSeconds: 4.5,
        })),
      ),
    };
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    const syncCarouselSharePackage = Reflect.get(shareModule, 'syncCarouselSharePackage');
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    expect(syncCarouselSharePackage).toEqual(expect.any(Function));
    if (
      typeof publishCarouselSharePackage !== 'function' ||
      typeof syncCarouselSharePackage !== 'function'
    ) {
      return;
    }

    await publishCarouselSharePackage(projectPath, packageRecord);
    await syncCarouselSharePackage(projectPath, packageRecord, ['hero: unreadable']);

    await expect(
      access(path.join(projectPath, 'output/carousel/ready-to-share')),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      access(path.join(projectPath, 'analysis/carousel-share.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('invalidates the previous share before carousel QC setup can fail', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-qc-start-'));
    temporaryRoots.push(projectPath);
    const {packageRecord} = await createPackageFixture(projectPath);
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    if (typeof publishCarouselSharePackage !== 'function') return;

    await publishCarouselSharePackage(projectPath, packageRecord);
    const {runCarouselQc} = await import('../../src/media/carousel-qc');

    await expect(runCarouselQc(projectPath)).rejects.toThrow(/package is missing/i);
    await expect(
      access(path.join(projectPath, 'output/carousel/ready-to-share')),
    ).rejects.toThrow(/ENOENT/);
    await expect(
      access(path.join(projectPath, 'analysis/carousel-share.json')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('requires the exact ready-to-share regular-file inventory for freshness', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-boundary-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'carousel-share-outside-'));
    temporaryRoots.push(projectPath, outsideRoot);
    const {packageRecord, canonicalFiles} = await createPackageFixture(projectPath);
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    const readCarouselSharePackageFreshness = Reflect.get(
      shareModule,
      'readCarouselSharePackageFreshness',
    );
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    expect(readCarouselSharePackageFreshness).toEqual(expect.any(Function));
    if (
      typeof publishCarouselSharePackage !== 'function' ||
      typeof readCarouselSharePackageFreshness !== 'function'
    ) {
      return;
    }

    const record = await publishCarouselSharePackage(projectPath, packageRecord);
    const shareDirectory = path.join(projectPath, 'output/carousel/ready-to-share');
    const sharedHero = path.join(shareDirectory, '01-hero.mp4');
    const extraCard = path.join(shareDirectory, '03-stale.mp4');
    await writeFile(extraCard, 'stale-card');
    await expect(
      readCarouselSharePackageFreshness(projectPath, packageRecord),
    ).resolves.toEqual(
      expect.objectContaining({fresh: false, reason: expect.stringMatching(/inventory|unexpected/i)}),
    );

    await rm(extraCard, {force: true});
    const outsideHero = path.join(outsideRoot, 'outside-hero.mp4');
    await copyFile(canonicalFiles[0], outsideHero);
    await rm(sharedHero, {force: true});
    await symlink(outsideHero, sharedHero);
    await expect(
      readCarouselSharePackageFreshness(projectPath, packageRecord),
    ).resolves.toEqual(
      expect.objectContaining({fresh: false, reason: expect.stringMatching(/real file|symlink/i)}),
    );

    await publishCarouselSharePackage(projectPath, packageRecord);
    record.cards[0].file = 'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4';
    await writeFile(
      path.join(projectPath, 'analysis/carousel-share.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );
    await expect(
      readCarouselSharePackageFreshness(projectPath, packageRecord),
    ).resolves.toEqual(
      expect.objectContaining({fresh: false, reason: expect.stringMatching(/path|ready-to-share/i)}),
    );
  });

  it('invalidates the record and orphan staging directories even when failed-QC cleanup is blocked', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-malformed-'));
    temporaryRoots.push(projectPath);
    const {packageRecord} = await createPackageFixture(projectPath);
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    const syncCarouselSharePackage = Reflect.get(shareModule, 'syncCarouselSharePackage');
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    expect(syncCarouselSharePackage).toEqual(expect.any(Function));
    if (
      typeof publishCarouselSharePackage !== 'function' ||
      typeof syncCarouselSharePackage !== 'function'
    ) {
      return;
    }

    await publishCarouselSharePackage(projectPath, packageRecord);
    const carouselRoot = path.join(projectPath, 'output/carousel');
    const shareDirectory = path.join(carouselRoot, 'ready-to-share');
    const partial = path.join(carouselRoot, '.ready-to-share.partial-123-orphan');
    const backup = path.join(carouselRoot, '.ready-to-share.backup-123-orphan');
    await rm(shareDirectory, {recursive: true, force: true});
    await writeFile(shareDirectory, 'malformed-share-path');
    await mkdir(partial);
    await mkdir(backup);

    await expect(
      syncCarouselSharePackage(projectPath, packageRecord, ['hero: unreadable']),
    ).rejects.toThrow(/boundary|real directory/i);
    await expect(access(path.join(projectPath, 'analysis/carousel-share.json'))).rejects.toThrow(
      /ENOENT/,
    );
    await expect(access(partial)).rejects.toThrow(/ENOENT/);
    await expect(access(backup)).rejects.toThrow(/ENOENT/);
    await expect(readFile(shareDirectory, 'utf8')).resolves.toBe('malformed-share-path');
  });

  it('does not remove a failed-QC record through a linked analysis directory', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-analysis-link-'));
    const externalAnalysis = await mkdtemp(path.join(tmpdir(), 'carousel-share-external-analysis-'));
    temporaryRoots.push(projectPath, externalAnalysis);
    const {packageRecord} = await createPackageFixture(projectPath);
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    const syncCarouselSharePackage = Reflect.get(shareModule, 'syncCarouselSharePackage');
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    expect(syncCarouselSharePackage).toEqual(expect.any(Function));
    if (
      typeof publishCarouselSharePackage !== 'function' ||
      typeof syncCarouselSharePackage !== 'function'
    ) {
      return;
    }

    await publishCarouselSharePackage(projectPath, packageRecord);
    await rm(path.join(projectPath, 'analysis'), {recursive: true, force: true});
    await writeFile(path.join(externalAnalysis, 'carousel-share.json'), 'external-record');
    await symlink(externalAnalysis, path.join(projectPath, 'analysis'), 'dir');

    await expect(
      syncCarouselSharePackage(projectPath, packageRecord, ['hero: unreadable']),
    ).rejects.toThrow(/analysis|boundary|real directory/i);
    await expect(readFile(path.join(externalAnalysis, 'carousel-share.json'), 'utf8')).resolves.toBe(
      'external-record',
    );
  });

  it('removes orphan partial and backup packages before successful publication', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-share-orphans-'));
    temporaryRoots.push(projectPath);
    const {packageRecord} = await createPackageFixture(projectPath);
    const carouselRoot = path.join(projectPath, 'output/carousel');
    const partial = path.join(carouselRoot, '.ready-to-share.partial-123-orphan');
    const backup = path.join(carouselRoot, '.ready-to-share.backup-123-orphan');
    await mkdir(partial);
    await mkdir(backup);
    await writeFile(path.join(partial, 'card.mp4'), 'partial');
    await writeFile(path.join(backup, 'card.mp4'), 'backup');
    const shareModule = await loadShareModule();
    const publishCarouselSharePackage = Reflect.get(
      shareModule,
      'publishCarouselSharePackage',
    );
    expect(publishCarouselSharePackage).toEqual(expect.any(Function));
    if (typeof publishCarouselSharePackage !== 'function') return;

    await publishCarouselSharePackage(projectPath, packageRecord);

    await expect(access(partial)).rejects.toThrow(/ENOENT/);
    await expect(access(backup)).rejects.toThrow(/ENOENT/);
  });
});
