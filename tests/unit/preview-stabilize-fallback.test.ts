import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {EditClip} from '../../src/contracts/schemas';

const runFfmpeg = vi.hoisted(() => vi.fn());

vi.mock('../../src/media/ffmpeg', () => ({runFfmpeg}));
vi.mock('../../src/core/implementation-fingerprint', () => ({
  implementationFingerprint: vi.fn(async () => 'pipeline-build'),
}));

import {preparePreviewStabilizedClip} from '../../src/media/preview-stabilize';

const processResult = (exitCode: number) => ({
  command: 'ffmpeg',
  args: [],
  stdout: '',
  stderr: '',
  exitCode,
});

describe('preview stabilization fallback', () => {
  beforeEach(() => {
    runFfmpeg.mockReset();
  });

  it('uses the unstabilized proxy when the transform pass fails and fallback is enabled', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-stabilize-fallback-'));
    const originalPath = path.join(projectPath, 'input/clips/original.mp4');
    const proxyPath = path.join(projectPath, 'work/proxies/source.mp4');
    await mkdir(path.dirname(originalPath), {recursive: true});
    await mkdir(path.dirname(proxyPath), {recursive: true});
    await writeFile(originalPath, 'original-video');
    await writeFile(proxyPath, 'proxy-video');

    runFfmpeg.mockImplementation(
      async (args: readonly string[], options?: {allowFailure?: boolean}) => {
        const filter = args[args.indexOf('-vf') + 1];
        if (filter.includes('vidstabdetect=')) {
          const transformsPath = filter.match(/result=(.+)$/)?.[1];
          if (!transformsPath) throw new Error('test could not locate transform path');
          await writeFile(transformsPath, 'detected-transforms');
          return processResult(0);
        }
        expect(options).toEqual({allowFailure: true});
        return processResult(1);
      },
    );

    const clip: EditClip = {
      id: 'shot-1',
      sourceId: 'source-1',
      inSeconds: 0,
      outSeconds: 1,
      playbackRate: 1,
      crop: {
        start: {x: 0.5, y: 0.5, scale: 1},
        end: {x: 0.5, y: 0.5, scale: 1},
      },
      stabilization: {enabled: true, strength: 0.2, fallbackToUnstabilized: true},
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
    };

    const result = await preparePreviewStabilizedClip(
      projectPath,
      clip,
      proxyPath,
      originalPath,
      'scale=960:-2',
      null,
      false,
    );

    expect(result.sourcePath).toBe(proxyPath);
    expect(result.item).toEqual(
      expect.objectContaining({
        stabilization: 'fallback',
        path: null,
        checksumSha256: null,
        transformPath: null,
        transformChecksumSha256: null,
      }),
    );
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
  });
});
