import {randomUUID} from 'node:crypto';
import {mkdir, readdir, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {
  assertPublicationGuard,
  currentPublicationOperationId,
} from '../core/publication-guard';

const temporaryOutputPath = (outputPath: string, operationId: string | null): string => {
  const extension = path.extname(outputPath);
  const filename = path.basename(outputPath, extension);
  const owner = operationId ?? 'unscoped';
  return path.join(
    path.dirname(outputPath),
    `.${filename}.partial-${owner}-${process.pid}-${randomUUID()}${extension}`,
  );
};

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const removeOrphanedPartials = async (
  outputPath: string,
  operationId: string | null,
): Promise<void> => {
  const directory = path.dirname(outputPath);
  const extension = path.extname(outputPath);
  const filename = path.basename(outputPath, extension);
  const prefix = `.${filename}.partial-`;
  const currentOperationPrefix = operationId
    ? `.${filename}.partial-${operationId}-`
    : null;
  const entries = await readdir(directory, {withFileTypes: true});
  for (const entry of entries) {
    if (
      !(entry.isFile() || entry.isSymbolicLink()) ||
      !entry.name.startsWith(prefix) ||
      !entry.name.endsWith(extension)
    ) {
      continue;
    }
    if (currentOperationPrefix && !entry.name.startsWith(currentOperationPrefix)) {
      // A different operation ID may still belong to a successor that owns this output now.
      // It remains an inert partial rather than risking destructive cross-operation cleanup.
      continue;
    }
    // A media operation can only remove another operation's partial while it still owns the
    // project lock. Rechecking immediately before unlink fences same-operation recovery.
    await assertPublicationGuard();
    await unlink(path.join(directory, entry.name));
  }
};

export const writeAtomically = async <T>(
  outputPath: string,
  write: (temporaryPath: string) => Promise<T>,
  validate: (temporaryPath: string) => Promise<void> = async () => undefined,
): Promise<T> => {
  await assertPublicationGuard();
  await mkdir(path.dirname(outputPath), {recursive: true});
  const operationId = currentPublicationOperationId();
  await removeOrphanedPartials(outputPath, operationId);
  const temporaryPath = temporaryOutputPath(outputPath, operationId);
  try {
    const result = await write(temporaryPath);
    await validate(temporaryPath);
    await assertPublicationGuard();
    await rename(temporaryPath, outputPath);
    return result;
  } catch (error) {
    await unlinkIfPresent(temporaryPath);
    throw error;
  }
};
