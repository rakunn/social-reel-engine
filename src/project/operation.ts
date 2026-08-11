import {execFileSync} from 'node:child_process';
import {mkdir, rm, rmdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {readJson, writeJson} from '../core/json';

export const MEDIA_OPERATION_COMMANDS = [
  'analyze',
  'beats',
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
    processStartMarker: z.string().min(1).nullable().default(null),
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
  processStartMarker?: string | null;
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

const operationLockPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/operation.lock');

const operationLockOwnerPath = (projectPath: string): string =>
  path.join(operationLockPath(projectPath), 'owner.json');

const MediaOperationLockSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    pid: z.number().int().positive(),
    processStartMarker: z.string().min(1).nullable(),
    acquiredAt: z.string().datetime({offset: true}),
  })
  .strict();

type MediaOperationLock = z.infer<typeof MediaOperationLockSchema>;

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_START_RETRY_LIMIT = 100;

const missingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const directoryExists = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'EEXIST';

const pause = async (): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));

const readProcessStartMarker = (pid: number): string | null => {
  try {
    const marker = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return marker.length > 0 ? marker : null;
  } catch {
    return null;
  }
};

const isProcessIdentityAlive = (identity: {
  pid: number;
  processStartMarker: string | null;
}): boolean => {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (!identity.processStartMarker) return true;
  return readProcessStartMarker(identity.pid) === identity.processStartMarker;
};

const readMediaOperationLock = async (projectPath: string): Promise<MediaOperationLock | null> => {
  try {
    return await readJson(operationLockOwnerPath(projectPath), MediaOperationLockSchema);
  } catch {
    return null;
  }
};

const releaseMediaOperationLock = async (projectPath: string): Promise<void> => {
  try {
    await unlink(operationLockOwnerPath(projectPath));
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
  try {
    await rmdir(operationLockPath(projectPath));
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
};

const removeStaleMediaOperationLock = async (projectPath: string): Promise<void> => {
  await rm(operationLockPath(projectPath), {recursive: true, force: true});
};

const acquireMediaOperationLock = async (projectPath: string, now: Date, pid: number): Promise<void> => {
  const lockPath = operationLockPath(projectPath);
  await mkdir(path.dirname(lockPath), {recursive: true});
  const processStartMarker = readProcessStartMarker(pid);
  for (let attempt = 0; attempt <= LOCK_START_RETRY_LIMIT; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        await writeJson(
          operationLockOwnerPath(projectPath),
          MediaOperationLockSchema.parse({
            schemaVersion: '1.0.0',
            pid,
            processStartMarker,
            acquiredAt: now.toISOString(),
          }),
        );
        return;
      } catch (error) {
        await releaseMediaOperationLock(projectPath);
        throw error;
      }
    } catch (error) {
      if (!directoryExists(error)) throw error;
    }

    const [existing, owner] = await Promise.all([
      readMediaOperation(projectPath),
      readMediaOperationLock(projectPath),
    ]);
    if (existing && isMediaOperationAlive(existing)) {
      throw new Error(
        `Cannot start a media operation: ${existing.command} is already active for this reel project`,
      );
    }
    if (owner && isProcessIdentityAlive(owner)) {
      if (attempt === LOCK_START_RETRY_LIMIT) {
        throw new Error('Cannot start a media operation: another media operation is still starting');
      }
      await pause();
      continue;
    }
    if (!owner && attempt < 1) {
      await pause();
      continue;
    }
    await removeStaleMediaOperationLock(projectPath);
  }
  throw new Error('Cannot start a media operation: lock acquisition timed out');
};

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
  const now = options.now ?? new Date();
  const pid = options.pid ?? process.pid;
  await acquireMediaOperationLock(projectPath, now, pid);
  const existing = await readMediaOperation(projectPath);
  if (existing && isMediaOperationAlive(existing)) {
    await releaseMediaOperationLock(projectPath);
    throw new Error(
      `Cannot start ${command}: ${existing.command} is already active for this reel project`,
    );
  }
  const record = MediaOperationRecordSchema.parse({
    schemaVersion: '1.0.0',
    command,
    state: 'running',
    pid,
    processStartMarker: options.processStartMarker ?? readProcessStartMarker(pid),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    finishedAt: null,
    phase: options.phase ?? 'starting',
    progress: options.progress ?? null,
    error: null,
  });
  try {
    await writeJson(operationPath(projectPath), record);
    return record;
  } catch (error) {
    await releaseMediaOperationLock(projectPath);
    throw error;
  }
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
  try {
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
  } finally {
    await releaseMediaOperationLock(projectPath);
  }
};

export const completeMediaOperation = async (projectPath: string): Promise<void> => {
  try {
    await unlink(operationPath(projectPath));
  } catch (error) {
    if (!missingFile(error)) throw error;
  } finally {
    await releaseMediaOperationLock(projectPath);
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
  return isProcessIdentityAlive(record);
};
