import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {ZodType} from 'zod';

export const readJson = async <T>(filePath: string, schema?: ZodType<T>): Promise<T> => {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  return schema ? schema.parse(parsed) : (parsed as T);
};

export const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
};
