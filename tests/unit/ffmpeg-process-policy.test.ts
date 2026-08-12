import {beforeEach, describe, expect, it, vi} from 'vitest';

const runProcess = vi.hoisted(() => vi.fn());

vi.mock('../../src/media/process', () => ({runProcess}));

import {runFfmpeg, runFfprobe} from '../../src/media/ffmpeg';

describe('FFmpeg process policies', () => {
  beforeEach(() => {
    runProcess.mockReset();
    runProcess.mockResolvedValue({
      command: 'fixture',
      args: [],
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  });

  it('uses an idle bound for encodes without imposing a total duration', async () => {
    await runFfmpeg(['-i', 'input.mov', 'output.mp4']);

    expect(runProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({idleTimeoutMs: 5 * 60_000}),
    );
    expect(runProcess.mock.calls[0][2]).not.toHaveProperty('timeoutMs');
  });

  it('uses a short wall-clock bound for probes', async () => {
    await runFfprobe(['-show_format', 'input.mov']);

    expect(runProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({timeoutMs: 2 * 60_000}),
    );
  });
});
