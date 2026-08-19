import React from 'react';
import {Composition} from 'remotion';
import {SocialReel} from './Reel';
import {calculateReelMetadata, type ReelRenderProps} from './model';
import {calculatePhotoMetadata, SharePhoto, type SharePhotoProps} from './Photo';

const defaultProps: ReelRenderProps = {
  edit: {
    schemaVersion: '1.0.0',
    reelName: 'studio-preview',
    output: {width: 1080, height: 1920, fps: 30},
    clips: [
      {
        id: 'placeholder',
        sourceId: 'placeholder',
        inSeconds: 0,
        outSeconds: 1,
        playbackRate: 1,
        crop: {
          start: {x: 0.5, y: 0.5, scale: 1},
          end: {x: 0.5, y: 0.5, scale: 1},
        },
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
        grade: {
          exposureStops: 0,
          whiteBalanceKelvin: 6500,
          tint: 0,
          technicalLutId: null,
          creativeLutId: null,
          combinedLutId: null,
          creativeMix: 0,
        },
        audio: {muted: true, gainDb: 0},
        transitionAfter: {type: 'none', durationSeconds: 0},
      },
    ],
    titles: [{text: 'Load a reel through npm run reel', startSeconds: 0, durationSeconds: 1, position: 'center'}],
    music: null,
    captions: null,
  },
  media: {placeholder: 'jobs/placeholder.mp4'},
  music: null,
  captions: [],
  watermark: 'STUDIO PLACEHOLDER',
  trimBeforeFramesByClip: {},
  fontUrl: null,
};

const defaultPhotoProps: SharePhotoProps = {
  media: 'jobs/placeholder.mp4',
  trimBeforeFrames: 0,
  crop: {x: 0.5, y: 0.5, scale: 1},
  width: 1080,
  height: 1920,
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="SocialReel"
      component={SocialReel}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={30}
      defaultProps={defaultProps}
      calculateMetadata={({props}) => calculateReelMetadata(props as ReelRenderProps)}
    />
    <Composition
      id="SharePhoto"
      component={SharePhoto}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1}
      defaultProps={defaultPhotoProps}
      calculateMetadata={({props}) => calculatePhotoMetadata(props as SharePhotoProps)}
    />
  </>
);
