import {access, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const generateProxies = vi.hoisted(() => vi.fn());
const readValidatedSourceManifest = vi.hoisted(() => vi.fn());

vi.mock('../../src/media/proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/media/proxy')>();
  return {...actual, generateProxies};
});

vi.mock('../../src/media/source-integrity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/media/source-integrity')>();
  return {...actual, readValidatedSourceManifest};
});

import {prepareRenderProps} from '../../src/render/stage';

const temporaryDirectories: string[] = [];

const makeDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const missing = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
};

beforeEach(() => {
  generateProxies.mockReset();
  readValidatedSourceManifest.mockReset();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, {recursive: true, force: true})),
  );
});

describe('render-stage preparation cleanup', () => {
  it('removes a populated stage when caption parsing fails before preparation returns', async () => {
    const engineRoot = await makeDirectory('reel-stage-engine-');
    const projectPath = await makeDirectory('reel-stage-project-');
    const proxyRelativePath = 'work/proxies/source-1.mp4';
    const captionRelativePath = 'config/captions.json';
    const proxyPath = path.join(projectPath, proxyRelativePath);
    await mkdir(path.dirname(proxyPath), {recursive: true});
    await mkdir(path.join(projectPath, 'edits'), {recursive: true});
    await mkdir(path.join(projectPath, 'config'), {recursive: true});
    await writeFile(proxyPath, 'proxy-video');
    await writeFile(path.join(projectPath, captionRelativePath), '{invalid-json');
    await writeFile(
      path.join(projectPath, 'edits/edit.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        reelName: 'preparation-cleanup',
        output: {width: 1080, height: 1920, fps: 30},
        clips: [
          {
            id: 'shot-1',
            sourceId: 'source-1',
            inSeconds: 0,
            outSeconds: 1,
            playbackRate: 1,
            crop: {
              start: {x: 0.5, y: 0.5, scale: 1},
              end: {x: 0.5, y: 0.5, scale: 1},
            },
            stabilization: {
              enabled: false,
              strength: 0,
              fallbackToUnstabilized: true,
            },
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
        titles: [],
        music: null,
        captions: {
          relativePath: captionRelativePath,
          format: 'remotion-json',
        },
      }),
    );

    generateProxies.mockResolvedValue({
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-12T00:00:00.000Z',
      items: [
        {
          sourceId: 'source-1',
          proxy: proxyRelativePath,
          representativeFrame: 'work/proxies/source-1-frame.jpg',
          contactSheet: 'work/proxies/source-1-contact.jpg',
          normalization: 'technical',
          normalizerFile: null,
          maximumDimension: 960,
          cached: true,
        },
      ],
    });
    readValidatedSourceManifest.mockResolvedValue({
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-12T00:00:00.000Z',
      sources: [
        {
          id: 'source-1',
          relativePath: 'input/clips/source-1.mp4',
          checksumSha256: 'a'.repeat(64),
          sizeBytes: 11,
          mediaType: 'video',
          ffprobe: {format: {}, streams: []},
          camera: {
            manufacturer: null,
            model: null,
            gamma: null,
            gamut: null,
            profileId: null,
            confirmed: false,
          },
        },
      ],
    });

    await expect(prepareRenderProps(projectPath, engineRoot, 'preview')).rejects.toThrow(
      /json|unexpected|position/i,
    );

    expect(await missing(path.join(engineRoot, 'public/jobs/preparation-cleanup'))).toBe(true);
  });
});
