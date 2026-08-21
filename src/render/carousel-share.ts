import {randomUUID} from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {assertPublicationGuard} from '../core/publication-guard';
import {
  carouselCardFilename,
  type CarouselPackageRecord,
  type CarouselPackageFreshness,
} from './carousel';

export const CAROUSEL_SHARE_DIRECTORY = 'output/carousel/ready-to-share';

const CAROUSEL_SHARE_PARTIAL_PREFIX = '.ready-to-share.partial-';
const CAROUSEL_SHARE_BACKUP_PREFIX = '.ready-to-share.backup-';

export const CarouselSharePackageRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    generatedAt: z.string().datetime({offset: true}),
    packageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    directory: z.literal(CAROUSEL_SHARE_DIRECTORY),
    cards: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        clipId: z.string().min(1),
        sourceFile: z.string().min(1),
        file: z.string().min(1),
        checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().nonnegative(),
      }),
    ).min(2),
  })
  .strict();

export type CarouselSharePackageRecord = z.infer<
  typeof CarouselSharePackageRecordSchema
>;

export const readCarouselSharePackageRecord = async (
  projectPath: string,
): Promise<CarouselSharePackageRecord | null> => {
  try {
    return await readJson(
      path.join(projectPath, 'analysis/carousel-share.json'),
      CarouselSharePackageRecordSchema,
    );
  } catch {
    return null;
  }
};

export const readCarouselSharePackageFreshness = async (
  projectPath: string,
  packageRecord: CarouselPackageRecord,
): Promise<CarouselPackageFreshness> => {
  const shareRecord = await readCarouselSharePackageRecord(projectPath);
  if (!shareRecord) return {fresh: false, reason: 'No ready-to-share package record exists'};
  if (shareRecord.packageFingerprint !== packageRecord.fingerprint) {
    return {fresh: false, reason: 'Ready-to-share fingerprint does not match the carousel package'};
  }
  if (shareRecord.cards.length !== packageRecord.cards.length) {
    return {fresh: false, reason: 'Ready-to-share card count does not match the carousel package'};
  }

  const projectRoot = path.resolve(projectPath);
  const shareDirectory = path.join(projectRoot, CAROUSEL_SHARE_DIRECTORY);
  let realShareDirectory: string;
  try {
    const realProjectRoot = await realpath(projectRoot);
    const directoryBoundaries = [
      ['output', path.join(projectRoot, 'output')],
      ['output/carousel', path.join(projectRoot, 'output/carousel')],
      [CAROUSEL_SHARE_DIRECTORY, shareDirectory],
    ] as const;
    for (const [relativeDirectory, directory] of directoryBoundaries) {
      const directoryStats = await lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        return {
          fresh: false,
          reason: `Ready-to-share boundary is not a real directory: ${relativeDirectory}`,
        };
      }
      if ((await realpath(directory)) !== path.join(realProjectRoot, relativeDirectory)) {
        return {
          fresh: false,
          reason: `Ready-to-share boundary resolves outside the project: ${relativeDirectory}`,
        };
      }
    }
    realShareDirectory = await realpath(shareDirectory);
  } catch {
    return {fresh: false, reason: 'Ready-to-share directory is missing'};
  }

  const expectedFilenames = shareRecord.cards.map((card) =>
    carouselCardFilename(card.index, card.clipId),
  );
  try {
    const entries = await readdir(shareDirectory, {withFileTypes: true});
    const observedFilenames = entries.map((entry) => entry.name).sort();
    const sortedExpectedFilenames = [...expectedFilenames].sort();
    if (
      observedFilenames.length !== sortedExpectedFilenames.length ||
      observedFilenames.some((filename, index) => filename !== sortedExpectedFilenames[index])
    ) {
      return {fresh: false, reason: 'Ready-to-share file inventory does not match its record'};
    }
  } catch {
    return {fresh: false, reason: 'Ready-to-share file inventory cannot be read'};
  }

  for (const [index, card] of shareRecord.cards.entries()) {
    const canonicalCard = packageRecord.cards[index];
    const filename = expectedFilenames[index];
    const expectedCardFile = `${CAROUSEL_SHARE_DIRECTORY}/${filename}`;
    if (
      card.index !== canonicalCard?.index ||
      card.clipId !== canonicalCard.clipId ||
      card.sourceFile !== canonicalCard.file ||
      card.file !== expectedCardFile ||
      card.checksumSha256 !== canonicalCard.checksumSha256 ||
      card.sizeBytes !== canonicalCard.sizeBytes
    ) {
      return {fresh: false, reason: `Ready-to-share card does not match its package: ${card.file}`};
    }
    try {
      const sharedPath = path.join(shareDirectory, filename);
      const sharedStats = await lstat(sharedPath);
      if (!sharedStats.isFile() || sharedStats.isSymbolicLink()) {
        return {fresh: false, reason: `Ready-to-share card is not a real file: ${card.file}`};
      }
      if ((await realpath(sharedPath)) !== path.join(realShareDirectory, filename)) {
        return {fresh: false, reason: `Ready-to-share card resolves outside its directory: ${card.file}`};
      }
      if (sharedStats.size !== card.sizeBytes) {
        return {fresh: false, reason: `Ready-to-share card size does not match: ${card.file}`};
      }
      if ((await hashFile(sharedPath)) !== card.checksumSha256) {
        return {
          fresh: false,
          reason: `Ready-to-share card checksum does not match: ${card.file}`,
        };
      }
    } catch {
      return {fresh: false, reason: `Ready-to-share card is missing: ${card.file}`};
    }
  }
  return {fresh: true, reason: null};
};

const ensureRealDirectory = async (
  directory: string,
  expectedRealPath: string,
): Promise<string> => {
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Carousel share publication boundary is not a real directory: ${directory}`);
  }
  const observedRealPath = await realpath(directory);
  if (observedRealPath !== expectedRealPath) {
    throw new Error(`Carousel share publication boundary resolves outside the project: ${directory}`);
  }
  return observedRealPath;
};

const ensureCarouselRoot = async (projectPath: string): Promise<{
  carouselRoot: string;
  realProjectRoot: string;
  realCarouselRoot: string;
}> => {
  const projectRoot = path.resolve(projectPath);
  const realProjectRoot = await realpath(projectRoot);
  const outputRoot = path.join(projectRoot, 'output');
  const realOutputRoot = await ensureRealDirectory(
    outputRoot,
    path.join(realProjectRoot, 'output'),
  );
  const carouselRoot = path.join(outputRoot, 'carousel');
  const realCarouselRoot = await ensureRealDirectory(
    carouselRoot,
    path.join(realOutputRoot, 'carousel'),
  );
  return {carouselRoot, realProjectRoot, realCarouselRoot};
};

const ensureAnalysisRoot = async (
  projectPath: string,
  realProjectRoot: string,
): Promise<string> => {
  const analysisRoot = path.join(path.resolve(projectPath), 'analysis');
  await ensureRealDirectory(analysisRoot, path.join(realProjectRoot, 'analysis'));
  return analysisRoot;
};

const removeCarouselShareOrphans = async (
  carouselRoot: string,
  realCarouselRoot: string,
): Promise<void> => {
  const entries = await readdir(carouselRoot, {withFileTypes: true});
  for (const entry of entries) {
    if (
      !entry.name.startsWith(CAROUSEL_SHARE_PARTIAL_PREFIX) &&
      !entry.name.startsWith(CAROUSEL_SHARE_BACKUP_PREFIX)
    ) {
      continue;
    }
    const orphanPath = path.join(carouselRoot, entry.name);
    const orphanStats = await lstat(orphanPath);
    if (orphanStats.isDirectory() && !orphanStats.isSymbolicLink()) {
      if ((await realpath(orphanPath)) !== path.join(realCarouselRoot, entry.name)) {
        throw new Error(`Carousel share orphan resolves outside the project: ${orphanPath}`);
      }
      await assertPublicationGuard();
      await rm(orphanPath, {recursive: true, force: true});
      continue;
    }
    await assertPublicationGuard();
    await rm(orphanPath, {force: true});
  }
};

const assertCanonicalCard = async (
  projectPath: string,
  realProjectRoot: string,
  card: CarouselPackageRecord['cards'][number],
): Promise<string> => {
  const sourcePath = resolveInside(projectPath, card.file);
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error(`Carousel share source is not a real file: ${card.file}`);
  }
  const realSourcePath = await realpath(sourcePath);
  if (!realSourcePath.startsWith(`${realProjectRoot}${path.sep}`)) {
    throw new Error(`Carousel share source resolves outside the project: ${card.file}`);
  }
  if (sourceStats.size !== card.sizeBytes || (await hashFile(sourcePath)) !== card.checksumSha256) {
    throw new Error(`Carousel share source does not match its package record: ${card.file}`);
  }
  return sourcePath;
};

const replaceShareDirectory = async (
  carouselRoot: string,
  stagedDirectory: string,
): Promise<void> => {
  const shareDirectory = path.join(carouselRoot, 'ready-to-share');
  const backupDirectory = path.join(
    carouselRoot,
    `.ready-to-share.backup-${process.pid}-${randomUUID()}`,
  );
  let movedExisting = false;
  try {
    const existing = await lstat(shareDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(
          `Carousel share publication boundary is not a real directory: ${shareDirectory}`,
        );
      }
      await assertPublicationGuard();
      await rename(shareDirectory, backupDirectory);
      movedExisting = true;
    }
    try {
      await assertPublicationGuard();
      await rename(stagedDirectory, shareDirectory);
    } catch (error) {
      if (movedExisting) await rename(backupDirectory, shareDirectory);
      throw error;
    }
    if (movedExisting) await rm(backupDirectory, {recursive: true, force: true});
  } catch (error) {
    await rm(stagedDirectory, {recursive: true, force: true});
    throw error;
  }
};

export const publishCarouselSharePackage = async (
  projectPath: string,
  packageRecord: CarouselPackageRecord,
  now = new Date(),
): Promise<CarouselSharePackageRecord> => {
  const {carouselRoot, realProjectRoot, realCarouselRoot} = await ensureCarouselRoot(projectPath);
  const analysisRoot = await ensureAnalysisRoot(projectPath, realProjectRoot);
  await removeCarouselShareOrphans(carouselRoot, realCarouselRoot);
  const stagedDirectory = await mkdtemp(
    path.join(carouselRoot, `.ready-to-share.partial-${process.pid}-`),
  );
  const cards: CarouselSharePackageRecord['cards'] = [];
  try {
    for (const card of packageRecord.cards) {
      const sourcePath = await assertCanonicalCard(projectPath, realProjectRoot, card);
      const filename = carouselCardFilename(card.index, card.clipId);
      const stagedFile = path.join(stagedDirectory, filename);
      await copyFile(sourcePath, stagedFile);
      const stagedStats = await stat(stagedFile);
      const stagedChecksum = await hashFile(stagedFile);
      if (stagedStats.size !== card.sizeBytes || stagedChecksum !== card.checksumSha256) {
        throw new Error(`Carousel share copy does not match its package record: ${card.file}`);
      }
      cards.push({
        index: card.index,
        clipId: card.clipId,
        sourceFile: card.file,
        file: `${CAROUSEL_SHARE_DIRECTORY}/${filename}`,
        checksumSha256: stagedChecksum,
        sizeBytes: stagedStats.size,
      });
    }
    await replaceShareDirectory(carouselRoot, stagedDirectory);
  } catch (error) {
    await rm(stagedDirectory, {recursive: true, force: true});
    throw error;
  }

  const record = CarouselSharePackageRecordSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    packageFingerprint: packageRecord.fingerprint,
    directory: CAROUSEL_SHARE_DIRECTORY,
    cards,
  });
  await writeJson(path.join(analysisRoot, 'carousel-share.json'), record);
  return record;
};

const clearCarouselSharePackage = async (projectPath: string): Promise<void> => {
  const {carouselRoot, realProjectRoot, realCarouselRoot} = await ensureCarouselRoot(projectPath);
  const analysisRoot = await ensureAnalysisRoot(projectPath, realProjectRoot);
  await assertPublicationGuard();
  await rm(path.join(analysisRoot, 'carousel-share.json'), {force: true});
  await removeCarouselShareOrphans(carouselRoot, realCarouselRoot);
  const shareDirectory = path.join(carouselRoot, 'ready-to-share');
  const existing = await lstat(shareDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(
        `Carousel share publication boundary is not a real directory: ${shareDirectory}`,
      );
    }
    await assertPublicationGuard();
    await rm(shareDirectory, {recursive: true, force: true});
  }
};

export const syncCarouselSharePackage = async (
  projectPath: string,
  packageRecord: CarouselPackageRecord,
  qcFailures: readonly string[],
  now = new Date(),
): Promise<CarouselSharePackageRecord | null> => {
  if (qcFailures.length > 0) {
    await clearCarouselSharePackage(projectPath);
    return null;
  }
  return await publishCarouselSharePackage(projectPath, packageRecord, now);
};
