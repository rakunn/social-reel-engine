import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import {RenderInterruptedError} from '../../src/render/errors';

const runProcess = vi.hoisted(() => vi.fn());

vi.mock('../../src/media/process', () => ({runProcess}));
vi.mock('../../src/render/remotion-runtime', () => ({
  checkRemotionRuntime: vi.fn(async () => ({ok: true, message: 'runtime ready'})),
}));

import {runDoctor} from '../../src/commands/doctor';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Doctor interrupt propagation', () => {
  it('propagates an interrupt nested in a diagnostic command cleanup failure', async () => {
    const interruption = new RenderInterruptedError('SIGINT');
    const aggregate = new AggregateError(
      [new Error('diagnostic cleanup failed'), interruption],
      'diagnostic interrupted during cleanup',
    );
    runProcess.mockRejectedValue(aggregate);

    await expect(
      runDoctor(repositoryRoot, {
        storageCapacity: {
          statfs: async () => ({bsize: 1024, bavail: 100 * 1024 * 1024}),
        },
        dependencyMaterialization: {platform: 'linux'},
      }),
    ).rejects.toBe(aggregate);
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});
