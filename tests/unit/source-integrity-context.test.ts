import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {analyzeSources} from '../../src/media/analyze';
import {
  createSourceIntegrityContext,
  readVerifiedInputSnapshot,
} from '../../src/media/source-integrity';
import {
  ingestFiles,
  readValidatedIngestManifest,
} from '../../src/project/ingest';
import {createReelProject} from '../../src/project/workspace';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

const makeProject = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-integrity-context-'));
  temporaryRoots.push(root);
  return await createReelProject({
    engineRoot: repositoryRoot,
    projectsRoot: path.join(root, 'projects'),
    reelName: 'integrity-context',
  });
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, {recursive: true, force: true})));
});

describe('source integrity context', () => {
  it('reuses a verified input snapshot during one command', async () => {
    const projectPath = await makeProject();
    const sourcePath = path.join(path.dirname(projectPath), 'caption.srt');
    await writeFile(sourcePath, '1\n00:00:00,000 --> 00:00:01,000\nOriginal\n');
    await ingestFiles(projectPath, [sourcePath], 'captions');
    await analyzeSources(projectPath);

    const context = createSourceIntegrityContext();
    const first = await readVerifiedInputSnapshot(projectPath, context);
    const second = await readVerifiedInputSnapshot(projectPath, context);

    expect(second).toBe(first);
    expect(first.ingest.files).toHaveLength(1);
    expect(first.sourceManifest.sources[0]).toMatchObject({
      relativePath: 'input/captions/caption.srt',
      mediaType: 'caption',
    });
  });

  it('rejects changed input bytes in a fresh command context', async () => {
    const projectPath = await makeProject();
    const sourcePath = path.join(path.dirname(projectPath), 'caption.srt');
    await writeFile(sourcePath, '1\n00:00:00,000 --> 00:00:01,000\nOriginal\n');
    await ingestFiles(projectPath, [sourcePath], 'captions');
    await analyzeSources(projectPath);

    await writeFile(
      path.join(projectPath, 'input/captions/caption.srt'),
      '1\n00:00:00,000 --> 00:00:01,000\nChanged\n',
    );

    await expect(
      readVerifiedInputSnapshot(projectPath, createSourceIntegrityContext()),
    ).rejects.toThrow(/stale or inconsistent/i);
  });

  it('rejects a LUT whose bytes changed after analysis', async () => {
    const projectPath = await makeProject();
    const sourcePath = path.join(path.dirname(projectPath), 'normalizer.cube');
    await writeFile(sourcePath, 'TITLE "Original"\nLUT_3D_SIZE 2\n');
    await ingestFiles(projectPath, [sourcePath], 'technical-lut');
    await analyzeSources(projectPath);

    await writeFile(
      path.join(projectPath, 'input/luts/technical/normalizer.cube'),
      'TITLE "Changed"\nLUT_3D_SIZE 2\n',
    );

    await expect(
      readValidatedIngestManifest(projectPath),
    ).rejects.toThrow(/stale|inconsistent|ingest|checksum/i);
  });
});
