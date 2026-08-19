import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
  ProcessAbortedError,
  ProcessExecutionError,
  ProcessTimeoutError,
  runProcess,
} from '../../src/media/process';
import {RenderInterruptedError} from '../../src/render/errors';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(root, 'tests/fixtures/process-runner-tree.ts');
const leakedPids = new Set<number>();
const sentinels: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

const killPidIfPresent = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const pidFrom = (output: string, label: 'group' | 'child'): number => {
  const match = output.match(new RegExp(`${label}:(\\d+)`));
  if (match === null) throw new Error(`Missing ${label} PID in fixture output: ${output}`);
  return Number(match[1]);
};

const waitForPath = async (filePath: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

afterEach(async () => {
  for (const pid of leakedPids) killPidIfPresent(pid);
  leakedPids.clear();
  for (const sentinel of sentinels.splice(0)) {
    if (sentinel.pid !== undefined) killPidIfPresent(sentinel.pid);
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, {recursive: true, force: true})),
  );
});

describe.runIf(process.platform !== 'win32')('owned media process execution', () => {
  it('rejects a missing executable without emitting an unhandled child error', async () => {
    await expect(
      runProcess(path.join(root, 'does-not-exist'), []),
    ).rejects.toThrow(/failed to spawn|enoent/i);
  });

  it('bounds captured output while preserving its tail', async () => {
    const result = await runProcess(
      process.execPath,
      ['-e', "process.stdout.write('prefix-' + 'x'.repeat(512) + '-tail')"],
      {maxOutputBytes: 32},
    );

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32);
    expect(result.stdout).toMatch(/-tail$/);
  });

  it('times out an idle command and cleans its exact group', async () => {
    let thrown: unknown;
    try {
      await runProcess(
        process.execPath,
        ['--import', 'tsx', fixture, 'idle-then-exit'],
        {
          idleTimeoutMs: 40,
          cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 10},
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProcessTimeoutError);
    const timeout = thrown as ProcessTimeoutError;
    expect(timeout.kind).toBe('idle');
    expect(() => process.kill(-timeout.pgid!, 0)).toThrow(
      expect.objectContaining({code: 'ESRCH'}),
    );
  });

  it('enforces an explicit wall-clock timeout independently of output', async () => {
    await expect(
      runProcess(
        process.execPath,
        [
          '-e',
          "process.stdout.write('.'); const timer = setInterval(() => process.stdout.write('.'), 10); setTimeout(() => { clearInterval(timer); }, 2_000)",
        ],
        {
          timeoutMs: 500,
          cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 10},
        },
      ),
    ).rejects.toMatchObject({
      name: ProcessTimeoutError.name,
      kind: 'wall',
      stdout: expect.stringMatching(/\./),
      message: expect.stringMatching(/\n\.+$/),
    });
  });

  it('honors an AbortSignal and reports the command context', async () => {
    const controller = new AbortController();
    const running = runProcess(
      process.execPath,
      ['--import', 'tsx', fixture, 'idle-then-exit'],
      {
        signal: controller.signal,
        cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 10},
      },
    );
    setTimeout(() => controller.abort('test cancellation'), 40);

    await expect(running).rejects.toMatchObject({
      name: ProcessAbortedError.name,
      command: process.execPath,
      args: expect.arrayContaining(['idle-then-exit']),
    });
  });

  it('forwards parent interruption into cleanup and removes its listeners', async () => {
    const signalTarget = new EventEmitter();
    const running = runProcess(
      process.execPath,
      ['--import', 'tsx', fixture, 'idle-then-exit'],
      {
        signalTarget,
        cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 10},
      },
    );
    setTimeout(() => signalTarget.emit('SIGINT'), 40);

    await expect(running).rejects.toEqual(expect.any(RenderInterruptedError));
    expect(signalTarget.listenerCount('SIGINT')).toBe(0);
    expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
    expect(signalTarget.listenerCount('SIGHUP')).toBe(0);
  });

  it('keeps interruption handlers installed through surviving-descendant cleanup', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'reel-media-process-'));
    temporaryDirectories.push(directory);
    const cleanupMarker = path.join(directory, 'cleanup-started');
    const signalTarget = new EventEmitter();
    const running = runProcess(
      process.execPath,
      ['--import', 'tsx', fixture, 'leave-stubborn-child', cleanupMarker],
      {
        signalTarget,
        cleanupTimeouts: {termMs: 500, killMs: 500, pollMs: 10},
      },
    );

    await waitForPath(cleanupMarker);
    signalTarget.emit('SIGINT');

    await expect(running).rejects.toEqual(expect.any(RenderInterruptedError));
    expect(signalTarget.listenerCount('SIGINT')).toBe(0);
    expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
    expect(signalTarget.listenerCount('SIGHUP')).toBe(0);
  });

  it('cleans a surviving descendant without touching an unrelated process', async () => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
      detached: true,
      stdio: 'ignore',
    });
    sentinels.push(sentinel);

    const result = await runProcess(
      process.execPath,
      ['--import', 'tsx', fixture, 'leave-child'],
      {cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 10}},
    );
    const groupPid = pidFrom(result.stdout, 'group');
    const childPid = pidFrom(result.stdout, 'child');
    leakedPids.add(childPid);

    expect(() => process.kill(-groupPid, 0)).toThrow(
      expect.objectContaining({code: 'ESRCH'}),
    );
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({code: 'ESRCH'}));
    leakedPids.delete(childPid);
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  });

  it('retains a non-zero exit while cleaning descendants on the failure path', async () => {
    let thrown: unknown;
    try {
      await runProcess(
        process.execPath,
        ['--import', 'tsx', fixture, 'leave-child-error'],
        {cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 10}},
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProcessExecutionError);
    const failure = thrown as ProcessExecutionError;
    const groupPid = pidFrom(failure.stdout, 'group');
    const childPid = pidFrom(failure.stdout, 'child');
    leakedPids.add(childPid);
    expect(failure.exitCode).toBe(7);
    expect(() => process.kill(-groupPid, 0)).toThrow(
      expect.objectContaining({code: 'ESRCH'}),
    );
    expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({code: 'ESRCH'}));
    leakedPids.delete(childPid);
  });
});
