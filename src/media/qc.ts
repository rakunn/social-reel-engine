import {open, stat} from 'node:fs/promises';

export type ProbeDocument = {
  format?: Record<string, unknown>;
  streams?: Array<Record<string, unknown>>;
};

const numberValue = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const fractionValue = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return numberValue(value);
  }
  const [numerator, denominator = '1'] = value.split('/');
  const top = Number(numerator);
  const bottom = Number(denominator);
  return Number.isFinite(top) && Number.isFinite(bottom) && bottom !== 0 ? top / bottom : null;
};

export const summarizeProbe = (probe: ProbeDocument) => {
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio');
  return {
    durationSeconds: numberValue(probe.format?.duration),
    formatName: probe.format?.format_name ?? null,
    width: numberValue(video?.width),
    height: numberValue(video?.height),
    fps: fractionValue(video?.avg_frame_rate ?? video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    videoProfile: video?.profile ?? null,
    videoBitRate: numberValue(video?.bit_rate),
    pixelFormat: video?.pix_fmt ?? null,
    colorPrimaries: video?.color_primaries ?? null,
    colorTransfer: video?.color_transfer ?? null,
    colorSpace: video?.color_space ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: numberValue(audio?.sample_rate),
    audioBitRate: numberValue(audio?.bit_rate),
    audioChannels: numberValue(audio?.channels),
  };
};

export const isSilentLoudness = (output: string): boolean =>
  /"input_i"\s*:\s*"-inf"/i.test(output) &&
  /"input_tp"\s*:\s*"-inf"/i.test(output);

export const inspectMp4FastStart = async (filePath: string): Promise<boolean> => {
  const fileStat = await stat(filePath);
  const handle = await open(filePath, 'r');
  let position = 0;
  let moovPosition: number | null = null;
  let mdatPosition: number | null = null;
  try {
    while (position + 8 <= fileStat.size) {
      const header = Buffer.alloc(16);
      const {bytesRead} = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) break;
      const size32 = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      let boxSize: number;
      if (size32 === 1) {
        if (bytesRead < 16) break;
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        boxSize = Number(extended);
      } else if (size32 === 0) {
        boxSize = fileStat.size - position;
      } else {
        boxSize = size32;
      }
      if (boxSize < 8 || position + boxSize > fileStat.size) return false;
      if (type === 'moov') moovPosition = position;
      if (type === 'mdat') mdatPosition = position;
      if (moovPosition !== null && mdatPosition !== null) break;
      position += boxSize;
    }
  } finally {
    await handle.close();
  }
  return moovPosition !== null && mdatPosition !== null && moovPosition < mdatPosition;
};

export type DetectedSection = {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
};

export const parseBlackFrames = (output: string): DetectedSection[] => {
  const expression = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  return [...output.matchAll(expression)].map((match) => ({
    startSeconds: Number(match[1]),
    endSeconds: Number(match[2]),
    durationSeconds: Number(match[3]),
  }));
};

export const parseFreezeSections = (output: string): DetectedSection[] => {
  const starts = [...output.matchAll(/freeze_start:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  const durations = [...output.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((match) =>
    Number(match[1]),
  );
  const ends = [...output.matchAll(/freeze_end:\s*([\d.]+)/g)].map((match) => Number(match[1]));
  return starts.map((startSeconds, index) => ({
    startSeconds,
    endSeconds: ends[index] ?? startSeconds + (durations[index] ?? 0),
    durationSeconds: durations[index] ?? (ends[index] ?? startSeconds) - startSeconds,
  }));
};

export const parseLoudness = (
  output: string,
): {integratedLufs: number; truePeakDbtp: number; loudnessRangeLu: number} | null => {
  const objects = [...output.matchAll(/\{[\s\S]*?\}/g)];
  for (const match of objects.reverse()) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const integratedLufs = numberValue(parsed.input_i);
      const truePeakDbtp = numberValue(parsed.input_tp);
      const loudnessRangeLu = numberValue(parsed.input_lra);
      if (integratedLufs !== null && truePeakDbtp !== null && loudnessRangeLu !== null) {
        return {integratedLufs, truePeakDbtp, loudnessRangeLu};
      }
    } catch {
      // FFmpeg logs may contain non-JSON braces; continue to the prior candidate.
    }
  }
  return null;
};

export type LoudnormMeasurement = {
  inputIntegratedLufs: number;
  inputTruePeakDbtp: number;
  inputLoudnessRangeLu: number;
  inputThresholdLufs: number;
  targetOffsetLu: number;
};

export const parseLoudnormMeasurement = (output: string): LoudnormMeasurement | null => {
  const objects = [...output.matchAll(/\{[\s\S]*?\}/g)];
  for (const match of objects.reverse()) {
    try {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const values = {
        inputIntegratedLufs: numberValue(parsed.input_i),
        inputTruePeakDbtp: numberValue(parsed.input_tp),
        inputLoudnessRangeLu: numberValue(parsed.input_lra),
        inputThresholdLufs: numberValue(parsed.input_thresh),
        targetOffsetLu: numberValue(parsed.target_offset),
      };
      if (Object.values(values).every((value) => value !== null)) {
        return values as LoudnormMeasurement;
      }
    } catch {
      // Continue to an earlier JSON object in the FFmpeg log.
    }
  }
  return null;
};
