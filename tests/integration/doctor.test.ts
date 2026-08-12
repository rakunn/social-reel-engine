import {execFile} from 'node:child_process';
import {chmod, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {runDoctor} from '../../src/commands/doctor';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

describe('doctor', () => {
  it('verifies the pinned local reel toolchain and required FFmpeg capabilities', async () => {
    const report = await runDoctor(repositoryRoot);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: 'node', status: 'pass'}),
        expect.objectContaining({id: 'remotion-versions', status: 'pass'}),
        expect.objectContaining({id: 'remotion-runtime', status: 'pass'}),
        expect.objectContaining({id: 'ffmpeg', status: 'pass'}),
        expect.objectContaining({id: 'ffprobe', status: 'pass'}),
        expect.objectContaining({id: 'librosa', status: 'pass'}),
        expect.objectContaining({
          id: 'lut-library',
          status: expect.stringMatching(/^(pass|warn)$/),
        }),
      ]),
    );
  });

  it('fails preflight when FFmpeg omits a filter used by the pipeline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reel-doctor-ffmpeg-'));
    const fakeFfmpeg = path.join(root, 'ffmpeg');
    await writeFile(
      fakeFfmpeg,
      '#!/bin/sh\n' +
        'case "$*" in\n' +
        '  *-filters*) printf "%s\\n" "... lut3d V->V" "... zscale V->V" "... vidstabdetect V->V" "... vidstabtransform V->V" "... loudnorm A->A" ;;\n' +
        '  *-encoders*) printf "%s\\n" "libx264" "prores_ks" "aac" ;;\n' +
        '  *) printf "%s\\n" "ffmpeg version synthetic" "ffprobe version synthetic" ;;\n' +
        'esac\n',
    );
    await chmod(fakeFfmpeg, 0o755);
    const code =
      `const {runDoctor} = await import('./src/commands/doctor.ts');` +
      `const report = await runDoctor(${JSON.stringify(repositoryRoot)});` +
      `process.stdout.write(JSON.stringify(report));`;
    const {stdout} = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          REEL_FFMPEG_PATH: fakeFfmpeg,
          REEL_FFPROBE_PATH: fakeFfmpeg,
        },
      },
    );
    const report = JSON.parse(stdout);
    expect(report.checks).toContainEqual(
      expect.objectContaining({id: 'ffmpeg-filters', status: 'fail'}),
    );
  }, 30_000);

  it('fails preflight when FFmpeg omits an encoder directly invoked by the pipeline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'reel-doctor-encoders-'));
    const fakeFfmpeg = path.join(root, 'ffmpeg');
    await writeFile(
      fakeFfmpeg,
      '#!/bin/sh\n' +
        'case "$*" in\n' +
        '  *-filters*) printf "%s\\n" "blackdetect blend colorbalance colortemperature drawbox drawtext exposure format fps freezedetect loudnorm lut3d scale setparams split tile vidstabdetect vidstabtransform zscale" ;;\n' +
        '  *-encoders*) printf "%s\\n" "libx264" "prores_ks" "aac" ;;\n' +
        '  *) printf "%s\\n" "ffmpeg version synthetic" "ffprobe version synthetic" ;;\n' +
        'esac\n',
    );
    await chmod(fakeFfmpeg, 0o755);
    const code =
      `const {runDoctor} = await import('./src/commands/doctor.ts');` +
      `const report = await runDoctor(${JSON.stringify(repositoryRoot)});` +
      `process.stdout.write(JSON.stringify(report));`;
    const {stdout} = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', code],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          REEL_FFMPEG_PATH: fakeFfmpeg,
          REEL_FFPROBE_PATH: fakeFfmpeg,
        },
      },
    );
    const report = JSON.parse(stdout);
    expect(report.checks).toContainEqual(
      expect.objectContaining({id: 'ffmpeg-encoders', status: 'fail'}),
    );
  }, 30_000);
});
