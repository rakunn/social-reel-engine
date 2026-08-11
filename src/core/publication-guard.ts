import {AsyncLocalStorage} from 'node:async_hooks';

export type PublicationGuard = () => Promise<void> | void;

const publicationGuardStorage = new AsyncLocalStorage<PublicationGuard>();

export const runWithPublicationGuard = async <T>(
  guard: PublicationGuard,
  operation: () => Promise<T>,
): Promise<T> => await publicationGuardStorage.run(guard, operation);

export const assertPublicationGuard = async (): Promise<void> => {
  const guard = publicationGuardStorage.getStore();
  if (guard) await guard();
};
