import {spawn, type ChildProcess} from 'node:child_process';
import type {Readable} from 'node:stream';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {prepareSyntheticReel, runSyntheticE2e} from '../../scripts/synthetic-e2e';
import {writeJson} from '../../src/core/json';
import {readRenderSettings} from '../../src/render/policy';
import {stopOwnedProcessGroup} from '../../src/render/process-group';
import {prepareRenderProps} from '../../src/render/stage';
import {
  describeProcessInventory,
  listRemotionProcessInventory,
  newProcessIds,
  type RemotionProcessInventoryEntry,
} from '../helpers/remotion-process-inventory';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runners = new Set<ChildProcess>();
const workerGroups = new Set<number>();

const waitForOutput = async (
  stream: Readable,
  expected: string,
  timeoutMs: number,
): Promise<string> =>
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}; output so far:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Stream ended before ${expected}; output:\n${output}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });

const waitForClose = async (
  child: ChildProcess,
): Promise<{exitCode: number | null; signal: NodeJS.Signals | null}> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {exitCode: child.exitCode, signal: child.signalCode};
  }
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
  });
};

const expectNoNewProcesses = (
  label: string,
  baseline: RemotionProcessInventoryEntry[],
  observed: RemotionProcessInventoryEntry[],
): void => {
  const added = newProcessIds(baseline, observed);
  expect(
    added,
    `${label} left new Remotion processes.\nBaseline:\n${describeProcessInventory(
      baseline,
    )}\nObserved:\n${describeProcessInventory(observed)}`,
  ).toEqual([]);
};

const waitForOwnedBrowser = async (
  workerPid: number,
  timeoutMs: number,
): Promise<RemotionProcessInventoryEntry[]> => {
  const deadline = Date.now() + timeoutMs;
  let observed: RemotionProcessInventoryEntry[] = [];
  while (Date.now() < deadline) {
    observed = await listRemotionProcessInventory(repositoryRoot);
    const workerIsVisible = observed.some((entry) => entry.pid === workerPid);
    const browserIsVisible = observed.some(
      (entry) =>
        entry.command.includes('chrome-headless-shell') ||
        entry.command.includes('Chrome Headless Shell') ||
        entry.command.includes('puppeteer_dev_chrome_profile-'),
    );
    if (workerIsVisible && browserIsVisible) return observed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for worker ${workerPid} and its browser.\nObserved:\n` +
      describeProcessInventory(observed),
  );
};

afterEach(async () => {
  for (const runner of runners) {
    if (runner.exitCode === null && runner.signalCode === null) {
      runner.kill('SIGKILL');
      await waitForClose(runner).catch(() => undefined);
    }
  }
  runners.clear();
  for (const pgid of workerGroups) {
    await stopOwnedProcessGroup(pgid).catch(() => undefined);
  }
  workerGroups.clear();
});

describe.runIf(process.platform === 'darwin')('real Remotion process lifecycle', () => {
  it(
    'adds no stale process after success or forced cancellation',
    async () => {
      const baseline = await listRemotionProcessInventory(repositoryRoot);
      await runSyntheticE2e(repositoryRoot, {silent: true});
      const afterSuccess = await listRemotionProcessInventory(repositoryRoot);
      expectNoNewProcesses('Successful render', baseline, afterSuccess);

      const prepared = await prepareSyntheticReel(repositoryRoot, {silent: true});
      const {props} = await prepareRenderProps(
        prepared.projectPath,
        repositoryRoot,
        'preview',
      );
      const settings = await readRenderSettings(prepared.projectPath);
      const requestPath = path.join(
        prepared.projectPath,
        'work/render/cancel-request.json',
      );
      await writeJson(requestPath, {
        schemaVersion: '1.0.0',
        engineRoot: repositoryRoot,
        target: 'preview',
        rawOutput: path.join(
          prepared.projectPath,
          'work/render/cancel-preview.mp4',
        ),
        inputProps: props,
        settings,
      });

      const runner = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(repositoryRoot, 'tests/fixtures/run-remotion-request.ts'),
          requestPath,
        ],
        {cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe']},
      );
      runners.add(runner);
      let stdout = '';
      let stderr = '';
      runner.stdout!.setEncoding('utf8');
      runner.stderr!.setEncoding('utf8');
      runner.stdout!.on('data', (chunk: string) => {
        stdout += chunk;
      });
      runner.stderr!.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const markerOutput = await waitForOutput(
        runner.stdout!,
        'REMOTION_WORKER_STARTED',
        120_000,
      );
      const workerPid = Number(
        markerOutput.match(/REMOTION_WORKER_STARTED (\d+)/)?.[1],
      );
      expect(workerPid).toBeGreaterThan(0);
      workerGroups.add(workerPid);
      const activeInventory = await waitForOwnedBrowser(workerPid, 120_000);
      expect(activeInventory.some((entry) => entry.pid === workerPid)).toBe(true);
      const closed = waitForClose(runner);
      expect(runner.kill('SIGTERM')).toBe(true);
      const result = await closed;
      runners.delete(runner);
      workerGroups.delete(workerPid);
      expect(
        result,
        `Runner output:\n${stdout}\nRunner errors:\n${stderr}`,
      ).toEqual({exitCode: 143, signal: null});

      const afterCancellation = await listRemotionProcessInventory(repositoryRoot);
      expectNoNewProcesses('Cancelled render', baseline, afterCancellation);
    },
    300_000,
  );
});
