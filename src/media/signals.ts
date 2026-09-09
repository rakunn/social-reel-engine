import type {WorkerSignal} from '../render/errors';

export type ProcessSignalTarget = {
  on(signal: WorkerSignal, listener: () => void): unknown;
  off(signal: WorkerSignal, listener: () => void): unknown;
};

type Subscription = {notify: (signal: WorkerSignal) => void};
type SignalHub = {
  subscriptions: Set<Subscription>;
  listeners: Map<WorkerSignal, () => void>;
};

const hubs = new WeakMap<ProcessSignalTarget, SignalHub>();

// Parallel ffprobe/FFmpeg jobs share one OS listener per signal. Each job still
// owns its cancellation and removes its subscription only after cleanup finishes.
export const subscribeProcessSignals = (
  target: ProcessSignalTarget,
  notify: (signal: WorkerSignal) => void,
): (() => void) => {
  let hub = hubs.get(target);
  if (!hub) {
    hub = {subscriptions: new Set(), listeners: new Map()};
    const current = hub;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const listener = () => {
        for (const subscription of [...current.subscriptions]) subscription.notify(signal);
      };
      current.listeners.set(signal, listener);
      target.on(signal, listener);
    }
    hubs.set(target, hub);
  }
  const subscription = {notify};
  hub.subscriptions.add(subscription);
  const current = hub;
  return () => {
    if (!current.subscriptions.delete(subscription)) return;
    if (current.subscriptions.size === 0) {
      for (const [signal, listener] of current.listeners) target.off(signal, listener);
      hubs.delete(target);
    }
  };
};
