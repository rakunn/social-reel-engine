import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {hashFile} from '../../src/core/hash';

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
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});

describe('catalog LUT installation locking', () => {
  it('holds the snapshot interlock through LUT metadata publication', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-library-lock-'));
    temporaryRoots.push(temporaryRoot);
    await mkdir(path.join(temporaryRoot, 'library'), {recursive: true});
    const file = 'library/identity.cube';
    await writeFile(path.join(temporaryRoot, file),
      'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
    await writeFile(path.join(temporaryRoot, 'library/lut-catalog.json'), JSON.stringify({
      schemaVersion: '1.0.0',
      technical: [{
        id: 'synthetic-normalization', kind: 'technical', file,
        checksumSha256: await hashFile(path.join(temporaryRoot, file)),
        cameraModel: 'Test Generator', profileId: 'synthetic-log',
        inputGamma: 'Synthetic Log', inputGamut: 'Synthetic Gamut',
        inputColorSpace: 'Synthetic Log/Synthetic Gamut', outputColorSpace: 'Rec.709 Gamma 2.4',
        transformSemantics: 'normalization', defaultMix: 1,
      }],
      creative: [], unclassified: [],
    }));
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot: path.join(temporaryRoot, 'projects'),
      reelName: 'catalog-lock-project',
    });

    await expect(
      installCatalogLut(projectPath, temporaryRoot, 'synthetic-normalization'),
    ).resolves.toEqual(expect.objectContaining({id: 'synthetic-normalization'}));
  });
});
