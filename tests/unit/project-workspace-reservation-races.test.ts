import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

type Gate = {
  armed: boolean;
  blocked: boolean;
  started: (() => void) | null;
  resume: (() => void) | null;
  wait: Promise<void> | null;
};

const gates = vi.hoisted(() => ({
  markerlessProcess: false,
  reclaimRename: {
    armed: false,
    blocked: false,
    started: null,
    resume: null,
    wait: null,
  } as Gate,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((...args: Parameters<typeof actual.execFileSync>) => {
      if (gates.markerlessProcess) throw new Error('ps unavailable');
      return actual.execFileSync(...args);
    }) as typeof actual.execFileSync,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [fromPath, toPath] = args;
      if (
        gates.reclaimRename.armed &&
        !gates.reclaimRename.blocked &&
        String(fromPath).endsWith('/.project-raced-project.reservation') &&
        String(toPath).includes('.reclaimed-')
      ) {
        gates.reclaimRename.blocked = true;
        gates.reclaimRename.started?.();
        await gates.reclaimRename.wait;
      }
      return await actual.rename(...args);
    },
  };
});

import {
  acquireProjectNameReservation,
  type ProjectNameReservation,
} from '../../src/project/workspace';

const armGate = (gate: Gate): {started: Promise<void>; resume(): void} => {
  gate.armed = true;
  gate.blocked = false;
  gate.wait = new Promise<void>((resolve) => {
    gate.resume = resolve;
  });
  return {
    started: new Promise<void>((resolve) => {
      gate.started = resolve;
    }),
    resume: () => gate.resume?.(),
  };
};

const settleReservation = async (
  promise: Promise<ProjectNameReservation>,
): Promise<
  | {status: 'fulfilled'; value: ProjectNameReservation}
  | {status: 'rejected'; reason: unknown}
> =>
  await promise.then(
    (value) => ({status: 'fulfilled' as const, value}),
    (reason: unknown) => ({status: 'rejected' as const, reason}),
  );

afterEach(() => {
  gates.reclaimRename.resume?.();
  gates.reclaimRename.armed = false;
  gates.reclaimRename.blocked = false;
  gates.reclaimRename.started = null;
  gates.reclaimRename.resume = null;
  gates.reclaimRename.wait = null;
  gates.markerlessProcess = false;
  vi.useRealTimers();
});

describe('project-name reservation races', () => {
  it('renews a markerless reservation for the full ownership lifetime', async () => {
    vi.useFakeTimers();
    gates.markerlessProcess = true;
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-reservation-heartbeat-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const reservation = await acquireProjectNameReservation(projectsRoot, 'long-copy-project');

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const contender = settleReservation(
      acquireProjectNameReservation(projectsRoot, 'long-copy-project'),
    );
    const outcome = await contender;
    try {
      expect(outcome.status).toBe('rejected');
      expect(
        JSON.parse(
          await readFile(
            path.join(projectsRoot, '.project-long-copy-project.reservation/owner.json'),
            'utf8',
          ),
        ).leaseExpiresAt,
      ).toBeTruthy();
    } finally {
      if (outcome.status === 'fulfilled') await outcome.value.release().catch(() => undefined);
      await reservation.release().catch(() => undefined);
    }
  });

  it('does not let a delayed stale reclaimer move a successor reservation', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-reservation-reclaim-race-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const reservationPath = path.join(projectsRoot, '.project-raced-project.reservation');
    await mkdir(reservationPath, {recursive: true});
    await writeFile(
      path.join(reservationPath, 'owner.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'stale-owner',
        pid: 2_147_483_647,
        processStartMarker: null,
        leaseExpiresAt: '2026-08-27T00:00:00.000Z',
        acquiredAt: '2026-08-27T00:00:00.000Z',
      }),
    );

    const reclaimGate = armGate(gates.reclaimRename);
    const firstPromise = settleReservation(
      acquireProjectNameReservation(projectsRoot, 'raced-project'),
    );
    await reclaimGate.started;
    const secondOutcome = await settleReservation(
      acquireProjectNameReservation(projectsRoot, 'raced-project'),
    );
    reclaimGate.resume();
    const firstOutcome = await firstPromise;
    const outcomes = [firstOutcome, secondOutcome];
    try {
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    } finally {
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') await outcome.value.release().catch(() => undefined);
      }
    }
  });
});
