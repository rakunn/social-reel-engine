import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
  type SourceManifest,
  type EditManifest,
} from '../contracts/schemas';
import {hashFile} from '../core/hash';
import {readJson} from '../core/json';
import {
  timelineDurationSeconds,
  validatePlaybackRate,
  validateTransitionDurations,
} from '../core/timeline';
import {readValidatedSourceManifest} from '../media/source-integrity';
import {parseCaptionContent} from '../remotion/captions';

const parseFps = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? 1);
  return denominator !== 0 && Number.isFinite(numerator) && Number.isFinite(denominator)
    ? numerator / denominator
    : null;
};

export type EditValidation = {
  valid: boolean;
  durationSeconds: number;
  failures: string[];
  warnings: string[];
};

export const validateEdit = async (
  projectPath: string,
  input?: unknown,
): Promise<EditValidation> => {
  const edit = EditManifestSchema.parse(
    input ?? (await readJson(path.join(projectPath, 'edits/edit.json'))),
  );
  const failures = validateTransitionDurations(edit);
  const warnings: string[] = [];
  let manifest: SourceManifest | null = null;
  try {
    manifest = await readValidatedSourceManifest(projectPath);
  } catch (error) {
    failures.push((error as Error).message);
  }

  if (manifest) {
    for (const clip of edit.clips) {
      const source = manifest.sources.find((entry) => entry.id === clip.sourceId);
      if (!source || source.mediaType !== 'video') {
        failures.push(`${clip.id}: source ${clip.sourceId} is missing or is not video`);
        continue;
      }
      const sourcePath = path.join(projectPath, source.relativePath);
      try {
        await access(sourcePath);
        if ((await hashFile(sourcePath)) !== source.checksumSha256) {
          failures.push(`${clip.id}: source checksum changed after ingest`);
        }
      } catch {
        failures.push(`${clip.id}: media file is missing (${source.relativePath})`);
      }
      const duration = Number(source.ffprobe.format?.duration);
      if (!Number.isFinite(duration) || clip.outSeconds > duration + 0.001) {
        failures.push(`${clip.id}: selected out point exceeds source duration`);
      }
      const video = source.ffprobe.streams.find((stream) => stream.codec_type === 'video');
      const audio = source.ffprobe.streams.find((stream) => stream.codec_type === 'audio');
      if (!clip.audio.muted && !audio) {
        failures.push(`${clip.id}: camera audio is enabled but the source has no audio stream`);
      }
      const sourceFps = parseFps(video?.avg_frame_rate ?? video?.r_frame_rate);
      if (!sourceFps) {
        failures.push(`${clip.id}: source frame rate is unavailable`);
      } else {
        const rate = validatePlaybackRate(clip.playbackRate, sourceFps, edit.output.fps);
        if (!rate.valid) {
          failures.push(`${clip.id}: ${rate.reason}`);
        }
      }
    }
  }

  if (edit.music && manifest) {
    const music = manifest.sources.find(
      (source) => source.id === edit.music?.sourceId && source.mediaType === 'audio',
    );
    if (!music) {
      failures.push(`Music source ${edit.music.sourceId} is missing`);
    } else {
      if (!music.ffprobe.streams.some((stream) => stream.codec_type === 'audio')) {
        failures.push(`Music source ${edit.music.sourceId} has no audio stream`);
      }
      try {
        const musicPath = path.join(projectPath, music.relativePath);
        await access(musicPath);
        if ((await hashFile(musicPath)) !== music.checksumSha256) {
          failures.push('Music source checksum changed after ingest');
        }
      } catch {
        failures.push(`Music file is missing (${music.relativePath})`);
      }
    }
  }
  if (edit.captions && manifest) {
    const caption = manifest.sources.find(
      (source) =>
        source.mediaType === 'caption' && source.relativePath === edit.captions?.relativePath,
    );
    if (!caption) {
      failures.push(`Caption source is missing from the manifest (${edit.captions.relativePath})`);
    } else {
      const captionPath = path.join(projectPath, caption.relativePath);
      let captionExists = true;
      try {
        await access(captionPath);
      } catch {
        captionExists = false;
        failures.push(`Caption file is missing (${edit.captions.relativePath})`);
      }
      if (captionExists) {
        if ((await hashFile(captionPath)) !== caption.checksumSha256) {
          failures.push('Caption source checksum changed after ingest');
        }
        try {
          parseCaptionContent(await readFile(captionPath, 'utf8'), edit.captions.format);
        } catch (error) {
          failures.push(`Caption file is invalid: ${(error as Error).message}`);
        }
      }
    }
  }

  const durationSeconds = timelineDurationSeconds(edit);
  if (durationSeconds < 20 || durationSeconds > 30) {
    warnings.push(
      `Timeline is ${durationSeconds.toFixed(2)}s; the standard social-reel target is 20–30s`,
    );
  }
  return {valid: failures.length === 0, durationSeconds, failures, warnings};
};
