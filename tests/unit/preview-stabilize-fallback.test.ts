import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {EditClip} from '../../src/contracts/schemas';
import {RenderInterruptedError} from '../../src/render/errors';

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

const temporaryDirectories: string[] = [];

const makeStabilizationFixture = async () => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-stabilize-fallback-'));
  temporaryDirectories.push(projectPath);
  const originalPath = path.join(projectPath, 'input/clips/original.mp4');
  const proxyPath = path.join(projectPath, 'work/proxies/source.mp4');
  await mkdir(path.dirname(originalPath), {recursive: true});
  await mkdir(path.dirname(proxyPath), {recursive: true});
  await writeFile(originalPath, 'original-video');
  await writeFile(proxyPath, 'proxy-video');

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
    stabilization: {
      enabled: true,
      strength: 0.2,
      fallbackToUnstabilized: true,
    },
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

  return {projectPath, originalPath, proxyPath, clip};
};

const prepareFixtureClip = async (fixture: Awaited<ReturnType<typeof makeStabilizationFixture>>) =>
  await preparePreviewStabilizedClip(
    fixture.projectPath,
    fixture.clip,
    fixture.proxyPath,
    fixture.originalPath,
    'scale=960:-2',
    null,
    false,
  );

describe('preview stabilization fallback', () => {
  beforeEach(() => {
    runFfmpeg.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(async (directory) => await rm(directory, {recursive: true, force: true})),
    );
  });

  it('uses the unstabilized proxy when the transform pass fails and fallback is enabled', async () => {
    const fixture = await makeStabilizationFixture();

    runFfmpeg.mockImplementation(async (args: readonly string[]) => {
      const filter = args[args.indexOf('-vf') + 1];
      if (filter.includes('vidstabdetect=')) {
        const transformsPath = filter.match(/result=(.+)$/)?.[1];
        if (!transformsPath) throw new Error('test could not locate transform path');
        await writeFile(transformsPath, 'detected-transforms');
        return processResult(0);
      }
      throw new Error('transform failed');
    });

    const result = await prepareFixtureClip(fixture);

    expect(result.sourcePath).toBe(fixture.proxyPath);
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

  it('propagates an interrupt from stabilization detection instead of selecting fallback', async () => {
    const fixture = await makeStabilizationFixture();
    const interruption = new RenderInterruptedError('SIGINT');
    runFfmpeg.mockRejectedValueOnce(interruption);

    await expect(prepareFixtureClip(fixture)).rejects.toBe(interruption);
  });

  it('propagates an interrupt from stabilization transformation instead of selecting fallback', async () => {
    const fixture = await makeStabilizationFixture();
    const interruption = new RenderInterruptedError('SIGTERM');
    runFfmpeg
      .mockImplementationOnce(async (args: readonly string[]) => {
        const filter = args[args.indexOf('-vf') + 1];
        const transformsPath = filter.match(/result=(.+)$/)?.[1];
        if (!transformsPath) throw new Error('test could not locate transform path');
        await writeFile(transformsPath, 'detected-transforms');
        return processResult(0);
      })
      .mockRejectedValueOnce(interruption);

    await expect(prepareFixtureClip(fixture)).rejects.toBe(interruption);
  });

  it('propagates an interrupt nested in a detection cleanup failure', async () => {
    const fixture = await makeStabilizationFixture();
    const interruption = new RenderInterruptedError('SIGINT');
    const aggregate = new AggregateError(
      [interruption, new Error('temporary transform cleanup failed')],
      'detection and cleanup failed',
    );
    runFfmpeg.mockRejectedValueOnce(aggregate);

    await expect(prepareFixtureClip(fixture)).rejects.toBe(aggregate);
  });

  it('propagates an interrupt nested in a transformation cleanup failure', async () => {
    const fixture = await makeStabilizationFixture();
    const interruption = new RenderInterruptedError('SIGTERM');
    const aggregate = new AggregateError(
      [new Error('temporary output cleanup failed'), interruption],
      'transformation and cleanup failed',
    );
    runFfmpeg
      .mockImplementationOnce(async (args: readonly string[]) => {
        const filter = args[args.indexOf('-vf') + 1];
        const transformsPath = filter.match(/result=(.+)$/)?.[1];
        if (!transformsPath) throw new Error('test could not locate transform path');
        await writeFile(transformsPath, 'detected-transforms');
        return processResult(0);
      })
      .mockRejectedValueOnce(aggregate);

    await expect(prepareFixtureClip(fixture)).rejects.toBe(aggregate);
  });
});
