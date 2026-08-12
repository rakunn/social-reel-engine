import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {readJson, writeJson} from '../core/json';
import {
  runWithMediaOperationPublicationGuard,
  runWithPublicationGuard,
} from '../core/publication-guard';

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
    state: z.enum(['running', 'failed', 'completed']),
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

const statusScanLockPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/status-scan.lock');

const statusScanLockOwnerPath = (projectPath: string): string =>
  path.join(statusScanLockPath(projectPath), 'owner.json');

const operationLockTombstonePath = (projectPath: string, id: string): string =>
  path.join(projectPath, 'analysis', `operation.lock.reclaimed-${id}`);

const operationLockReclaimClaimPath = (projectPath: string, identity: string): string =>
  path.join(projectPath, 'analysis', `operation.lock.reclaiming-${identity}.json`);

const statusScanLockTombstonePath = (projectPath: string, id: string): string =>
  path.join(projectPath, 'analysis', `status-scan.lock.reclaimed-${id}`);

const statusScanLockReclaimClaimPath = (projectPath: string, identity: string): string =>
  path.join(projectPath, 'analysis', `status-scan.lock.reclaiming-${identity}.json`);

const MediaOperationLockSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    id: z.string().min(1).nullable().default(null),
    state: z.enum(['active', 'released']).default('active'),
    pid: z.number().int().positive(),
    processStartMarker: z.string().min(1).nullable(),
    leaseExpiresAt: z.string().datetime({offset: true}).nullable(),
    acquiredAt: z.string().datetime({offset: true}),
    releasedAt: z.string().datetime({offset: true}).nullable().default(null),
  })
  .strict();

type MediaOperationLock = z.infer<typeof MediaOperationLockSchema>;
type ActiveMediaOperationLock = MediaOperationLock & {id: string; state: 'active'};

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

const lockIsInitializing = async (lockPath: string): Promise<boolean> => {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs < LOCK_INITIALIZATION_GRACE_MS;
  } catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
};

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

const claimMediaOperationLock = async (
  projectPath: string,
  owner: ActiveMediaOperationLock,
): Promise<boolean> => {
  try {
    await writeFile(
      operationLockOwnerPath(projectPath),
      `${JSON.stringify(MediaOperationLockSchema.parse(owner), null, 2)}\n`,
      {encoding: 'utf8', flag: 'wx'},
    );
  } catch (error) {
    if (directoryExists(error) || missingFile(error)) return false;
    throw error;
  }
  const claimed = await readMediaOperationLock(projectPath);
  return claimed?.id === owner.id && claimed.state === 'active';
};

const readStatusScanLock = async (projectPath: string): Promise<MediaOperationLock | null> => {
  try {
    return await readJson(statusScanLockOwnerPath(projectPath), MediaOperationLockSchema);
  } catch {
    return null;
  }
};

const claimStatusScanLock = async (
  projectPath: string,
  owner: ActiveMediaOperationLock,
): Promise<boolean> => {
  try {
    await writeFile(
      statusScanLockOwnerPath(projectPath),
      `${JSON.stringify(MediaOperationLockSchema.parse(owner), null, 2)}\n`,
      {encoding: 'utf8', flag: 'wx'},
    );
  } catch (error) {
    if (directoryExists(error) || missingFile(error)) return false;
    throw error;
  }
  const claimed = await readStatusScanLock(projectPath);
  return claimed?.id === owner.id && claimed.state === 'active';
};

const mediaOperationOwnershipLost = (): Error =>
  new Error('Cannot mutate a media operation after its ownership was lost');

const asOperationError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const createReclaimClaim = (): ActiveMediaOperationLock => {
  const now = new Date();
  const processStartMarker = readProcessStartMarker(process.pid);
  return {
    schemaVersion: '1.0.0',
    id: randomUUID(),
    state: 'active',
    pid: process.pid,
    processStartMarker,
    leaseExpiresAt: processStartMarker ? null : markerlessLeaseExpiry(now),
    acquiredAt: now.toISOString(),
    releasedAt: null,
  };
};

const readReclaimClaim = async (claimPath: string): Promise<MediaOperationLock | null> => {
  try {
    return await readJson(claimPath, MediaOperationLockSchema);
  } catch {
    return null;
  }
};

const staleReclaimClaimIdentity = async (
  claimPath: string,
  claim: MediaOperationLock | null,
): Promise<string | null> => {
  if (claim?.id) return claim.id;
  try {
    const claimStat = await stat(claimPath);
    return `uninitialized-${claimStat.dev}-${claimStat.ino}`;
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
};

const reclaimClaimIsOwned = async (claimPath: string, claimId: string): Promise<boolean> => {
  const claim = await readReclaimClaim(claimPath);
  return (
    claim?.id === claimId &&
    claim.state === 'active' &&
    isProcessIdentityAlive(claim)
  );
};

const reclaimClaimFencePath = (claimPath: string, claimId: string): string =>
  `${claimPath}.reclaimed-${claimId}`;

const reclaimClaimFenceOwnerPath = (fencePath: string): string =>
  path.join(fencePath, 'owner.json');

const reclaimClaimFenceSnapshotPath = (fencePath: string): string =>
  path.join(fencePath, 'claim.json');

const reclaimClaimFenceInitializationPath = (fencePath: string, ownerId: string): string =>
  `${fencePath}.initializing-${ownerId}`;

const reclaimClaimFenceRetirementPath = (fencePath: string, ownerId: string): string =>
  `${fencePath}.retired-${ownerId}`;

const readReclaimClaimFenceOwner = async (
  fencePath: string,
): Promise<MediaOperationLock | null> => {
  try {
    return await readJson(reclaimClaimFenceOwnerPath(fencePath), MediaOperationLockSchema);
  } catch {
    return null;
  }
};

const reclaimClaimFenceContainsSnapshot = async (fencePath: string): Promise<boolean> => {
  try {
    await stat(reclaimClaimFenceSnapshotPath(fencePath));
    return true;
  } catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
};

const reclaimClaimFenceIsOwned = async (fencePath: string, ownerId: string): Promise<boolean> => {
  const owner = await readReclaimClaimFenceOwner(fencePath);
  return owner?.id === ownerId && owner.state === 'active' && isProcessIdentityAlive(owner);
};

const createReclaimClaimFence = async (
  fencePath: string,
): Promise<ActiveMediaOperationLock | null> => {
  const owner = createReclaimClaim();
  const initializationPath = reclaimClaimFenceInitializationPath(fencePath, owner.id);
  let initialized = false;
  try {
    try {
      await mkdir(initializationPath);
      initialized = true;
      await writeFile(
        reclaimClaimFenceOwnerPath(initializationPath),
        `${JSON.stringify(MediaOperationLockSchema.parse(owner), null, 2)}\n`,
        {encoding: 'utf8', flag: 'wx'},
      );
    } catch (error) {
      if (directoryExists(error)) return null;
      throw error;
    }
    try {
      await rename(initializationPath, fencePath);
      initialized = false;
      return owner;
    } catch (error) {
      if (directoryExists(error) || nonEmptyDirectory(error)) return null;
      throw error;
    }
  } finally {
    if (initialized) {
      try {
        await rm(initializationPath, {recursive: true, force: true});
      } catch (error) {
        if (!missingFile(error)) throw error;
      }
    }
  }
};

const retireStaleReclaimClaimFence = async (
  fencePath: string,
  owner: MediaOperationLock,
): Promise<boolean> => {
  if (!owner.id) return false;
  const retirementPath = reclaimClaimFenceRetirementPath(fencePath, owner.id);
  try {
    await rename(fencePath, retirementPath);
    // Keep the retired directory non-empty. A delayed contender that observed this
    // owner must fail rather than move a successor fence into a reusable pathname.
    return true;
  } catch (error) {
    if (missingFile(error) || directoryExists(error) || nonEmptyDirectory(error)) return false;
    throw error;
  }
};

const rotateStaleReclaimClaim = async (claimPath: string, claimId: string): Promise<boolean> => {
  const fencePath = reclaimClaimFencePath(claimPath, claimId);
  for (let attempt = 0; attempt <= LOCK_START_RETRY_LIMIT; attempt += 1) {
    const owner = await createReclaimClaimFence(fencePath);
    if (owner) {
      if (!(await reclaimClaimFenceIsOwned(fencePath, owner.id))) return false;
      try {
        await rename(claimPath, reclaimClaimFenceSnapshotPath(fencePath));
        return true;
      } catch (error) {
        if (missingFile(error) || directoryExists(error) || nonEmptyDirectory(error)) {
          return false;
        }
        throw error;
      }
    }

    if (await reclaimClaimFenceContainsSnapshot(fencePath)) return false;
    const existingOwner = await readReclaimClaimFenceOwner(fencePath);
    if (!existingOwner) return false;
    if (existingOwner.state === 'active' && isProcessIdentityAlive(existingOwner)) {
      return false;
    }
    if (!(await retireStaleReclaimClaimFence(fencePath, existingOwner))) return false;
  }
  return false;
};

const acquireReclaimClaim = async (claimPath: string): Promise<ActiveMediaOperationLock | null> => {
  for (let attempt = 0; attempt <= LOCK_START_RETRY_LIMIT; attempt += 1) {
    const candidate = createReclaimClaim();
    try {
      await writeFile(
        claimPath,
        `${JSON.stringify(MediaOperationLockSchema.parse(candidate), null, 2)}\n`,
        {encoding: 'utf8', flag: 'wx'},
      );
      return candidate;
    } catch (error) {
      if (missingFile(error)) return null;
      if (!directoryExists(error)) throw error;
    }
    const existing = await readReclaimClaim(claimPath);
    if (existing?.state === 'active' && isProcessIdentityAlive(existing)) return null;
    const identity = await staleReclaimClaimIdentity(claimPath, existing);
    if (!identity) return null;
    if (!(await rotateStaleReclaimClaim(claimPath, identity))) {
      return null;
    }
  }
  return null;
};

const releaseReclaimClaim = async (claimPath: string, claimId: string): Promise<void> => {
  if (!(await reclaimClaimIsOwned(claimPath, claimId))) return;
  try {
    await rm(claimPath, {force: true});
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
};

type ReclaimLockOptions = {
  claimPath: string;
  lockPath: string;
  canReclaim(): Promise<boolean>;
  tombstonePath(claimId: string): string;
};

const reclaimLockWithClaim = async ({
  claimPath,
  lockPath,
  canReclaim,
  tombstonePath,
}: ReclaimLockOptions): Promise<boolean> => {
  const claim = await acquireReclaimClaim(claimPath);
  if (!claim) return false;
  try {
    if (!(await canReclaim()) || !(await reclaimClaimIsOwned(claimPath, claim.id))) {
      return false;
    }
    const reclaimedPath = tombstonePath(claim.id);
    try {
      await rename(lockPath, reclaimedPath);
    } catch (error) {
      if (missingFile(error) || directoryExists(error) || nonEmptyDirectory(error)) return false;
      throw error;
    }
    try {
      await rm(reclaimedPath, {recursive: true, force: true});
    } catch (error) {
      if (!missingFile(error)) throw error;
    }
    return true;
  } finally {
    await releaseReclaimClaim(claimPath, claim.id);
  }
};

const releaseMediaOperationLock = async (
  projectPath: string,
  operationId: string,
): Promise<boolean> => {
  const owner = await readMediaOperationLock(projectPath);
  if (
    !owner ||
    owner.id !== operationId ||
    owner.state !== 'active' ||
    !isProcessIdentityAlive(owner)
  ) {
    return false;
  }
  const released = MediaOperationLockSchema.parse({
    ...owner,
    state: 'released',
    releasedAt: new Date().toISOString(),
  });
  await runWithPublicationGuard(
    async () => {
      const current = await readMediaOperationLock(projectPath);
      if (
        !current ||
        current.id !== operationId ||
        current.state !== 'active' ||
        !isProcessIdentityAlive(current)
      ) {
        throw mediaOperationOwnershipLost();
      }
    },
    async () =>
      await writeJson(
        operationLockOwnerPath(projectPath),
        released,
      ),
  );
  const current = await readMediaOperationLock(projectPath);
  return current?.id === operationId && current.state === 'released';
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
  return await reclaimLockWithClaim({
    lockPath: operationLockPath(projectPath),
    claimPath: operationLockReclaimClaimPath(projectPath, identity),
    canReclaim: async () => {
      const current = await readMediaOperationLock(projectPath);
      if (current?.state === 'active' && isProcessIdentityAlive(current)) return false;
      return (await staleLockIdentity(projectPath, current)) === identity;
    },
    tombstonePath: (claimId) => `${operationLockTombstonePath(projectPath, identity)}-${claimId}`,
  });
};

const statusScanLockIdentity = async (
  projectPath: string,
  owner: MediaOperationLock | null,
): Promise<string | null> => {
  if (owner?.id) return owner.id;
  try {
    const lockStat = await stat(statusScanLockPath(projectPath));
    return `uninitialized-${lockStat.dev}-${lockStat.ino}`;
  } catch (error) {
    if (missingFile(error)) return null;
    throw error;
  }
};

const reclaimStaleStatusScanLock = async (
  projectPath: string,
  owner: MediaOperationLock | null,
): Promise<boolean> => {
  const identity = await statusScanLockIdentity(projectPath, owner);
  if (!identity) return false;
  return await reclaimLockWithClaim({
    lockPath: statusScanLockPath(projectPath),
    claimPath: statusScanLockReclaimClaimPath(projectPath, identity),
    canReclaim: async () => {
      const current = await readStatusScanLock(projectPath);
      if (current?.state === 'active' && isProcessIdentityAlive(current)) return false;
      return (await statusScanLockIdentity(projectPath, current)) === identity;
    },
    tombstonePath: (claimId) =>
      `${statusScanLockTombstonePath(projectPath, identity)}-${claimId}`,
  });
};

const releaseStatusScanLock = async (projectPath: string, lockId: string): Promise<boolean> => {
  const owner = await readStatusScanLock(projectPath);
  if (
    !owner ||
    owner.id !== lockId ||
    owner.state !== 'active' ||
    !isProcessIdentityAlive(owner)
  ) {
    return false;
  }
  const released = MediaOperationLockSchema.parse({
    ...owner,
    state: 'released',
    releasedAt: new Date().toISOString(),
  });
  await runWithPublicationGuard(
    async () => {
      const current = await readStatusScanLock(projectPath);
      if (
        !current ||
        current.id !== lockId ||
        current.state !== 'active' ||
        !isProcessIdentityAlive(current)
      ) {
        throw mediaOperationOwnershipLost();
      }
    },
    async () => await writeJson(statusScanLockOwnerPath(projectPath), released),
  );
  const current = await readStatusScanLock(projectPath);
  return current?.id === lockId && current.state === 'released';
};

const statusScanIsActive = async (projectPath: string): Promise<boolean> => {
  const owner = await readStatusScanLock(projectPath);
  if (owner && owner.state === 'active' && isProcessIdentityAlive(owner)) return true;
  if (!owner && (await lockIsInitializing(statusScanLockPath(projectPath)))) return true;
  if (await reclaimStaleStatusScanLock(projectPath, owner)) return false;
  try {
    await stat(statusScanLockPath(projectPath));
    return true;
  } catch (error) {
    if (missingFile(error)) return false;
    throw error;
  }
};

export const isMediaOperationLockActive = async (projectPath: string): Promise<boolean> => {
  const owner = await readMediaOperationLock(projectPath);
  if (owner?.state === 'active' && isProcessIdentityAlive(owner)) return true;
  return owner === null && (await lockIsInitializing(operationLockPath(projectPath)));
};

export type StatusScanLockResult<T> =
  | {acquired: true; value: T}
  | {acquired: false};

export const runWithStatusScanLock = async <T>(
  projectPath: string,
  scan: () => Promise<T>,
): Promise<StatusScanLockResult<T>> => {
  const lockPath = statusScanLockPath(projectPath);
  await mkdir(path.dirname(lockPath), {recursive: true});
  const pid = process.pid;
  const processStartMarker = readProcessStartMarker(pid);
  let lock: ActiveMediaOperationLock | null = null;
  for (let attempt = 0; attempt <= LOCK_START_RETRY_LIMIT; attempt += 1) {
    try {
      await mkdir(lockPath);
      const now = new Date();
      const candidate: ActiveMediaOperationLock = {
        schemaVersion: '1.0.0',
        id: randomUUID(),
        state: 'active',
        pid,
        processStartMarker,
        leaseExpiresAt: processStartMarker ? null : markerlessLeaseExpiry(now),
        acquiredAt: now.toISOString(),
        releasedAt: null,
      };
      try {
        if (!(await claimStatusScanLock(projectPath, candidate))) continue;
        lock = candidate;
        break;
      } catch (error) {
        await releaseStatusScanLock(projectPath, candidate.id);
        throw error;
      }
    } catch (error) {
      if (!directoryExists(error)) throw error;
    }
    const owner = await readStatusScanLock(projectPath);
    if (owner && owner.state === 'active' && isProcessIdentityAlive(owner)) {
      return {acquired: false};
    }
    if (!owner && (await lockIsInitializing(lockPath))) return {acquired: false};
    if (await reclaimStaleStatusScanLock(projectPath, owner)) continue;
    await pause();
  }
  if (!lock) return {acquired: false};
  let ownershipFailure: Error | null = null;
  const assertOwnership = async (): Promise<MediaOperationLock> => {
    if (ownershipFailure) throw ownershipFailure;
    const owner = await readStatusScanLock(projectPath);
    if (
      !owner ||
      owner.id !== lock.id ||
      owner.state !== 'active' ||
      !isProcessIdentityAlive(owner)
    ) {
      ownershipFailure = mediaOperationOwnershipLost();
      throw ownershipFailure;
    }
    return owner;
  };
  const renewLease = async (): Promise<void> => {
    const owner = await assertOwnership();
    if (owner.processStartMarker) return;
    const leaseExpiresAt = markerlessLeaseExpiry(new Date());
    await runWithPublicationGuard(
      async () => {
        await assertOwnership();
      },
      async () =>
        await writeJson(
          statusScanLockOwnerPath(projectPath),
          MediaOperationLockSchema.parse({...owner, leaseExpiresAt}),
        ),
    );
  };
  let renewalQueue: Promise<void> = Promise.resolve();
  const enqueueRenewal = (): void => {
    const renewal = renewalQueue.then(async () => await renewLease());
    renewalQueue = renewal.then(
      () => undefined,
      (error) => {
        ownershipFailure = asOperationError(error);
      },
    );
  };
  const heartbeat =
    lock.processStartMarker === null
      ? setInterval(() => {
          enqueueRenewal();
        }, MARKERLESS_OPERATION_HEARTBEAT_MS)
      : null;
  heartbeat?.unref();
  try {
    if (await isMediaOperationLockActive(projectPath)) return {acquired: false};
    const value = await scan();
    await assertOwnership();
    return {acquired: true, value};
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await renewalQueue;
    if (!(await releaseStatusScanLock(projectPath, lock.id))) {
      throw mediaOperationOwnershipLost();
    }
    if (ownershipFailure) throw ownershipFailure;
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
        state: 'active',
        pid,
        processStartMarker,
        leaseExpiresAt: processStartMarker ? null : markerlessLeaseExpiry(now),
        acquiredAt: now.toISOString(),
        releasedAt: null,
      };
      try {
        if (!(await claimMediaOperationLock(projectPath, owner))) continue;
        if (await statusScanIsActive(projectPath)) {
          throw new Error(
            'Cannot start a media operation: project status is checking inputs; retry when it completes',
          );
        }
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
    if (owner?.state === 'active' && isProcessIdentityAlive(owner)) {
      if (attempt === LOCK_START_RETRY_LIMIT + (reclaimedOnFinalAttempt ? 1 : 0)) {
        throw new Error('Cannot start a media operation: another media operation is still starting');
      }
      await pause();
      continue;
    }
    if (!owner && (await lockIsInitializing(lockPath))) {
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

const readStoredMediaOperation = async (
  projectPath: string,
): Promise<MediaOperationRecord | null> => {
  try {
    return await readJson(operationPath(projectPath), MediaOperationRecordSchema);
  } catch {
    return null;
  }
};

export const readMediaOperation = async (projectPath: string): Promise<MediaOperationRecord | null> => {
  const record = await readStoredMediaOperation(projectPath);
  return record?.state === 'completed' ? null : record;
};

const assertMediaOperationOwnership = async (
  projectPath: string,
  operationId: string,
): Promise<{record: MediaOperationRecord; lock: MediaOperationLock}> => {
  const [current, owner] = await Promise.all([
    readStoredMediaOperation(projectPath),
    readMediaOperationLock(projectPath),
  ]);
  if (
    !current ||
    current.state !== 'running' ||
    current.id !== operationId ||
    !owner ||
    owner.id !== operationId ||
    owner.state !== 'active' ||
    !isProcessIdentityAlive(owner)
  ) {
    throw mediaOperationOwnershipLost();
  }
  return {record: current, lock: owner};
};

const assertMediaOperationLockOwnership = async (
  projectPath: string,
  operationId: string,
): Promise<void> => {
  const [current, owner] = await Promise.all([
    readStoredMediaOperation(projectPath),
    readMediaOperationLock(projectPath),
  ]);
  if (
    !owner ||
    owner.id !== operationId ||
    owner.state !== 'active' ||
    (current?.state === 'running' &&
      current.id !== operationId &&
      isMediaOperationAlive(current))
  ) {
    throw mediaOperationOwnershipLost();
  }
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
    await runWithPublicationGuard(
      async () => {
        await assertMediaOperationLockOwnership(projectPath, lock.id);
      },
      async () => await writeJson(operationPath(projectPath), record),
    );
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
  await runWithPublicationGuard(
    async () => {
      await assertMediaOperationOwnership(projectPath, operationId);
    },
    async () => {
      await writeJson(
        operationLockOwnerPath(projectPath),
        MediaOperationLockSchema.parse({
          ...lock,
          state: 'active',
          releasedAt: null,
          leaseExpiresAt,
        }),
      );
      await writeJson(operationPath(projectPath), next);
    },
  );
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
  await runWithPublicationGuard(
    async () => {
      await assertMediaOperationOwnership(projectPath, operationId);
    },
    async () => await writeJson(operationPath(projectPath), next),
  );
  if (!(await releaseMediaOperationLock(projectPath, operationId))) {
    throw mediaOperationOwnershipLost();
  }
  return next;
};

export const completeMediaOperation = async (
  projectPath: string,
  operationId: string,
): Promise<void> => {
  const {record} = await assertMediaOperationOwnership(projectPath, operationId);
  const completed = MediaOperationRecordSchema.parse({
    ...record,
    state: 'completed',
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    error: null,
  });
  await runWithPublicationGuard(
    async () => {
      await assertMediaOperationOwnership(projectPath, operationId);
    },
    async () => await writeJson(operationPath(projectPath), completed),
  );
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
    const result = await runWithMediaOperationPublicationGuard(
      operationId,
      assertOwnership,
      async () => await operation({update, assertOwnership}),
    );
    await stopHeartbeat();
    await completeMediaOperation(projectPath, operationId);
    return result;
  } catch (error) {
    const finalizationFailures: unknown[] = [];
    try {
      await stopHeartbeat();
    } catch (failure) {
      finalizationFailures.push(failure);
    }
    try {
      await failMediaOperation(projectPath, operationId, error);
    } catch (failure) {
      if (!(failure instanceof Error) || !/ownership.*lost/i.test(failure.message)) {
        finalizationFailures.push(failure);
      }
    }
    if (finalizationFailures.length > 0) {
      throw new AggregateError(
        [error, ...finalizationFailures],
        'Media operation failed and its failure state could not be finalized',
      );
    }
    throw error;
  }
};

export const isMediaOperationAlive = (record: MediaOperationRecord): boolean => {
  if (record.state !== 'running') return false;
  return isProcessIdentityAlive(record);
};
