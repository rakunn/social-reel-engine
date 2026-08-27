import {constants as fsConstants} from 'node:fs';
import {access, copyFile, lstat, mkdir, readdir, readFile, rm} from 'node:fs/promises';
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
import type {ArtifactIndex} from './artifacts';
import {isMediaOperationLockActive} from './operation';
import {assertProjectScaffold, createReelProject} from './workspace';

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

const cloneTree = async (source: string, target: string): Promise<number> => {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Variant source contains a symbolic link: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    await mkdir(target, {recursive: true});
    let copied = 0;
    for (const entry of await readdir(source)) {
      copied += await cloneTree(path.join(source, entry), path.join(target, entry));
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

const cloneIfPresent = async (source: string, target: string): Promise<number> =>
  (await exists(source)) ? await cloneTree(source, target) : 0;

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
    if (!record.checksums || record.files.length !== Object.keys(record.checksums).length) continue;
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
      path.join(sourcePath, 'analysis/proxies.json'),
      path.join(targetPath, 'analysis/proxies.json'),
    );
  }
  return copiedFiles;
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
  await assertProjectScaffold(sourcePath);
  if (await exists(targetPath)) {
    throw new Error(`Reel project "${safeTargetName}" already exists`);
  }
  if (await isMediaOperationLockActive(sourcePath)) {
    throw new Error('Cannot create a variant while the source project has active media work');
  }
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
    .then((status) => status.colorApproved && sourceApprovals.color ? sourceApprovals.color : null)
    .catch(() => null);
  const format = sourceBrief.projectType === 'carousel' ? 'carousel-1.91:1' : 'reel-9:16';
  let created = false;
  try {
    await createReelProject({
      engineRoot,
      projectsRoot: resolvedProjectsRoot,
      reelName: safeTargetName,
      title: title?.trim() || `${sourceBrief.identity.title} variant`,
      format,
      now,
    });
    created = true;
    let copiedFiles = 0;
    for (const relativePath of ['input', 'config']) {
      copiedFiles += await cloneTree(
        path.join(sourcePath, relativePath),
        path.join(targetPath, relativePath),
      );
    }
    for (const relativePath of ['analysis/sources.json', 'analysis/ingest.json']) {
      copiedFiles += await cloneIfPresent(
        path.join(sourcePath, relativePath),
        path.join(targetPath, relativePath),
      );
    }
    copiedFiles += await cloneValidArtifactCache(sourcePath, targetPath);

    await writeJson(
      path.join(targetPath, 'brief.json'),
      ReelBriefSchema.parse({
        ...sourceBrief,
        identity: {
          reelName: safeTargetName,
          title: title?.trim() || `${sourceBrief.identity.title} variant`,
          createdAt: now.toISOString(),
        },
        rightsConfirmed: reusableRights,
        rightsConfirmation: reusableRights ? sourceBrief.rightsConfirmation : null,
      }),
    );
    await writeJson(
      path.join(targetPath, 'edits/edit.json'),
      EditManifestSchema.parse({...sourceEdit, reelName: safeTargetName}),
    );
    await writeJson(
      path.join(targetPath, 'analysis/approvals.json'),
      ApprovalStateSchema.parse({
        schemaVersion: '1.0.0',
        edit: null,
        color: reusableColor,
      }),
    );
    if (reusableColor) {
      copiedFiles += await cloneTree(
        path.join(sourcePath, 'previews/graded-stills'),
        path.join(targetPath, 'previews/graded-stills'),
      );
      copiedFiles += await cloneTree(
        path.join(sourcePath, 'analysis/graded-stills.json'),
        path.join(targetPath, 'analysis/graded-stills.json'),
      );
    }
    if (reusableRights) {
      const targetRights = await readRightsConfirmationStatus(targetPath).catch(() => ({
        confirmed: false,
      }));
      if (!targetRights.confirmed) {
        await writeJson(
          path.join(targetPath, 'brief.json'),
          ReelBriefSchema.parse({
            ...(await readJson(path.join(targetPath, 'brief.json'), ReelBriefSchema)),
            rightsConfirmed: false,
            rightsConfirmation: null,
          }),
        );
      }
    }
    return {sourcePath, targetPath, copiedFiles};
  } catch (error) {
    if (created) await rm(targetPath, {recursive: true, force: true});
    throw error;
  }
};
