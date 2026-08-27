import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  acquireProjectNameReservation,
  createReelProject,
  getProjectStatus,
  type ProjectStatus,
} from '../../src/project/workspace';
import {ingestFiles, scanInputs} from '../../src/project/ingest';
import {runWithStatusScanLock} from '../../src/project/operation';
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
  it('honors an existing atomic reservation for a project name', async () => {
    const projectsRoot = await makeProjectsRoot();
    const reservation = await acquireProjectNameReservation(projectsRoot, 'reserved-project');
    try {
      await expect(
        createReelProject({
          engineRoot: repositoryRoot,
          projectsRoot,
          reelName: 'reserved-project',
        }),
      ).rejects.toThrow(/reserved|being created/i);
      await expect(access(path.join(projectsRoot, 'reserved-project'))).rejects.toThrow();
    } finally {
      await reservation.release();
    }
  });

  it('reclaims a project-name reservation whose owner process is gone', async () => {
    const projectsRoot = await makeProjectsRoot();
    const reservationPath = path.join(projectsRoot, '.project-stale-project.reservation');
    await mkdir(reservationPath, {recursive: true});
    await writeFile(
      path.join(reservationPath, 'owner.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        id: 'stale-owner',
        pid: 2_147_483_647,
        acquiredAt: '2026-08-27T00:00:00.000Z',
      }),
    );

    await expect(
      createReelProject({
        engineRoot: repositoryRoot,
        projectsRoot,
        reelName: 'stale-project',
      }),
    ).resolves.toBe(path.join(projectsRoot, 'stale-project'));
    await expect(access(reservationPath)).rejects.toThrow();
  });

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
    expect(
      JSON.parse(await readFile(path.join(projectPath, 'config/photos.json'), 'utf8')),
    ).toEqual({
      schemaVersion: '1.0.0',
      enabled: false,
      profiles: [],
      count: 5,
      jpegQuality: 95,
    });

    await expect(
      createReelProject({
        engineRoot: repositoryRoot,
        projectsRoot,
        reelName: 'island-sunrise',
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it('creates a 1.91:1 carousel project with per-card duration targets', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'loboc-carousel',
      title: 'Loboc River',
      format: 'carousel-1.91:1',
      now: new Date('2026-08-18T00:00:00.000Z'),
    });

    const brief = JSON.parse(await readFile(path.join(projectPath, 'brief.json'), 'utf8'));
    const edit = JSON.parse(await readFile(path.join(projectPath, 'edits/edit.json'), 'utf8'));
    const settings = JSON.parse(
      await readFile(path.join(projectPath, 'config/settings.json'), 'utf8'),
    );

    expect(brief).toEqual(
      expect.objectContaining({
        projectType: 'carousel',
        target: {minSeconds: 4, idealSeconds: 4.5, maxSeconds: 5},
        output: {width: 1910, height: 1000, fps: 30},
        options: {music: false, captions: false, cameraAudio: false},
      }),
    );
    expect(edit.output).toEqual({width: 1910, height: 1000, fps: 30});
    expect(settings.preview).toEqual(
      expect.objectContaining({width: 764, height: 400}),
    );
    expect(settings.master).toEqual(
      expect.objectContaining({width: 1910, height: 1000}),
    );
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

  it('does not create a project directory when status targets an unknown reel', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = path.join(projectsRoot, 'misspelled-reel');

    await expect(getProjectStatus(projectPath)).rejects.toThrow(/does not exist or is incomplete/i);
    await expect(access(projectPath)).rejects.toThrow();
  });

  it('counts clips recursively when reporting status', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'nested-clips',
    });
    const nestedDirectory = path.join(projectPath, 'input/clips/day-one');
    await mkdir(nestedDirectory, {recursive: true});
    await writeFile(path.join(nestedDirectory, 'clip.mp4'), 'synthetic nested clip');

    const status = await getProjectStatus(projectPath);
    expect(status.inputs).toBe(1);
    expect(status.stage).toBe('awaiting-analysis');
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
  it('does not mutate inputs while a snapshot scan holds the project lock', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'ingest-snapshot-lock',
    });
    const sourceRoot = await mkdtemp(path.join(tmpdir(), 'reel-source-'));
    const source = path.join(sourceRoot, 'locked.MP4');
    await writeFile(source, 'locked input bytes');

    const snapshot = await runWithStatusScanLock(projectPath, async () => {
      await expect(ingestFiles(projectPath, [source], 'clips')).rejects.toThrow(
        /snapshot|status|lock|media work/i,
      );
    });

    expect(snapshot.acquired).toBe(true);
    await expect(access(path.join(projectPath, 'input/clips/locked.MP4'))).rejects.toThrow();
  });

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

  it('ignores macOS filesystem metadata during recursive input scans', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'metadata-scan',
    });
    const clipsDirectory = path.join(projectPath, 'input/clips');
    const archiveMetadata = path.join(clipsDirectory, '__MACOSX');
    await mkdir(archiveMetadata, {recursive: true});
    await writeFile(path.join(clipsDirectory, 'clip.mp4'), 'synthetic clip');
    await writeFile(path.join(clipsDirectory, '.DS_Store'), 'finder metadata');
    await writeFile(path.join(clipsDirectory, '._clip.mp4'), 'appledouble metadata');
    await writeFile(path.join(archiveMetadata, '._clip.mp4'), 'archive metadata');

    const manifest = await scanInputs(projectPath);

    expect(manifest.files.map((file) => file.relativePath)).toEqual([
      'input/clips/clip.mp4',
    ]);
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
