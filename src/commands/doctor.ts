import {access} from 'node:fs/promises';
import path from 'node:path';
import {hashFile} from '../core/hash';
import {readJson} from '../core/json';
import {FFMPEG, FFPROBE} from '../media/ffmpeg';
import {runProcess} from '../media/process';
import {LutDefinitionSchema} from '../contracts/schemas';
import {checkRemotionRuntime} from '../render/remotion-runtime';

export type DoctorCheck = {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

const REQUIRED_FFMPEG_FILTERS = [
  'blackdetect',
  'blend',
  'colorbalance',
  'colortemperature',
  'drawbox',
  'drawtext',
  'exposure',
  'format',
  'fps',
  'freezedetect',
  'loudnorm',
  'lut3d',
  'scale',
  'setparams',
  'split',
  'tile',
  'vidstabdetect',
  'vidstabtransform',
  'zscale',
] as const;

const REQUIRED_FFMPEG_ENCODERS = [
  'aac',
  'libx264',
  'pcm_s16le',
  'png',
  'prores_ks',
] as const;

const hasRequiredFfmpegFilters = (output: string): boolean => {
  const available = new Set(output.split(/\s+/));
  return REQUIRED_FFMPEG_FILTERS.every((name) => available.has(name));
};

const checkCommand = async (
  id: string,
  command: string,
  args: string[],
  predicate: (output: string) => boolean,
  success: string,
): Promise<DoctorCheck> => {
  try {
    const result = await runProcess(command, args, {allowFailure: true});
    const output = `${result.stdout}\n${result.stderr}`;
    return result.exitCode === 0 && predicate(output)
      ? {id, status: 'pass', message: success}
      : {id, status: 'fail', message: `${command} is present but lacks required capability`};
  } catch (error) {
    return {id, status: 'fail', message: `${command} is unavailable: ${(error as Error).message}`};
  }
};

const libraryCheck = async (engineRoot: string): Promise<DoctorCheck> => {
  try {
    const catalog = await readJson<{
      guide?: {file: string; checksumSha256: string};
      technical?: Array<{file: string; checksumSha256: string}>;
      creative?: Array<{file: string; checksumSha256: string}>;
      unclassified?: Array<{file: string; checksumSha256: string}>;
    }>(path.join(engineRoot, 'library/lut-catalog.json'));
    const entries = [
      ...(catalog.guide ? [catalog.guide] : []),
      ...(catalog.technical ?? []),
      ...(catalog.creative ?? []),
      ...(catalog.unclassified ?? []),
    ];
    const failures: string[] = [];
    for (const entry of [...(catalog.technical ?? []), ...(catalog.creative ?? [])]) {
      const parsed = LutDefinitionSchema.safeParse(entry);
      if (!parsed.success) {
        failures.push(`${entry.file} has invalid catalog metadata`);
      }
    }
    for (const entry of entries) {
      const filePath = path.join(engineRoot, entry.file);
      try {
        await access(filePath);
        if ((await hashFile(filePath)) !== entry.checksumSha256) {
          failures.push(`${entry.file} checksum mismatch`);
        }
      } catch {
        failures.push(`${entry.file} missing`);
      }
    }
    return failures.length
      ? {id: 'lut-library', status: 'warn', message: failures.join('; ')}
      : {
          id: 'lut-library',
          status: 'pass',
          message: `${entries.length} local LUT/guide assets match the tracked catalog`,
        };
  } catch {
    return {
      id: 'lut-library',
      status: 'warn',
      message: 'No optional local LUT catalog is available',
    };
  }
};

export const runDoctor = async (engineRoot: string): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [];
  checks.push(
    process.version === 'v24.12.0'
      ? {id: 'node', status: 'pass', message: 'Node.js v24.12.0 matches the project pin'}
      : {
          id: 'node',
          status: 'fail',
          message: `Node.js v24.12.0 is required; current runtime is ${process.version}`,
        },
  );
  try {
    const packageJson = await readJson<{
      dependencies?: Record<string, string>;
    }>(path.join(engineRoot, 'package.json'));
    const versions = Object.entries(packageJson.dependencies ?? {}).filter(
      ([name]) => name === 'remotion' || name.startsWith('@remotion/'),
    );
    const mismatched = versions.filter(([, version]) => version !== '4.0.507');
    checks.push(
      versions.length > 0 && mismatched.length === 0
        ? {
            id: 'remotion-versions',
            status: 'pass',
            message: `${versions.length} Remotion packages are pinned to 4.0.507`,
          }
        : {
            id: 'remotion-versions',
            status: 'fail',
            message: `Remotion version mismatch: ${mismatched.map(([name, version]) => `${name}@${version}`).join(', ')}`,
          },
    );
  } catch (error) {
    checks.push({id: 'remotion-versions', status: 'fail', message: (error as Error).message});
  }
  const remotionRuntime = await checkRemotionRuntime(engineRoot);
  checks.push({
    id: 'remotion-runtime',
    status: remotionRuntime.ok ? 'pass' : 'fail',
    message: remotionRuntime.message,
  });

  checks.push(
    await checkCommand('ffmpeg', FFMPEG, ['-hide_banner', '-version'], (output) => /ffmpeg version/i.test(output), 'FFmpeg is available'),
  );
  checks.push(
    await checkCommand('ffprobe', FFPROBE, ['-hide_banner', '-version'], (output) => /ffprobe version/i.test(output), 'ffprobe is available'),
  );
  checks.push(
    await checkCommand(
      'ffmpeg-filters',
      FFMPEG,
      ['-hide_banner', '-filters'],
      hasRequiredFfmpegFilters,
      `FFmpeg has all ${REQUIRED_FFMPEG_FILTERS.length} pipeline filters`,
    ),
  );
  checks.push(
    await checkCommand(
      'ffmpeg-encoders',
      FFMPEG,
      ['-hide_banner', '-encoders'],
      (output) => {
        const available = new Set(output.split(/\s+/));
        return REQUIRED_FFMPEG_ENCODERS.every((name) => available.has(name));
      },
      `FFmpeg has all ${REQUIRED_FFMPEG_ENCODERS.length} pipeline encoders`,
    ),
  );
  checks.push(
    await checkCommand(
      'librosa',
      path.join(engineRoot, '.venv/bin/python'),
      ['-c', "import librosa; print(librosa.__version__)"],
      (output) => output.trim() === '0.11.0',
      'librosa 0.11.0 is installed in .venv',
    ),
  );
  checks.push(await libraryCheck(engineRoot));
  return {ok: checks.every((check) => check.status !== 'fail'), checks};
};
