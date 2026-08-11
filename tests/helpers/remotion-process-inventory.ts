import {spawn} from 'node:child_process';
import path from 'node:path';

export type RemotionProcessInventoryEntry = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  elapsed: string;
  command: string;
};

const readProcessTable = async (): Promise<string> =>
  await new Promise((resolve, reject) => {
    const child = spawn(
      'ps',
      ['-ax', '-o', 'pid=,ppid=,pgid=,stat=,etime=,command='],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`ps exited with code ${exitCode}: ${stderr.trim()}`));
    });
  });

const parseEntry = (line: string): RemotionProcessInventoryEntry => {
  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/,
  );
  if (match === null) throw new Error(`Could not parse process inventory row: ${line}`);
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    state: match[4],
    elapsed: match[5],
    command: match[6],
  };
};

const hasRemotionProfile = (command: string): boolean =>
  /--user-data-dir=(?:"[^"]*|\S*)puppeteer_dev_chrome_profile-/i.test(command);

const isRemotionCommand = (command: string): boolean =>
  command.includes('/src/render/remotion-worker.ts') ||
  command.includes('/tests/fixtures/run-remotion-request.ts') ||
  command.includes('/node_modules/@remotion/') ||
  command.includes('chrome-headless-shell') ||
  command.includes('Chrome Headless Shell') ||
  hasRemotionProfile(command);

export const listRemotionProcessInventory = async (
  engineRoot: string,
): Promise<RemotionProcessInventoryEntry[]> => {
  const root = path.resolve(engineRoot);
  return (await readProcessTable())
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseEntry)
    .filter(
      (entry) =>
        isRemotionCommand(entry.command) &&
        (entry.command.includes(root) || hasRemotionProfile(entry.command)),
    )
    .sort((left, right) => left.pid - right.pid);
};

export const newProcessIds = (
  baseline: readonly RemotionProcessInventoryEntry[],
  observed: readonly RemotionProcessInventoryEntry[],
): number[] => {
  const baselineIds = new Set(baseline.map((entry) => entry.pid));
  return observed
    .filter((entry) => !baselineIds.has(entry.pid))
    .map((entry) => entry.pid)
    .sort((left, right) => left - right);
};

export const describeProcessInventory = (
  inventory: readonly RemotionProcessInventoryEntry[],
): string =>
  inventory.length === 0
    ? '<empty>'
    : inventory
        .map(
          (entry) =>
            `${entry.pid} ppid=${entry.ppid} pgid=${entry.pgid} state=${entry.state} ` +
            `elapsed=${entry.elapsed} ${entry.command}`,
        )
        .join('\n');
