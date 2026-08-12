import {copyFile, link, mkdir, readdir, rm, rmdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import {hashFile} from '../core/hash';
import {assertSafeReelName, resolveInside} from '../core/paths';
import {writeAtomically} from '../media/atomic-output';

const renderFingerprintPattern = /^[a-f0-9]{16}$/;
const hardLinkFallbackCodes = new Set([
  'EACCES',
  'EMLINK',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV',
]);

const jobsRootFor = (engineRoot: string): string =>
  path.resolve(engineRoot, 'public/jobs');

const assertRenderFingerprint = (fingerprint: string): string => {
  if (!renderFingerprintPattern.test(fingerprint)) {
    throw new Error(`Invalid render-stage fingerprint: ${fingerprint}`);
  }
  return fingerprint;
};

const exactRenderStage = (
  engineRoot: string,
  stageRoot: string,
): {stageRoot: string; reelRoot: string; reelName: string} => {
  const jobsRoot = jobsRootFor(engineRoot);
  const resolvedStage = path.resolve(stageRoot);
  const relative = path.relative(jobsRoot, resolvedStage);
  const segments = relative.split(path.sep);
  if (
    path.isAbsolute(relative) ||
    segments.length !== 2 ||
    segments.some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`Refusing to remove non-stage path outside public/jobs/<reel>/<fingerprint>: ${stageRoot}`);
  }
  const [reelName, fingerprint] = segments;
  assertSafeReelName(reelName);
  assertRenderFingerprint(fingerprint);
  return {
    stageRoot: resolvedStage,
    reelRoot: path.join(jobsRoot, reelName),
    reelName,
  };
};

export const renderStageRoot = (
  engineRoot: string,
  reelName: string,
  fingerprint: string,
): string =>
  path.join(
    jobsRootFor(engineRoot),
    assertSafeReelName(reelName),
    assertRenderFingerprint(fingerprint),
  );

export const removeRenderStage = async (
  engineRoot: string,
  stageRoot: string,
): Promise<void> => {
  const validated = exactRenderStage(engineRoot, stageRoot);
  await rm(validated.stageRoot, {recursive: true, force: true});
  try {
    await rmdir(validated.reelRoot);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
  }
};

export const pruneRenderStages = async (
  engineRoot: string,
  reelName: string,
  keepStageRoot?: string,
): Promise<void> => {
  const safeReelName = assertSafeReelName(reelName);
  const reelRoot = path.join(jobsRootFor(engineRoot), safeReelName);
  const keep =
    keepStageRoot === undefined ? null : exactRenderStage(engineRoot, keepStageRoot);
  if (keep !== null && keep.reelName !== safeReelName) {
    throw new Error(`Render stage ${keepStageRoot} does not belong to reel ${safeReelName}`);
  }
  let entries;
  try {
    entries = await readdir(reelRoot, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          renderFingerprintPattern.test(entry.name) &&
          path.join(reelRoot, entry.name) !== keep?.stageRoot,
      )
      .map(async (entry) => {
        await removeRenderStage(engineRoot, path.join(reelRoot, entry.name));
      }),
  );
};

const fileChecksumIfPresent = async (filePath: string): Promise<string | null> => {
  try {
    return await hashFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const linkOrCopy = async (source: string, target: string): Promise<void> => {
  try {
    await link(source, target);
  } catch (error) {
    if (!hardLinkFallbackCodes.has((error as NodeJS.ErrnoException).code ?? '')) {
      throw error;
    }
    await copyFile(source, target);
  }
};

export const stageImmutableFile = async (
  source: string,
  stageRoot: string,
  relativeTarget: string,
  sourceChecksumSha256?: string,
): Promise<string> => {
  const target = resolveInside(stageRoot, relativeTarget);
  await mkdir(path.dirname(target), {recursive: true});
  const checksumSha256 = sourceChecksumSha256 ?? (await hashFile(source));
  if ((await fileChecksumIfPresent(target)) !== checksumSha256) {
    await writeAtomically(
      target,
      async (temporaryOutput) => {
        await linkOrCopy(source, temporaryOutput);
      },
      async (temporaryOutput) => {
        if ((await hashFile(temporaryOutput)) !== checksumSha256) {
          throw new Error(`Staged file checksum does not match source: ${relativeTarget}`);
        }
      },
    );
  }
  return relativeTarget.split(path.sep).join('/');
};

export const withDisposableRenderStage = async <T>(
  engineRoot: string,
  stageRoot: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await removeRenderStage(engineRoot, stageRoot);
  } catch (cleanupError) {
    if (operationError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        'Render failed and its disposable stage could not be removed',
      );
    }
    throw cleanupError;
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
};

export const rawRenderOutputPath = (
  projectPath: string,
  target: 'preview' | 'master',
): string =>
  path.join(
    projectPath,
    'work/render',
    target === 'preview' ? 'preview-remotion.mp4' : 'master-remotion.mov',
  );

export const removePublishedRawRender = async (
  projectPath: string,
  rawOutput: string,
): Promise<void> => {
  const rawRoot = path.resolve(projectPath, 'work/render');
  const resolved = path.resolve(rawOutput);
  const allowed = new Set([
    path.join(rawRoot, 'preview-remotion.mp4'),
    path.join(rawRoot, 'master-remotion.mov'),
  ]);
  if (!allowed.has(resolved)) {
    throw new Error(`Refusing to remove non-render scratch output: ${rawOutput}`);
  }
  try {
    await unlink(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};
