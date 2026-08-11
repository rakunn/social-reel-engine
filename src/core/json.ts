import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {ZodType} from 'zod';
import {assertPublicationGuard} from './publication-guard';

export const readJson = async <T>(filePath: string, schema?: ZodType<T>): Promise<T> => {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return schema ? schema.parse(parsed) : (parsed as T);
};

export const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await assertPublicationGuard();
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await assertPublicationGuard();
    await rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
};
