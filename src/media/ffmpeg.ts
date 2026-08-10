import {runProcess, type ProcessResult} from './process';
import type {ProbeDocument} from './qc';

export const FFMPEG = process.env.REEL_FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.REEL_FFPROBE_PATH || 'ffprobe';

export const runFfmpeg = async (
  args: readonly string[],
  options: {cwd?: string; allowFailure?: boolean} = {},
): Promise<ProcessResult> =>
  await runProcess(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], options);

export const runFfprobe = async (args: readonly string[]): Promise<ProcessResult> =>
  await runProcess(FFPROBE, ['-v', 'error', ...args]);

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
