import {randomUUID} from 'node:crypto';
import {mkdir, readdir, rename, unlink} from 'node:fs/promises';
import path from 'node:path';

const temporaryOutputPath = (outputPath: string): string => {
  const extension = path.extname(outputPath);
  const filename = path.basename(outputPath, extension);
  return path.join(
    path.dirname(outputPath),
    `.${filename}.partial-${process.pid}-${randomUUID()}${extension}`,
  );
};

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const removeOrphanedPartials = async (outputPath: string): Promise<void> => {
  const directory = path.dirname(outputPath);
  const extension = path.extname(outputPath);
  const filename = path.basename(outputPath, extension);
  const prefix = `.${filename}.partial-`;
  const entries = await readdir(directory, {withFileTypes: true});
  await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(extension),
      )
      .map(async (entry) => await unlink(path.join(directory, entry.name))),
  );
};

export const writeAtomically = async <T>(
  outputPath: string,
  write: (temporaryPath: string) => Promise<T>,
  validate: (temporaryPath: string) => Promise<void> = async () => undefined,
): Promise<T> => {
  await mkdir(path.dirname(outputPath), {recursive: true});
  await removeOrphanedPartials(outputPath);
  const temporaryPath = temporaryOutputPath(outputPath);
  try {
    const result = await write(temporaryPath);
    await validate(temporaryPath);
    await rename(temporaryPath, outputPath);
    return result;
  } catch (error) {
    await unlinkIfPresent(temporaryPath);
    throw error;
  }
};
