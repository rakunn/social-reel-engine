import type {Caption} from '@remotion/captions';
import {loadFont} from '@remotion/fonts';
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
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {EditManifest} from '../contracts/schemas';
import {
  buildShotTimings,
  cardTextContainerStyle,
  cardTextStyles,
  captionFrameRange,
  cropTransform,
  fontFaceRule,
  fontFaceRules,
  secondsToMediaFrames,
  styleProfileForOutput,
  titleOpacity,
  type ReelRenderProps,
  type StagedFontRoles,
} from './model';
import type {OutputStyleTokens, StyleConfig} from '../style/contracts';
import {CINEMATIC_MINIMAL_STYLE} from '../style/contracts';

const dbToGain = (db: number): number => 10 ** (db / 20);

const customFontLoads = new Map<string, Promise<void>>();

export const ensureCustomFontLoaded = (fontUrl: string): Promise<void> => {
  const assetUrl = staticFile(fontUrl).replaceAll("'", '%27');
  const existing = customFontLoads.get(assetUrl);
  if (existing) return existing;
  const loading = loadFont({
    family: 'ReelCustom',
    url: assetUrl,
    display: 'block',
  });
  customFontLoads.set(assetUrl, loading);
  return loading;
};

export const ensureCustomFontsLoaded = (fonts: StagedFontRoles): Promise<void[]> => {
  const distinct = new Map<string, NonNullable<StagedFontRoles[keyof StagedFontRoles]>>();
  for (const font of Object.values(fonts)) {
    if (!font) continue;
    distinct.set(`${font.family}\0${font.url}`, font);
  }
  return Promise.all(
    [...distinct.values()].map((font) => {
      const assetUrl = staticFile(font.url).replaceAll("'", '%27');
      const key = `${font.family}\0${assetUrl}`;
      const existing = customFontLoads.get(key);
      if (existing) return existing;
      const loading = loadFont({family: font.family, url: assetUrl, display: 'block'});
      customFontLoads.set(key, loading);
      return loading;
    }),
  );
};

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
  visualStyle: StyleConfig;
}> = ({clip, durationInFrames, src, trimBeforeFrames, visualStyle}) => {
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
      {clip.textOverlay ? (
        <CardTextOverlay
          overlay={clip.textOverlay}
          durationInFrames={durationInFrames}
          visualStyle={visualStyle}
        />
      ) : null}
    </AbsoluteFill>
  );
};

const CardTextOverlay: React.FC<{
  overlay: NonNullable<EditManifest['clips'][number]['textOverlay']>;
  durationInFrames: number;
  visualStyle: StyleConfig;
}> = ({overlay, durationInFrames, visualStyle}) => {
  const frame = useCurrentFrame();
  const output = useVideoConfig();
  const profile = styleProfileForOutput(visualStyle, output);
  const text = cardTextStyles(visualStyle, profile);
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        opacity: titleOpacity(frame, durationInFrames, profile.fadeFrames),
        paddingLeft: output.width * profile.horizontalPadding,
        paddingRight: output.width * profile.horizontalPadding,
        paddingBottom: output.height * profile.bottomPadding,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: `${profile.scrimHeight * 100}%`,
          backgroundColor: `rgba(20,43,51,${profile.scrimOpacity})`,
          zIndex: 0,
        }}
      />
      <div
        style={{
          ...cardTextContainerStyle(),
          color: visualStyle.palette.primary,
          maxWidth: `${profile.maxTextWidth * 100}%`,
          textShadow: profile.shadow,
          zIndex: 1,
        }}
      >
        <div style={text.heading}>
          {overlay.heading}
        </div>
        {overlay.subheading ? (
          <div
            style={{
              ...text.body,
              marginTop: profile.gap,
              opacity: 0.9,
            }}
          >
            {overlay.subheading}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

const Titles: React.FC<{edit: EditManifest; visualStyle: StyleConfig}> = ({edit, visualStyle}) => {
  const {fps} = useVideoConfig();
  return (
    <>
      {edit.titles.map((title, index) => {
        const from = Math.round(title.startSeconds * fps);
        const durationInFrames = Math.max(1, Math.round(title.durationSeconds * fps));
        return (
          <Sequence key={`${title.text}-${index}`} from={from} durationInFrames={durationInFrames}>
            <TitleCard title={title} durationInFrames={durationInFrames} visualStyle={visualStyle} />
          </Sequence>
        );
      })}
    </>
  );
};

const TitleCard: React.FC<{
  title: EditManifest['titles'][number];
  durationInFrames: number;
  visualStyle: StyleConfig;
}> = ({title, durationInFrames, visualStyle}) => {
  const frame = useCurrentFrame();
  const output = useVideoConfig();
  const profile = styleProfileForOutput(visualStyle, output);
  const text = cardTextStyles(visualStyle, profile);
  const opacity = titleOpacity(frame, durationInFrames, profile.fadeFrames);
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
        paddingLeft: output.width * profile.horizontalPadding,
        paddingRight: output.width * profile.horizontalPadding,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          ...text.heading,
          textAlign: 'center',
          textShadow: profile.shadow,
          whiteSpace: 'pre-wrap',
        }}
      >
        {title.text}
      </div>
    </AbsoluteFill>
  );
};

const CaptionCard: React.FC<{
  caption: Caption;
  visualStyle: StyleConfig;
  profile: OutputStyleTokens;
}> = ({caption, visualStyle, profile}) => (
  <AbsoluteFill
    style={{
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingLeft: `${profile.horizontalPadding * 100}%`,
      paddingRight: `${profile.horizontalPadding * 100}%`,
      paddingBottom: `${profile.bottomPadding * 100}%`,
      pointerEvents: 'none',
    }}
  >
    <div
      style={{
        color: visualStyle.palette.primary,
        backgroundColor: 'rgba(0,0,0,0.72)',
        borderRadius: 12,
        fontFamily: [visualStyle.typography.body.family, ...visualStyle.typography.body.fallback].join(', '),
        fontSize: profile.captionSize,
        fontWeight: visualStyle.typography.body.weight,
        lineHeight: profile.bodyLineHeight,
        padding: '14px 22px 18px',
        textAlign: 'center',
        whiteSpace: 'pre-wrap',
      }}
    >
      {caption.text.trim()}
    </div>
  </AbsoluteFill>
);

const Captions: React.FC<{captions: Caption[]; visualStyle: StyleConfig}> = ({captions, visualStyle}) => {
  const output = useVideoConfig();
  const {fps} = output;
  const profile = styleProfileForOutput(visualStyle, output);
  return (
    <>
      {captions.map((caption, index) => {
        const range = captionFrameRange(caption, fps);
        return (
          <Sequence key={`${caption.startMs}-${index}`} {...range}>
            <CaptionCard caption={caption} visualStyle={visualStyle} profile={profile} />
          </Sequence>
        );
      })}
    </>
  );
};

export const SocialReel: React.FC<ReelRenderProps> = (props) => {
  const visualStyle = props.visualStyle ?? CINEMATIC_MINIMAL_STYLE;
  const fonts = props.fonts ?? {display: null, body: null, metadata: null};
  void ensureCustomFontsLoaded(fonts);
  if (props.fontUrl && Object.values(fonts).every((font) => font === null)) {
    void ensureCustomFontLoaded(props.fontUrl);
  }
  const staticFonts = Object.fromEntries(
    Object.entries(fonts).map(([role, font]) => [
      role,
      font ? {...font, url: staticFile(font.url)} : null,
    ]),
  ) as StagedFontRoles;
  const roleRules = fontFaceRules(staticFonts);
  const timings = buildShotTimings(props.edit);
  return (
    <AbsoluteFill style={{backgroundColor: '#050505'}}>
      {roleRules || props.fontUrl ? (
        <style>{roleRules || fontFaceRule(staticFile(props.fontUrl!))}</style>
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
                visualStyle={visualStyle}
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
      <Titles edit={props.edit} visualStyle={visualStyle} />
      <Captions captions={props.captions} visualStyle={visualStyle} />
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
