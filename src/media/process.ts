import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {
  processGroupExists,
  spawnOwnedProcess,
  stopOwnedProcessGroup,
  type CleanupTimeouts,
  type OwnedProcess,
} from '../render/process-group';
import {RenderInterruptedError, type WorkerSignal} from '../render/errors';

export type ProcessResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunProcessOptions = {
  cwd?: string;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  cleanupTimeouts?: Partial<CleanupTimeouts>;
  signalTarget?: ProcessSignalTarget;
};

type ProcessTermination =
  | {type: 'timeout'; kind: 'wall' | 'idle'}
  | {type: 'abort'; reason: unknown}
  | {type: 'interrupt'; signal: WorkerSignal};

export type ProcessSignalTarget = {
  on(signal: WorkerSignal, listener: () => void): unknown;
  off(signal: WorkerSignal, listener: () => void): unknown;
};

type ProcessErrorContext = ProcessResult & {pgid: number | null};

const diagnosticSuffix = (context: ProcessErrorContext): string => {
  const details = context.stderr.trim() || context.stdout.trim();
  return details === '' ? '' : `\n${details}`;
};

export class ProcessExecutionError extends Error {
  readonly command: string;
  readonly args: string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly pgid: number | null;

  constructor(message: string, context: ProcessErrorContext) {
    super(message);
    this.name = 'ProcessExecutionError';
    this.command = context.command;
    this.args = context.args;
    this.stdout = context.stdout;
    this.stderr = context.stderr;
    this.exitCode = context.exitCode;
    this.pgid = context.pgid;
  }
}

export class ProcessTimeoutError extends ProcessExecutionError {
  constructor(
    readonly kind: 'wall' | 'idle',
    context: ProcessErrorContext,
  ) {
    super(
      `${context.command} exceeded its ${kind === 'idle' ? 'idle' : 'wall-clock'} timeout${diagnosticSuffix(context)}`,
      context,
    );
    this.name = 'ProcessTimeoutError';
  }
}

export class ProcessAbortedError extends ProcessExecutionError {
  constructor(context: ProcessErrorContext, readonly reason: unknown) {
    super(
      `${context.command} was aborted${reason === undefined ? '' : `: ${String(reason)}`}${diagnosticSuffix(context)}`,
      context,
    );
    this.name = 'ProcessAbortedError';
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

class OutputTail {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: string | Buffer): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length >= this.maximumBytes) {
      this.chunks = [incoming.subarray(incoming.length - this.maximumBytes)];
      this.byteLength = this.maximumBytes;
      return;
    }
    this.chunks.push(incoming);
    this.byteLength += incoming.length;
    while (
      this.chunks.length > 1 &&
      this.byteLength - this.chunks[0].length >= this.maximumBytes
    ) {
      this.byteLength -= this.chunks[0].length;
      this.chunks.shift();
    }
    if (this.byteLength > this.maximumBytes) {
      const overflow = this.byteLength - this.maximumBytes;
      this.chunks[0] = this.chunks[0].subarray(overflow);
      this.byteLength = this.maximumBytes;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString('utf8');
  }
}

const positiveDuration = (name: string, value: number | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
};

const positiveOutputLimit = (value: number | undefined): number => {
  const resolved = value ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error('maxOutputBytes must be a positive safe integer');
  }
  return resolved;
};

const stopWindowsChild = async (
  owned: OwnedProcess,
  timeouts: Partial<CleanupTimeouts>,
): Promise<void> => {
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  owned.child.kill('SIGTERM');
  const termMs = timeouts.termMs ?? 5_000;
  const closed = await Promise.race([
    owned.closed.then(() => true, () => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), termMs)),
  ]);
  if (closed) return;
  owned.child.kill('SIGKILL');
};

const stopOwned = async (
  owned: OwnedProcess,
  cleanupTimeouts: Partial<CleanupTimeouts>,
): Promise<void> => {
  if (owned.pgid === null) {
    await stopWindowsChild(owned, cleanupTimeouts);
    return;
  }
  await stopOwnedProcessGroup(owned.pgid, cleanupTimeouts);
};

const resultFor = (
  command: string,
  args: readonly string[],
  stdout: OutputTail,
  stderr: OutputTail,
  exitCode: number | null,
): ProcessResult => ({
  command,
  args: [...args],
  stdout: stdout.toString(),
  stderr: stderr.toString(),
  exitCode: exitCode ?? -1,
});

const processFailureMessage = (
  result: ProcessResult,
  signal: NodeJS.Signals | null,
): string => {
  const status =
    signal === null ? `code ${result.exitCode}` : `signal ${signal}`;
  const details = result.stderr.trim() || result.stdout.trim();
  return `${result.command} exited with ${status}${details === '' ? '' : `\n${details}`}`;
};

const attachOutput = (
  child: ChildProcessWithoutNullStreams,
  stdout: OutputTail,
  stderr: OutputTail,
  onActivity: () => void,
): void => {
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdout.append(chunk);
    onActivity();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr.append(chunk);
    onActivity();
  });
};

export const runProcess = async (
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> => {
  const timeoutMs = positiveDuration('timeoutMs', options.timeoutMs);
  const idleTimeoutMs = positiveDuration('idleTimeoutMs', options.idleTimeoutMs);
  const maximumOutputBytes = positiveOutputLimit(options.maxOutputBytes);
  const emptyContext = (): ProcessErrorContext => ({
    command,
    args: [...args],
    stdout: '',
    stderr: '',
    exitCode: -1,
    pgid: null,
  });
  if (options.signal?.aborted) {
    throw new ProcessAbortedError(emptyContext(), options.signal.reason);
  }

  const owned = spawnOwnedProcess({
    command,
    args,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  owned.child.stdin.end();
  const stdout = new OutputTail(maximumOutputBytes);
  const stderr = new OutputTail(maximumOutputBytes);
  let wallTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let termination: ProcessTermination | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let reportCleanupFailure!: (error: unknown) => void;
  const cleanupFailure = new Promise<{kind: 'cleanup-error'; error: unknown}>((resolve) => {
    reportCleanupFailure = (error) => resolve({kind: 'cleanup-error', error});
  });

  const beginCleanup = (): Promise<void> => {
    cleanupPromise ??= stopOwned(owned, options.cleanupTimeouts ?? {});
    void cleanupPromise.catch(reportCleanupFailure);
    return cleanupPromise;
  };

  const beginTermination = (
    reason: ProcessTermination,
  ): void => {
    if (termination !== null) return;
    termination = reason;
    beginCleanup();
  };

  const resetIdleTimer = (): void => {
    if (idleTimeoutMs === undefined || termination !== null) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => beginTermination({type: 'timeout', kind: 'idle'}),
      idleTimeoutMs,
    );
  };
  attachOutput(owned.child, stdout, stderr, resetIdleTimer);
  resetIdleTimer();
  if (timeoutMs !== undefined) {
    wallTimer = setTimeout(
      () => beginTermination({type: 'timeout', kind: 'wall'}),
      timeoutMs,
    );
  }
  const abortListener = () =>
    beginTermination({type: 'abort', reason: options.signal?.reason});
  options.signal?.addEventListener('abort', abortListener, {once: true});
  if (options.signal?.aborted) abortListener();

  const signalTarget = options.signalTarget ?? process;
  const signalListeners = new Map<WorkerSignal, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const listener = () => beginTermination({type: 'interrupt', signal});
    signalListeners.set(signal, listener);
    signalTarget.on(signal, listener);
  }

  const closedOutcome: Promise<
    | {kind: 'closed'; exitCode: number | null; signal: NodeJS.Signals | null}
    | {kind: 'spawn-error'; error: unknown}
  > = owned.closed
    .then(({exitCode, signal}) => ({kind: 'closed' as const, exitCode, signal}))
    .catch((error: unknown) => ({kind: 'spawn-error' as const, error}));
  let lifecycle:
    | Awaited<typeof closedOutcome>
    | {kind: 'cleanup-error'; error: unknown};
  try {
    lifecycle = await Promise.race([closedOutcome, cleanupFailure]);
  } finally {
    if (wallTimer !== undefined) clearTimeout(wallTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.signal?.removeEventListener('abort', abortListener);
  }

  const outcome =
    lifecycle.kind === 'closed'
      ? {exitCode: lifecycle.exitCode, signal: lifecycle.signal}
      : {exitCode: owned.child.exitCode, signal: owned.child.signalCode};
  const lifecycleError = lifecycle.kind === 'spawn-error' ? lifecycle.error : undefined;
  let cleanupError = lifecycle.kind === 'cleanup-error' ? lifecycle.error : undefined;
  try {
    if (cleanupPromise !== null) {
      await cleanupPromise;
    } else if (owned.pgid !== null && processGroupExists(owned.pgid)) {
      await beginCleanup();
    }
  } catch (error) {
    cleanupError ??= error;
  } finally {
    for (const [signal, listener] of signalListeners) {
      signalTarget.off(signal, listener);
    }
  }

  const result = resultFor(command, args, stdout, stderr, outcome.exitCode);
  const context: ProcessErrorContext = {...result, pgid: owned.pgid};
  const terminalReason = termination as ProcessTermination | null;
  const processContextError = new ProcessExecutionError(
    `${command} did not complete normally`,
    context,
  );
  const primaryError: Error | null =
    terminalReason?.type === 'timeout'
      ? new ProcessTimeoutError(terminalReason.kind, context)
      : terminalReason?.type === 'abort'
        ? new ProcessAbortedError(context, terminalReason.reason)
        : terminalReason?.type === 'interrupt'
          ? new RenderInterruptedError(terminalReason.signal, {cause: processContextError})
          : null;
  if (primaryError !== null) {
    const secondaryErrors = [lifecycleError, cleanupError].filter(
      (error) => error !== undefined,
    );
    if (secondaryErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...secondaryErrors],
        `${command} interruption and owned-process cleanup both failed`,
      );
    }
    throw primaryError;
  }
  if (lifecycleError !== undefined) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [lifecycleError, cleanupError],
        `${command} execution and owned-process cleanup both failed`,
      );
    }
    throw lifecycleError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  if ((outcome.exitCode !== 0 || outcome.signal !== null) && !options.allowFailure) {
    throw new ProcessExecutionError(processFailureMessage(result, outcome.signal), context);
  }
  return result;
};
