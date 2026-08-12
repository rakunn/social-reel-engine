export type WorkerSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

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
