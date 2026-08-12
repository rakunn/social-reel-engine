import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const runIsolatedNode = async (
  args: string[],
  timeoutMs: number,
): Promise<{stdout: string; stderr: string; timedOut: boolean}> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined && process.platform !== 'win32') {
        process.kill(-child.pid, 'SIGKILL');
      } else {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.once('error', reject);
    child.once('close', () => {
      clearTimeout(timer);
      resolve({stdout, stderr, timedOut});
    });
  });

describe('CLI startup isolation', () => {
  it('does not load the Remotion bundler for non-render command startup', async () => {
    const code = `
      await import('./src/cli.ts');
      process.stdout.write('ready');
    `;

    const result = await runIsolatedNode(
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      5_000,
    );

    expect(result.timedOut, result.stderr).toBe(false);
    expect(result.stdout).toBe('ready');
  }, 10_000);

  it('does not load the Remotion bundler in the parent supervisor process', async () => {
    const code = `
      await import('./src/render/remotion-supervisor.ts');
      const loadedRspack = process.report
        .getReport()
        .sharedObjects
        .some((file) => file.includes('rspack'));
      process.stdout.write(JSON.stringify({loadedRspack}));
    `;

    const result = await runIsolatedNode(
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      5_000,
    );

    expect(result.timedOut, result.stderr).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({loadedRspack: false});
  }, 10_000);
});
