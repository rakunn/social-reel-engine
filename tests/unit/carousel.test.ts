import {describe, expect, it, vi} from 'vitest';
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hashFile} from '../../src/core/hash';
import {writeJson} from '../../src/core/json';
import {
  ReelBriefSchema,
  EditManifestSchema,
  RenderSettingsSchema,
  QcReportSchema,
} from '../../src/contracts/schemas';
import {carouselContractFailures} from '../../src/edit/validate';
import {
  buildCarouselCardEdit,
  carouselCardFilename,
  evaluateCarouselPackageRecord,
  evaluateCarouselOutputStatus,
  publishCarouselCards,
  readCarouselPackageFreshness,
  renderCarouselPackage,
  type CarouselPackageRecord,
} from '../../src/render/carousel';
import {summarizeCarouselQc} from '../../src/media/carousel-qc';
import {renderMasterAndDelivery} from '../../src/render/remotion';

const clip = (id: string, durationSeconds = 4.5) => ({
  id,
  sourceId: `source-${id}`,
  inSeconds: 1,
  outSeconds: 1 + durationSeconds,
  playbackRate: 1,
  crop: {
    start: {x: 0.5, y: 0.5, scale: 1},
    end: {x: 0.5, y: 0.5, scale: 1},
  },
  stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
  grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
  audio: {muted: true, gainDb: 0},
  transitionAfter: {type: 'none' as const, durationSeconds: 0},
});

const brief = ReelBriefSchema.parse({
  schemaVersion: '1.0.0',
  projectType: 'carousel',
  identity: {
    reelName: 'loboc-carousel',
    title: 'Loboc River',
    createdAt: '2026-08-18T00:00:00.000Z',
  },
  target: {minSeconds: 4, idealSeconds: 4.5, maxSeconds: 5},
  output: {width: 1910, height: 1000, fps: 30},
  style: 'cinematic-minimal',
  options: {music: false, captions: false, cameraAudio: false},
  rightsConfirmed: false,
});

const validEdit = EditManifestSchema.parse({
  schemaVersion: '1.0.0',
  reelName: 'loboc-carousel',
  output: {width: 1910, height: 1000, fps: 30},
  clips: [clip('hero'), clip('closer')],
  titles: [],
  music: null,
  captions: null,
});

const settings = RenderSettingsSchema.parse({
  schemaVersion: '1.0.0',
  proxy: {width: 960, height: 540, crf: 23},
  preview: {width: 764, height: 400, crf: 20, audioBitrate: '192k'},
  master: {
    width: 1910,
    height: 1000,
    fps: 30,
    videoCodec: 'prores_ks',
    profile: 3,
    pixelFormat: 'yuv422p10le',
    audioCodec: 'pcm_s16le',
    audioSampleRate: 48_000,
  },
  delivery: {
    videoCodec: 'libx264',
    pixelFormat: 'yuv420p',
    crf: 17,
    audioCodec: 'aac',
    audioBitrate: '256k',
    integratedLufs: -14,
    truePeakDbtp: -1.5,
  },
});

const carouselProps = {
  edit: validEdit,
  media: {hero: 'media/hero.mov', closer: 'media/closer.mov'},
  music: null,
  captions: [],
  watermark: null,
  trimBeforeFramesByClip: {hero: 0, closer: 0},
  fontUrl: null,
};

describe('carousel edit contract', () => {
  it('accepts independently publishable 4–5 second cards', () => {
    expect(carouselContractFailures(validEdit, brief)).toEqual([]);
  });

  it('rejects global overlays, a single card, and out-of-range card durations', () => {
    const invalid = EditManifestSchema.parse({
      ...validEdit,
      clips: [clip('only', 3.5)],
      titles: [{text: 'Global title', startSeconds: 0, durationSeconds: 1}],
    });
    expect(carouselContractFailures(invalid, brief)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/at least two cards/i),
        expect.stringMatching(/only.*4.*5.*seconds/i),
        expect.stringMatching(/titles/i),
      ]),
    );
  });

  it('rejects transitions between independently publishable cards', () => {
    const invalid = EditManifestSchema.parse({
      ...validEdit,
      clips: [
        {...clip('first'), transitionAfter: {type: 'fade', durationSeconds: 0.5}},
        clip('second'),
      ],
    });
    expect(carouselContractFailures(invalid, brief)).toContainEqual(
      expect.stringMatching(/first.*transition/i),
    );
  });

  it('keeps the 4–5 second card contract when the brief target is widened', () => {
    const widenedBrief = ReelBriefSchema.parse({
      ...brief,
      target: {minSeconds: 1, idealSeconds: 6, maxSeconds: 12},
    });
    const invalid = EditManifestSchema.parse({
      ...validEdit,
      clips: [clip('hero', 10), clip('closer', 10)],
    });

    expect(carouselContractFailures(invalid, widenedBrief)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/hero.*4.*5.*seconds/i),
        expect.stringMatching(/closer.*4.*5.*seconds/i),
      ]),
    );
  });
});

describe('carousel card rendering model', () => {
  it('builds a standalone timeline without leaking neighboring cards or global media', () => {
    const card = buildCarouselCardEdit(validEdit, 1);
    expect(card).toEqual(
      expect.objectContaining({
        output: {width: 1910, height: 1000, fps: 30},
        clips: [expect.objectContaining({id: 'closer'})],
        titles: [],
        music: null,
        captions: null,
      }),
    );
    expect(card.clips[0].transitionAfter).toEqual({type: 'none', durationSeconds: 0});
  });

  it('uses stable ordered delivery filenames and rejects unsafe card IDs', () => {
    expect(carouselCardFilename(0, 'loboc-hero')).toBe('01-loboc-hero.mp4');
    expect(carouselCardFilename(11, 'river.close')).toBe('12-river.close.mp4');
    expect(() => carouselCardFilename(0, '../escape')).toThrow(/card id/i);
  });

  it('treats the package as fresh only when every ordered MP4 matches its record', () => {
    const record: CarouselPackageRecord = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-18T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: [
        {
          index: 0,
          clipId: 'hero',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4',
          checksumSha256: 'b'.repeat(64),
          sizeBytes: 123,
          durationSeconds: 4.5,
        },
      ],
    };
    expect(
      evaluateCarouselPackageRecord(record, 'a'.repeat(64), {
        'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4': {
          checksumSha256: 'b'.repeat(64),
          sizeBytes: 123,
        },
      }),
    ).toEqual({fresh: true, reason: null});
    expect(
      evaluateCarouselPackageRecord(record, 'a'.repeat(64), {
        'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4': {
          checksumSha256: 'c'.repeat(64),
          sizeBytes: 123,
        },
      }),
    ).toEqual(expect.objectContaining({fresh: false, reason: expect.stringMatching(/checksum/i)}));
  });

  it('publishes one independently encoded MP4 for each ordered card', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-publish-'));
    const result = await publishCarouselCards(
      {
        projectPath,
        engineRoot: projectPath,
        publicDir: projectPath,
        fingerprint: 'a'.repeat(64),
        props: carouselProps,
        settings,
      },
      {
        supervise: async (request) => {
          await writeFile(request.rawOutput, `master:${request.inputProps.edit ? 'card' : 'missing'}`);
        },
        runFfmpeg: async (args) => {
          const output = args.at(-1)!;
          if (output !== '-') await writeFile(output, 'encoded-card');
          return {
            command: 'ffmpeg',
            args: [...args],
            stdout: '',
            stderr: output === '-' ? '{"input_i":"-inf","input_tp":"-inf"}' : '',
            exitCode: 0,
          };
        },
        probeFile: async () => ({format: {duration: '4.5'}, streams: []}),
      },
      new Date('2026-08-18T00:00:00.000Z'),
    );

    expect(result.cards.map((card) => ({index: card.index, clipId: card.clipId}))).toEqual([
      {index: 0, clipId: 'hero'},
      {index: 1, clipId: 'closer'},
    ]);
    for (const card of result.cards) {
      await expect(readFile(path.join(projectPath, card.file), 'utf8')).resolves.toBe(
        'encoded-card',
      );
    }
  });

  it.each([
    {
      label: 'carousel output root',
      link: 'output/carousel',
      escapedCard: 'aaaaaaaaaaaaaaaa/01-hero.mp4',
    },
    {
      label: 'carousel fingerprint directory',
      link: 'output/carousel/aaaaaaaaaaaaaaaa',
      escapedCard: '01-hero.mp4',
    },
    {
      label: 'carousel staging root',
      link: 'work/carousel',
      escapedCard: 'aaaaaaaaaaaaaaaa/01-hero.mov',
    },
    {
      label: 'carousel staging fingerprint directory',
      link: 'work/carousel/aaaaaaaaaaaaaaaa',
      escapedCard: '01-hero.mov',
    },
  ])('refuses a symlinked $label before rendering or publishing', async ({link, escapedCard}) => {
    const root = await mkdtemp(path.join(tmpdir(), 'carousel-publish-symlink-'));
    const projectPath = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    const sentinel = path.join(outside, 'sentinel.txt');
    const supervise = vi.fn(async (request) => {
      await writeFile(request.rawOutput, 'master');
    });
    try {
      await mkdir(path.dirname(path.join(projectPath, link)), {recursive: true});
      await mkdir(outside, {recursive: true});
      await writeFile(sentinel, 'keep');
      await symlink(outside, path.join(projectPath, link), 'dir');

      await expect(
        publishCarouselCards(
          {
            projectPath,
            engineRoot: projectPath,
            publicDir: projectPath,
            fingerprint: 'a'.repeat(64),
            props: carouselProps,
            settings,
          },
          {
            supervise,
            runFfmpeg: async (args) => {
              const output = args.at(-1)!;
              if (output !== '-') await writeFile(output, 'encoded-card');
              return {
                command: 'ffmpeg',
                args: [...args],
                stdout: '',
                stderr: output === '-' ? '{"input_i":"-inf","input_tp":"-inf"}' : '',
                exitCode: 0,
              };
            },
            probeFile: async () => ({format: {duration: '4.5'}, streams: []}),
          },
        ),
      ).rejects.toThrow(/symlink|outside|boundary|real directory/i);
      expect(supervise).not.toHaveBeenCalled();
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
      await expect(stat(path.join(outside, escapedCard))).rejects.toThrow();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });

  it('detects a published carousel card changed after package recording', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-freshness-'));
    const outputDirectory = path.join(projectPath, 'output/carousel/aaaaaaaaaaaaaaaa');
    await mkdir(outputDirectory, {recursive: true});
    const cards = [];
    for (const [index, id] of ['hero', 'closer'].entries()) {
      const relativeFile = `output/carousel/aaaaaaaaaaaaaaaa/${carouselCardFilename(index, id)}`;
      const absoluteFile = path.join(projectPath, ...relativeFile.split('/'));
      await writeFile(absoluteFile, `card-${id}`);
      cards.push({
        index,
        clipId: id,
        file: relativeFile,
        checksumSha256: await hashFile(absoluteFile),
        sizeBytes: (await stat(absoluteFile)).size,
        durationSeconds: 4.5,
      });
    }
    await writeJson(path.join(projectPath, 'analysis/carousel.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-18T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards,
    });

    await expect(
      readCarouselPackageFreshness(projectPath, {expectedFingerprint: 'a'.repeat(64)}),
    ).resolves.toEqual({fresh: true, reason: null});
    await writeFile(path.join(projectPath, cards[0].file), 'mutated-card');
    await expect(
      readCarouselPackageFreshness(projectPath, {expectedFingerprint: 'a'.repeat(64)}),
    ).resolves.toEqual(
      expect.objectContaining({fresh: false, reason: expect.stringMatching(/size|checksum/i)}),
    );
  });

  it('refuses to publish carousel cards from a standard reel project', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-standard-project-'));
    await writeJson(path.join(projectPath, 'brief.json'), {
      ...brief,
      projectType: 'reel',
      target: {minSeconds: 20, idealSeconds: 25, maxSeconds: 30},
      output: {width: 1080, height: 1920, fps: 30},
    });
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...validEdit,
      output: {width: 1080, height: 1920, fps: 30},
    });

    await expect(renderCarouselPackage(projectPath, projectPath)).rejects.toThrow(
      /carousel project/i,
    );
  });

  it('refuses to publish a combined standard render from a carousel project', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'carousel-standard-render-'));
    await writeJson(path.join(projectPath, 'brief.json'), brief);

    await expect(renderMasterAndDelivery(projectPath, projectPath)).rejects.toThrow(
      /standard render.*reel project|carousel.*render-carousel/i,
    );
  });

  it('rejects standard render settings that do not match the reel edit output', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-mismatched-render-settings-'));
    await writeJson(path.join(projectPath, 'brief.json'), {
      ...brief,
      projectType: 'reel',
      target: {minSeconds: 20, idealSeconds: 25, maxSeconds: 30},
      output: {width: 1080, height: 1920, fps: 30},
    });
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...validEdit,
      output: {width: 1080, height: 1920, fps: 30},
    });
    await writeJson(path.join(projectPath, 'config/settings.json'), {
      schemaVersion: '1.0.0',
      proxy: {width: 960, height: 540, crf: 23},
      preview: {width: 764, height: 400, crf: 20, audioBitrate: '192k'},
      master: {
        width: 1910,
        height: 1000,
        fps: 30,
        videoCodec: 'prores_ks',
        profile: 3,
        pixelFormat: 'yuv422p10le',
        audioCodec: 'pcm_s16le',
        audioSampleRate: 48_000,
      },
      delivery: {
        videoCodec: 'libx264',
        pixelFormat: 'yuv420p',
        crf: 17,
        audioCodec: 'aac',
        audioBitrate: '256k',
        integratedLufs: -14,
        truePeakDbtp: -1.5,
      },
    });

    await expect(renderMasterAndDelivery(projectPath, projectPath)).rejects.toThrow(
      /render settings.*edit output|edit output.*render settings/i,
    );
  });

  it('requires current QC before reporting a carousel package as rendered', () => {
    const evaluateWithCardBinding = evaluateCarouselOutputStatus as (
      packageFresh: boolean,
      packageFingerprint: string | null,
      qcPackageFingerprint: string | null,
      qcFailures: readonly string[],
      qcCardsMatchPackage: boolean,
    ) => ReturnType<typeof evaluateCarouselOutputStatus>;
    expect(evaluateCarouselOutputStatus(false, null, null, [], false)).toBe('ready');
    expect(
      evaluateCarouselOutputStatus(true, 'a'.repeat(64), null, [], false),
    ).toBe('awaiting-qc');
    expect(
      evaluateCarouselOutputStatus(
        true,
        'a'.repeat(64),
        'a'.repeat(64),
        ['closer: width mismatch'],
        true,
      ),
    ).toBe('awaiting-qc');
    expect(
      evaluateCarouselOutputStatus(true, 'a'.repeat(64), 'a'.repeat(64), [], true),
    ).toBe('rendered');
    expect(
      evaluateWithCardBinding(
        true,
        'a'.repeat(64),
        'a'.repeat(64),
        [],
        false,
      ),
    ).toBe('awaiting-qc');
  });
});

describe('carousel QC summary', () => {
  it('preserves card order and prefixes card-specific failures', () => {
    const packageRecord: CarouselPackageRecord = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-18T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: [
        {
          index: 0,
          clipId: 'hero',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4',
          checksumSha256: 'b'.repeat(64),
          sizeBytes: 10,
          durationSeconds: 4.5,
        },
        {
          index: 1,
          clipId: 'closer',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/02-closer.mp4',
          checksumSha256: 'c'.repeat(64),
          sizeBytes: 11,
          durationSeconds: 4.5,
        },
      ],
    };
    const report = (failures: string[]) =>
      QcReportSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-18T00:01:00.000Z',
        target: 'delivery',
        readable: true,
        approvals: {edit: true, color: true},
        renderArtifact: null,
        expected: {},
        observed: {},
        checks: [],
        warnings: [],
        failures,
      });
    const summary = summarizeCarouselQc(
      packageRecord,
      [report([]), report(['width expected 1910, observed 1920'])],
      new Date('2026-08-18T00:02:00.000Z'),
    );

    expect(summary.cards.map((card) => card.clipId)).toEqual(['hero', 'closer']);
    expect(summary.failures).toEqual([
      'closer: width expected 1910, observed 1920',
    ]);
  });

  it('binds every QC card artifact to the current package bytes', async () => {
    const qcModule = await import('../../src/media/carousel-qc');
    const carouselQcMatchesPackage = Reflect.get(qcModule, 'carouselQcMatchesPackage');
    const packageRecord: CarouselPackageRecord = {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-18T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      aspectRatio: '1.91:1',
      cards: [
        {
          index: 0,
          clipId: 'hero',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/01-hero.mp4',
          checksumSha256: 'b'.repeat(64),
          sizeBytes: 10,
          durationSeconds: 4.5,
        },
        {
          index: 1,
          clipId: 'closer',
          file: 'output/carousel/aaaaaaaaaaaaaaaa/02-closer.mp4',
          checksumSha256: 'c'.repeat(64),
          sizeBytes: 11,
          durationSeconds: 4.5,
        },
      ],
    };
    const reports = packageRecord.cards.map((card) =>
      QcReportSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-18T00:01:00.000Z',
        target: 'delivery',
        readable: true,
        approvals: {edit: true, color: true},
        renderArtifact: {
          fingerprint: packageRecord.fingerprint,
          checksumSha256: card.checksumSha256,
          sizeBytes: card.sizeBytes,
        },
        expected: {},
        observed: {},
        checks: [],
        warnings: [],
        failures: [],
      }),
    );
    const qc = summarizeCarouselQc(
      packageRecord,
      reports,
      new Date('2026-08-18T00:02:00.000Z'),
    );

    expect(carouselQcMatchesPackage).toEqual(expect.any(Function));
    if (typeof carouselQcMatchesPackage !== 'function') return;
    expect(carouselQcMatchesPackage(packageRecord, qc)).toBe(true);
    expect(
      carouselQcMatchesPackage(
        {
          ...packageRecord,
          cards: [
            {...packageRecord.cards[0], checksumSha256: 'd'.repeat(64)},
            packageRecord.cards[1],
          ],
        },
        qc,
      ),
    ).toBe(false);
  });
});
