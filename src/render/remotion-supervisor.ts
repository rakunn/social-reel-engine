import {randomUUID} from 'node:crypto';
import {mkdir, readFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson, writeJson} from '../core/json';
import {
  spawnOwnedProcess,
  stopOwnedProcessGroup,
  type CleanupTimeouts,
  type OwnedProcess,
} from './process-group';
import {
  RemotionWorkerRequestSchema,
  RemotionWorkerResultSchema,
  type RemotionWorkerRequest,
  type RemotionWorkerResult,
  type WorkerSignal,
} from './remotion-worker';

export const DEFAULT_GRACEFUL_CANCEL_MS = 10_000;

export class RenderInterruptedError extends Error {
  readonly exitCode: number;

  constructor(
    readonly signal: WorkerSignal,
    options?: ErrorOptions,
  ) {
    super(`Render interrupted by ${signal}`, options);
    this.name = 'RenderInterruptedError';
    this.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
  }
}

const findRenderInterruption = (
  error: unknown,
  seen = new Set<unknown>(),
): RenderInterruptedError | null => {
  if (seen.has(error)) return null;
  seen.add(error);
  if (error instanceof RenderInterruptedError) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const interruption = findRenderInterruption(nested, seen);
      if (interruption !== null) return interruption;
    }
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findRenderInterruption(error.cause, seen);
  }
  return null;
};

export const exitCodeForRenderError = (error: unknown): number =>
  findRenderInterruption(error)?.exitCode ?? 1;

type SupervisorSignalTarget = {
  on(signal: WorkerSignal, listener: () => void): unknown;
  off(signal: WorkerSignal, listener: () => void): unknown;
};

export type RemotionSupervisorOptions = {
  workerEntryPoint?: string;
  gracefulCancelMs?: number;
  cleanupTimeouts?: Partial<CleanupTimeouts>;
  environment?: NodeJS.ProcessEnv;
  signalTarget?: SupervisorSignalTarget;
  onWorkerSpawn?: (pid: number) => void;
};

export type RemotionSupervisorDependencies = {
  spawnOwnedProcess: typeof spawnOwnedProcess;
  stopOwnedProcessGroup: typeof stopOwnedProcessGroup;
};

const defaultDependencies: RemotionSupervisorDependencies = {
  spawnOwnedProcess,
  stopOwnedProcessGroup,
};

type WorkerOutcome =
  | {
      kind: 'closed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | {kind: 'close-error'; error: unknown}
  | {kind: 'grace-expired'};

const signalChildForGracefulShutdown = (owned: OwnedProcess): void => {
  try {
    process.kill(owned.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const installSupervisorSignalHandlers = (
  target: SupervisorSignalTarget,
  gracefulCancelMs: number,
): {
  graceExpired: Promise<WorkerOutcome>;
  attach(owned: OwnedProcess): void;
  markWorkerClosed(): void;
  stopForwarding(): void;
  receivedSignal(): WorkerSignal | null;
  remove(): void;
} => {
  let received: WorkerSignal | null = null;
  let owned: OwnedProcess | null = null;
  let workerAlive = false;
  let forwarding = true;
  let timer: NodeJS.Timeout | undefined;
  let resolveGraceExpired!: (outcome: WorkerOutcome) => void;
  const graceExpired = new Promise<WorkerOutcome>((resolve) => {
    resolveGraceExpired = resolve;
  });
  const forwardIfPossible = () => {
    if (received === null || owned === null || !workerAlive || !forwarding) return;
    signalChildForGracefulShutdown(owned);
  };
  const listeners = new Map<WorkerSignal, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const listener = () => {
      if (received !== null) return;
      received = signal;
      forwardIfPossible();
      timer = setTimeout(
        () => resolveGraceExpired({kind: 'grace-expired'}),
        Math.max(0, gracefulCancelMs),
      );
    };
    listeners.set(signal, listener);
    target.on(signal, listener);
  }
  return {
    graceExpired,
    attach: (processToOwn) => {
      owned = processToOwn;
      workerAlive = true;
      forwardIfPossible();
    },
    markWorkerClosed: () => {
      workerAlive = false;
    },
    stopForwarding: () => {
      forwarding = false;
    },
    receivedSignal: () => received,
    remove: () => {
      if (timer !== undefined) clearTimeout(timer);
      for (const [signal, listener] of listeners) {
        target.off(signal, listener);
      }
    },
  };
};

const captureWorkerOutput = (
  owned: OwnedProcess,
): {stdout(): string; stderr(): string} => {
  let stdout = '';
  let stderr = '';
  owned.child.stdout.setEncoding('utf8');
  owned.child.stderr.setEncoding('utf8');
  owned.child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  owned.child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  return {stdout: () => stdout, stderr: () => stderr};
};

const workerExitError = (
  outcome: Exclude<WorkerOutcome, {kind: 'grace-expired'}>,
  stderr: string,
): Error | null => {
  if (outcome.kind === 'close-error') {
    return outcome.error instanceof Error
      ? outcome.error
      : new Error(`Remotion worker failed to close: ${String(outcome.error)}`);
  }
  if (outcome.exitCode === 0 && outcome.signal === null) return null;
  const status =
    outcome.signal === null
      ? `exit code ${outcome.exitCode ?? 'unknown'}`
      : `signal ${outcome.signal}`;
  return new Error(
    `Remotion worker exited with ${status}${
      stderr.trim() === '' ? '' : `\nWorker stderr:\n${stderr.trim()}`
    }`,
  );
};

const resultError = (result: RemotionWorkerResult, stderr: string): Error | null => {
  if (result.ok) return null;
  const details = [result.error.stack ?? result.error.message];
  if (stderr.trim() !== '') details.push(`Worker stderr:\n${stderr.trim()}`);
  return new Error(details.join('\n'));
};

const protocolReadError = (error: unknown, stderr: string): Error =>
  new Error(
    `Could not read the Remotion worker result: ${
      error instanceof Error ? error.message : String(error)
    }${stderr.trim() === '' ? '' : `\nWorker stderr:\n${stderr.trim()}`}`,
    {cause: error},
  );

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const readOwnedPgidIfPresent = async (filePath: string): Promise<number | null> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid owned browser process-group ID in ${filePath}: ${value}`);
  }
  const pgid = Number(value);
  if (!Number.isSafeInteger(pgid) || pgid <= 0) {
    throw new Error(`Invalid owned browser process-group ID in ${filePath}: ${value}`);
  }
  return pgid;
};

export const superviseRemotionRender = async (
  rawRequest: RemotionWorkerRequest,
  options: RemotionSupervisorOptions = {},
  dependencyOverrides: Partial<RemotionSupervisorDependencies> = {},
): Promise<void> => {
  const request = RemotionWorkerRequestSchema.parse(rawRequest);
  const dependencies = {...defaultDependencies, ...dependencyOverrides};
  const workDirectory = path.dirname(request.rawOutput);
  await mkdir(workDirectory, {recursive: true});
  const protocolId = `${process.pid}-${randomUUID()}`;
  const requestPath = path.join(workDirectory, `.remotion-worker-${protocolId}.request.json`);
  const resultPath = path.join(workDirectory, `.remotion-worker-${protocolId}.result.json`);
  const browserPgidPath = path.join(
    workDirectory,
    `.remotion-browser-${protocolId}.pgid`,
  );
  const browserLauncherPath = path.join(
    workDirectory,
    `.remotion-browser-launcher-${protocolId}.cjs`,
  );
  const workerRequest = RemotionWorkerRequestSchema.parse({
    ...request,
    browserLifecycle: {
      launcherPath: browserLauncherPath,
      pgidPath: browserPgidPath,
    },
  });
  const workerEntryPoint =
    options.workerEntryPoint ?? fileURLToPath(new URL('./remotion-worker.ts', import.meta.url));
  const signalHandlers = installSupervisorSignalHandlers(
    options.signalTarget ?? process,
    options.gracefulCancelMs ?? DEFAULT_GRACEFUL_CANCEL_MS,
  );
  let owned: OwnedProcess | undefined;
  let output: {stdout(): string; stderr(): string} = {stdout: () => '', stderr: () => ''};
  let closedOutcome: Promise<WorkerOutcome> | undefined;
  let outcome: WorkerOutcome | undefined;
  let setupError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    await writeJson(requestPath, workerRequest);
    owned = dependencies.spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', workerEntryPoint, requestPath, resultPath],
      cwd: request.engineRoot,
      env: options.environment ?? process.env,
    });
    owned.child.stdin.end();
    output = captureWorkerOutput(owned);
    signalHandlers.attach(owned);
    closedOutcome = owned.closed
      .then<WorkerOutcome>(({exitCode, signal}) => {
        signalHandlers.markWorkerClosed();
        return {kind: 'closed', exitCode, signal};
      })
      .catch((error: unknown): WorkerOutcome => {
        signalHandlers.markWorkerClosed();
        return {kind: 'close-error', error};
      });
    options.onWorkerSpawn?.(owned.pid);
    outcome = await Promise.race([closedOutcome, signalHandlers.graceExpired]);
  } catch (error) {
    setupError = error;
  } finally {
    signalHandlers.stopForwarding();
    if (owned !== undefined) {
      if (owned.pgid === null) {
        if (outcome?.kind === 'grace-expired' || setupError !== undefined) {
          try {
            owned.child.kill('SIGKILL');
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      } else {
        try {
          await dependencies.stopOwnedProcessGroup(owned.pgid, options.cleanupTimeouts);
          signalHandlers.markWorkerClosed();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    try {
      const browserPgid = await readOwnedPgidIfPresent(browserPgidPath);
      if (browserPgid !== null && browserPgid !== owned?.pgid) {
        await dependencies.stopOwnedProcessGroup(browserPgid, options.cleanupTimeouts);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    signalHandlers.remove();
  }

  let renderError: unknown = setupError;
  if (renderError === undefined && outcome !== undefined) {
    renderError =
      outcome.kind === 'grace-expired'
        ? new Error('Remotion worker graceful shutdown expired')
        : workerExitError(outcome, output.stderr());
  }

  let workerResult: RemotionWorkerResult | undefined;
  let workerProtocolError: Error | undefined;
  if (owned !== undefined) {
    try {
      workerResult = await readJson(resultPath, RemotionWorkerResultSchema);
    } catch (error) {
      workerProtocolError = protocolReadError(error, output.stderr());
    }
  }

  if (setupError === undefined) {
    if (workerResult === undefined) {
      renderError = renderError ?? workerProtocolError;
    } else {
      renderError = resultError(workerResult, output.stderr()) ?? renderError ?? undefined;
    }
  }

  const interrupted = signalHandlers.receivedSignal();
  if (interrupted !== null) {
    renderError = new RenderInterruptedError(
      interrupted,
      renderError === undefined ? undefined : {cause: renderError},
    );
  }

  let operationError = renderError;
  if (cleanupErrors.length > 0) {
    if (operationError === undefined && cleanupErrors.length === 1) {
      operationError = cleanupErrors[0];
    } else {
      operationError = new AggregateError(
        [
          ...(operationError === undefined ? [] : [operationError]),
          ...cleanupErrors,
        ],
        operationError === undefined
          ? 'Owned Remotion process cleanup failed'
          : 'Remotion render and owned-process cleanup both failed',
      );
    }
  }

  let protocolCleanupError: unknown;
  try {
    await Promise.all([
      unlinkIfPresent(requestPath),
      unlinkIfPresent(resultPath),
      unlinkIfPresent(browserPgidPath),
      unlinkIfPresent(browserLauncherPath),
    ]);
  } catch (error) {
    protocolCleanupError = error;
  }

  if (operationError !== undefined && protocolCleanupError !== undefined) {
    throw new AggregateError(
      [operationError, protocolCleanupError],
      'Remotion supervision and protocol-file cleanup both failed',
    );
  }
  if (operationError !== undefined) throw operationError;
  if (protocolCleanupError !== undefined) throw protocolCleanupError;
};
