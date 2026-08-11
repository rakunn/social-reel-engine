import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {getProjectStatus} from '../../src/project/workspace';
import {
  beginMediaOperation,
  completeMediaOperation,
  readMediaOperation,
  runMediaOperation,
  updateMediaOperation,
} from '../../src/project/operation';

const temporaryProjects: string[] = [];

const makeProject = async (): Promise<string> => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-operation-'));
  temporaryProjects.push(projectPath);
  return projectPath;
};

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map(async (projectPath) => await rm(projectPath, {recursive: true, force: true})));
});

describe('media operation records', () => {
  it('persists proxy progress and removes the record after a successful operation', async () => {
    const projectPath = await makeProject();

    await beginMediaOperation(projectPath, 'proxy', {
      now: new Date('2026-08-11T10:00:00.000Z'),
      pid: process.pid,
      phase: 'transcoding',
      progress: {completed: 0, total: 7, label: 'source-01'},
    });
    await updateMediaOperation(projectPath, {
      now: new Date('2026-08-11T10:01:00.000Z'),
      phase: 'transcoding',
      progress: {completed: 1, total: 7, label: 'source-02'},
    });

    await expect(readMediaOperation(projectPath)).resolves.toMatchObject({
      command: 'proxy',
      state: 'running',
      phase: 'transcoding',
      progress: {completed: 1, total: 7, label: 'source-02'},
    });

    await completeMediaOperation(projectPath);

    await expect(readMediaOperation(projectPath)).resolves.toBeNull();
  });

  it('reports an active operation before it scans a project with no input directories', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'proxy', {
      now: new Date('2026-08-11T10:00:00.000Z'),
      pid: process.pid,
      phase: 'transcoding',
      progress: {completed: 2, total: 7, label: 'source-03'},
    });

    await expect(getProjectStatus(projectPath)).resolves.toMatchObject({
      stage: 'media-in-progress',
      activity: {
        command: 'proxy',
        phase: 'transcoding',
        progress: {completed: 2, total: 7, label: 'source-03'},
      },
    });
  });

  it('does not replace a live operation with a competing media command', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'proxy', {
      pid: process.pid,
      phase: 'transcoding',
    });

    await expect(
      runMediaOperation(projectPath, 'analyze', async () => undefined),
    ).rejects.toThrow(/proxy is already active/i);
    await expect(readMediaOperation(projectPath)).resolves.toMatchObject({
      command: 'proxy',
      state: 'running',
    });
  });

  it('reports a stale operation as interrupted with its retry command', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'render', {
      now: new Date('2026-08-11T10:00:00.000Z'),
      pid: 999_999_999,
      phase: 'rendering-master',
      progress: null,
    });

    await expect(getProjectStatus(projectPath)).resolves.toMatchObject({
      stage: 'interrupted-media-job',
      nextAction: 'Run render again to replace interrupted work safely.',
      activity: {command: 'render', phase: 'rendering-master'},
    });
  });

  it('replaces a stale operation when its retry completes successfully', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'render', {
      pid: 999_999_999,
      phase: 'rendering-master',
    });

    await expect(
      runMediaOperation(projectPath, 'render', async () => 'recovered'),
    ).resolves.toBe('recovered');
    await expect(readMediaOperation(projectPath)).resolves.toBeNull();
  });

  it('keeps a failed operation record with the last reported phase', async () => {
    const projectPath = await makeProject();

    await expect(
      runMediaOperation(projectPath, 'proxy', async ({update}) => {
        await update({
          phase: 'transcoding',
          progress: {completed: 3, total: 7, label: 'source-04'},
        });
        throw new Error('ffmpeg exited with code 1');
      }),
    ).rejects.toThrow('ffmpeg exited with code 1');

    await expect(readMediaOperation(projectPath)).resolves.toMatchObject({
      command: 'proxy',
      state: 'failed',
      phase: 'transcoding',
      progress: {completed: 3, total: 7, label: 'source-04'},
      error: 'ffmpeg exited with code 1',
    });
  });
});
