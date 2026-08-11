import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';

export type ProcessGroupMember = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  command: string;
};

export type CleanupTimeouts = {
  termMs: number;
  killMs: number;
  pollMs: number;
};

export const DEFAULT_CLEANUP_TIMEOUTS: CleanupTimeouts = {
  termMs: 5_000,
  killMs: 5_000,
  pollMs: 100,
};

export type OwnedProcess = {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  pgid: number | null;
  closed: Promise<{exitCode: number | null; signal: NodeJS.Signals | null}>;
};

export type SpawnOwnedProcessOptions = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export class OwnedProcessCleanupError extends Error {
  constructor(
    readonly pgid: number,
    readonly members: ProcessGroupMember[],
  ) {
    super(
      `Process group ${pgid} did not exit: ${members
        .map((member) => `${member.pid} ${member.state} ${member.command}`)
        .join('; ')}`,
    );
    this.name = 'OwnedProcessCleanupError';
  }
}

const assertPgid = (pgid: number): void => {
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`Invalid process group ID: ${pgid}`);
  }
};

export const spawnOwnedProcess = ({
  command,
  args = [],
  cwd,
  env,
}: SpawnOwnedProcessOptions): OwnedProcess => {
  const detached = process.platform !== 'win32';
  const child = spawn(command, args, {
    cwd,
    env,
    detached,
    stdio: 'pipe',
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`Failed to spawn owned process: ${command}`);
  }

  const closed = new Promise<{exitCode: number | null; signal: NodeJS.Signals | null}>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({exitCode, signal}));
    },
  );

  return {
    child,
    pid,
    pgid: detached ? pid : null,
    closed,
  };
};

const readProcessTable = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'ps',
      ['-ax', '-o', 'pid=,ppid=,pgid=,stat=,command='],
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

const parseProcessGroupMember = (line: string): ProcessGroupMember => {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (match === null) {
    throw new Error(`Could not parse process table row: ${line}`);
  }
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    state: match[4],
    command: match[5],
  };
};

export const listProcessGroupMembers = async (
  pgid: number,
): Promise<ProcessGroupMember[]> => {
  assertPgid(pgid);
  const output = await readProcessTable();
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseProcessGroupMember)
    .filter((member) => member.pgid === pgid);
};

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export const waitForProcessGroupExit = async (
  pgid: number,
  timeoutMs: number,
  pollMs = DEFAULT_CLEANUP_TIMEOUTS.pollMs,
): Promise<ProcessGroupMember[]> => {
  assertPgid(pgid);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const interval = Math.max(1, pollMs);

  while (true) {
    const members = await listProcessGroupMembers(pgid);
    if (members.length === 0 || Date.now() >= deadline) {
      return members;
    }
    await wait(Math.min(interval, Math.max(1, deadline - Date.now())));
  }
};

const signalProcessGroup = (pgid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

export const stopOwnedProcessGroup = async (
  pgid: number,
  timeouts: Partial<CleanupTimeouts> = {},
): Promise<void> => {
  assertPgid(pgid);
  const resolved = {...DEFAULT_CLEANUP_TIMEOUTS, ...timeouts};
  const initialMembers = await listProcessGroupMembers(pgid);
  if (initialMembers.length === 0 || !signalProcessGroup(pgid, 'SIGTERM')) {
    return;
  }

  let members = await waitForProcessGroupExit(pgid, resolved.termMs, resolved.pollMs);
  if (members.length === 0) {
    return;
  }
  if (!signalProcessGroup(pgid, 'SIGKILL')) {
    return;
  }

  members = await waitForProcessGroupExit(pgid, resolved.killMs, resolved.pollMs);
  if (members.length > 0) {
    throw new OwnedProcessCleanupError(pgid, members);
  }
};
