import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {scanInputs} from '../project/ingest';
import {runProcess} from './process';

const TimestampArraySchema = z.array(z.number().finite().nonnegative());

export const BeatAnalysisSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    generatedAt: z.string().datetime({offset: true}),
    relativePath: z
      .string()
      .min(1)
      .refine((value) => !path.isAbsolute(value) && !value.split('/').includes('..'), {
        message: 'Beat-analysis source path must be a safe relative path',
      }),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    analyzer: z.literal('librosa-0.11.0'),
    analyzerImplementationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    durationSeconds: z.number().finite().positive(),
    sampleRate: z.number().int().positive(),
    tempoBpm: z.number().finite().nonnegative(),
    beatsSeconds: TimestampArraySchema,
    onsetsSeconds: TimestampArraySchema,
  })
  .strict()
  .superRefine((analysis, context) => {
    for (const field of ['beatsSeconds', 'onsetsSeconds'] as const) {
      let previous = -Infinity;
      for (const [index, timestamp] of analysis[field].entries()) {
        if (timestamp < previous) {
          context.addIssue({
            code: 'custom',
            path: [field, index],
            message: `${field} must be ordered chronologically`,
          });
        }
        if (timestamp > analysis.durationSeconds) {
          context.addIssue({
            code: 'custom',
            path: [field, index],
            message: `${field} timestamps must not exceed the analyzed duration`,
          });
        }
        previous = timestamp;
      }
    }
  });

export type BeatAnalysis = z.infer<typeof BeatAnalysisSchema>;

export const analyzeMusic = async (
  projectPath: string,
  engineRoot: string,
  now = new Date(),
): Promise<BeatAnalysis> => {
  const musicFiles = (await scanInputs(projectPath, now)).files.filter(
    (file) => file.kind === 'music',
  );
  if (musicFiles.length === 0) {
    throw new Error('No supplied music found in input/music');
  }
  if (musicFiles.length > 1) {
    throw new Error('Multiple music files found; keep exactly one supplied track for deterministic analysis');
  }
  const [{relativePath, checksumSha256}] = musicFiles;
  const audioPath = path.join(projectPath, relativePath);
  const script = path.join(engineRoot, 'python/analyze_beats.py');
  const analyzerImplementationSha256 = await hashFile(script);
  const outputPath = path.join(projectPath, 'analysis/beats.json');
  try {
    const existing = await readJson(outputPath, BeatAnalysisSchema);
    if (
      existing.relativePath === relativePath &&
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
  const parsed = JSON.parse(processResult.stdout) as Record<string, unknown>;
  const result = BeatAnalysisSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    relativePath,
    checksumSha256,
    analyzer: 'librosa-0.11.0',
    analyzerImplementationSha256,
    ...parsed,
  });
  await writeJson(outputPath, result);
  return result;
};
