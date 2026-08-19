import {access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {runSyntheticCarouselE2e} from '../../scripts/synthetic-e2e';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('synthetic 1.91:1 carousel acceptance render', () => {
  it(
    'renders and validates two independent ordered MP4 cards',
    async () => {
      const result = await runSyntheticCarouselE2e(repositoryRoot, {cleanup: true});

      expect(result.qc.failures).toEqual([]);
      expect(result.cards).toHaveLength(2);
      expect(result.cards.map((card) => card.clipId)).toEqual(['synthetic-a', 'synthetic-b']);
      expect(result.cards.every((card) => card.durationSeconds === 4.5)).toBe(true);
      expect(result.originalsUnchanged).toBe(true);
      expect(result.packageReused).toBe(true);
      expect(result.status.stage).toBe('carousel-rendered');
      await expect(access(result.projectPath)).rejects.toThrow(/ENOENT/);
    },
    180_000,
  );
});
