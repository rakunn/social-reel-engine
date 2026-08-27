import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it, vi} from 'vitest';

const lockState = vi.hoisted(() => ({depth: 0}));

vi.mock('../../src/project/operation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/project/operation')>();
  return {
    ...actual,
    runWithStatusScanLock: async <T>(_projectPath: string, scan: () => Promise<T>) => {
      lockState.depth += 1;
      try {
        return {acquired: true as const, value: await scan()};
      } finally {
        lockState.depth -= 1;
      }
    },
  };
});

vi.mock('../../src/core/json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/json')>();
  return {
    ...actual,
    writeJson: async (...args: Parameters<typeof actual.writeJson>) => {
      const [filePath] = args;
      if (String(filePath).endsWith('/config/luts.json') && lockState.depth === 0) {
        throw new Error('LUT metadata publication escaped the project snapshot lock');
      }
      return await actual.writeJson(...args);
    },
  };
});

import {installCatalogLut} from '../../src/project/library';
import {createReelProject} from '../../src/project/workspace';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('catalog LUT installation locking', () => {
  it('holds the snapshot interlock through LUT metadata publication', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-library-lock-'));
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot: path.join(temporaryRoot, 'projects'),
      reelName: 'catalog-lock-project',
    });

    await expect(
      installCatalogLut(projectPath, repositoryRoot, 'dji-mini-4-pro-dlogm-rec709-v1'),
    ).resolves.toEqual(expect.objectContaining({id: 'dji-mini-4-pro-dlogm-rec709-v1'}));
  });
});
