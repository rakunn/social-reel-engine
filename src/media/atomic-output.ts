import {randomUUID} from 'node:crypto';
import {mkdir, rename, unlink} from 'node:fs/promises';
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

export const writeAtomically = async <T>(
  outputPath: string,
  write: (temporaryPath: string) => Promise<T>,
  validate: (temporaryPath: string) => Promise<void> = async () => undefined,
): Promise<T> => {
  await mkdir(path.dirname(outputPath), {recursive: true});
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
