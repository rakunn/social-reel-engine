import {mkdir, readdir} from 'node:fs/promises';
import path from 'node:path';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {runProcess} from './process';

export type BeatAnalysis = {
  schemaVersion: '1.0.0';
  generatedAt: string;
  relativePath: string;
  checksumSha256: string;
  analyzer: 'librosa-0.11.0';
  analyzerImplementationSha256: string;
  durationSeconds: number;
  sampleRate: number;
  tempoBpm: number;
  beatsSeconds: number[];
  onsetsSeconds: number[];
};

export const analyzeMusic = async (
  projectPath: string,
  engineRoot: string,
  now = new Date(),
): Promise<BeatAnalysis> => {
  const musicDirectory = path.join(projectPath, 'input/music');
  const musicFiles = (await readdir(musicDirectory))
    .filter((file) => !file.startsWith('.'))
    .sort();
  if (musicFiles.length === 0) {
    throw new Error('No supplied music found in input/music');
  }
  if (musicFiles.length > 1) {
    throw new Error('Multiple music files found; keep exactly one supplied track for deterministic analysis');
  }
  const relativePath = `input/music/${musicFiles[0]}`;
  const audioPath = path.join(projectPath, relativePath);
  const checksumSha256 = await hashFile(audioPath);
  const script = path.join(engineRoot, 'python/analyze_beats.py');
  const analyzerImplementationSha256 = await hashFile(script);
  const outputPath = path.join(projectPath, 'analysis/beats.json');
  try {
    const existing = await readJson<BeatAnalysis>(outputPath);
    if (
      existing.checksumSha256 === checksumSha256 &&
      existing.analyzer === 'librosa-0.11.0' &&
      existing.analyzerImplementationSha256 === analyzerImplementationSha256
    ) {
      return existing;
    }
  } catch {
    // Generate the first analysis or replace invalid/stale data.
  }

  const python = path.join(engineRoot, '.venv/bin/python');
  const cacheRoot = path.join(engineRoot, '.cache');
  const numbaCache = path.join(cacheRoot, 'numba');
  await mkdir(numbaCache, {recursive: true});
  const processResult = await runProcess(python, [script, audioPath], {
    cwd: engineRoot,
    env: {
      ...process.env,
      NUMBA_CACHE_DIR: numbaCache,
      XDG_CACHE_HOME: cacheRoot,
    },
  });
  const parsed = JSON.parse(processResult.stdout) as Omit<
    BeatAnalysis,
    | 'schemaVersion'
    | 'generatedAt'
    | 'relativePath'
    | 'checksumSha256'
    | 'analyzer'
    | 'analyzerImplementationSha256'
  >;
  const result: BeatAnalysis = {
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    relativePath,
    checksumSha256,
    analyzer: 'librosa-0.11.0',
    analyzerImplementationSha256,
    ...parsed,
  };
  await writeJson(outputPath, result);
  return result;
};
