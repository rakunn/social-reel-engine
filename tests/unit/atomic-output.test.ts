import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  runWithMediaOperationPublicationGuard,
  runWithPublicationGuard,
} from '../../src/core/publication-guard';
import {writeAtomically} from '../../src/media/atomic-output';
import {exitCodeForRenderError, RenderInterruptedError} from '../../src/render/errors';

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

  it('preserves an interrupt when partial-output cleanup also fails', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    const interruption = new RenderInterruptedError('SIGTERM');

    let thrown: unknown;
    try {
      await writeAtomically(output, async (temporary) => {
        await mkdir(temporary);
        throw interruption;
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toBe(interruption);
    expect(exitCodeForRenderError(thrown)).toBe(143);
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

  it('cleans matching orphaned partials before a retry writes a replacement', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    await writeFile(path.join(directory, '.proxy.partial-interrupted.mp4'), 'orphaned proxy');
    await writeFile(path.join(directory, '.other.partial-interrupted.mp4'), 'different output');

    await writeAtomically(output, async (temporary) => {
      await writeFile(temporary, 'replacement proxy');
    });

    await expect(readFile(output, 'utf8')).resolves.toBe('replacement proxy');
    await expect(readdir(directory)).resolves.toEqual([
      '.other.partial-interrupted.mp4',
      'proxy.mp4',
    ]);
  });

  it('tags a media partial with its operation ID', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    let temporaryPath = '';

    await runWithMediaOperationPublicationGuard(
      'operation-123',
      async () => undefined,
      async () =>
        await writeAtomically(output, async (temporary) => {
          temporaryPath = temporary;
          await writeFile(temporary, 'operation-owned proxy');
        }),
    );

    expect(path.basename(temporaryPath)).toMatch(/^\.proxy\.partial-operation-123-/);
    await expect(readFile(output, 'utf8')).resolves.toBe('operation-owned proxy');
  });

  it('reclaims a predecessor media operation partial during cleanup', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    const predecessorPartial = path.join(
      directory,
      '.proxy.partial-interrupted-operation.mp4',
    );
    await writeFile(predecessorPartial, 'interrupted proxy');

    await runWithMediaOperationPublicationGuard(
      'operation-123',
      async () => undefined,
      async () =>
        await writeAtomically(output, async (temporary) => {
          await writeFile(temporary, 'replacement proxy');
        }),
    );

    await expect(readFile(predecessorPartial, 'utf8')).rejects.toThrow(/ENOENT/);
    await expect(readFile(output, 'utf8')).resolves.toBe('replacement proxy');
  });

  it('does not delete a successor partial after ownership is lost during cleanup', async () => {
    const directory = await makeDirectory();
    const output = path.join(directory, 'proxy.mp4');
    const successorPartial = path.join(
      directory,
      '.proxy.partial-successor-operation-123.mp4',
    );
    await writeFile(successorPartial, 'successor proxy');
    let assertions = 0;

    await expect(
      runWithPublicationGuard(
        async () => {
          assertions += 1;
          if (assertions >= 2) throw new Error('operation ownership lost');
        },
        async () =>
          await writeAtomically(output, async (temporary) => {
            await writeFile(temporary, 'replacement proxy');
          }),
      ),
    ).rejects.toThrow(/ownership lost/i);

    await expect(readFile(successorPartial, 'utf8')).resolves.toBe('successor proxy');
    await expect(readFile(output, 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
