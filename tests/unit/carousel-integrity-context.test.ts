import {mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

const hashMutation = vi.hoisted(() => ({
  enabled: false,
  triggerPath: '',
  sourcePath: '',
}));

vi.mock('../../src/core/hash', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/hash')>();
  return {
    ...actual,
    hashFile: async (filePath: string) => {
      const checksum = await actual.hashFile(filePath);
      if (hashMutation.enabled && filePath === hashMutation.triggerPath) {
        hashMutation.enabled = false;
        await writeFile(hashMutation.sourcePath, 'changed-during-cached-carousel-check');
      }
      return checksum;
    },
  };
});

vi.mock('../../src/edit/validate', () => ({
  validateEdit: vi.fn().mockResolvedValue({valid: true, failures: [], warnings: []}),
}));

vi.mock('../../src/edit/approve', () => ({
  assertFinalReadiness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/render/artifacts', () => ({
  expectedRenderFingerprint: vi.fn().mockResolvedValue('a'.repeat(64)),
}));

import {hashFile} from '../../src/core/hash';
import {writeJson} from '../../src/core/json';
import {analyzeSources} from '../../src/media/analyze';
import {
  createSourceIntegrityContext,
  readVerifiedInputSnapshot,
} from '../../src/media/source-integrity';
import {ingestFiles} from '../../src/project/ingest';
import {createReelProject} from '../../src/project/workspace';
import {
  carouselCardFilename,
  expectedCarouselFingerprint,
  renderCarouselPackage,
} from '../../src/render/carousel';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

afterEach(async () => {
  hashMutation.enabled = false;
  hashMutation.triggerPath = '';
  hashMutation.sourcePath = '';
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, {recursive: true, force: true})),
  );
});

describe('carousel render integrity context', () => {
  it('rejects a cached package when a verified input changes during freshness evaluation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'carousel-integrity-context-'));
    temporaryRoots.push(root);
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot: path.join(root, 'projects'),
      reelName: 'cached-carousel-integrity',
      format: 'carousel-1.91:1',
    });
    const sourcePath = path.join(root, 'caption.srt');
    await writeFile(sourcePath, '1\n00:00:00,000 --> 00:00:01,000\nOriginal\n');
    await ingestFiles(projectPath, [sourcePath], 'captions');
    const manifest = await analyzeSources(projectPath);
    const sourceId = manifest.sources[0]?.id;
    if (!sourceId) throw new Error('Synthetic source manifest is empty');
    const clip = (id: string) => ({
      id,
      sourceId,
      inSeconds: 0,
      outSeconds: 4.5,
      playbackRate: 1,
      crop: {
        start: {x: 0.5, y: 0.5, scale: 1},
        end: {x: 0.5, y: 0.5, scale: 1},
      },
      stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
      grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
      audio: {muted: true, gainDb: 0},
      transitionAfter: {type: 'none' as const, durationSeconds: 0},
    });
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      schemaVersion: '1.0.0',
      reelName: 'cached-carousel-integrity',
      output: {width: 1910, height: 1000, fps: 30},
      clips: [clip('hero'), clip('closer')],
      titles: [],
      music: null,
      captions: null,
    });

    const integrity = createSourceIntegrityContext();
    await readVerifiedInputSnapshot(projectPath, integrity);
    const fingerprint = await expectedCarouselFingerprint(projectPath, {integrity});
    const outputDirectory = path.join(
      projectPath,
      `output/carousel/${fingerprint.slice(0, 16)}`,
    );
    const cards = [];
    for (const [index, clipId] of ['hero', 'closer'].entries()) {
      const relativeFile = `output/carousel/${fingerprint.slice(0, 16)}/${carouselCardFilename(index, clipId)}`;
      const absoluteFile = path.join(projectPath, ...relativeFile.split('/'));
      await import('node:fs/promises').then(({mkdir}) =>
        mkdir(outputDirectory, {recursive: true}),
      );
      await writeFile(absoluteFile, `cached-${clipId}`);
      cards.push({
        index,
        clipId,
        file: relativeFile,
        checksumSha256: await hashFile(absoluteFile),
        sizeBytes: (await stat(absoluteFile)).size,
        durationSeconds: 4.5,
      });
    }
    await writeJson(path.join(projectPath, 'analysis/carousel.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-19T00:00:00.000Z',
      fingerprint,
      aspectRatio: '1.91:1',
      cards,
    });

    hashMutation.triggerPath = path.join(projectPath, cards[1].file);
    hashMutation.sourcePath = path.join(projectPath, 'input/captions/caption.srt');
    hashMutation.enabled = true;

    await expect(
      renderCarouselPackage(projectPath, repositoryRoot, {integrity}),
    ).rejects.toThrow(/changed during the media operation|stale or inconsistent/i);
  });
});
