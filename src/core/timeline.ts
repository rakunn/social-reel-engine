import type {AnimatedCrop, EditManifest} from '../contracts/schemas';

export const clipDurationSeconds = (
  clip: Pick<EditManifest['clips'][number], 'inSeconds' | 'outSeconds' | 'playbackRate'>,
): number => (clip.outSeconds - clip.inSeconds) / clip.playbackRate;

export const timelineDurationSeconds = (edit: EditManifest): number => {
  const clipDuration = edit.clips.reduce((sum, clip) => sum + clipDurationSeconds(clip), 0);
  const overlap = edit.clips
    .slice(0, -1)
    .reduce((sum, clip) => sum + clip.transitionAfter.durationSeconds, 0);
  return clipDuration - overlap;
};

export const timelineDurationFrames = (edit: EditManifest): number =>
  edit.clips.reduce(
    (frames, clip, index) =>
      frames +
      secondsToFrames(clipDurationSeconds(clip), edit.output.fps) -
      (index === edit.clips.length - 1
        ? 0
        : secondsToFrames(clip.transitionAfter.durationSeconds, edit.output.fps)),
    0,
  );

export const renderedTimelineDurationSeconds = (edit: EditManifest): number =>
  timelineDurationFrames(edit) / edit.output.fps;

export const secondsToFrames = (seconds: number, fps: number): number =>
  Math.max(0, Math.round(seconds * fps));

export const validatePlaybackRate = (
  playbackRate: number,
  sourceFps: number,
  outputFps: number,
): {valid: boolean; reason: string | null} => {
  if (!Number.isFinite(playbackRate) || playbackRate < 0.5 || playbackRate > 2) {
    return {valid: false, reason: 'Playback rate must be between 0.5 and 2.0'};
  }
  if (playbackRate < 1 && sourceFps * playbackRate < outputFps) {
    return {
      valid: false,
      reason: `Source ${sourceFps} fps cannot sustain ${playbackRate}x playback at ${outputFps} fps without frame synthesis`,
    };
  }
  return {valid: true, reason: null};
};

const lerp = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

export const interpolateCrop = (
  crop: AnimatedCrop,
  progress: number,
): AnimatedCrop['start'] => {
  const clamped = Math.min(1, Math.max(0, progress));
  return {
    x: lerp(crop.start.x, crop.end.x, clamped),
    y: lerp(crop.start.y, crop.end.y, clamped),
    scale: lerp(crop.start.scale, crop.end.scale, clamped),
  };
};

export const validateTransitionDurations = (edit: EditManifest): string[] => {
  const failures: string[] = [];
  for (let index = 0; index < edit.clips.length - 1; index += 1) {
    const current = edit.clips[index];
    const next = edit.clips[index + 1];
    const transition = current.transitionAfter.durationSeconds;
    const maximum = Math.min(clipDurationSeconds(current), clipDurationSeconds(next)) / 2;
    if (transition > maximum) {
      failures.push(
        `${current.id}: transition ${transition}s exceeds half the shorter adjacent clip (${maximum}s)`,
      );
    }
  }
  return failures;
};
