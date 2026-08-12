import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {RenderInterruptedError} from '../../src/render/errors';
import {
  checkRemotionRuntime,
  resolveRemotionRuntime,
} from '../../src/render/remotion-runtime';

const temporaryDirectories: string[] = [];

const makeCompositorFixture = async (): Promise<{
  root: string;
  packageJson: string;
  ffprobe: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-remotion-runtime-'));
  temporaryDirectories.push(root);
  const compositor = path.join(root, 'node_modules/@remotion/compositor-darwin-arm64');
  await mkdir(compositor, {recursive: true});
  const packageJson = path.join(compositor, 'package.json');
  const ffprobe = path.join(compositor, 'ffprobe');
  await writeFile(packageJson, '{"name":"@remotion/compositor-darwin-arm64"}\n');
  await writeFile(ffprobe, '#!/bin/sh\nprintf "ffprobe version fixture\\n"\n');
  return {root, packageJson, ffprobe};
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      await rm(directory, {recursive: true, force: true}),
    ),
  );
});

describe('Remotion compositor runtime', () => {
  it('resolves the macOS compositor and prepends its directory only for the worker', async () => {
    const fixture = await makeCompositorFixture();
    const runtime = await resolveRemotionRuntime(fixture.root, {
      platform: 'darwin',
      arch: 'arm64',
      environment: {PATH: '/usr/bin', DYLD_LIBRARY_PATH: '/existing/libraries'},
      resolvePackage: () => fixture.packageJson,
    });

    expect(runtime).toMatchObject({
      compositorPackage: '@remotion/compositor-darwin-arm64',
      compositorDirectory: path.dirname(fixture.packageJson),
      ffprobePath: fixture.ffprobe,
    });
    expect(runtime.workerEnvironment).toEqual({
      PATH: '/usr/bin',
      DYLD_LIBRARY_PATH: `${path.dirname(fixture.packageJson)}${path.delimiter}/existing/libraries`,
    });
  });

  it('reports an actionable preflight failure when bundled ffprobe cannot start', async () => {
    const fixture = await makeCompositorFixture();
    const runProcess = vi.fn().mockResolvedValue({
      command: fixture.ffprobe,
      args: ['-hide_banner', '-version'],
      stdout: '',
      stderr: 'dyld: Library not loaded: libavcodec.dylib',
      exitCode: 1,
    });

    const check = await checkRemotionRuntime(fixture.root, {
      runtime: {
        platform: 'darwin',
        arch: 'arm64',
        resolvePackage: () => fixture.packageJson,
      },
      runProcess,
    });

    expect(runProcess).toHaveBeenCalledWith(
      fixture.ffprobe,
      ['-hide_banner', '-version'],
      expect.objectContaining({
        allowFailure: true,
        env: expect.objectContaining({
          DYLD_LIBRARY_PATH: expect.stringContaining(path.dirname(fixture.packageJson)),
        }),
      }),
    );
    expect(check).toEqual(
      expect.objectContaining({
        ok: false,
        message: expect.stringMatching(/Remotion compositor ffprobe.*DYLD_LIBRARY_PATH/i),
      }),
    );
  });

  it('propagates an interrupt nested in compositor cleanup failure', async () => {
    const fixture = await makeCompositorFixture();
    const interruption = new RenderInterruptedError('SIGINT');
    const aggregate = new AggregateError(
      [new Error('ffprobe cleanup failed'), interruption],
      'ffprobe interrupted during cleanup',
    );

    await expect(
      checkRemotionRuntime(fixture.root, {
        runtime: {
          platform: 'darwin',
          arch: 'arm64',
          resolvePackage: () => fixture.packageJson,
        },
        runProcess: vi.fn().mockRejectedValue(aggregate),
      }),
    ).rejects.toBe(aggregate);
  });

  it('falls back to the runnable Linux musl compositor when GNU ffprobe fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reel-remotion-linux-runtime-'));
    temporaryDirectories.push(root);
    const gnuDirectory = path.join(root, 'node_modules/@remotion/compositor-linux-x64-gnu');
    const muslDirectory = path.join(root, 'node_modules/@remotion/compositor-linux-x64-musl');
    const gnuPackage = path.join(gnuDirectory, 'package.json');
    const muslPackage = path.join(muslDirectory, 'package.json');
    await Promise.all([
      mkdir(gnuDirectory, {recursive: true}),
      mkdir(muslDirectory, {recursive: true}),
    ]);
    await Promise.all([
      writeFile(gnuPackage, '{"name":"@remotion/compositor-linux-x64-gnu"}\n'),
      writeFile(muslPackage, '{"name":"@remotion/compositor-linux-x64-musl"}\n'),
      writeFile(path.join(gnuDirectory, 'ffprobe'), 'gnu fixture\n'),
      writeFile(path.join(muslDirectory, 'ffprobe'), 'musl fixture\n'),
    ]);
    const runProcess = vi.fn(async (command: string) => ({
      command,
      args: [],
      stdout: command.includes('-musl/') ? 'ffprobe version musl fixture' : '',
      stderr: command.includes('-musl/') ? '' : 'not runnable on musl',
      exitCode: command.includes('-musl/') ? 0 : 1,
    }));

    const check = await checkRemotionRuntime(root, {
      runtime: {
        platform: 'linux',
        arch: 'x64',
        resolvePackage: (request) => {
          if (request.includes('-gnu/package.json')) return gnuPackage;
          if (request.includes('-musl/package.json')) return muslPackage;
          throw new Error(`Unexpected package request: ${request}`);
        },
      },
      runProcess,
    });

    expect(check).toMatchObject({
      ok: true,
      runtime: {compositorPackage: '@remotion/compositor-linux-x64-musl'},
    });
    expect(runProcess).toHaveBeenCalledTimes(2);
  });

  it('resolves the bundled Windows compositor executable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reel-remotion-windows-runtime-'));
    temporaryDirectories.push(root);
    const compositor = path.join(root, 'node_modules/@remotion/compositor-win32-x64-msvc');
    const packageJson = path.join(compositor, 'package.json');
    const ffprobe = path.join(compositor, 'ffprobe.exe');
    await mkdir(compositor, {recursive: true});
    await Promise.all([
      writeFile(packageJson, '{"name":"@remotion/compositor-win32-x64-msvc"}\n'),
      writeFile(ffprobe, 'windows ffprobe fixture\n'),
    ]);

    const runtime = await resolveRemotionRuntime(root, {
      platform: 'win32',
      arch: 'x64',
      environment: {PATH: 'C:\\Windows\\System32'},
      resolvePackage: () => packageJson,
    });

    expect(runtime).toMatchObject({
      compositorPackage: '@remotion/compositor-win32-x64-msvc',
      compositorDirectory: compositor,
      ffprobePath: ffprobe,
      workerEnvironment: {PATH: 'C:\\Windows\\System32'},
    });
  });
});
