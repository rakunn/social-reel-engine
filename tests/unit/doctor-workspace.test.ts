import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  dependencyMaterializationCheck,
  runDoctor,
  storageCapacityCheck,
} from '../../src/commands/doctor';
import {RenderInterruptedError} from '../../src/render/errors';

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

  it('excludes optional LUT and guide roots from the critical materialization scan', async () => {
    const engineRoot = await makeDirectory();
    const runtimeRoot = path.join(engineRoot, 'node_modules/@remotion');
    const lutRoot = path.join(engineRoot, 'library/luts');
    const guideRoot = path.join(engineRoot, 'library/guides');
    await Promise.all(
      [runtimeRoot, lutRoot, guideRoot].map(async (root) => await mkdir(root, {recursive: true})),
    );
    const runProcess = vi.fn(async (_command: string, args: readonly string[]) => ({
      command: '/usr/bin/find',
      args: [...args],
      stdout: args.includes(lutRoot) ? `${lutRoot}/optional.cube\n` : '',
      stderr: '',
      exitCode: 0,
    }));

    await expect(
      dependencyMaterializationCheck(engineRoot, {platform: 'darwin', runProcess}),
    ).resolves.toEqual(
      expect.objectContaining({id: 'dependency-materialization', status: 'pass'}),
    );
    expect(runProcess).toHaveBeenCalledWith(
      '/usr/bin/find',
      expect.not.arrayContaining([lutRoot, guideRoot]),
      expect.objectContaining({allowFailure: true}),
    );
  });

  it('propagates an interrupt nested in dependency-inspection cleanup failure', async () => {
    const engineRoot = await makeDirectory();
    const criticalRoot = path.join(engineRoot, 'node_modules/@remotion');
    await mkdir(criticalRoot, {recursive: true});
    const interruption = new RenderInterruptedError('SIGTERM');
    const aggregate = new AggregateError(
      [interruption, new Error('find cleanup failed')],
      'dependency inspection interrupted during cleanup',
    );

    await expect(
      dependencyMaterializationCheck(engineRoot, {
        platform: 'darwin',
        criticalRoots: [criticalRoot],
        runProcess: async () => {
          throw aggregate;
        },
      }),
    ).rejects.toBe(aggregate);
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

  it('continues runtime and tool probes after recording a storage failure', async () => {
    const report = await runDoctor(repositoryRoot, {
      storageCapacity: {
        statfs: async () => ({bsize: 1024, bavail: 5 * 1024 * 1024}),
      },
      dependencyMaterialization: {platform: 'linux'},
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({id: 'storage-capacity', status: 'fail'}),
    );
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'remotion-runtime'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'ffmpeg'}));
  });

  it('continues safe probes when critical dependency roots are not installed', async () => {
    const report = await runDoctor(repositoryRoot, {
      dependencyMaterialization: {platform: 'darwin', criticalRoots: []},
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({id: 'dependency-materialization', status: 'fail'}),
    );
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'remotion-runtime'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'ffmpeg'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'ffprobe'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'librosa'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'lut-library'}));
  });

  it('continues safe probes when dependency materialization cannot be inspected', async () => {
    const criticalRoot = await makeDirectory();
    const report = await runDoctor(repositoryRoot, {
      dependencyMaterialization: {
        platform: 'darwin',
        criticalRoots: [criticalRoot],
        runProcess: async () => ({
          command: '/usr/bin/find',
          args: [],
          stdout: '',
          stderr: 'operation not permitted',
          exitCode: 1,
        }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'dependency-materialization',
        status: 'fail',
        message: expect.stringMatching(/could not inspect/i),
      }),
    );
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'ffmpeg'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'ffprobe'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'librosa'}));
    expect(report.checks).toContainEqual(expect.objectContaining({id: 'lut-library'}));
  });

  it('stops before runtime probes for a confirmed dataless dependency', async () => {
    const engineRoot = await makeDirectory();
    const criticalRoot = path.join(engineRoot, 'node_modules/@remotion');
    const dataless = path.join(criticalRoot, 'studio/dist/bundle.js');
    await mkdir(criticalRoot, {recursive: true});

    const report = await runDoctor(engineRoot, {
      dependencyMaterialization: {
        platform: 'darwin',
        criticalRoots: [criticalRoot],
        runProcess: async () => ({
          command: '/usr/bin/find',
          args: [],
          stdout: `${dataless}\n`,
          stderr: '',
          exitCode: 0,
        }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({id: 'dependency-materialization', status: 'fail'}),
    );
    expect(report.checks.some((check) => check.id === 'remotion-runtime')).toBe(false);
    expect(report.checks.some((check) => check.id === 'ffmpeg')).toBe(false);
  });
});
