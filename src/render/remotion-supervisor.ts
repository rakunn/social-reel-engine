import {randomUUID} from 'node:crypto';
import {mkdir, unlink} from 'node:fs/promises';
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

export const exitCodeForRenderError = (error: unknown): number =>
  error instanceof RenderInterruptedError ? error.exitCode : 1;

type SupervisorSignalTarget = {
  on(signal: WorkerSignal, listener: () => void): unknown;
  off(signal: WorkerSignal, listener: () => void): unknown;
};

export type RemotionSupervisorOptions = {
  workerEntryPoint?: string;
  gracefulCancelMs?: number;
  cleanupTimeouts?: Partial<CleanupTimeouts>;
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

const signalChild = (owned: OwnedProcess, signal: WorkerSignal): void => {
  try {
    process.kill(owned.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
};

const installSupervisorSignalHandlers = (
  owned: OwnedProcess,
  target: SupervisorSignalTarget,
  gracefulCancelMs: number,
): {
  graceExpired: Promise<WorkerOutcome>;
  receivedSignal(): WorkerSignal | null;
  remove(): void;
} => {
  let received: WorkerSignal | null = null;
  let timer: NodeJS.Timeout | undefined;
  let resolveGraceExpired!: (outcome: WorkerOutcome) => void;
  const graceExpired = new Promise<WorkerOutcome>((resolve) => {
    resolveGraceExpired = resolve;
  });
  const listeners = new Map<WorkerSignal, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const listener = () => {
      if (received !== null) return;
      received = signal;
      signalChild(owned, signal);
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

const combineRenderAndCleanupErrors = (
  renderError: unknown,
  cleanupError: unknown,
): AggregateError =>
  new AggregateError(
    [renderError, cleanupError],
    'Remotion render and owned-process cleanup both failed',
  );

const unlinkIfPresent = async (filePath: string): Promise<void> => {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
  const workerEntryPoint =
    options.workerEntryPoint ?? fileURLToPath(new URL('./remotion-worker.ts', import.meta.url));
  let removeSignalHandlers = (): void => undefined;
  let operationError: unknown;

  try {
    await writeJson(requestPath, request);
    const owned = dependencies.spawnOwnedProcess({
      command: process.execPath,
      args: ['--import', 'tsx', workerEntryPoint, requestPath, resultPath],
      cwd: request.engineRoot,
      env: process.env,
    });
    owned.child.stdin.end();
    const output = captureWorkerOutput(owned);
    const signalHandlers = installSupervisorSignalHandlers(
      owned,
      options.signalTarget ?? process,
      options.gracefulCancelMs ?? DEFAULT_GRACEFUL_CANCEL_MS,
    );
    removeSignalHandlers = signalHandlers.remove;
    options.onWorkerSpawn?.(owned.pid);

    const closedOutcome: Promise<WorkerOutcome> = owned.closed
      .then<WorkerOutcome>(({exitCode, signal}) => ({kind: 'closed', exitCode, signal}))
      .catch((error: unknown): WorkerOutcome => ({kind: 'close-error', error}));
    const outcome = await Promise.race([closedOutcome, signalHandlers.graceExpired]);
    let interrupted = signalHandlers.receivedSignal();
    let renderError: unknown =
      interrupted === null
        ? outcome.kind === 'grace-expired'
          ? new Error('Remotion worker graceful shutdown expired without an interrupt')
          : workerExitError(outcome, output.stderr())
        : new RenderInterruptedError(interrupted);
    let cleanupError: unknown;

    if (outcome.kind === 'grace-expired') {
      try {
        if (owned.pgid === null) {
          owned.child.kill('SIGKILL');
        } else {
          await dependencies.stopOwnedProcessGroup(owned.pgid, options.cleanupTimeouts);
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError === undefined && owned.pgid !== null) {
      try {
        await dependencies.stopOwnedProcessGroup(owned.pgid, options.cleanupTimeouts);
      } catch (error) {
        cleanupError = error;
      }
    }

    interrupted = signalHandlers.receivedSignal();
    if (interrupted !== null && !(renderError instanceof RenderInterruptedError)) {
      renderError = new RenderInterruptedError(interrupted);
    }

    if (cleanupError !== undefined) {
      operationError =
        renderError === null || renderError === undefined
          ? cleanupError
          : combineRenderAndCleanupErrors(renderError, cleanupError);
    } else {
      let workerResult: RemotionWorkerResult | undefined;
      let workerProtocolError: Error | undefined;
      try {
        workerResult = await readJson(resultPath, RemotionWorkerResultSchema);
      } catch (error) {
        workerProtocolError = protocolReadError(error, output.stderr());
      }

      interrupted = signalHandlers.receivedSignal();

      if (interrupted !== null) {
        const cause =
          workerResult === undefined
            ? workerProtocolError
            : resultError(workerResult, output.stderr()) ?? renderError ?? undefined;
        operationError = new RenderInterruptedError(
          interrupted,
          cause === undefined ? undefined : {cause},
        );
      } else if (workerResult === undefined) {
        operationError = renderError ?? workerProtocolError;
      } else {
        operationError = resultError(workerResult, output.stderr()) ?? renderError ?? undefined;
      }
    }
  } catch (error) {
    operationError = operationError ?? error;
  } finally {
    removeSignalHandlers();
  }

  let protocolCleanupError: unknown;
  try {
    await Promise.all([unlinkIfPresent(requestPath), unlinkIfPresent(resultPath)]);
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
