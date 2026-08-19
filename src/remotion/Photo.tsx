import React from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile} from 'remotion';
import {photoCropStyle} from './model';

export type SharePhotoProps = {
  media: string;
  trimBeforeFrames: number;
  crop: {x: number; y: number; scale: number};
  width: number;
  height: number;
};

export const calculatePhotoMetadata = (props: SharePhotoProps) => ({
  width: props.width,
  height: props.height,
  fps: 30,
  durationInFrames: 1,
  props,
});

export const SharePhoto: React.FC<SharePhotoProps> = ({media, trimBeforeFrames, crop}) => (
  <AbsoluteFill style={{backgroundColor: '#050505', overflow: 'hidden'}}>
    <OffthreadVideo
      src={staticFile(media)}
      trimBefore={trimBeforeFrames}
      muted
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        ...photoCropStyle(crop),
      }}
    />
  </AbsoluteFill>
);
