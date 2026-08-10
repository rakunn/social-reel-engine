import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';
import {writeJson} from '../../src/core/json';
import {validateEdit} from '../../src/edit/validate';
import {analyzeSources} from '../../src/media/analyze';
import {runFfmpeg} from '../../src/media/ffmpeg';
import {ingestFiles} from '../../src/project/ingest';
import {createReelProject} from '../../src/project/workspace';
import {renderPreview} from '../../src/render/remotion';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let projectPath: string;
let videoSourceId: string;
let musicSourceId: string;

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
  const captions = path.join(root, 'malformed.json');
  await writeFile(captions, '[{}]');
  const srt = path.join(root, 'malformed.srt');
  await writeFile(
    srt,
    '1\n00:00:00,000 --> 00:00:00,800\nValid caption\n\n2\nBroken caption\n',
  );
  await ingestFiles(projectPath, [video], 'clips');
  await ingestFiles(projectPath, [video], 'music');
  await ingestFiles(projectPath, [captions, srt], 'captions');
  const manifest = await analyzeSources(projectPath);
  videoSourceId = manifest.sources.find((source) => source.mediaType === 'video')!.id;
  musicSourceId = manifest.sources.find((source) => source.mediaType === 'audio')!.id;
}, 30_000);

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

  it('blocks preview rendering before setup when the edit is invalid', async () => {
    await writeJson(
      path.join(projectPath, 'edits/edit.json'),
      edit({muted: false, captions: 'none'}),
    );
    await expect(renderPreview(projectPath, repositoryRoot)).rejects.toThrow(/audio stream/i);
  });
});
