import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {writeAtomically} from '../../src/media/atomic-output';

const temporaryDirectories: string[] = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reel-atomic-output-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, {recursive: true, force: true})));
});

describe('atomic media output', () => {
  it('keeps the prior final file when the media writer fails', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    await writeFile(output, 'known-good-proxy');

    await expect(
      writeAtomically(output, async (temporary) => {
        await writeFile(temporary, 'partial-proxy');
        throw new Error('ffmpeg exited with code 1');
      }),
    ).rejects.toThrow('ffmpeg exited with code 1');

    await expect(readFile(output, 'utf8')).resolves.toBe('known-good-proxy');
    await expect(readdir(directory)).resolves.toEqual(['proxy.mp4']);
  });

  it('validates a completed temporary output before publishing it', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    let validated = '';

    await writeAtomically(
      output,
      async (temporary) => {
        await writeFile(temporary, 'complete-proxy');
      },
      async (temporary) => {
        validated = await readFile(temporary, 'utf8');
      },
    );

    expect(validated).toBe('complete-proxy');
    await expect(readFile(output, 'utf8')).resolves.toBe('complete-proxy');
  });
});
