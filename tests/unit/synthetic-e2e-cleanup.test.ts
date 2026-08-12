import {access, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const runFfmpeg = vi.hoisted(() => vi.fn());

vi.mock('../../src/media/ffmpeg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/media/ffmpeg')>();
  return {...actual, runFfmpeg};
});

import {runSyntheticE2e} from '../../scripts/synthetic-e2e';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let temporaryRoot: string | null = null;

beforeEach(() => {
  temporaryRoot = null;
  runFfmpeg.mockReset();
  runFfmpeg.mockImplementation(async (args: readonly string[]) => {
    const output = args.at(-1);
    if (!output) throw new Error('Synthetic fixture did not provide an output path');
    temporaryRoot = path.dirname(path.dirname(output));
    throw new Error('synthetic fixture generation failed');
  });
});

afterEach(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
});

describe('synthetic E2E fixture cleanup', () => {
  it('removes its temporary root when preparation fails', async () => {
    await expect(
      runSyntheticE2e(repositoryRoot, {cleanup: true}),
    ).rejects.toThrow('synthetic fixture generation failed');

    expect(temporaryRoot).not.toBeNull();
    await expect(access(temporaryRoot!)).rejects.toThrow(/ENOENT/);
  });
});
