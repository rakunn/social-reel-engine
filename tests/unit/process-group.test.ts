import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
  listProcessGroupMembers,
  spawnOwnedProcess,
  stopOwnedProcessGroup,
} from '../../src/render/process-group';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(root, 'tests/fixtures/process-tree-worker.ts');
const sentinels: ChildProcess[] = [];
const ownedGroups = new Set<number>();

const killGroupIfPresent = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
};

afterEach(async () => {
  for (const pgid of ownedGroups) {
    killGroupIfPresent(pgid);
  }
  ownedGroups.clear();

  for (const sentinel of sentinels.splice(0)) {
    if (sentinel.pid !== undefined) {
      killGroupIfPresent(sentinel.pid);
    }
  }
});

describe.runIf(process.platform !== 'win32')('owned process groups', () => {
  it('removes only descendants in the owned group', async () => {
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      detached: true,
      stdio: 'ignore',
    });
    sentinels.push(sentinel);

    const owned = spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', fixture, 'leave-child'],
      cwd: root,
    });
    ownedGroups.add(owned.pgid!);
    expect(await owned.closed).toEqual({exitCode: 0, signal: null});
    expect(await listProcessGroupMembers(owned.pgid!)).not.toEqual([]);

    await stopOwnedProcessGroup(owned.pgid!, {
      termMs: 500,
      killMs: 500,
      pollMs: 20,
    });
    ownedGroups.delete(owned.pgid!);

    expect(await listProcessGroupMembers(owned.pgid!)).toEqual([]);
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  });

  it('retains an error exit while cleaning its surviving descendant', async () => {
    const owned = spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', fixture, 'error-exit'],
      cwd: root,
    });
    ownedGroups.add(owned.pgid!);

    expect(await owned.closed).toEqual({exitCode: 7, signal: null});
    expect(await listProcessGroupMembers(owned.pgid!)).not.toEqual([]);
    await stopOwnedProcessGroup(owned.pgid!, {
      termMs: 500,
      killMs: 500,
      pollMs: 20,
    });
    ownedGroups.delete(owned.pgid!);
    expect(await listProcessGroupMembers(owned.pgid!)).toEqual([]);
  });

  it('escalates a stubborn owned descendant to SIGKILL', async () => {
    const owned = spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', fixture, 'ignore-term'],
      cwd: root,
    });
    ownedGroups.add(owned.pgid!);
    await owned.closed;

    await stopOwnedProcessGroup(owned.pgid!, {
      termMs: 50,
      killMs: 500,
      pollMs: 20,
    });
    ownedGroups.delete(owned.pgid!);
    expect(await listProcessGroupMembers(owned.pgid!)).toEqual([]);
  });
});
