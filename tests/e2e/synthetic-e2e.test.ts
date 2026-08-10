import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {runSyntheticE2e} from '../../scripts/synthetic-e2e';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('synthetic two-clip acceptance render', () => {
  it(
    'renders and validates preview, 10-bit ProRes master, and normalized delivery',
    async () => {
      const results = [
        await runSyntheticE2e(repositoryRoot),
        await runSyntheticE2e(repositoryRoot, {silent: true}),
      ];
      for (const result of results) {
        expect(result.qc.preview.failures).toEqual([]);
        expect(result.qc.master.failures).toEqual([]);
        expect(result.qc.delivery.failures).toEqual([]);
        expect(result.originalsUnchanged).toBe(true);
        expect(result.renderArtifactsReused).toBe(true);
        expect(result.outputs.preview).toMatch(/preview\.mp4$/);
        expect(result.outputs.master).toMatch(/master\.mov$/);
        expect(result.outputs.delivery).toMatch(/delivery\.mp4$/);
      }
      expect(results.map((result) => result.silent)).toEqual([false, true]);
    },
    240_000,
  );
});
