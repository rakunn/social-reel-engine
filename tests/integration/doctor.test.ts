import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {runDoctor} from '../../src/commands/doctor';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('doctor', () => {
  it('verifies the pinned local reel toolchain and required FFmpeg capabilities', async () => {
    const report = await runDoctor(repositoryRoot);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: 'node', status: 'pass'}),
        expect.objectContaining({id: 'remotion-versions', status: 'pass'}),
        expect.objectContaining({id: 'ffmpeg', status: 'pass'}),
        expect.objectContaining({id: 'ffprobe', status: 'pass'}),
        expect.objectContaining({id: 'librosa', status: 'pass'}),
        expect.objectContaining({id: 'lut-library', status: 'pass'}),
      ]),
    );
  });
});
