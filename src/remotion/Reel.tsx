import type {Caption} from '@remotion/captions';
import {Audio} from '@remotion/media';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {slide} from '@remotion/transitions/slide';
import {wipe} from '@remotion/transitions/wipe';
import type {TransitionPresentation} from '@remotion/transitions';
import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {EditManifest} from '../contracts/schemas';
import {
  buildShotTimings,
  captionFrameRange,
  cropTransform,
  secondsToMediaFrames,
  type ReelRenderProps,
} from './model';

const dbToGain = (db: number): number => 10 ** (db / 20);

const transitionPresentation = (
  type: EditManifest['clips'][number]['transitionAfter']['type'],
): TransitionPresentation<Record<string, unknown>> => {
  if (type === 'slide') {
    return slide({direction: 'from-right'});
  }
  if (type === 'wipe') {
    return wipe({direction: 'from-left'});
  }
  return fade();
};

const Shot: React.FC<{
  clip: EditManifest['clips'][number];
  durationInFrames: number;
  src: string;
  trimBeforeFrames: number;
}> = ({clip, durationInFrames, src, trimBeforeFrames}) => {
  const frame = useCurrentFrame();
  const crop = cropTransform(clip.crop, frame, durationInFrames);
  return (
    <AbsoluteFill style={{backgroundColor: '#050505', overflow: 'hidden'}}>
      <OffthreadVideo
        src={staticFile(src)}
        trimBefore={trimBeforeFrames}
        playbackRate={clip.playbackRate}
        muted={clip.audio.muted}
        volume={dbToGain(clip.audio.gainDb)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          ...crop,
        }}
      />
    </AbsoluteFill>
  );
};

const Titles: React.FC<{edit: EditManifest}> = ({edit}) => {
  const {fps} = useVideoConfig();
  return (
    <>
      {edit.titles.map((title, index) => {
        const from = Math.round(title.startSeconds * fps);
        const durationInFrames = Math.max(1, Math.round(title.durationSeconds * fps));
        return (
          <Sequence key={`${title.text}-${index}`} from={from} durationInFrames={durationInFrames}>
            <TitleCard title={title} durationInFrames={durationInFrames} />
          </Sequence>
        );
      })}
    </>
  );
};

const TitleCard: React.FC<{
  title: EditManifest['titles'][number];
  durationInFrames: number;
}> = ({title, durationInFrames}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(
    frame,
    [0, Math.min(10, durationInFrames / 4), Math.max(10, durationInFrames - 10), durationInFrames],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const align =
    title.position === 'top'
      ? {justifyContent: 'flex-start', paddingTop: 180}
      : title.position === 'bottom'
        ? {justifyContent: 'flex-end', paddingBottom: 220}
        : {justifyContent: 'center'};
  return (
    <AbsoluteFill
      style={{
        ...align,
        alignItems: 'center',
        opacity,
        paddingLeft: 90,
        paddingRight: 90,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          color: '#fffaf2',
          fontFamily: 'ReelCustom, Helvetica Neue, Arial, sans-serif',
          fontSize: 74,
          fontWeight: 500,
          letterSpacing: '-0.035em',
          lineHeight: 1.02,
          textAlign: 'center',
          textShadow: '0 2px 24px rgba(0,0,0,0.7)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {title.text}
      </div>
    </AbsoluteFill>
  );
};

const CaptionCard: React.FC<{caption: Caption}> = ({caption}) => (
  <AbsoluteFill
    style={{
      justifyContent: 'flex-end',
      alignItems: 'center',
      padding: '0 70px 190px',
      pointerEvents: 'none',
    }}
  >
    <div
      style={{
        color: 'white',
        backgroundColor: 'rgba(0,0,0,0.72)',
        borderRadius: 12,
        fontFamily: 'ReelCustom, Helvetica Neue, Arial, sans-serif',
        fontSize: 48,
        fontWeight: 600,
        lineHeight: 1.15,
        padding: '14px 22px 18px',
        textAlign: 'center',
        whiteSpace: 'pre-wrap',
      }}
    >
      {caption.text.trim()}
    </div>
  </AbsoluteFill>
);

const Captions: React.FC<{captions: Caption[]}> = ({captions}) => {
  const {fps} = useVideoConfig();
  return (
    <>
      {captions.map((caption, index) => {
        const range = captionFrameRange(caption, fps);
        return (
          <Sequence key={`${caption.startMs}-${index}`} {...range}>
            <CaptionCard caption={caption} />
          </Sequence>
        );
      })}
    </>
  );
};

export const SocialReel: React.FC<ReelRenderProps> = (props) => {
  const timings = buildShotTimings(props.edit);
  return (
    <AbsoluteFill style={{backgroundColor: '#050505'}}>
      {props.fontUrl ? (
        <style>{`@font-face{font-family:ReelCustom;src:url('${staticFile(props.fontUrl)}');font-display:block;}`}</style>
      ) : null}
      <TransitionSeries>
        {props.edit.clips.map((clip, index) => {
          const timing = timings[index];
          const src = props.media[clip.id] ?? props.media[clip.sourceId];
          if (!src) {
            throw new Error(`No staged media for clip ${clip.id}`);
          }
          const elements: React.ReactNode[] = [
            <TransitionSeries.Sequence key={`shot-${clip.id}`} durationInFrames={timing.durationInFrames}>
              <Shot
                clip={clip}
                durationInFrames={timing.durationInFrames}
                src={src}
                trimBeforeFrames={props.trimBeforeFramesByClip?.[clip.id] ?? 0}
              />
            </TransitionSeries.Sequence>,
          ];
          if (timing.transitionFrames > 0) {
            elements.push(
              <TransitionSeries.Transition
                key={`transition-${clip.id}`}
                presentation={transitionPresentation(clip.transitionAfter.type)}
                timing={linearTiming({durationInFrames: timing.transitionFrames})}
              />,
            );
          }
          return elements;
        })}
      </TransitionSeries>
      {props.music && props.edit.music ? (
        <Audio
          src={staticFile(props.music)}
          trimBefore={secondsToMediaFrames(props.edit.music.startSeconds, props.edit.output.fps)}
          volume={dbToGain(props.edit.music.gainDb)}
        />
      ) : null}
      <Titles edit={props.edit} />
      <Captions captions={props.captions} />
      {props.watermark ? (
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            alignItems: 'center',
            paddingBottom: 60,
            color: 'white',
            fontFamily: 'Helvetica Neue, Arial, sans-serif',
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textShadow: '0 2px 8px black',
          }}
        >
          {props.watermark}
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
