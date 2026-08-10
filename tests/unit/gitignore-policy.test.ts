import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {runProcess} from '../../src/media/process';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const checkIgnored = async (relativePath: string): Promise<boolean> => {
  const result = await runProcess(
    'git',
    ['check-ignore', '--no-index', '--quiet', relativePath],
    {cwd: repositoryRoot, allowFailure: true},
  );
  return result.exitCode === 0;
};

describe('runtime project Git policy', () => {
  it('ignores every file created inside a reel job', async () => {
    await expect(checkIgnored('projects/example-reel/brief.json')).resolves.toBe(true);
    await expect(
      checkIgnored('projects/example-reel/input/clips/source.mp4'),
    ).resolves.toBe(true);
  });

  it('keeps the reusable template and projects directory marker trackable', async () => {
    await expect(checkIgnored('templates/reel/brief.json')).resolves.toBe(false);
    await expect(checkIgnored('projects/.gitkeep')).resolves.toBe(false);
  });
});
