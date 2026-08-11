import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getProjectStatus} from '../../src/project/workspace';
import {writeJson} from '../../src/core/json';
import {writeAtomically} from '../../src/media/atomic-output';
import {
  MEDIA_OPERATION_COMMANDS,
  beginMediaOperation,
  completeMediaOperation,
  failMediaOperation,
  isMediaOperationAlive,
  readMediaOperation,
  runMediaOperation,
  runWithStatusScanLock,
  updateMediaOperation,
  type MediaOperationRecord,
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

    const operation = await beginMediaOperation(projectPath, 'proxy', {
      now: new Date('2026-08-11T10:00:00.000Z'),
      pid: process.pid,
      phase: 'transcoding',
      progress: {completed: 0, total: 7, label: 'source-01'},
    });
    await updateMediaOperation(projectPath, operation.id!, {
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

    await completeMediaOperation(projectPath, operation.id!);

    await expect(readMediaOperation(projectPath)).resolves.toBeNull();
  });

  it('marks completed operation state released before a successor starts', async () => {
    const projectPath = await makeProject();
    const completed = await beginMediaOperation(projectPath, 'proxy', {
      pid: process.pid,
      phase: 'transcoding',
    });

    await completeMediaOperation(projectPath, completed.id!);

    await expect(readMediaOperation(projectPath)).resolves.toBeNull();
    await expect(
      readFile(
        path.join(projectPath, 'analysis/operation.lock/owner.json'),
        'utf8',
      ),
    ).resolves.toContain('"state": "released"');
    await expect(
      readFile(path.join(projectPath, 'analysis/operation.json'), 'utf8'),
    ).resolves.toContain('"state": "completed"');

    const successor = await beginMediaOperation(projectPath, 'render', {
      pid: process.pid,
      phase: 'rendering-master',
    });
    await expect(
      readFile(
        path.join(projectPath, `analysis/operation.lock.reclaimed-${completed.id}/owner.json`),
        'utf8',
      ),
    ).resolves.toContain(completed.id!);
    await completeMediaOperation(projectPath, successor.id!);
  });

  it('reports an active operation before it scans a project with no input directories', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'proxy', {
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

  it('keeps a status scan from competing with producer startup', async () => {
    const projectPath = await makeProject();
    let releaseScan!: () => void;
    let markScanStarted!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const statusScan = runWithStatusScanLock(projectPath, async () => {
      markScanStarted();
      await release;
      return 'scanned';
    });

    await scanStarted;
    await expect(
      beginMediaOperation(projectPath, 'proxy', {pid: process.pid, phase: 'transcoding'}),
    ).rejects.toThrow(/status is checking inputs/i);

    releaseScan();
    await expect(statusScan).resolves.toEqual({acquired: true, value: 'scanned'});

    const media = await beginMediaOperation(projectPath, 'proxy', {
      pid: process.pid,
      phase: 'transcoding',
    });
    await completeMediaOperation(projectPath, media.id!);
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

  it('atomically admits one concurrent media operation and rejects every competitor', async () => {
    const projectPath = await makeProject();
    const results = await Promise.allSettled(
      Array.from({length: 8}, (_, index) =>
        beginMediaOperation(projectPath, index % 2 === 0 ? 'proxy' : 'render', {
          phase: 'starting',
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )) {
      expect(result.reason).toBeInstanceOf(Error);
      expect((result.reason as Error).message).toMatch(/already active/i);
    }
  });

  it('admits only one retry while reclaiming a stale media lock', async () => {
    const projectPath = await makeProject();
    await beginMediaOperation(projectPath, 'proxy', {
      pid: 999_999_999,
      phase: 'interrupted-proxy',
    });

    const results = await Promise.allSettled(
      Array.from({length: 12}, (_, index) =>
        beginMediaOperation(projectPath, index % 2 === 0 ? 'proxy' : 'render', {
          phase: 'starting',
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )) {
      expect(result.reason).toBeInstanceOf(Error);
      expect((result.reason as Error).message).toMatch(/already active/i);
    }
  });

  it('retries lock acquisition after reclaiming an ownerless stale lock', async () => {
    const projectPath = await makeProject();
    await mkdir(path.join(projectPath, 'analysis/operation.lock'), {recursive: true});

    let nowCalls = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      if (nowCalls === 1) return 0;
      return nowCalls <= 101 ? 999 : 1_000;
    });
    let recovered: MediaOperationRecord;
    try {
      recovered = await beginMediaOperation(projectPath, 'proxy', {
        pid: process.pid,
        phase: 'recovering-ownerless-lock',
      });
    } finally {
      now.mockRestore();
    }

    expect(recovered).toMatchObject({
      command: 'proxy',
      state: 'running',
      phase: 'recovering-ownerless-lock',
    });
    const tombstone = (await readdir(path.join(projectPath, 'analysis'))).find((entry) =>
      entry.startsWith('operation.lock.reclaimed-'),
    );
    expect(tombstone).toBeDefined();
    expect(await readdir(path.join(projectPath, 'analysis', tombstone!))).not.toEqual([]);
    await completeMediaOperation(projectPath, recovered.id!);
  });

  it('treats a reused PID with a different process-start marker as interrupted', () => {
    const record = {
      schemaVersion: '1.0.0',
      command: 'proxy',
      state: 'running',
      pid: process.pid,
      processStartMarker: 'different-process-instance',
      startedAt: '2026-08-11T10:00:00.000Z',
      updatedAt: '2026-08-11T10:00:00.000Z',
      finishedAt: null,
      phase: 'transcoding',
      progress: null,
      error: null,
    } as unknown as MediaOperationRecord;

    expect(isMediaOperationAlive(record)).toBe(false);
  });

  it('records a time-zone independent process-start marker', async () => {
    const projectPath = await makeProject();
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const utc = await beginMediaOperation(projectPath, 'proxy', {phase: 'transcoding'});
      await completeMediaOperation(projectPath, utc.id!);

      process.env.TZ = 'America/Los_Angeles';
      const pacific = await beginMediaOperation(projectPath, 'proxy', {phase: 'transcoding'});

      expect(utc.processStartMarker).not.toBeNull();
      expect(pacific.processStartMarker).toBe(utc.processStartMarker);
      await completeMediaOperation(projectPath, pacific.id!);
    } finally {
      if (originalTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimezone;
      }
    }
  });

  it('treats an expired markerless operation as interrupted despite a live PID', () => {
    const record = {
      schemaVersion: '1.0.0',
      command: 'proxy',
      state: 'running',
      pid: process.pid,
      processStartMarker: null,
      leaseExpiresAt: '2026-08-11T09:00:00.000Z',
      startedAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T08:55:00.000Z',
      finishedAt: null,
      phase: 'transcoding',
      progress: null,
      error: null,
    } as unknown as MediaOperationRecord;

    expect(isMediaOperationAlive(record)).toBe(false);
  });

  it('renews the lease for a markerless operation before it expires', async () => {
    const projectPath = await makeProject();
    const now = new Date();
    const startedAt = new Date(now.getTime() - 2 * 60_000);
    const record = await beginMediaOperation(projectPath, 'proxy', {
      now: startedAt,
      pid: process.pid,
      processStartMarker: null,
      phase: 'transcoding',
    });

    expect(record.processStartMarker).toBeNull();
    expect(isMediaOperationAlive(record)).toBe(true);

    const renewed = await updateMediaOperation(projectPath, record.id!, {
      now,
      progress: {completed: 1, total: 2, label: 'source-02'},
    });

    expect(isMediaOperationAlive(renewed)).toBe(true);
  });

  it('does not renew markerless ownership after its lease expires', async () => {
    const projectPath = await makeProject();
    const now = new Date();
    const record = await beginMediaOperation(projectPath, 'proxy', {
      now: new Date(now.getTime() - 10 * 60_000),
      pid: process.pid,
      processStartMarker: null,
      phase: 'transcoding',
    });

    await expect(
      updateMediaOperation(projectPath, record.id!, {
        now,
        progress: {completed: 1, total: 2, label: 'source-02'},
      }),
    ).rejects.toThrow(/ownership.*lost/i);
  });

  it('fences a resumed markerless operation after a retry replaces it', async () => {
    const projectPath = await makeProject();
    const interrupted = await beginMediaOperation(projectPath, 'proxy', {
      now: new Date('2000-01-01T00:00:00.000Z'),
      pid: process.pid,
      processStartMarker: null,
      phase: 'transcoding',
    });
    const replacement = await beginMediaOperation(projectPath, 'render', {
      pid: process.pid,
      processStartMarker: null,
      phase: 'rendering-master',
    });

    await expect(
      updateMediaOperation(projectPath, interrupted.id!, {phase: 'late-proxy-update'}),
    ).rejects.toThrow(/ownership.*lost/i);
    await expect(completeMediaOperation(projectPath, interrupted.id!)).rejects.toThrow(
      /ownership.*lost/i,
    );
    await expect(
      failMediaOperation(projectPath, interrupted.id!, new Error('late proxy failure')),
    ).rejects.toThrow(/ownership.*lost/i);

    await expect(readMediaOperation(projectPath)).resolves.toMatchObject({
      id: replacement.id,
      command: 'render',
      state: 'running',
      phase: 'rendering-master',
    });
    await expect(
      readFile(path.join(projectPath, 'analysis/operation.lock/owner.json'), 'utf8'),
    ).resolves.toContain(replacement.id!);

    await completeMediaOperation(projectPath, replacement.id!);
  });

  it('prevents a fenced-off producer from publishing media or reports', async () => {
    const projectPath = await makeProject();
    const outputPath = path.join(projectPath, 'work/proxies/late.mp4');
    const reportPath = path.join(projectPath, 'analysis/late-proxy.json');
    let startProducer!: () => void;
    let resumeProducer!: () => void;
    const producerStarted = new Promise<void>((resolve) => {
      startProducer = resolve;
    });
    const producerResumed = new Promise<void>((resolve) => {
      resumeProducer = resolve;
    });
    const staleProducer = runMediaOperation(
      projectPath,
      'proxy',
      async () => {
        startProducer();
        await producerResumed;
        await Promise.all([
          writeAtomically(outputPath, async (temporaryOutput) => {
            await writeFile(temporaryOutput, 'late proxy');
          }),
          writeJson(reportPath, {published: 'late'}),
        ]);
      },
      {
        now: new Date('2000-01-01T00:00:00.000Z'),
        pid: process.pid,
        processStartMarker: null,
        phase: 'transcoding',
      },
    );

    await producerStarted;
    const replacement = await beginMediaOperation(projectPath, 'render', {
      pid: process.pid,
      processStartMarker: null,
      phase: 'rendering-master',
    });
    resumeProducer();

    await expect(staleProducer).rejects.toThrow(/ownership.*lost/i);
    await expect(readFile(outputPath, 'utf8')).rejects.toThrow(/ENOENT/);
    await expect(readFile(reportPath, 'utf8')).rejects.toThrow(/ENOENT/);
    await completeMediaOperation(projectPath, replacement.id!);
  });

  it('tracks beat analysis as a mutually exclusive media operation', async () => {
    const projectPath = await makeProject();

    expect(MEDIA_OPERATION_COMMANDS).toContain('beats');
    await beginMediaOperation(projectPath, 'beats' as never, {phase: 'analyzing-beats'});

    await expect(getProjectStatus(projectPath)).resolves.toMatchObject({
      stage: 'media-in-progress',
      activity: {command: 'beats', phase: 'analyzing-beats'},
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
