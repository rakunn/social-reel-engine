import {access, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  createReelProject,
  getProjectStatus,
  type ProjectStatus,
} from '../../src/project/workspace';
import {ingestFiles, scanInputs} from '../../src/project/ingest';
import {
  artifactFingerprint,
  isArtifactFresh,
  type ArtifactRecord,
} from '../../src/project/artifacts';
import {hashFile} from '../../src/core/hash';
import {analyzeSources} from '../../src/media/analyze';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const makeProjectsRoot = async (): Promise<string> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-engine-workspace-'));
  return path.join(temporaryRoot, 'projects');
};

describe('reel project workspace', () => {
  it('creates the complete isolated folder structure and personalized records', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'island-sunrise',
      title: 'Island Sunrise',
      now: new Date('2026-08-10T00:00:00.000Z'),
    });

    const expectedDirectories = [
      'input/clips',
      'input/music',
      'input/captions',
      'input/luts/technical',
      'input/luts/creative',
      'input/fonts',
      'input/brand',
      'config',
      'analysis',
      'edits',
      'work',
      'previews',
      'output',
    ];
    const entries = await Promise.all(
      expectedDirectories.map(async (directory) => {
        const stat = await import('node:fs/promises').then(({stat}) =>
          stat(path.join(projectPath, directory)),
        );
        return stat.isDirectory();
      }),
    );
    expect(entries.every(Boolean)).toBe(true);

    const brief = JSON.parse(await readFile(path.join(projectPath, 'brief.json'), 'utf8'));
    expect(brief.identity).toEqual({
      reelName: 'island-sunrise',
      title: 'Island Sunrise',
      createdAt: '2026-08-10T00:00:00.000Z',
    });
    expect(
      JSON.parse(await readFile(path.join(projectPath, 'analysis/approvals.json'), 'utf8')),
    ).toEqual({schemaVersion: '1.0.0', edit: null, color: null});

    await expect(
      createReelProject({
        engineRoot: repositoryRoot,
        projectsRoot,
        reelName: 'island-sunrise',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('reports actionable stage readiness', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'status-test',
    });
    const status: ProjectStatus = await getProjectStatus(projectPath);
    expect(status.stage).toBe('awaiting-inputs');
    expect(status.nextAction).toMatch(/input\/clips/i);
  });

  it('does not leave a project directory when the title is invalid', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = path.join(projectsRoot, 'invalid-title');

    await expect(
      createReelProject({
        engineRoot: repositoryRoot,
        projectsRoot,
        reelName: 'invalid-title',
        title: 'x'.repeat(161),
      }),
    ).rejects.toThrow(/160|too_big|title/i);
    await expect(access(projectPath)).rejects.toThrow();

    await expect(
      createReelProject({
        engineRoot: repositoryRoot,
        projectsRoot,
        reelName: 'invalid-title',
        title: 'Corrected title',
      }),
    ).resolves.toBe(projectPath);
  });
});

describe('immutable ingest', () => {
  it('copies inputs, records checksums, and leaves originals unchanged', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'ingest-test',
    });
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'reel-source-'));
    const source = path.join(sourceRoot, 'DJI_0001.MP4');
    await writeFile(source, Buffer.from('immutable synthetic clip'));
    const before = await hashFile(source);

    const result = await ingestFiles(projectPath, [source], 'clips');
    expect(result.added).toHaveLength(1);
    expect(await hashFile(source)).toBe(before);
    expect(await hashFile(path.join(projectPath, 'input/clips/DJI_0001.MP4'))).toBe(before);

    const manifest = await scanInputs(projectPath, new Date('2026-08-10T00:00:00.000Z'));
    expect(manifest.files).toEqual([
      expect.objectContaining({
        relativePath: 'input/clips/DJI_0001.MP4',
        checksumSha256: before,
        kind: 'clips',
      }),
    ]);

    const second = await ingestFiles(projectPath, [source], 'clips');
    expect(second).toEqual({added: [], unchanged: ['input/clips/DJI_0001.MP4']});
  });

  it('will not overwrite a same-name source with different bytes', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'conflict-test',
    });
    const leftRoot = await mkdtemp(path.join(tmpdir(), 'reel-left-'));
    const rightRoot = await mkdtemp(path.join(tmpdir(), 'reel-right-'));
    const left = path.join(leftRoot, 'clip.mov');
    const right = path.join(rightRoot, 'clip.mov');
    await writeFile(left, 'left');
    await writeFile(right, 'right');
    await ingestFiles(projectPath, [left], 'clips');
    await expect(ingestFiles(projectPath, [right], 'clips')).rejects.toThrow(/refusing to overwrite/i);
  });

  it('gives byte-identical files at different paths distinct source IDs', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'duplicate-bytes',
    });
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'reel-duplicate-bytes-'));
    const first = path.join(sourceRoot, 'first.srt');
    const second = path.join(sourceRoot, 'second.srt');
    const contents = '1\n00:00:00,000 --> 00:00:01,000\nSame bytes\n';
    await writeFile(first, contents);
    await writeFile(second, contents);
    await ingestFiles(projectPath, [first, second], 'captions');

    const manifest = await analyzeSources(projectPath);
    expect(manifest.sources).toHaveLength(2);
    expect(new Set(manifest.sources.map((source) => source.id)).size).toBe(2);
  });
});

describe('generated artifact cache keys', () => {
  it('is fresh only when source and configuration fingerprints match', () => {
    const fingerprint = artifactFingerprint({sources: ['sha-a'], config: {proxy: 'v1'}});
    const artifact: ArtifactRecord = {
      fingerprint,
      generatedAt: '2026-08-10T00:00:00.000Z',
      files: ['work/proxies/clip.mp4'],
    };
    expect(isArtifactFresh(artifact, fingerprint)).toBe(true);
    expect(
      isArtifactFresh(
        artifact,
        artifactFingerprint({sources: ['sha-b'], config: {proxy: 'v1'}}),
      ),
    ).toBe(false);
  });
});
