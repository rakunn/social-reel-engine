import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  dependencyMaterializationCheck,
  storageCapacityCheck,
} from '../../src/commands/doctor';

const temporaryDirectories: string[] = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reel-doctor-workspace-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, {recursive: true, force: true})),
  );
});

describe('Doctor workspace preflight', () => {
  it('fails fast when a critical macOS dependency is still dataless', async () => {
    const engineRoot = await makeDirectory();
    const criticalRoot = path.join(engineRoot, 'node_modules/@remotion');
    await mkdir(criticalRoot, {recursive: true});
    const dataless = path.join(criticalRoot, 'studio/dist/bundle.js');
    const runProcess = vi.fn(async () => ({
      command: '/usr/bin/find',
      args: [],
      stdout: `${dataless}\n`,
      stderr: '',
      exitCode: 0,
    }));

    await expect(
      dependencyMaterializationCheck(engineRoot, {
        platform: 'darwin',
        criticalRoots: [criticalRoot],
        runProcess,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'dependency-materialization',
        status: 'fail',
        message: expect.stringMatching(/dataless|offload|materializ/i),
      }),
    );
    expect(runProcess).toHaveBeenCalledWith(
      '/usr/bin/find',
      [criticalRoot, '-flags', '+dataless', '-print', '-quit'],
      expect.objectContaining({allowFailure: true, timeoutMs: 30_000}),
    );
  });

  it('passes when critical dependencies are materialized', async () => {
    const engineRoot = await makeDirectory();
    const criticalRoot = path.join(engineRoot, 'node_modules/@remotion');
    await mkdir(criticalRoot, {recursive: true});

    await expect(
      dependencyMaterializationCheck(engineRoot, {
        platform: 'darwin',
        criticalRoots: [criticalRoot],
        runProcess: async () => ({
          command: '/usr/bin/find',
          args: [],
          stdout: '',
          stderr: '',
          exitCode: 0,
        }),
      }),
    ).resolves.toEqual(
      expect.objectContaining({id: 'dependency-materialization', status: 'pass'}),
    );
  });

  it('classifies available render space into fail, warn, and pass bands', async () => {
    const engineRoot = await makeDirectory();
    const withAvailableGiB = (availableGiB: number) =>
      storageCapacityCheck(engineRoot, {
        statfs: async () => ({bsize: 1024, bavail: availableGiB * 1024 * 1024}),
      });

    await expect(withAvailableGiB(5)).resolves.toEqual(
      expect.objectContaining({id: 'storage-capacity', status: 'fail'}),
    );
    await expect(withAvailableGiB(20)).resolves.toEqual(
      expect.objectContaining({id: 'storage-capacity', status: 'warn'}),
    );
    await expect(withAvailableGiB(100)).resolves.toEqual(
      expect.objectContaining({id: 'storage-capacity', status: 'pass'}),
    );
  });
});
