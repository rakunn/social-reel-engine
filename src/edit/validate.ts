import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
  ReelBriefSchema,
  type SourceManifest,
  type EditManifest,
} from '../contracts/schemas';
import {hashFile} from '../core/hash';
import {readJson} from '../core/json';
import {
  secondsToFrames,
  timelineDurationSeconds,
  timelineDurationFrames,
  validatePlaybackRate,
  validateTransitionDurations,
} from '../core/timeline';
import {readValidatedSourceManifest} from '../media/source-integrity';
import {parseCaptionContent} from '../remotion/captions';
import {captionFrameRange} from '../remotion/model';

const parseFps = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? 1);
  const fps =
    denominator !== 0 && Number.isFinite(numerator) && Number.isFinite(denominator)
      ? numerator / denominator
      : null;
  return fps !== null && fps > 0 ? fps : null;
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
  const brief = ReelBriefSchema.parse(await readJson(path.join(projectPath, 'brief.json')));
  const failures = validateTransitionDurations(edit);
  const warnings: string[] = [];
  const durationFrames = timelineDurationFrames(edit);
  if (!brief.options.music && edit.music) {
    failures.push('Music is disabled by the project brief');
  }
  if (!brief.options.captions && edit.captions) {
    failures.push('Captions are disabled by the project brief');
  }
  if (!brief.options.cameraAudio) {
    for (const clip of edit.clips.filter((entry) => !entry.audio.muted)) {
      failures.push(`${clip.id}: camera audio is disabled by the project brief`);
    }
  }
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
      const video = source.ffprobe.streams.find((stream) => stream.codec_type === 'video');
      const audio = source.ffprobe.streams.find((stream) => stream.codec_type === 'audio');
      const videoDuration = Number(video?.duration);
      const formatDuration = Number(source.ffprobe.format?.duration);
      const duration =
        Number.isFinite(videoDuration) && videoDuration > 0
          ? videoDuration
          : Number.isFinite(formatDuration) && formatDuration > 0
            ? formatDuration
            : null;
      if (duration === null || clip.outSeconds > duration + 0.001) {
        failures.push(`${clip.id}: selected out point exceeds source duration`);
      }
      if (!clip.audio.muted && !audio) {
        failures.push(`${clip.id}: camera audio is enabled but the source has no audio stream`);
      }
      const sourceFps = parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate);
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
      const audioStream = music.ffprobe.streams.find(
        (stream) => stream.codec_type === 'audio',
      );
      if (!audioStream) {
        failures.push(`Music source ${edit.music.sourceId} has no audio stream`);
      } else {
        const streamDuration = Number(audioStream.duration);
        const formatDuration = Number(music.ffprobe.format?.duration);
        const musicDuration =
          Number.isFinite(streamDuration) && streamDuration > 0
            ? streamDuration
            : Number.isFinite(formatDuration) && formatDuration > 0
              ? formatDuration
              : null;
        if (musicDuration === null) {
          failures.push(`Music source ${edit.music.sourceId} duration is unavailable`);
        } else if (edit.music.startSeconds >= musicDuration) {
          failures.push(
            `Music start offset ${edit.music.startSeconds}s is at or beyond the ${musicDuration}s audio duration`,
          );
        }
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
          const captions = parseCaptionContent(
            await readFile(captionPath, 'utf8'),
            edit.captions.format,
          );
          const overlapsTimeline = captions.some((item) => {
            const range = captionFrameRange(item, edit.output.fps);
            return range.from < durationFrames && range.from + range.durationInFrames > 0;
          });
          if (!overlapsTimeline) {
            failures.push('Caption file has no captions that overlap the rendered timeline');
          }
        } catch (error) {
          failures.push(`Caption file is invalid: ${(error as Error).message}`);
        }
      }
    }
  }

  for (const [index, title] of edit.titles.entries()) {
    const startFrame = secondsToFrames(title.startSeconds, edit.output.fps);
    if (startFrame >= durationFrames) {
      failures.push(
        `Title ${index + 1} starts outside the rendered timeline at frame ${startFrame}`,
      );
    }
  }

  const durationSeconds = timelineDurationSeconds(edit);
  if (
    durationSeconds < brief.target.minSeconds ||
    durationSeconds > brief.target.maxSeconds
  ) {
    warnings.push(
      `Timeline is ${durationSeconds.toFixed(2)}s; the project target is ${brief.target.minSeconds}–${brief.target.maxSeconds}s`,
    );
  }
  return {valid: failures.length === 0, durationSeconds, failures, warnings};
};
