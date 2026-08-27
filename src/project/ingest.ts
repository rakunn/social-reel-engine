import {constants as fsConstants} from 'node:fs';
import {copyFile, mkdir, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {hashFile} from '../core/hash';
import {writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {runWithStatusScanLock} from './operation';

export const INPUT_KINDS = [
  'clips',
  'music',
  'captions',
  'technical-lut',
  'creative-lut',
  'fonts',
  'brand',
] as const;

export type InputKind = (typeof INPUT_KINDS)[number];

const kindDirectory: Record<InputKind, string> = {
  clips: 'input/clips',
  music: 'input/music',
  captions: 'input/captions',
  'technical-lut': 'input/luts/technical',
  'creative-lut': 'input/luts/creative',
  fonts: 'input/fonts',
  brand: 'input/brand',
};

const ignoredInputNames = new Set([
  '.gitkeep',
  'README.md',
  '.DS_Store',
  '.localized',
  'Thumbs.db',
  'desktop.ini',
]);

const ignoredInputDirectories = new Set([
  '__MACOSX',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
]);

export type IngestManifest = {
  schemaVersion: '1.0.0';
  generatedAt: string;
  files: Array<{
    relativePath: string;
    kind: InputKind;
    checksumSha256: string;
    sizeBytes: number;
  }>;
};

const walkFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {withFileTypes: true});
  const paths = await Promise.all(
    entries.map(async (entry) => {
      if (
        ignoredInputNames.has(entry.name) ||
        entry.name.startsWith('._') ||
        (entry.isDirectory() && ignoredInputDirectories.has(entry.name))
      ) {
        return [];
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await walkFiles(entryPath);
      }
      return [entryPath];
    }),
  );
  return paths.flat();
};

export const scanInputs = async (
  projectPath: string,
  now = new Date(),
): Promise<IngestManifest> => {
  const files: IngestManifest['files'] = [];
  for (const kind of INPUT_KINDS) {
    const directory = resolveInside(projectPath, kindDirectory[kind]);
    for (const filePath of await walkFiles(directory)) {
      const fileStat = await stat(filePath);
      files.push({
        relativePath: path.relative(projectPath, filePath).split(path.sep).join('/'),
        kind,
        checksumSha256: await hashFile(filePath),
        sizeBytes: fileStat.size,
      });
    }
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {schemaVersion: '1.0.0', generatedAt: now.toISOString(), files};
};

const ingestFilesWithLock = async (
  projectPath: string,
  sourcePaths: readonly string[],
  kind: InputKind,
): Promise<{added: string[]; unchanged: string[]}> => {
  if (!INPUT_KINDS.includes(kind)) {
    throw new Error(`Unsupported input kind "${kind}"`);
  }
  const targetDirectory = resolveInside(projectPath, kindDirectory[kind]);
  await mkdir(targetDirectory, {recursive: true});
  const added: string[] = [];
  const unchanged: string[] = [];

  for (const sourcePath of sourcePaths) {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`Input is not a regular file: ${sourcePath}`);
    }
    const targetPath = path.join(targetDirectory, path.basename(sourcePath));
    const relativePath = path.relative(projectPath, targetPath).split(path.sep).join('/');
    const sourceHash = await hashFile(sourcePath);
    try {
      await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
      const copiedHash = await hashFile(targetPath);
      if (copiedHash !== sourceHash) {
        throw new Error(`Checksum verification failed after copying ${sourcePath}`);
      }
      added.push(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existingHash = await hashFile(targetPath);
      if (existingHash !== sourceHash) {
        throw new Error(`Refusing to overwrite existing input ${relativePath} with different bytes`);
      }
      unchanged.push(relativePath);
    }
  }

  const manifest = await scanInputs(projectPath);
  await writeJson(path.join(projectPath, 'analysis/ingest.json'), manifest);
  return {added, unchanged};
};

export const ingestFiles = async (
  projectPath: string,
  sourcePaths: readonly string[],
  kind: InputKind,
): Promise<{added: string[]; unchanged: string[]}> => {
  const result = await runWithStatusScanLock(
    projectPath,
    async () => await ingestFilesWithLock(projectPath, sourcePaths, kind),
  );
  if (!result.acquired) {
    throw new Error('Cannot ingest while a project snapshot, status scan, or media work is active');
  }
  return result.value;
};
