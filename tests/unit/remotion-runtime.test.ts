import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
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
});
