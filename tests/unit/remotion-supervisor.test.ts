import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {finalizeRawRender} from '../../src/render/remotion';
import {
  exitCodeForRenderError,
  RenderInterruptedError,
  superviseRemotionRender,
} from '../../src/render/remotion-supervisor';
import {DEFAULT_RENDER_SETTINGS} from '../../src/render/policy';
import {
  listProcessGroupMembers,
  OwnedProcessCleanupError,
} from '../../src/render/process-group';
import type {RemotionWorkerRequest} from '../../src/render/remotion-worker';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const processTreeFixture = path.join(
  repositoryRoot,
  'tests/fixtures/process-tree-worker.ts',
);
const temporaryDirectories: string[] = [];
const sentinels: ChildProcess[] = [];
const ownedGroups = new Set<number>();

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remotion-supervisor-'));
  temporaryDirectories.push(directory);
  return directory;
};

const makeRequest = (directory: string): RemotionWorkerRequest => ({
  schemaVersion: '1.0.0',
  engineRoot: repositoryRoot,
  publicDir: path.join(directory, 'public'),
  target: 'preview',
  rawOutput: path.join(directory, 'work/render/preview-remotion.mp4'),
  inputProps: {reelName: 'supervisor-test'},
  settings: DEFAULT_RENDER_SETTINGS,
});

const writeWorker = async (directory: string, source: string): Promise<string> => {
  const workerPath = path.join(directory, 'worker.mjs');
  await writeFile(workerPath, source, 'utf8');
  return workerPath;
};

const assertTemporaryProtocolFilesRemoved = async (request: RemotionWorkerRequest) => {
  const files = await readdir(path.dirname(request.rawOutput));
  expect(
    files.filter(
      (file) =>
        file.startsWith('.remotion-worker-') ||
        file.startsWith('.remotion-browser-'),
    ),
  ).toEqual([]);
};

const killGroupIfPresent = (pgid: number): void => {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

afterEach(async () => {
  for (const pgid of ownedGroups) {
    killGroupIfPresent(pgid);
  }
  ownedGroups.clear();
  for (const sentinel of sentinels.splice(0)) {
    if (sentinel.pid !== undefined) killGroupIfPresent(sentinel.pid);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, {recursive: true, force: true});
  }
});

describe.runIf(process.platform !== 'win32')('Remotion process supervisor', () => {
  it('accepts success only after the spawned process group is empty', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const browserPidRecord = path.join(directory, 'browser-pgid.txt');
    const workerEntryPoint = await writeWorker(
      directory,
      `
        import {spawn} from 'node:child_process';
        import {readFileSync, writeFileSync} from 'node:fs';
        const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
        const browser = spawn(
          process.execPath,
          ['--import', 'tsx', ${JSON.stringify(processTreeFixture)}, 'leave-child'],
          {
          detached: true,
          stdio: 'ignore',
          },
        );
        writeFileSync(${JSON.stringify(browserPidRecord)}, String(browser.pid));
        writeFileSync(request.browserLifecycle.pgidPath, String(browser.pid));
        await new Promise((resolve, reject) => {
          browser.once('error', reject);
          browser.once('close', resolve);
        });
        const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
          stdio: 'ignore',
        });
        descendant.unref();
        writeFileSync(process.argv[3], JSON.stringify({schemaVersion: '1.0.0', ok: true}));
      `,
    );
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      detached: true,
      stdio: 'ignore',
    });
    sentinels.push(sentinel);
    let workerPid = 0;
    let thrown: unknown;

    try {
      await superviseRemotionRender(request, {
        workerEntryPoint,
        cleanupTimeouts: {termMs: 500, killMs: 500, pollMs: 20},
        onWorkerSpawn: (pid) => {
          workerPid = pid;
        },
      });
    } catch (error) {
      thrown = error;
    }
    const browserPgid = Number(await readFile(browserPidRecord, 'utf8'));
    ownedGroups.add(browserPgid);

    expect(thrown).toBeUndefined();
    expect(workerPid).toBeGreaterThan(0);
    expect(await listProcessGroupMembers(workerPid)).toEqual([]);
    expect(await listProcessGroupMembers(browserPgid)).toEqual([]);
    ownedGroups.delete(browserPgid);
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('cleans the spawned group when setup fails after spawn', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const workerEntryPoint = await writeWorker(
      directory,
      `setInterval(() => undefined, 1_000);`,
    );
    let workerPid = 0;

    await expect(
      superviseRemotionRender(request, {
        workerEntryPoint,
        cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 20},
        onWorkerSpawn: (pid) => {
          workerPid = pid;
          ownedGroups.add(pid);
          throw new Error('spawn observer failed');
        },
      }),
    ).rejects.toThrow(/spawn observer failed/);

    expect(workerPid).toBeGreaterThan(0);
    expect(await listProcessGroupMembers(workerPid)).toEqual([]);
    ownedGroups.delete(workerPid);
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('retains worker stderr in a schema-reported render error', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const workerEntryPoint = await writeWorker(
      directory,
      `
        import {writeFileSync} from 'node:fs';
        process.stderr.write('fixture stderr\\n');
        writeFileSync(process.argv[3], JSON.stringify({
          schemaVersion: '1.0.0',
          ok: false,
          signal: null,
          error: {message: 'worker exploded', stack: null},
        }));
        process.exitCode = 1;
      `,
    );

    await expect(
      superviseRemotionRender(request, {workerEntryPoint}),
    ).rejects.toThrow(/worker exploded[\s\S]*fixture stderr/);
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('combines a worker failure with exact process-group cleanup diagnostics', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const workerEntryPoint = await writeWorker(
      directory,
      `
        process.stderr.write('render failed before cleanup\\n');
        process.exitCode = 1;
      `,
    );
    let workerPid = 0;
    const cleanupPgids: number[] = [];
    let thrown: unknown;

    try {
      await superviseRemotionRender(
        request,
        {
          workerEntryPoint,
          onWorkerSpawn: (pid) => {
            workerPid = pid;
          },
        },
        {
          stopOwnedProcessGroup: async (pgid) => {
            cleanupPgids.push(pgid);
            throw new OwnedProcessCleanupError(pgid, [
              {
                pid: pgid + 1,
                ppid: 1,
                pgid,
                state: 'UE',
                command: '/owned/remotion-descendant',
              },
            ]);
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(cleanupPgids).toEqual([workerPid]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect(String(thrown)).toContain('render and owned-process cleanup both failed');
    expect((thrown as AggregateError).errors.map(String).join('\n')).toMatch(
      /render failed before cleanup[\s\S]*UE[\s\S]*owned\/remotion-descendant/,
    );
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('forwards interruption, cleans its exact group, and removes signal listeners', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const workerEntryPoint = await writeWorker(
      directory,
      `setInterval(() => undefined, 1_000);`,
    );
    const signalTarget = new EventEmitter();
    let workerPid = 0;
    const running = superviseRemotionRender(request, {
      workerEntryPoint,
      gracefulCancelMs: 50,
      cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 20},
      signalTarget,
      onWorkerSpawn: (pid) => {
        workerPid = pid;
        queueMicrotask(() => signalTarget.emit('SIGTERM'));
      },
    });

    await expect(running).rejects.toEqual(expect.any(RenderInterruptedError));
    expect(workerPid).toBeGreaterThan(0);
    expect(await listProcessGroupMembers(workerPid)).toEqual([]);
    expect(signalTarget.listenerCount('SIGINT')).toBe(0);
    expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
    expect(signalTarget.listenerCount('SIGHUP')).toBe(0);
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('does not lose an interrupt that arrives while verifying cleanup', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const workerEntryPoint = await writeWorker(
      directory,
      `
        import {writeFileSync} from 'node:fs';
        writeFileSync(process.argv[3], JSON.stringify({schemaVersion: '1.0.0', ok: true}));
      `,
    );
    const signalTarget = new EventEmitter();

    await expect(
      superviseRemotionRender(
        request,
        {workerEntryPoint, signalTarget},
        {
          stopOwnedProcessGroup: async () => {
            signalTarget.emit('SIGTERM');
          },
        },
      ),
    ).rejects.toEqual(expect.any(RenderInterruptedError));
    expect(signalTarget.listenerCount('SIGTERM')).toBe(0);
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('forwards graceful SIGTERM while preserving an original SIGINT', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const readyPath = path.join(directory, 'worker-ready');
    const receivedPath = path.join(directory, 'worker-signal');
    const workerEntryPoint = await writeWorker(
      directory,
      `
        import {writeFileSync} from 'node:fs';
        const timer = setInterval(() => undefined, 1_000);
        const finish = (signal) => {
          writeFileSync(${JSON.stringify(receivedPath)}, signal);
          clearInterval(timer);
        };
        process.once('SIGTERM', () => finish('SIGTERM'));
        process.once('SIGINT', () => finish('SIGINT'));
        writeFileSync(${JSON.stringify(readyPath)}, 'ready');
      `,
    );
    const signalTarget = new EventEmitter();
    const running = superviseRemotionRender(request, {
      workerEntryPoint,
      gracefulCancelMs: 500,
      cleanupTimeouts: {termMs: 100, killMs: 500, pollMs: 20},
      signalTarget,
    });

    await vi.waitFor(async () => {
      expect(await readFile(readyPath, 'utf8')).toBe('ready');
    });
    signalTarget.emit('SIGINT');

    await expect(running).rejects.toMatchObject({signal: 'SIGINT', exitCode: 130});
    expect(await readFile(receivedPath, 'utf8')).toBe('SIGTERM');
    await assertTemporaryProtocolFilesRemoved(request);
  });

  it('passes the compositor environment to the Remotion worker without mutating the parent process', async () => {
    const directory = await makeTemporaryDirectory();
    const request = makeRequest(directory);
    const workerEntryPoint = await writeWorker(
      directory,
      `
        import {writeFileSync} from 'node:fs';
        if (process.env.DYLD_LIBRARY_PATH !== '/fixture/compositor') {
          throw new Error('worker did not receive compositor library path');
        }
        writeFileSync(process.argv[3], JSON.stringify({schemaVersion: '1.0.0', ok: true}));
      `,
    );

    await expect(
      superviseRemotionRender(request, {
        workerEntryPoint,
        environment: {...process.env, DYLD_LIBRARY_PATH: '/fixture/compositor'},
      }, {
        stopOwnedProcessGroup: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(process.env.DYLD_LIBRARY_PATH).not.toBe('/fixture/compositor');
    await assertTemporaryProtocolFilesRemoved(request);
  });
});

describe('render artifact lifecycle boundary', () => {
  it('post-processes and records only after worker cleanup succeeds', async () => {
    const root = await makeTemporaryDirectory();
    const rawOutput = path.join(root, 'work/render/preview-remotion.mp4');
    const outputLocation = path.join(root, 'preview.mp4');
    await mkdir(path.dirname(rawOutput), {recursive: true});
    await writeFile(rawOutput, 'raw');
    const calls: string[] = [];

    await finalizeRawRender(
      {
        projectPath: root,
        target: 'preview',
        rawOutput,
        outputLocation,
        fingerprint: 'fingerprint',
        workerRequest: {rawOutput} as never,
      },
      {
        supervise: async (request) => {
          calls.push('worker');
          await writeFile(request.rawOutput, 'raw');
        },
        runFfmpeg: async (args) => {
          calls.push('post-process');
          await writeFile(args.at(-1)!, 'post-processed');
          return {command: 'ffmpeg', args: [], stdout: '', stderr: '', exitCode: 0};
        },
        recordArtifact: async () => {
          calls.push('record');
          return {} as never;
        },
        probeFile: async () => ({}) as never,
      },
    );

    expect(calls).toEqual(['worker', 'post-process', 'record']);
    await expect(readFile(rawOutput, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('does not post-process or record after cleanup failure', async () => {
    const root = await makeTemporaryDirectory();
    const postProcess = vi.fn();
    const recordArtifact = vi.fn();

    await expect(
      finalizeRawRender(
        {
          projectPath: root,
          target: 'master',
          rawOutput: path.join(root, 'work/render/master-remotion.mov'),
          outputLocation: path.join(root, 'output/master.mov'),
          fingerprint: 'fingerprint',
          workerRequest: {} as never,
        },
        {
          supervise: async () => {
            throw new Error('process group 4102 did not exit');
          },
          runFfmpeg: postProcess,
          recordArtifact,
        },
      ),
    ).rejects.toThrow(/4102/);
    expect(postProcess).not.toHaveBeenCalled();
    expect(recordArtifact).not.toHaveBeenCalled();
  });

  it('keeps an existing final output when post-processing fails', async () => {
    const root = await makeTemporaryDirectory();
    const rawOutput = path.join(root, 'work/render/preview-remotion.mp4');
    const outputLocation = path.join(root, 'preview.mp4');
    await mkdir(path.dirname(rawOutput), {recursive: true});
    await writeFile(outputLocation, 'known-good-preview');
    const recordArtifact = vi.fn();

    await expect(
      finalizeRawRender(
        {
          projectPath: root,
          target: 'preview',
          rawOutput,
          outputLocation,
          fingerprint: 'fingerprint',
          workerRequest: {rawOutput} as never,
        },
        {
          supervise: async (request: RemotionWorkerRequest) => {
            await writeFile(request.rawOutput, 'raw-render');
          },
          runFfmpeg: async (args: readonly string[]) => {
            await writeFile(args.at(-1)!, 'partial-preview');
            throw new Error('post-processing failed');
          },
          recordArtifact,
          probeFile: async () => ({}) as never,
        } as never,
      ),
    ).rejects.toThrow('post-processing failed');

    await expect(readFile(outputLocation, 'utf8')).resolves.toBe('known-good-preview');
    await expect(readFile(rawOutput, 'utf8')).resolves.toBe('raw-render');
    expect(recordArtifact).not.toHaveBeenCalled();
  });

  it('retains the raw render when artifact publication fails', async () => {
    const root = await makeTemporaryDirectory();
    const rawOutput = path.join(root, 'work/render/master-remotion.mov');
    const outputLocation = path.join(root, 'output/master.mov');

    await expect(
      finalizeRawRender(
        {
          projectPath: root,
          target: 'master',
          rawOutput,
          outputLocation,
          fingerprint: 'fingerprint',
          workerRequest: {rawOutput} as never,
        },
        {
          supervise: async (request: RemotionWorkerRequest) => {
            await writeFile(request.rawOutput, 'raw-render');
          },
          runFfmpeg: async (args: readonly string[]) => {
            await writeFile(args.at(-1)!, 'post-processed');
            return {command: 'ffmpeg', args: [], stdout: '', stderr: '', exitCode: 0};
          },
          probeFile: async () => ({}) as never,
          recordArtifact: async () => {
            throw new Error('artifact publication failed');
          },
        },
      ),
    ).rejects.toThrow('artifact publication failed');

    await expect(readFile(rawOutput, 'utf8')).resolves.toBe('raw-render');
  });

  it('maps render interruptions to conventional exit codes', () => {
    expect(exitCodeForRenderError(new RenderInterruptedError('SIGINT'))).toBe(130);
    expect(exitCodeForRenderError(new RenderInterruptedError('SIGTERM'))).toBe(143);
    expect(exitCodeForRenderError(new RenderInterruptedError('SIGHUP'))).toBe(129);
    expect(exitCodeForRenderError(new Error('render failed'))).toBe(1);
    expect(
      exitCodeForRenderError(
        new AggregateError(
          [new Error('cleanup failed'), new RenderInterruptedError('SIGINT')],
          'render and cleanup failed',
        ),
      ),
    ).toBe(130);
  });
});
