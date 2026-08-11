import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

const validation = vi.hoisted(() => ({
  validateEdit: vi.fn(),
}));
const artifacts = vi.hoisted(() => ({
  expectedRenderFingerprint: vi.fn(),
  readRenderArtifactFreshness: vi.fn(),
  readRenderArtifactRecord: vi.fn(),
}));

vi.mock('../../src/edit/validate', () => ({
  validateEdit: validation.validateEdit,
}));
vi.mock('../../src/render/artifacts', () => artifacts);

import {approveEdit} from '../../src/edit/approve';
import {writeJson} from '../../src/core/json';
import {createSourceIntegrityContext} from '../../src/media/source-integrity';
import {createReelProject} from '../../src/project/workspace';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const temporaryRoots: string[] = [];

afterEach(async () => {
  validation.validateEdit.mockReset();
  artifacts.expectedRenderFingerprint.mockReset();
  artifacts.readRenderArtifactFreshness.mockReset();
  artifacts.readRenderArtifactRecord.mockReset();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => await rm(root, {recursive: true, force: true})));
});

describe('approval integrity context', () => {
  it('reuses the verified context for preview freshness', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reel-approval-integrity-'));
    temporaryRoots.push(root);
    const projectPath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot: path.join(root, 'projects'),
      reelName: 'approval-integrity',
    });
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      schemaVersion: '1.0.0',
      reelName: 'approval-integrity',
      output: {width: 1080, height: 1920, fps: 30},
      clips: [
        {
          id: 'shot-1',
          sourceId: 'source-1',
          inSeconds: 0,
          outSeconds: 1,
          playbackRate: 1,
          crop: {
            start: {x: 0.5, y: 0.5, scale: 1},
            end: {x: 0.5, y: 0.5, scale: 1},
          },
          stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
          grade: {
            exposureStops: 0,
            whiteBalanceKelvin: 6500,
            tint: 0,
            technicalLutId: null,
            creativeLutId: null,
            combinedLutId: null,
            creativeMix: 0,
          },
          audio: {muted: true, gainDb: 0},
          transitionAfter: {type: 'none', durationSeconds: 0},
        },
      ],
      titles: [],
      music: null,
      captions: null,
    });
    const integrity = createSourceIntegrityContext();
    validation.validateEdit.mockResolvedValue({valid: true, failures: []});
    artifacts.expectedRenderFingerprint.mockResolvedValue('preview-fingerprint');
    artifacts.readRenderArtifactFreshness.mockResolvedValue({fresh: false, reason: 'stubbed stale preview'});

    await expect(approveEdit(projectPath, new Date(), {integrity})).rejects.toThrow(/stubbed stale preview/i);
    expect(artifacts.readRenderArtifactFreshness).toHaveBeenCalledWith(projectPath, 'preview', {
      expectedFingerprint: 'preview-fingerprint',
      integrity,
    });
  });
});
