import {mkdir, mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {EditManifestSchema, SourceManifestSchema} from '../../src/contracts/schemas';
import {referencedRenderSources} from '../../src/render/artifacts';
import {CINEMATIC_MINIMAL_STYLE, StyleConfigSchema} from '../../src/style/contracts';
import {readProjectStyle, resolveStyleFontSources} from '../../src/style/project';

const makeManifest = (fontPaths: string[]) =>
  SourceManifestSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: '2026-08-27T00:00:00.000Z',
    sources: [
      {
        id: 'video-source',
        relativePath: 'input/clips/clip.mp4',
        checksumSha256: 'a'.repeat(64),
        sizeBytes: 100,
        mediaType: 'video',
        ffprobe: {format: {}, streams: []},
        camera: {confirmed: false, profileId: null},
      },
      ...fontPaths.map((relativePath, index) => ({
        id: `font-${index}`,
        relativePath,
        checksumSha256: String(index + 1).repeat(64),
        sizeBytes: 100,
        mediaType: 'font',
        ffprobe: {format: {}, streams: []},
        camera: {confirmed: false, profileId: null},
      })),
    ],
  });

const edit = EditManifestSchema.parse({
  schemaVersion: '1.0.0',
  reelName: 'style-test',
  output: {width: 1080, height: 1920, fps: 30},
  clips: [
    {
      id: 'hero',
      sourceId: 'video-source',
      inSeconds: 0,
      outSeconds: 4,
      playbackRate: 1,
      crop: {start: {x: 0.5, y: 0.5, scale: 1}, end: {x: 0.5, y: 0.5, scale: 1}},
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
      audio: {muted: true, gainDb: -60},
      textOverlay: null,
      transitionAfter: {type: 'none', durationSeconds: 0},
    },
  ],
  titles: [],
  music: null,
  captions: null,
});

describe('project style resolution', () => {
  it.each([
    {fontPaths: [] as string[], expected: [] as string[]},
    {fontPaths: ['input/fonts/only.ttf'], expected: ['input/fonts/only.ttf']},
  ])('resolves deterministic legacy style for $fontPaths.length fonts', async ({fontPaths, expected}) => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'legacy-style-'));
    await mkdir(path.join(projectPath, 'config'), {recursive: true});
    const manifest = makeManifest(fontPaths);
    const style = await readProjectStyle(projectPath, manifest);
    expect(resolveStyleFontSources(style, manifest).map((source) => source.relativePath)).toEqual(
      expected,
    );
  });

  it('rejects a legacy project with multiple unassigned fonts', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'legacy-style-'));
    await mkdir(path.join(projectPath, 'config'), {recursive: true});
    const manifest = makeManifest(['input/fonts/a.ttf', 'input/fonts/b.ttf']);
    await expect(readProjectStyle(projectPath, manifest)).rejects.toThrow(
      /multiple|apply.*style|ambiguous/i,
    );
  });

  it('includes every selected role font once and ignores unselected fonts', () => {
    const manifest = makeManifest([
      'input/fonts/fraunces.ttf',
      'input/fonts/manrope.ttf',
      'input/fonts/unused.ttf',
    ]);
    const style = StyleConfigSchema.parse({
      ...CINEMATIC_MINIMAL_STYLE,
      presetId: 'explicit-style',
      catalogFingerprint: 'f'.repeat(64),
      typography: {
        display: {
          assetId: 'fraunces',
          relativePath: 'input/fonts/fraunces.ttf',
          family: 'ReelDisplay',
          weight: 600,
          style: 'normal',
          fallback: ['serif'],
        },
        body: {
          assetId: 'manrope',
          relativePath: 'input/fonts/manrope.ttf',
          family: 'ReelBody',
          weight: 450,
          style: 'normal',
          fallback: ['sans-serif'],
        },
        metadata: {
          assetId: 'manrope',
          relativePath: 'input/fonts/manrope.ttf',
          family: 'ReelBody',
          weight: 550,
          style: 'normal',
          fallback: ['sans-serif'],
        },
      },
    });
    expect(
      referencedRenderSources(edit, manifest, style)
        .map((source) => source.relativePath)
        .sort(),
    ).toEqual([
      'input/clips/clip.mp4',
      'input/fonts/fraunces.ttf',
      'input/fonts/manrope.ttf',
    ]);
  });
});
