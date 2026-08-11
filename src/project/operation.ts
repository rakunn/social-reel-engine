import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {readJson, writeJson} from '../core/json';
import {runWithPublicationGuard} from '../core/publication-guard';

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
    id: z.string().min(1).nullable().default(null),
    command: MediaOperationCommandSchema,
    state: z.enum(['running', 'failed']),
    pid: z.number().int().positive(),
    processStartMarker: z.string().min(1).nullable().default(null),
    leaseExpiresAt: z.string().datetime({offset: true}).nullable().default(null),
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
  assertOwnership(): Promise<void>;
};

const operationPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/operation.json');

const operationLockPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/operation.lock');

const operationLockOwnerPath = (projectPath: string): string =>
  path.join(operationLockPath(projectPath), 'owner.json');

const operationLockTombstonePath = (projectPath: string, id: string): string =>
  path.join(projectPath, 'analysis', `operation.lock.reclaimed-${id}`);

const releasedOperationLockPath = (projectPath: string, id: string): string =>
  path.join(projectPath, 'analysis', `operation.lock.released-${id}`);

const completedOperationRecordDirectoryPath = (projectPath: string, id: string): string =>
  path.join(projectPath, 'analysis', `operation.completed-${id}`);

const completedOperationRecordPath = (projectPath: string, id: string): string =>
  path.join(completedOperationRecordDirectoryPath(projectPath, id), 'record.json');

const ownerlessReclaimMarkerPath = (projectPath: string, identity: string): string =>
  path.join(operationLockPath(projectPath), `.reclaim-${identity}`);

const MediaOperationLockSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    id: z.string().min(1).nullable().default(null),
    pid: z.number().int().positive(),
    processStartMarker: z.string().min(1).nullable(),
    leaseExpiresAt: z.string().datetime({offset: true}).nullable(),
    acquiredAt: z.string().datetime({offset: true}),
  })
  .strict();

type MediaOperationLock = z.infer<typeof MediaOperationLockSchema>;
type ActiveMediaOperationLock = MediaOperationLock & {id: string};

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_START_RETRY_LIMIT = 100;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const MARKERLESS_OPERATION_LEASE_MS = 5 * 60_000;
const MARKERLESS_OPERATION_HEARTBEAT_MS = Math.floor(
  MARKERLESS_OPERATION_LEASE_MS / 3,
);

const missingFile = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';

const directoryExists = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'EEXIST';

const nonEmptyDirectory = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === 'ENOTEMPTY';

const pause = async (): Promise<void> =>
  await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));

const markerlessLeaseExpiry = (now: Date): string =>
  new Date(now.getTime() + MARKERLESS_OPERATION_LEASE_MS).toISOString();

const markerlessLeaseIsCurrent = (leaseExpiresAt: string | null): boolean =>
  leaseExpiresAt !== null && Date.parse(leaseExpiresAt) > Date.now();

const readProcessStartMarker = (pid: number): string | null => {
  try {
    const marker = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {...process.env, LC_ALL: 'C', TZ: 'UTC'},
    }).trim();
    return marker.length > 0 ? marker : null;
  } catch {
    return null;
  }
};

const isProcessIdentityAlive = (identity: {
  pid: number;
  processStartMarker: string | null;
  leaseExpiresAt: string | null;
}): boolean => {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
  if (!identity.processStartMarker) {
    return markerlessLeaseIsCurrent(identity.leaseExpiresAt);
  }
  return readProcessStartMarker(identity.pid) === identity.processStartMarker;
};

const readMediaOperationLockAt = async (lockPath: string): Promise<MediaOperationLock | null> => {
  try {
    return await readJson(path.join(lockPath, 'owner.json'), MediaOperationLockSchema);
  } catch {
    return null;
  }
};

const readMediaOperationLock = async (projectPath: string): Promise<MediaOperationLock | null> =>
  await readMediaOperationLockAt(operationLockPath(projectPath));

const mediaOperationOwnershipLost = (): Error =>
  new Error('Cannot mutate a media operation after its ownership was lost');

const asOperationError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const releaseMediaOperationLock = async (
  projectPath: string,
  operationId: string,
): Promise<boolean> => {
  const lockPath = operationLockPath(projectPath);
  const releasedPath = releasedOperationLockPath(projectPath, operationId);
  const owner = await readMediaOperationLock(projectPath);
  if (!owner || owner.id !== operationId || !isProcessIdentityAlive(owner)) return false;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if (missingFile(error) || directoryExists(error) || nonEmptyDirectory(error)) return false;
    throw error;
  }
  const claimed = await readMediaOperationLockAt(releasedPath);
  if (!claimed || claimed.id !== operationId) {
    try {
      await rename(releasedPath, lockPath);
    } catch {
      // A competing operation may have acquired the global lock while this stale release rolled back.
    }
    return false;
  }
  return true;
};

const staleLockIdentity = async (
  projectPath: string,
  owner: MediaOperationLock | null,
): Promise<string | null> => {
  if (owner?.id) return owner.id;
  try {
    const lockStat = await stat(operationLockPath(projectPath));
    return `uninitialized-${lockStat.dev}-${lockStat.ino}`;
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
};

const reclaimStaleMediaOperationLock = async (
  projectPath: string,
  owner: MediaOperationLock | null,
): Promise<boolean> => {
  const identity = await staleLockIdentity(projectPath, owner);
  if (!identity) return false;
  if (!owner) {
    const markerPath = ownerlessReclaimMarkerPath(projectPath, identity);
    try {
      await writeFile(markerPath, `${identity}\n`, {encoding: 'utf8', flag: 'wx'});
    } catch (error) {
      if (!directoryExists(error)) {
        if (missingFile(error)) return false;
        throw error;
      }
    }
    if ((await staleLockIdentity(projectPath, null)) !== identity) return false;
  }
  try {
    await rename(
      operationLockPath(projectPath),
      operationLockTombstonePath(projectPath, identity),
    );
    return true;
  } catch (error) {
    if (missingFile(error) || directoryExists(error) || nonEmptyDirectory(error)) return false;
    throw error;
  }
};

const acquireMediaOperationLock = async (
  projectPath: string,
  now: Date,
  pid: number,
  processStartMarker: string | null,
): Promise<ActiveMediaOperationLock> => {
  const lockPath = operationLockPath(projectPath);
  await mkdir(path.dirname(lockPath), {recursive: true});
  const acquisitionStartedAt = Date.now();
  let reclaimedOnFinalAttempt = false;
  for (
    let attempt = 0;
    attempt <= LOCK_START_RETRY_LIMIT + (reclaimedOnFinalAttempt ? 1 : 0);
    attempt += 1
  ) {
    try {
      await mkdir(lockPath);
      const owner: ActiveMediaOperationLock = {
        schemaVersion: '1.0.0',
        id: randomUUID(),
        pid,
        processStartMarker,
        leaseExpiresAt: processStartMarker ? null : markerlessLeaseExpiry(now),
        acquiredAt: now.toISOString(),
      };
      try {
        await writeJson(
          operationLockOwnerPath(projectPath),
          MediaOperationLockSchema.parse(owner),
        );
        return owner;
      } catch (error) {
        await releaseMediaOperationLock(projectPath, owner.id);
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
      if (attempt === LOCK_START_RETRY_LIMIT + (reclaimedOnFinalAttempt ? 1 : 0)) {
        throw new Error('Cannot start a media operation: another media operation is still starting');
      }
      await pause();
      continue;
    }
    if (
      !owner &&
      Date.now() - acquisitionStartedAt < LOCK_INITIALIZATION_GRACE_MS
    ) {
      await pause();
      continue;
    }
    if (await reclaimStaleMediaOperationLock(projectPath, owner)) {
      reclaimedOnFinalAttempt ||= attempt === LOCK_START_RETRY_LIMIT;
      continue;
    }
    await pause();
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

const assertMediaOperationOwnership = async (
  projectPath: string,
  operationId: string,
): Promise<{record: MediaOperationRecord; lock: MediaOperationLock}> => {
  const [current, owner] = await Promise.all([
    readMediaOperation(projectPath),
    readMediaOperationLock(projectPath),
  ]);
  if (
    !current ||
    current.state !== 'running' ||
    current.id !== operationId ||
    !owner ||
    owner.id !== operationId ||
    !isProcessIdentityAlive(owner)
  ) {
    throw mediaOperationOwnershipLost();
  }
  return {record: current, lock: owner};
};

export const beginMediaOperation = async (
  projectPath: string,
  command: MediaOperationCommand,
  options: BeginMediaOperationOptions = {},
): Promise<MediaOperationRecord> => {
  const now = options.now ?? new Date();
  const pid = options.pid ?? process.pid;
  const processStartMarker =
    options.processStartMarker === undefined
      ? readProcessStartMarker(pid)
      : options.processStartMarker;
  const lock = await acquireMediaOperationLock(projectPath, now, pid, processStartMarker);
  const existing = await readMediaOperation(projectPath);
  if (existing && isMediaOperationAlive(existing)) {
    await releaseMediaOperationLock(projectPath, lock.id);
    throw new Error(
      `Cannot start ${command}: ${existing.command} is already active for this reel project`,
    );
  }
  const record = MediaOperationRecordSchema.parse({
    schemaVersion: '1.0.0',
    id: lock.id,
    command,
    state: 'running',
    pid,
    processStartMarker,
    leaseExpiresAt: processStartMarker ? null : markerlessLeaseExpiry(now),
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
    await releaseMediaOperationLock(projectPath, lock.id);
    throw error;
  }
};

export const updateMediaOperation = async (
  projectPath: string,
  operationId: string,
  options: UpdateMediaOperationOptions,
): Promise<MediaOperationRecord> => {
  const {record: current, lock} = await assertMediaOperationOwnership(projectPath, operationId);
  const now = options.now ?? new Date();
  const leaseExpiresAt = current.processStartMarker
    ? null
    : markerlessLeaseExpiry(now);
  const next = MediaOperationRecordSchema.parse({
    ...current,
    updatedAt: now.toISOString(),
    leaseExpiresAt,
    phase: options.phase ?? current.phase,
    progress: options.progress === undefined ? current.progress : options.progress,
  });
  await writeJson(
    operationLockOwnerPath(projectPath),
    MediaOperationLockSchema.parse({...lock, leaseExpiresAt}),
  );
  await writeJson(operationPath(projectPath), next);
  return next;
};

export const failMediaOperation = async (
  projectPath: string,
  operationId: string,
  error: unknown,
  now = new Date(),
): Promise<MediaOperationRecord> => {
  const {record: current} = await assertMediaOperationOwnership(projectPath, operationId);
  const next = MediaOperationRecordSchema.parse({
    ...current,
    state: 'failed',
    updatedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    error: error instanceof Error ? error.message || error.name : String(error),
  });
  await writeJson(operationPath(projectPath), next);
  if (!(await releaseMediaOperationLock(projectPath, operationId))) {
    throw mediaOperationOwnershipLost();
  }
  return next;
};

export const completeMediaOperation = async (
  projectPath: string,
  operationId: string,
): Promise<void> => {
  await assertMediaOperationOwnership(projectPath, operationId);
  const recordDirectoryPath = completedOperationRecordDirectoryPath(projectPath, operationId);
  const recordPath = completedOperationRecordPath(projectPath, operationId);
  try {
    await mkdir(recordDirectoryPath);
    await rename(operationPath(projectPath), recordPath);
  } catch (error) {
    if (missingFile(error) || directoryExists(error)) throw mediaOperationOwnershipLost();
    throw error;
  }
  const claimedRecord = await readJson(recordPath, MediaOperationRecordSchema).catch(() => null);
  if (!claimedRecord || claimedRecord.id !== operationId) {
    try {
      await rename(recordPath, operationPath(projectPath));
    } catch {
      // A successor record wins if ownership changed while the completion record was claimed.
    }
    throw mediaOperationOwnershipLost();
  }
  if (!(await releaseMediaOperationLock(projectPath, operationId))) {
    throw mediaOperationOwnershipLost();
  }
};

export const runMediaOperation = async <T>(
  projectPath: string,
  command: MediaOperationCommand,
  operation: (context: MediaOperationContext) => Promise<T>,
  options: BeginMediaOperationOptions = {},
): Promise<T> => {
  const record = await beginMediaOperation(projectPath, command, options);
  if (!record.id) {
    throw new Error('Cannot run a media operation without an immutable ownership ID');
  }
  const operationId = record.id;
  let ownershipFailure: Error | null = null;
  const assertOwnership = async (): Promise<void> => {
    if (ownershipFailure) throw ownershipFailure;
    try {
      await assertMediaOperationOwnership(projectPath, operationId);
    } catch (error) {
      ownershipFailure = asOperationError(error);
      throw ownershipFailure;
    }
  };
  let updateQueue: Promise<void> = Promise.resolve();
  const update = async (next: UpdateMediaOperationOptions): Promise<MediaOperationRecord> => {
    const pending = updateQueue.then(
      async () => {
        try {
          return await updateMediaOperation(projectPath, operationId, next);
        } catch (error) {
          ownershipFailure = asOperationError(error);
          throw ownershipFailure;
        }
      },
    );
    updateQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  };
  const heartbeat =
    record.processStartMarker === null
      ? setInterval(() => {
          void update({}).catch(() => undefined);
        }, MARKERLESS_OPERATION_HEARTBEAT_MS)
      : null;
  heartbeat?.unref();
  const stopHeartbeat = async (): Promise<void> => {
    if (heartbeat) clearInterval(heartbeat);
    await updateQueue;
  };
  try {
    const result = await runWithPublicationGuard(assertOwnership, async () =>
      await operation({update, assertOwnership}),
    );
    await stopHeartbeat();
    await completeMediaOperation(projectPath, operationId);
    return result;
  } catch (error) {
    await stopHeartbeat();
    try {
      await failMediaOperation(projectPath, operationId, error);
    } catch (failure) {
      if (!(failure instanceof Error) || !/ownership.*lost/i.test(failure.message)) {
        throw failure;
      }
    }
    throw error;
  }
};

export const isMediaOperationAlive = (record: MediaOperationRecord): boolean => {
  if (record.state !== 'running') return false;
  return isProcessIdentityAlive(record);
};
