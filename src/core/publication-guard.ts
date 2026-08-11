import {AsyncLocalStorage} from 'node:async_hooks';

export type PublicationGuard = () => Promise<void> | void;

type PublicationScope = {
  guard: PublicationGuard;
  operationId: string | null;
};

const publicationGuardStorage = new AsyncLocalStorage<PublicationScope>();

export const runWithPublicationGuard = async <T>(
  guard: PublicationGuard,
  operation: () => Promise<T>,
): Promise<T> => {
  const inherited = publicationGuardStorage.getStore();
  return await publicationGuardStorage.run(
    {guard, operationId: inherited?.operationId ?? null},
    operation,
  );
};

export const runWithMediaOperationPublicationGuard = async <T>(
  operationId: string,
  guard: PublicationGuard,
  operation: () => Promise<T>,
): Promise<T> =>
  await publicationGuardStorage.run({guard, operationId}, operation);

export const currentPublicationOperationId = (): string | null =>
  publicationGuardStorage.getStore()?.operationId ?? null;

export const assertPublicationGuard = async (): Promise<void> => {
  const scope = publicationGuardStorage.getStore();
  if (scope) await scope.guard();
};
