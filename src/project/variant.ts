import {createHash} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  ReelBriefSchema,
} from '../contracts/schemas';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {assertSafeReelName, resolveInside} from '../core/paths';
import {readApprovalStatus} from '../edit/approve';
import {readRightsConfirmationStatus} from '../edit/rights';
import type {GradedClipReport} from '../media/grade';
import {readValidatedSourceManifest} from '../media/source-integrity';
import type {ArtifactIndex} from './artifacts';
import {runWithStatusScanLock} from './operation';
import {
  acquireProjectNameReservation,
  assertProjectScaffold,
  createReelProject,
} from './workspace';

export type CreateProjectVariantOptions = {
  engineRoot: string;
  projectsRoot?: string;
  sourceName: string;
  targetName: string;
  title?: string;
  now?: Date;
};

export type ProjectVariantResult = {
  sourcePath: string;
  targetPath: string;
  copiedFiles: number;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const MAX_PATH_COMPONENT_BYTES = 255;
const MKDTEMP_RANDOM_SUFFIX_BYTES = 6;

const variantStagingPrefix = (projectsRoot: string, targetName: string): string => {
  const readablePrefix = `.variant-${targetName}.partial-`;
  const basename =
    Buffer.byteLength(readablePrefix) <=
    MAX_PATH_COMPONENT_BYTES - MKDTEMP_RANDOM_SUFFIX_BYTES
      ? readablePrefix
      : `.variant-${createHash('sha256').update(targetName).digest('hex')}.partial-`;
  return path.join(projectsRoot, basename);
};

const assertNoSymbolicLinks = async (sourceRoot: string, source: string): Promise<void> => {
  const resolvedRoot = path.resolve(sourceRoot);
  const resolvedSource = path.resolve(source);
  const relativePath = path.relative(resolvedRoot, resolvedSource);
  if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error(`Variant source escaped its project: ${source}`);
  }
  let currentPath = resolvedRoot;
  const paths = [currentPath];
  if (relativePath) {
    for (const segment of relativePath.split(path.sep)) {
      currentPath = path.join(currentPath, segment);
      paths.push(currentPath);
    }
  }
  for (const candidatePath of paths) {
    if ((await lstat(candidatePath)).isSymbolicLink()) {
      throw new Error(`Variant source contains a symbolic link: ${candidatePath}`);
    }
  }
};

const cloneTree = async (
  sourceRoot: string,
  source: string,
  target: string,
): Promise<number> => {
  await assertNoSymbolicLinks(sourceRoot, source);
  const sourceStat = await lstat(source);
  if (sourceStat.isDirectory()) {
    await mkdir(target, {recursive: true});
    let copied = 0;
    for (const entry of await readdir(source)) {
      copied += await cloneTree(
        sourceRoot,
        path.join(source, entry),
        path.join(target, entry),
      );
    }
    return copied;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Variant source contains a non-regular file: ${source}`);
  }
  await mkdir(path.dirname(target), {recursive: true});
  await copyFile(source, target, fsConstants.COPYFILE_FICLONE);
  return 1;
};

const assertTreeContainsNoSymbolicLinks = async (
  sourceRoot: string,
  source: string,
): Promise<void> => {
  await assertNoSymbolicLinks(sourceRoot, source);
  const sourceStat = await lstat(source);
  if (sourceStat.isDirectory()) {
    for (const entry of await readdir(source)) {
      await assertTreeContainsNoSymbolicLinks(sourceRoot, path.join(source, entry));
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Variant source contains a non-regular file: ${source}`);
  }
};

const assertReadTreesContainNoSymbolicLinks = async (sourcePath: string): Promise<void> => {
  for (const relativePath of [
    'brief.json',
    'edits',
    'input',
    'config',
    'analysis',
    'previews/graded-stills',
    'work/graded',
  ]) {
    const source = path.join(sourcePath, relativePath);
    if (await exists(source)) {
      await assertTreeContainsNoSymbolicLinks(sourcePath, source);
    }
  }
};

const cloneIfPresent = async (
  sourceRoot: string,
  source: string,
  target: string,
): Promise<number> => (await exists(source)) ? await cloneTree(sourceRoot, source, target) : 0;

const reusableArtifactDirectories = new Set([
  'work/proxies',
  'analysis/frames',
  'analysis/contact-sheets',
]);

const isReusableArtifactPath = (relativePath: string): boolean =>
  relativePath === path.posix.normalize(relativePath) &&
  !relativePath.includes('\\') &&
  reusableArtifactDirectories.has(path.posix.dirname(relativePath));

const cloneValidArtifactCache = async (
  sourcePath: string,
  targetPath: string,
): Promise<number> => {
  let sourceIndex: ArtifactIndex;
  try {
    sourceIndex = await readJson<ArtifactIndex>(path.join(sourcePath, 'analysis/artifacts.json'));
  } catch {
    return 0;
  }
  const artifacts: ArtifactIndex['artifacts'] = {};
  let copiedFiles = 0;
  for (const [key, record] of Object.entries(sourceIndex.artifacts)) {
    if (
      !record.checksums ||
      record.files.length === 0 ||
      record.files.length !== Object.keys(record.checksums).length
    ) {
      continue;
    }
    if (!record.files.every(isReusableArtifactPath)) continue;
    let valid = true;
    for (const relativePath of record.files) {
      const expectedChecksum = record.checksums[relativePath];
      if (!expectedChecksum) {
        valid = false;
        break;
      }
      try {
        if ((await hashFile(resolveInside(sourcePath, relativePath))) !== expectedChecksum) {
          valid = false;
          break;
        }
      } catch {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    for (const relativePath of record.files) {
      copiedFiles += await cloneTree(
        sourcePath,
        resolveInside(sourcePath, relativePath),
        resolveInside(targetPath, relativePath),
      );
    }
    artifacts[key] = record;
  }
  if (Object.keys(artifacts).length > 0) {
    await writeJson(path.join(targetPath, 'analysis/artifacts.json'), {
      schemaVersion: '1.0.0',
      artifacts,
    } satisfies ArtifactIndex);
    copiedFiles += await cloneIfPresent(
      sourcePath,
      path.join(sourcePath, 'analysis/proxies.json'),
      path.join(targetPath, 'analysis/proxies.json'),
    );
  }
  return copiedFiles;
};

const cloneValidGradedClipCache = async (
  sourcePath: string,
  targetPath: string,
): Promise<number> => {
  let report: GradedClipReport;
  try {
    report = await readJson<GradedClipReport>(
      path.join(sourcePath, 'analysis/graded-clips.json'),
    );
  } catch {
    return 0;
  }
  if (report.schemaVersion !== '1.0.0' || !Array.isArray(report.items)) return 0;

  const validItems: GradedClipReport['items'] = [];
  let copiedFiles = 0;
  for (const item of report.items) {
    if (
      !item ||
      typeof item.path !== 'string' ||
      path.posix.dirname(item.path) !== 'work/graded' ||
      !item.path.toLowerCase().endsWith('.mov') ||
      !/^[a-f0-9]{64}$/.test(item.checksumSha256)
    ) {
      continue;
    }
    const sourceFile = resolveInside(sourcePath, item.path);
    try {
      if ((await hashFile(sourceFile)) !== item.checksumSha256) continue;
    } catch {
      continue;
    }
    copiedFiles += await cloneTree(
      sourcePath,
      sourceFile,
      resolveInside(targetPath, item.path),
    );
    validItems.push(item);
  }
  if (validItems.length === 0) return 0;
  await writeJson(path.join(targetPath, 'analysis/graded-clips.json'), {
    ...report,
    items: validItems,
  } satisfies GradedClipReport);
  return copiedFiles + 1;
};

export const createProjectVariant = async ({
  engineRoot,
  projectsRoot = path.join(engineRoot, 'projects'),
  sourceName,
  targetName,
  title,
  now = new Date(),
}: CreateProjectVariantOptions): Promise<ProjectVariantResult> => {
  const safeSourceName = assertSafeReelName(sourceName);
  const safeTargetName = assertSafeReelName(targetName);
  if (safeSourceName === safeTargetName) {
    throw new Error('Variant source and target names must be different');
  }
  const resolvedProjectsRoot = path.resolve(projectsRoot);
  const sourcePath = path.join(resolvedProjectsRoot, safeSourceName);
  const targetPath = path.join(resolvedProjectsRoot, safeTargetName);
  const sourceReservation = await acquireProjectNameReservation(
    resolvedProjectsRoot,
    safeSourceName,
  );
  try {
    await assertProjectScaffold(sourcePath);
    await assertNoSymbolicLinks(sourcePath, sourcePath);
    await assertNoSymbolicLinks(sourcePath, path.join(sourcePath, 'analysis'));
    const targetReservation = await acquireProjectNameReservation(
      resolvedProjectsRoot,
      safeTargetName,
    );
    try {
      if (await exists(targetPath)) {
        throw new Error(`Reel project "${safeTargetName}" already exists`);
      }
      const snapshot = await runWithStatusScanLock(sourcePath, async () => {
    await assertReadTreesContainNoSymbolicLinks(sourcePath);
    await readValidatedSourceManifest(sourcePath);
    const stagingRoot = await mkdtemp(
      variantStagingPrefix(resolvedProjectsRoot, safeTargetName),
    );
    const stagedProjectPath = path.join(stagingRoot, safeTargetName);
    try {
      const sourceBrief = await readJson(path.join(sourcePath, 'brief.json'), ReelBriefSchema);
      const sourceEdit = await readJson(path.join(sourcePath, 'edits/edit.json'), EditManifestSchema);
      const sourceApprovals = await readJson(
        path.join(sourcePath, 'analysis/approvals.json'),
        ApprovalStateSchema,
      );
      const reusableRights = await readRightsConfirmationStatus(sourcePath)
        .then((status) => status.confirmed)
        .catch(() => false);
      const reusableColor = await readApprovalStatus(sourcePath)
        .then((status) =>
          status.colorApproved && sourceApprovals.color ? sourceApprovals.color : null,
        )
        .catch(() => null);
      const format =
        sourceBrief.projectType === 'carousel' ? 'carousel-1.91:1' : 'reel-9:16';
      const titleSuffix = ' variant';
      const variantTitle =
        title?.trim() ||
        `${sourceBrief.identity.title.slice(0, 160 - titleSuffix.length).trimEnd()}${titleSuffix}`;
      await createReelProject({
        engineRoot,
        projectsRoot: stagingRoot,
        reelName: safeTargetName,
        title: variantTitle,
        format,
        now,
      });
      let copiedFiles = 0;
      for (const relativePath of ['input', 'config']) {
        copiedFiles += await cloneTree(
          sourcePath,
          path.join(sourcePath, relativePath),
          path.join(stagedProjectPath, relativePath),
        );
      }
      for (const relativePath of [
        'analysis/sources.json',
        'analysis/ingest.json',
        'analysis/beats.json',
      ]) {
        copiedFiles += await cloneIfPresent(
          sourcePath,
          path.join(sourcePath, relativePath),
          path.join(stagedProjectPath, relativePath),
        );
      }
      copiedFiles += await cloneValidArtifactCache(sourcePath, stagedProjectPath);
      copiedFiles += await cloneValidGradedClipCache(sourcePath, stagedProjectPath);

      await writeJson(
        path.join(stagedProjectPath, 'brief.json'),
        ReelBriefSchema.parse({
          ...sourceBrief,
          identity: {
            reelName: safeTargetName,
            title: variantTitle,
            createdAt: now.toISOString(),
          },
          rightsConfirmed: reusableRights,
          rightsConfirmation: reusableRights ? sourceBrief.rightsConfirmation : null,
        }),
      );
      await writeJson(
        path.join(stagedProjectPath, 'edits/edit.json'),
        EditManifestSchema.parse({...sourceEdit, reelName: safeTargetName}),
      );
      await writeJson(
        path.join(stagedProjectPath, 'analysis/approvals.json'),
        ApprovalStateSchema.parse({
          schemaVersion: '1.0.0',
          edit: null,
          color: reusableColor,
        }),
      );
      if (reusableColor) {
        copiedFiles += await cloneTree(
          sourcePath,
          path.join(sourcePath, 'previews/graded-stills'),
          path.join(stagedProjectPath, 'previews/graded-stills'),
        );
        copiedFiles += await cloneTree(
          sourcePath,
          path.join(sourcePath, 'analysis/graded-stills.json'),
          path.join(stagedProjectPath, 'analysis/graded-stills.json'),
        );
      }
      if (reusableRights) {
        const targetRights = await readRightsConfirmationStatus(stagedProjectPath).catch(() => ({
          confirmed: false,
        }));
        if (!targetRights.confirmed) {
          await writeJson(
            path.join(stagedProjectPath, 'brief.json'),
            ReelBriefSchema.parse({
              ...(await readJson(path.join(stagedProjectPath, 'brief.json'), ReelBriefSchema)),
              rightsConfirmed: false,
              rightsConfirmation: null,
            }),
          );
        }
      }
      if (await exists(targetPath)) {
        throw new Error(`Reel project "${safeTargetName}" already exists`);
      }
      await targetReservation.assertOwnership();
      await rename(stagedProjectPath, targetPath);
      await rm(stagingRoot, {recursive: true, force: true}).catch(() => undefined);
      return {sourcePath, targetPath, copiedFiles};
    } catch (error) {
      await rm(stagingRoot, {recursive: true, force: true});
      throw error;
    }
    });
      if (!snapshot.acquired) {
        throw new Error('Cannot create a variant while the source project has active media work');
      }
      return snapshot.value;
    } finally {
      await targetReservation.release();
    }
  } finally {
    await sourceReservation.release();
  }
};
