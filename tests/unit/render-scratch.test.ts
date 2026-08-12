import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  pruneRenderStages,
  removeRenderStage,
  renderStageRoot,
  stageImmutableFile,
  withDisposableRenderStage,
} from '../../src/render/scratch';

const temporaryDirectories: string[] = [];

const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'reel-render-scratch-'));
  temporaryDirectories.push(directory);
  return directory;
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, {recursive: true, force: true})),
  );
});

describe('render scratch lifecycle', () => {
  it('prunes stale fingerprints only for the selected reel', async () => {
    const engineRoot = await makeDirectory();
    const stale = renderStageRoot(engineRoot, 'camp-reel', '1111111111111111');
    const keep = renderStageRoot(engineRoot, 'camp-reel', '2222222222222222');
    const otherReel = renderStageRoot(engineRoot, 'other-reel', '3333333333333333');
    await Promise.all(
      [stale, keep, otherReel].map(async (directory) => {
        await mkdir(directory, {recursive: true});
        await writeFile(path.join(directory, 'asset.bin'), directory);
      }),
    );

    await pruneRenderStages(engineRoot, 'camp-reel', keep);

    expect(await exists(stale)).toBe(false);
    expect(await exists(keep)).toBe(true);
    expect(await exists(otherReel)).toBe(true);
  });

  it('rejects deletion targets outside an exact fingerprint directory', async () => {
    const engineRoot = await makeDirectory();
    const outside = path.join(engineRoot, 'do-not-delete');
    await mkdir(outside);
    await writeFile(path.join(outside, 'sentinel'), 'keep');

    await expect(removeRenderStage(engineRoot, outside)).rejects.toThrow(
      /render stage|public\/jobs/i,
    );
    await expect(readFile(path.join(outside, 'sentinel'), 'utf8')).resolves.toBe('keep');
  });

  it('does not follow a symlinked reel directory during recursive cleanup', async () => {
    const engineRoot = await makeDirectory();
    const jobsRoot = path.join(engineRoot, 'public/jobs');
    const outsideReel = path.join(engineRoot, 'outside/camp-reel');
    const outsideStage = path.join(outsideReel, '7777777777777777');
    const sentinel = path.join(outsideStage, 'sentinel');
    await mkdir(jobsRoot, {recursive: true});
    await mkdir(outsideStage, {recursive: true});
    await writeFile(sentinel, 'keep');
    await symlink(outsideReel, path.join(jobsRoot, 'camp-reel'), 'dir');

    await expect(
      removeRenderStage(
        engineRoot,
        path.join(jobsRoot, 'camp-reel/7777777777777777'),
      ),
    ).rejects.toThrow(/symlink|outside|boundary/i);
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
  });

  it('rejects a symlink at the current fingerprint before staging into it', async () => {
    const engineRoot = await makeDirectory();
    const jobsRoot = path.join(engineRoot, 'public/jobs');
    const reelRoot = path.join(jobsRoot, 'camp-reel');
    const outsideStage = path.join(engineRoot, 'outside/current-stage');
    const keep = path.join(reelRoot, '8888888888888888');
    await mkdir(reelRoot, {recursive: true});
    await mkdir(outsideStage, {recursive: true});
    await symlink(outsideStage, keep, 'dir');

    await expect(pruneRenderStages(engineRoot, 'camp-reel', keep)).rejects.toThrow(
      /symlink|real directory|boundary/i,
    );
  });

  it('hard-links immutable staged media when source and stage share a filesystem', async () => {
    const engineRoot = await makeDirectory();
    const source = path.join(engineRoot, 'project/work/proxies/source.mp4');
    const stageRoot = renderStageRoot(engineRoot, 'camp-reel', '4444444444444444');
    await mkdir(path.dirname(source), {recursive: true});
    await writeFile(source, 'immutable-proxy');

    const relative = await stageImmutableFile(source, stageRoot, 'media/shot-1.mp4');
    const staged = path.join(stageRoot, relative);

    expect(await readFile(staged, 'utf8')).toBe('immutable-proxy');
    expect((await stat(staged)).ino).toBe((await stat(source)).ino);
  });

  it('disposes the current stage after success and failure', async () => {
    const engineRoot = await makeDirectory();
    const successful = renderStageRoot(engineRoot, 'camp-reel', '5555555555555555');
    const failed = renderStageRoot(engineRoot, 'camp-reel', '6666666666666666');
    await mkdir(successful, {recursive: true});

    await expect(
      withDisposableRenderStage(engineRoot, successful, async () => 'rendered'),
    ).resolves.toBe('rendered');
    expect(await exists(successful)).toBe(false);

    await mkdir(failed, {recursive: true});
    await expect(
      withDisposableRenderStage(engineRoot, failed, async () => {
        throw new Error('render failed');
      }),
    ).rejects.toThrow('render failed');
    expect(await exists(failed)).toBe(false);
  });
});
