import {mkdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {readJson, writeJson} from '../core/json';

export const MEDIA_OPERATION_COMMANDS = [
  'analyze',
  'proxy',
  'grade-stills',
  'grade',
  'preview',
  'render',
  'qc',
] as const;

export type MediaOperationCommand = (typeof MEDIA_OPERATION_COMMANDS)[number];

const MediaOperationCommandSchema = z.enum(MEDIA_OPERATION_COMMANDS);
const ProgressSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    label: z.string().min(1),
  })
  .refine((value) => value.completed <= value.total, {
    message: 'Progress completed count cannot exceed total',
  });

const MediaOperationRecordSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    command: MediaOperationCommandSchema,
    state: z.enum(['running', 'failed']),
    pid: z.number().int().positive(),
    startedAt: z.string().datetime({offset: true}),
    updatedAt: z.string().datetime({offset: true}),
    finishedAt: z.string().datetime({offset: true}).nullable(),
    phase: z.string().min(1),
    progress: ProgressSchema.nullable(),
    error: z.string().min(1).nullable(),
  })
  .strict();

export type MediaOperationRecord = z.infer<typeof MediaOperationRecordSchema>;
export type MediaOperationProgress = z.infer<typeof ProgressSchema>;

export type BeginMediaOperationOptions = {
  now?: Date;
  pid?: number;
  phase?: string;
  progress?: MediaOperationProgress | null;
};

export type UpdateMediaOperationOptions = {
  now?: Date;
  phase?: string;
  progress?: MediaOperationProgress | null;
};

export type MediaOperationContext = {
  update(options: UpdateMediaOperationOptions): Promise<MediaOperationRecord>;
};

const operationPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/operation.json');

const missingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

export const readMediaOperation = async (projectPath: string): Promise<MediaOperationRecord | null> => {
  try {
    return await readJson(operationPath(projectPath), MediaOperationRecordSchema);
  } catch {
    return null;
  }
};

export const beginMediaOperation = async (
  projectPath: string,
  command: MediaOperationCommand,
  options: BeginMediaOperationOptions = {},
): Promise<MediaOperationRecord> => {
  const existing = await readMediaOperation(projectPath);
  if (existing && isMediaOperationAlive(existing)) {
    throw new Error(
      `Cannot start ${command}: ${existing.command} is already active for this reel project`,
    );
  }
  const now = options.now ?? new Date();
  const record = MediaOperationRecordSchema.parse({
    schemaVersion: '1.0.0',
    command,
    state: 'running',
    pid: options.pid ?? process.pid,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    phase: options.phase ?? 'starting',
    progress: options.progress ?? null,
    error: null,
  });
  await mkdir(path.dirname(operationPath(projectPath)), {recursive: true});
  await writeJson(operationPath(projectPath), record);
  return record;
};

export const updateMediaOperation = async (
  projectPath: string,
  options: UpdateMediaOperationOptions,
): Promise<MediaOperationRecord> => {
  const current = await readMediaOperation(projectPath);
  if (!current || current.state !== 'running') {
    throw new Error('Cannot update a media operation that is not running');
  }
  const next = MediaOperationRecordSchema.parse({
    ...current,
    updatedAt: (options.now ?? new Date()).toISOString(),
    phase: options.phase ?? current.phase,
    progress: options.progress === undefined ? current.progress : options.progress,
  });
  await writeJson(operationPath(projectPath), next);
  return next;
};

export const failMediaOperation = async (
  projectPath: string,
  error: unknown,
  now = new Date(),
): Promise<MediaOperationRecord> => {
  const current = await readMediaOperation(projectPath);
  if (!current) {
    throw new Error('Cannot fail a media operation that does not exist');
  }
  const next = MediaOperationRecordSchema.parse({
    ...current,
    state: 'failed',
    updatedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    error: error instanceof Error ? error.message || error.name : String(error),
  });
  await writeJson(operationPath(projectPath), next);
  return next;
};

export const completeMediaOperation = async (projectPath: string): Promise<void> => {
  try {
    await unlink(operationPath(projectPath));
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
};

export const runMediaOperation = async <T>(
  projectPath: string,
  command: MediaOperationCommand,
  operation: (context: MediaOperationContext) => Promise<T>,
  options: BeginMediaOperationOptions = {},
): Promise<T> => {
  await beginMediaOperation(projectPath, command, options);
  try {
    const result = await operation({
      update: async (update) => await updateMediaOperation(projectPath, update),
    });
    await completeMediaOperation(projectPath);
    return result;
  } catch (error) {
    await failMediaOperation(projectPath, error);
    throw error;
  }
};

export const isMediaOperationAlive = (record: MediaOperationRecord): boolean => {
  if (record.state !== 'running') return false;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
