import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';
import {writeJson} from '../../src/core/json';
import {validateEdit} from '../../src/edit/validate';
import {analyzeSources} from '../../src/media/analyze';
import {runFfmpeg} from '../../src/media/ffmpeg';
import {ingestFiles} from '../../src/project/ingest';
import {createReelProject, getProjectStatus} from '../../src/project/workspace';
import {renderPreview} from '../../src/render/remotion';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let projectPath: string;
let videoSourceId: string;
let videoWithAudioSourceId: string;
let musicSourceId: string;
let validMusicSourceId: string;

const edit = (options: {
  muted: boolean;
  captions: 'none' | 'remotion-json' | 'srt';
}) => ({
  schemaVersion: '1.0.0',
  reelName: 'edit-validation',
  output: {width: 1080, height: 1920, fps: 30},
  clips: [
    {
      id: 'shot-1',
      sourceId: videoSourceId,
      inSeconds: 0,
      outSeconds: 0.9,
      playbackRate: 1,
      crop: {
        start: {x: 0.5, y: 0.5, scale: 1},
        end: {x: 0.5, y: 0.5, scale: 1},
      },
      stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
      grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
      audio: {muted: options.muted, gainDb: 0},
      transitionAfter: {type: 'none', durationSeconds: 0},
    },
  ],
  titles: [],
  music: null,
  captions:
    options.captions === 'none'
      ? null
      : options.captions === 'remotion-json'
        ? {relativePath: 'input/captions/malformed.json', format: 'remotion-json'}
        : {relativePath: 'input/captions/malformed.srt', format: 'srt'},
});

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-edit-validation-'));
  projectPath = await createReelProject({
    engineRoot: repositoryRoot,
    projectsRoot: path.join(root, 'projects'),
    reelName: 'edit-validation',
  });
  const video = path.join(root, 'video-only.mp4');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=30:duration=1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    video,
  ]);
  const videoWithAudio = path.join(root, 'video-with-audio.mp4');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=30:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000:duration=1',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    videoWithAudio,
  ]);
  const captions = path.join(root, 'malformed.json');
  await writeFile(captions, '[{}]');
  const srt = path.join(root, 'malformed.srt');
  await writeFile(
    srt,
    '1\n00:00:00,000 --> 00:00:00,800\nValid caption\n\n2\nBroken caption\n',
  );
  const visibleCaptions = path.join(root, 'visible.json');
  await writeFile(
    visibleCaptions,
    JSON.stringify([
      {text: 'Visible', startMs: 0, endMs: 800, timestampMs: null, confidence: null},
    ]),
  );
  const futureCaptions = path.join(root, 'future.json');
  await writeFile(
    futureCaptions,
    JSON.stringify([
      {text: 'Too late', startMs: 2000, endMs: 2500, timestampMs: null, confidence: null},
    ]),
  );
  const validMusic = path.join(root, 'music.wav');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    validMusic,
  ]);
  await ingestFiles(projectPath, [video, videoWithAudio], 'clips');
  await ingestFiles(projectPath, [video, validMusic], 'music');
  await ingestFiles(projectPath, [captions, srt, visibleCaptions, futureCaptions], 'captions');
  const manifest = await analyzeSources(projectPath);
  videoSourceId = manifest.sources.find(
    (source) => source.relativePath === 'input/clips/video-only.mp4',
  )!.id;
  videoWithAudioSourceId = manifest.sources.find(
    (source) => source.relativePath === 'input/clips/video-with-audio.mp4',
  )!.id;
  musicSourceId = manifest.sources.find(
    (source) => source.relativePath === 'input/music/video-only.mp4',
  )!.id;
  validMusicSourceId = manifest.sources.find(
    (source) => source.relativePath === 'input/music/music.wav',
  )!.id;
}, 30_000);

const validateWithBriefOptions = async (
  options: {music: boolean; captions: boolean; cameraAudio: boolean},
  candidate: unknown,
) => {
  const briefPath = path.join(projectPath, 'brief.json');
  const original = JSON.parse(await readFile(briefPath, 'utf8'));
  await writeJson(briefPath, {...original, options});
  try {
    return await validateEdit(projectPath, candidate);
  } finally {
    await writeJson(briefPath, original);
  }
};

describe('edit media validation', () => {
  it('rejects requested camera audio when the source has no audio stream', async () => {
    const result = await validateEdit(projectPath, edit({muted: false, captions: 'none'}));
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/shot-1.*audio stream/i)]),
    );
  });

  it('rejects selected music when the source has no audio stream', async () => {
    const result = await validateEdit(projectPath, {
      ...edit({muted: true, captions: 'none'}),
      music: {sourceId: musicSourceId, startSeconds: 0, gainDb: -8},
    });
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/music.*audio stream/i)]),
    );
  });

  it('rejects a music offset at or beyond the audio duration', async () => {
    const result = await validateEdit(projectPath, {
      ...edit({muted: true, captions: 'none'}),
      music: {sourceId: validMusicSourceId, startSeconds: 1, gainDb: -8},
    });
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/music.*offset|start.*duration/i)]),
    );
  });

  it('falls back to the real frame rate when the average rate is unusable', async () => {
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    const changed = {
      ...original,
      sources: original.sources.map((source: {id: string; ffprobe: {streams: Array<Record<string, unknown>>}}) =>
        source.id === videoSourceId
          ? {
              ...source,
              ffprobe: {
                ...source.ffprobe,
                streams: source.ffprobe.streams.map((stream) =>
                  stream.codec_type === 'video'
                    ? {...stream, avg_frame_rate: '0/0', r_frame_rate: '30/1'}
                    : stream,
                ),
              },
            }
          : source,
      ),
    };
    await writeJson(manifestPath, changed);

    try {
      const result = await validateEdit(projectPath, edit({muted: true, captions: 'none'}));
      expect(result.valid).toBe(true);
      expect(result.failures).not.toContainEqual(expect.stringMatching(/frame rate/i));
    } finally {
      await writeJson(manifestPath, original);
    }
  });

  it('validates trims against the selected video stream instead of a longer container', async () => {
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    const changed = {
      ...original,
      sources: original.sources.map((source: {id: string; ffprobe: {format: Record<string, unknown>; streams: Array<Record<string, unknown>>}}) =>
        source.id === videoSourceId
          ? {
              ...source,
              ffprobe: {
                ...source.ffprobe,
                format: {...source.ffprobe.format, duration: '2.0'},
                streams: source.ffprobe.streams.map((stream) =>
                  stream.codec_type === 'video' ? {...stream, duration: '0.5'} : stream,
                ),
              },
            }
          : source,
      ),
    };
    await writeJson(manifestPath, changed);

    try {
      const result = await validateEdit(projectPath, edit({muted: true, captions: 'none'}));
      expect(result.valid).toBe(false);
      expect(result.failures).toContainEqual(expect.stringMatching(/out point.*source duration/i));
    } finally {
      await writeJson(manifestPath, original);
    }
  });

  it('derives selected video duration from duration_ts before using container duration', async () => {
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    const changed = {
      ...original,
      sources: original.sources.map((source: {id: string; ffprobe: {format: Record<string, unknown>; streams: Array<Record<string, unknown>>}}) =>
        source.id === videoSourceId
          ? {
              ...source,
              ffprobe: {
                ...source.ffprobe,
                format: {...source.ffprobe.format, duration: '2.0'},
                streams: source.ffprobe.streams.map((stream) =>
                  stream.codec_type === 'video'
                    ? {
                        ...stream,
                        duration: undefined,
                        duration_ts: '15',
                        time_base: '1/30',
                      }
                    : stream,
                ),
              },
            }
          : source,
      ),
    };
    await writeJson(manifestPath, changed);

    try {
      const result = await validateEdit(projectPath, edit({muted: true, captions: 'none'}));
      expect(result.valid).toBe(false);
      expect(result.failures).toContainEqual(expect.stringMatching(/out point.*source duration/i));
    } finally {
      await writeJson(manifestPath, original);
    }
  });

  it('rejects unmuted trims outside the audio stream timeline', async () => {
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    const changed = {
      ...original,
      sources: original.sources.map((source: {id: string; ffprobe: {streams: Array<Record<string, unknown>>}}) =>
        source.id === videoWithAudioSourceId
          ? {
              ...source,
              ffprobe: {
                ...source.ffprobe,
                streams: source.ffprobe.streams.map((stream) =>
                  stream.codec_type === 'audio'
                    ? {...stream, start_time: '0.2', duration: '0.5'}
                    : stream,
                ),
              },
            }
          : source,
      ),
    };
    await writeJson(manifestPath, changed);

    try {
      const base = edit({muted: false, captions: 'none'});
      const result = await validateWithBriefOptions(
        {music: true, captions: true, cameraAudio: true},
        {
          ...base,
          clips: [{...base.clips[0], sourceId: videoWithAudioSourceId}],
        },
      );
      expect(result.valid).toBe(false);
      expect(result.failures).toContainEqual(
        expect.stringMatching(/shot-1.*camera audio.*selected range/i),
      );
    } finally {
      await writeJson(manifestPath, original);
    }
  });

  it('rejects titles whose rounded start frame is outside the timeline', async () => {
    const result = await validateEdit(projectPath, {
      ...edit({muted: true, captions: 'none'}),
      titles: [
        {
          text: 'Too late',
          startSeconds: 0.9,
          durationSeconds: 0.5,
          position: 'center',
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(expect.stringMatching(/title.*timeline/i));
  });

  it('rejects malformed Remotion Caption JSON before rendering', async () => {
    const result = await validateEdit(
      projectPath,
      edit({muted: true, captions: 'remotion-json'}),
    );
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/caption.*invalid|invalid.*caption/i)]),
    );
  });

  it('rejects malformed SRT that parses to no captions', async () => {
    const result = await validateEdit(projectPath, edit({muted: true, captions: 'srt'}));
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/caption.*invalid|invalid.*caption/i)]),
    );
  });

  it('rejects a selected caption file when no caption overlaps the rendered timeline', async () => {
    const result = await validateWithBriefOptions(
      {music: true, captions: true, cameraAudio: true},
      {
        ...edit({muted: true, captions: 'none'}),
        captions: {relativePath: 'input/captions/future.json', format: 'remotion-json'},
      },
    );
    expect(result.valid).toBe(false);
    expect(result.failures).toContainEqual(expect.stringMatching(/caption.*timeline/i));
  });

  it('rejects music when the project brief disables music', async () => {
    const result = await validateWithBriefOptions(
      {music: false, captions: true, cameraAudio: true},
      {
        ...edit({muted: true, captions: 'none'}),
        music: {sourceId: validMusicSourceId, startSeconds: 0, gainDb: -8},
      },
    );
    expect(result.failures).toContainEqual(expect.stringMatching(/music.*disabled.*brief/i));
  });

  it('rejects captions when the project brief disables captions', async () => {
    const result = await validateWithBriefOptions(
      {music: true, captions: false, cameraAudio: true},
      {
        ...edit({muted: true, captions: 'none'}),
        captions: {relativePath: 'input/captions/visible.json', format: 'remotion-json'},
      },
    );
    expect(result.failures).toContainEqual(expect.stringMatching(/captions.*disabled.*brief/i));
  });

  it('rejects camera audio when the project brief disables camera audio', async () => {
    const base = edit({muted: false, captions: 'none'});
    const result = await validateWithBriefOptions(
      {music: true, captions: true, cameraAudio: false},
      {
        ...base,
        clips: [{...base.clips[0], sourceId: videoWithAudioSourceId}],
      },
    );
    expect(result.failures).toContainEqual(
      expect.stringMatching(/camera audio.*disabled.*brief/i),
    );
  });

  it('blocks preview rendering before setup when the edit is invalid', async () => {
    await writeJson(
      path.join(projectPath, 'edits/edit.json'),
      edit({muted: false, captions: 'none'}),
    );
    await expect(renderPreview(projectPath, repositoryRoot)).rejects.toThrow(/audio stream/i);
  });

  it('reports awaiting-edit when status encounters a semantically invalid edit', async () => {
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit({muted: true, captions: 'none'}),
      clips: [
        {
          ...edit({muted: true, captions: 'none'}).clips[0],
          outSeconds: 2,
        },
      ],
    });

    const status = await getProjectStatus(projectPath);
    expect(status.stage).toBe('awaiting-edit');
    expect(status.nextAction).toMatch(/validate|edit/i);
  });
});
