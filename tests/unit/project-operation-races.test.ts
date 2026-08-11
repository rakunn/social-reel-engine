import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
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
  owner: {armed: false, blocked: false, started: null, resume: null, wait: null} as Gate,
  statusOwner: {armed: false, blocked: false, started: null, resume: null, wait: null} as Gate,
  statusRenewal: {armed: false, blocked: false, started: null, resume: null, wait: null} as Gate,
  operationRecord: {armed: false, blocked: false, started: null, resume: null, wait: null} as Gate,
  markerlessProcess: false,
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
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [filePath] = args;
      if (
        gates.owner.armed &&
        !gates.owner.blocked &&
        String(filePath).endsWith('/analysis/operation.lock/owner.json')
      ) {
        gates.owner.blocked = true;
        gates.owner.started?.();
        await gates.owner.wait;
      }
      if (
        gates.statusOwner.armed &&
        !gates.statusOwner.blocked &&
        String(filePath).includes('/analysis/status-scan.lock/owner.json')
      ) {
        gates.statusOwner.blocked = true;
        gates.statusOwner.started?.();
        await gates.statusOwner.wait;
      }
      return await actual.writeFile(...args);
    },
  };
});

vi.mock('../../src/core/json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/json')>();
  return {
    ...actual,
    writeJson: async (...args: Parameters<typeof actual.writeJson>) => {
      const [filePath] = args;
      if (
        gates.operationRecord.armed &&
        !gates.operationRecord.blocked &&
        String(filePath).endsWith('/analysis/operation.json')
      ) {
        gates.operationRecord.blocked = true;
        gates.operationRecord.started?.();
        await gates.operationRecord.wait;
      }
      if (
        gates.statusRenewal.armed &&
        !gates.statusRenewal.blocked &&
        String(filePath).includes('/analysis/status-scan.lock/owner.json')
      ) {
        gates.statusRenewal.blocked = true;
        gates.statusRenewal.started?.();
        await gates.statusRenewal.wait;
      }
      return await actual.writeJson(...args);
    },
  };
});

import {
  beginMediaOperation,
  completeMediaOperation,
  failMediaOperation,
  readMediaOperation,
  runWithStatusScanLock,
} from '../../src/project/operation';
import {getProjectStatus} from '../../src/project/workspace';

const temporaryProjects: string[] = [];

const makeProject = async (): Promise<string> => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-operation-race-'));
  await Promise.all([
    mkdir(path.join(projectPath, 'analysis'), {recursive: true}),
    mkdir(path.join(projectPath, 'config'), {recursive: true}),
    mkdir(path.join(projectPath, 'edits'), {recursive: true}),
  ]);
  await Promise.all([
    writeFile(path.join(projectPath, 'brief.json'), '{}\n'),
    writeFile(path.join(projectPath, 'edits/edit.json'), '{}\n'),
  ]);
  temporaryProjects.push(projectPath);
  return projectPath;
};

const armGate = (gate: Gate): {started: Promise<void>; resume: () => void} => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release!: () => void;
  gate.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.armed = true;
  gate.blocked = false;
  gate.started = markStarted;
  gate.resume = release;
  return {started, resume: release};
};

const resetGate = (gate: Gate): void => {
  gate.resume?.();
  gate.armed = false;
  gate.blocked = false;
  gate.started = null;
  gate.resume = null;
  gate.wait = null;
};

afterEach(async () => {
  resetGate(gates.owner);
  resetGate(gates.statusOwner);
  resetGate(gates.statusRenewal);
  resetGate(gates.operationRecord);
  gates.markerlessProcess = false;
  vi.useRealTimers();
  await Promise.all(
    temporaryProjects.splice(0).map(async (projectPath) =>
      await rm(projectPath, {recursive: true, force: true}),
    ),
  );
});

describe('media-operation publication races', () => {
  it('reports an ownerless retry lock as starting while it publishes its owner', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'proxy', {
      now: new Date(0),
      pid: process.pid,
      processStartMarker: null,
      phase: 'interrupted-proxy',
    });
    const ownerGate = armGate(gates.owner);
    const retry = beginMediaOperation(projectPath, 'render', {
      pid: process.pid,
      processStartMarker: null,
      phase: 'starting-render',
    });

    await ownerGate.started;
    try {
      await expect(getProjectStatus(projectPath)).resolves.toMatchObject({
        stage: 'media-in-progress',
        nextAction: expect.stringMatching(/starting/i),
      });
    } finally {
      ownerGate.resume();
      const operation = await retry;
      await completeMediaOperation(projectPath, operation.id!);
    }
  });

  it('reports a retry as starting instead of its stale predecessor', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'proxy', {
      now: new Date(0),
      pid: process.pid,
      processStartMarker: null,
      phase: 'interrupted-proxy',
    });
    const recordGate = armGate(gates.operationRecord);
    const retry = beginMediaOperation(projectPath, 'render', {
      pid: process.pid,
      processStartMarker: null,
      phase: 'starting-render',
    });

    await recordGate.started;
    try {
      await expect(getProjectStatus(projectPath)).resolves.toMatchObject({
        stage: 'media-in-progress',
        nextAction: expect.stringMatching(/starting/i),
      });
    } finally {
      recordGate.resume();
      const operation = await retry;
      await completeMediaOperation(projectPath, operation.id!);
    }
  });

  it('does not scan after delayed status-owner publication loses its claim', async () => {
    const projectPath = await makeProject();
    const statusOwnerGate = armGate(gates.statusOwner);
    const first = runWithStatusScanLock(projectPath, async () => 'first');
    void first.catch(() => undefined);

    await statusOwnerGate.started;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const second = runWithStatusScanLock(projectPath, async () => {
      markSecondStarted();
      await release;
      return 'second';
    });

    await secondStarted;
    statusOwnerGate.resume();
    try {
      await expect(first).resolves.toEqual({acquired: false});
    } finally {
      releaseSecond();
      await second.catch(() => undefined);
    }
  });

  it('does not let a producer displace an initializing status lock', async () => {
    const projectPath = await makeProject();
    const statusOwnerGate = armGate(gates.statusOwner);
    const statusScan = runWithStatusScanLock(projectPath, async () => 'scanned');
    void statusScan.catch(() => undefined);

    await statusOwnerGate.started;
    const producer = beginMediaOperation(projectPath, 'proxy', {
      pid: process.pid,
      phase: 'starting-proxy',
    });
    try {
      await expect(producer).rejects.toThrow(/status is checking inputs/i);
    } finally {
      statusOwnerGate.resume();
      await producer
        .then(async (operation) => await completeMediaOperation(projectPath, operation.id!))
        .catch(() => undefined);
      await statusScan.catch(() => undefined);
    }
  });

  it('drains a markerless status lease renewal before releasing the lock', async () => {
    vi.useFakeTimers();
    gates.markerlessProcess = true;
    const projectPath = await makeProject();
    let releaseScan!: () => void;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const statusScan = runWithStatusScanLock(projectPath, async () => {
      markScanStarted();
      await scanRelease;
      return 'scanned';
    });

    await scanStarted;
    const renewalGate = armGate(gates.statusRenewal);
    await vi.advanceTimersByTimeAsync(100_000);
    await renewalGate.started;
    releaseScan();

    let settled = false;
    void statusScan.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    renewalGate.resume();
    await expect(statusScan).resolves.toEqual({acquired: true, value: 'scanned'});
    await expect(
      readFile(path.join(projectPath, 'analysis/status-scan.lock/owner.json'), 'utf8'),
    ).resolves.toContain('"state": "released"');
  });

  it('returns media-in-progress without scanning during producer record publication', async () => {
    const projectPath = await makeProject();
    const recordGate = armGate(gates.operationRecord);
    const starting = beginMediaOperation(projectPath, 'proxy', {
      pid: process.pid,
      phase: 'starting-proxy',
    });

    await recordGate.started;
    await expect(getProjectStatus(projectPath)).resolves.toMatchObject({
      stage: 'media-in-progress',
      nextAction: expect.stringMatching(/starting/i),
    });
    recordGate.resume();

    const operation = await starting;
    await completeMediaOperation(projectPath, operation.id!);
  });

  it('does not let a delayed owner write replace a retry lock', async () => {
    const projectPath = await makeProject();
    const ownerGate = armGate(gates.owner);
    const delayed = beginMediaOperation(projectPath, 'proxy', {
      pid: process.pid,
      phase: 'starting-proxy',
    });

    await ownerGate.started;
    const successor = await beginMediaOperation(projectPath, 'render', {
      pid: process.pid,
      phase: 'starting-render',
    });
    ownerGate.resume();

    await expect(delayed).rejects.toThrow(/already active/i);
    await expect(readMediaOperation(projectPath)).resolves.toMatchObject({
      id: successor.id,
      command: 'render',
      state: 'running',
    });
    await expect(
      readFile(path.join(projectPath, 'analysis/operation.lock/owner.json'), 'utf8'),
    ).resolves.toContain(successor.id!);
    await completeMediaOperation(projectPath, successor.id!);
  });

  it('does not let a delayed failure replace a retry record', async () => {
    const projectPath = await makeProject();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const interrupted = await beginMediaOperation(projectPath, 'proxy', {
        now: new Date(0),
        pid: process.pid,
        processStartMarker: null,
        phase: 'transcoding',
      });
      const recordGate = armGate(gates.operationRecord);
      const failure = failMediaOperation(
        projectPath,
        interrupted.id!,
        new Error('late proxy failure'),
        new Date(0),
      );

      await recordGate.started;
      clock.mockReturnValue(5 * 60_000 + 1);
      const successor = await beginMediaOperation(projectPath, 'render', {
        now: new Date(5 * 60_000 + 1),
        pid: process.pid,
        processStartMarker: null,
        phase: 'rendering-master',
      });
      recordGate.resume();

      await expect(failure).rejects.toThrow(/ownership.*lost/i);
      await expect(readMediaOperation(projectPath)).resolves.toMatchObject({
        id: successor.id,
        command: 'render',
        state: 'running',
      });
      await completeMediaOperation(projectPath, successor.id!);
    } finally {
      clock.mockRestore();
    }
  });
});
