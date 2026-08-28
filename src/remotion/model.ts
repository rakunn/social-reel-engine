import type {Caption} from '@remotion/captions';
import {interpolate} from 'remotion';
import type {EditManifest, AnimatedCrop} from '../contracts/schemas';
import {
  clipDurationSeconds,
  secondsToFrames,
  timelineDurationFrames,
} from '../core/timeline';

export type ReelRenderProps = {
  edit: EditManifest;
  media: Record<string, string>;
  music: string | null;
  captions: Caption[];
  watermark: string | null;
  trimBeforeFramesByClip?: Record<string, number>;
  fontUrl?: string | null;
};

export const secondsToMediaFrames = (seconds: number, fps: number): number =>
  secondsToFrames(seconds, fps);

export const fontFaceRule = (fontUrl: string): string =>
  `@font-face{font-family:ReelCustom;src:url(${JSON.stringify(fontUrl)});font-display:block;}`;

export const cardTextContainerStyle = () => ({
  maxWidth: '100%' as const,
  overflowWrap: 'anywhere' as const,
  wordBreak: 'break-word' as const,
});

export const titleOpacity = (frame: number, durationInFrames: number): number => {
  const finalFrame = Math.max(0, durationInFrames - 1);
  if (finalFrame === 0) return 0;
  const fadeDuration = Math.min(10, finalFrame / 2);
  const interpolationOptions = {
    extrapolateLeft: 'clamp' as const,
    extrapolateRight: 'clamp' as const,
  };
  const fadeIn = interpolate(frame, [0, fadeDuration], [0, 1], interpolationOptions);
  const fadeOut = interpolate(
    frame,
    [finalFrame - fadeDuration, finalFrame],
    [1, 0],
    interpolationOptions,
  );
  return Math.min(fadeIn, fadeOut);
};

export type ShotTiming = {
  id: string;
  startFrame: number;
  durationInFrames: number;
  transitionFrames: number;
};

export const buildShotTimings = (edit: EditManifest): ShotTiming[] => {
  let startFrame = 0;
  return edit.clips.map((clip, index) => {
    const durationInFrames = secondsToFrames(clipDurationSeconds(clip), edit.output.fps);
    const transitionFrames =
      index === edit.clips.length - 1
        ? 0
        : secondsToFrames(clip.transitionAfter.durationSeconds, edit.output.fps);
    const timing = {id: clip.id, startFrame, durationInFrames, transitionFrames};
    startFrame += durationInFrames - transitionFrames;
    return timing;
  });
};

export const calculateReelMetadata = (props: ReelRenderProps) => {
  const durationInFrames = Math.max(1, timelineDurationFrames(props.edit));
  return {
    width: props.edit.output.width,
    height: props.edit.output.height,
    fps: props.edit.output.fps,
    durationInFrames,
    props,
  };
};

export const cropTransform = (
  crop: AnimatedCrop,
  frame: number,
  durationInFrames: number,
): {transform: string; transformOrigin: string; objectPosition: string} => {
  const finalFrame = Math.max(0, durationInFrames - 1);
  const progress = finalFrame === 0 ? 0 : Math.min(1, Math.max(0, frame / finalFrame));
  const x = crop.start.x + (crop.end.x - crop.start.x) * progress;
  const y = crop.start.y + (crop.end.y - crop.start.y) * progress;
  const scale = crop.start.scale + (crop.end.scale - crop.start.scale) * progress;
  const xPercent = Number((x * 100).toFixed(4));
  const yPercent = Number((y * 100).toFixed(4));
  return {
    transform: `scale(${Number(scale.toFixed(4))})`,
    transformOrigin: `${xPercent}% ${yPercent}%`,
    objectPosition: `${xPercent}% ${yPercent}%`,
  };
};

export const photoCropStyle = (
  crop: {x: number; y: number; scale: number},
): {transform: string; transformOrigin: string; objectPosition: string} => {
  const xPercent = Number((crop.x * 100).toFixed(4));
  const yPercent = Number((crop.y * 100).toFixed(4));
  return {
    transform: `scale(${Number(crop.scale.toFixed(4))})`,
    transformOrigin: `${xPercent}% ${yPercent}%`,
    objectPosition: `${xPercent}% ${yPercent}%`,
  };
};

export const captionFrameRange = (
  caption: Caption,
  fps: number,
): {from: number; durationInFrames: number} => ({
  from: secondsToFrames(caption.startMs / 1000, fps),
  durationInFrames: Math.max(1, secondsToFrames((caption.endMs - caption.startMs) / 1000, fps)),
});
