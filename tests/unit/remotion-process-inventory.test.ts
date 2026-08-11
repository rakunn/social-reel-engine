import {describe, expect, it} from 'vitest';
import {
  isProcessDescendantOf,
  type RemotionProcessInventoryEntry,
} from '../helpers/remotion-process-inventory';

const entry = (
  pid: number,
  ppid: number,
  command: string,
): RemotionProcessInventoryEntry => ({
  pid,
  ppid,
  pgid: pid,
  state: 'S',
  elapsed: '00:01',
  command,
});

describe('Remotion process inventory ownership', () => {
  it('distinguishes the worker browser from baseline and concurrent browsers', () => {
    const inventory = [
      entry(100, 1, 'remotion-worker.ts'),
      entry(110, 100, '.remotion-browser-launcher-worker.cjs'),
      entry(111, 110, 'chrome-headless-shell --user-data-dir=owned'),
      entry(200, 1, 'chrome-headless-shell --user-data-dir=baseline'),
      entry(300, 1, 'remotion-worker.ts'),
      entry(310, 300, 'chrome-headless-shell --user-data-dir=concurrent'),
    ];

    expect(isProcessDescendantOf(inventory, 111, 100)).toBe(true);
    expect(isProcessDescendantOf(inventory, 200, 100)).toBe(false);
    expect(isProcessDescendantOf(inventory, 310, 100)).toBe(false);
  });
});
