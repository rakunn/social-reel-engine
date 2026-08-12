import {runProcess, type ProcessResult, type RunProcessOptions} from './process';
import type {ProbeDocument} from './qc';

export const FFMPEG = process.env.REEL_FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.REEL_FFPROBE_PATH || 'ffprobe';

export const runFfmpeg = async (
  args: readonly string[],
  options: Pick<RunProcessOptions, 'cwd' | 'allowFailure' | 'signal' | 'idleTimeoutMs'> = {},
): Promise<ProcessResult> =>
  await runProcess(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], {
    ...options,
    idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
  });

export const runFfprobe = async (args: readonly string[]): Promise<ProcessResult> =>
  await runProcess(FFPROBE, ['-v', 'error', ...args], {timeoutMs: 2 * 60_000});

export const probeFile = async (filePath: string): Promise<ProbeDocument> => {
  const result = await runFfprobe([
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    filePath,
  ]);
  return JSON.parse(result.stdout) as ProbeDocument;
};
