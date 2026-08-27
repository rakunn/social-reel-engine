import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  acquireProjectNameReservation,
  createReelProject,
} from '../../src/project/workspace';
import {writeJson} from '../../src/core/json';
import {hashFile} from '../../src/core/hash';
import {beginMediaOperation, completeMediaOperation} from '../../src/project/operation';
import {SourceManifestSchema, EditManifestSchema} from '../../src/contracts/schemas';
import {sourceIdFor} from '../../src/media/analyze';
import {confirmRights} from '../../src/edit/rights';
import {approveColor, approveEdit, readApprovalStatus} from '../../src/edit/approve';
import {
  expectedRenderFingerprint,
  recordRenderArtifact,
} from '../../src/render/artifacts';
import {
  createColorHash,
  createEditHash,
  createEditReviewHash,
} from '../../src/core/approvals';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const loadVariantModule = async () =>
  await import('../../src/project/variant').catch(() => null);

const writeVariantReadyEdit = async (projectPath: string, reelName: string): Promise<void> => {
  await writeJson(path.join(projectPath, 'edits/edit.json'), {
    schemaVersion: '1.0.0',
    reelName,
    output: {width: 1080, height: 1920, fps: 30},
    clips: [
      {
        id: 'hero',
        sourceId: 'video-source',
        inSeconds: 1,
        outSeconds: 5.5,
        playbackRate: 1,
        crop: {
          start: {x: 0.5, y: 0.5, scale: 1},
          end: {x: 0.5, y: 0.5, scale: 1},
        },
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: false},
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
};

describe('reel project variants', () => {
  it('does not publish over a target name reserved by another creator', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-reservation-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'reservation-source',
    });
    await writeVariantReadyEdit(sourcePath, 'reservation-source');
    const reservation = await acquireProjectNameReservation(projectsRoot, 'reserved-variant');
    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    try {
      await expect(
        module.createProjectVariant({
          engineRoot: repositoryRoot,
          projectsRoot,
          sourceName: 'reservation-source',
          targetName: 'reserved-variant',
        }),
      ).rejects.toThrow(/reserved|being created/i);
      await expect(access(path.join(projectsRoot, 'reserved-variant'))).rejects.toThrow();
    } finally {
      await reservation.release();
    }
  });

  it('rejects a symlinked analysis directory before acquiring its status lock', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-analysis-link-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'analysis-link-source',
    });
    await writeVariantReadyEdit(sourcePath, 'analysis-link-source');
    const externalAnalysisPath = path.join(temporaryRoot, 'external-analysis');
    await rename(path.join(sourcePath, 'analysis'), externalAnalysisPath);
    await symlink(externalAnalysisPath, path.join(sourcePath, 'analysis'), 'dir');

    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    await expect(
      module.createProjectVariant({
        engineRoot: repositoryRoot,
        projectsRoot,
        sourceName: 'analysis-link-source',
        targetName: 'analysis-link-variant',
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(access(path.join(projectsRoot, 'analysis-link-variant'))).rejects.toThrow();
    await expect(access(path.join(externalAnalysisPath, 'status-scan.lock'))).rejects.toThrow();
  });

  it.each(['brief.json', 'edits/edit.json'])(
    'rejects a symlinked directly-read metadata file: %s',
    async (relativePath) => {
      const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-metadata-link-'));
      const projectsRoot = path.join(temporaryRoot, 'projects');
      const sourcePath = await createReelProject({
        engineRoot: repositoryRoot,
        projectsRoot,
        reelName: 'metadata-link-source',
      });
      await writeVariantReadyEdit(sourcePath, 'metadata-link-source');
      const sourceMetadataPath = path.join(sourcePath, relativePath);
      const externalMetadataPath = path.join(
        temporaryRoot,
        `external-${relativePath.replaceAll('/', '-')}`,
      );
      await rename(sourceMetadataPath, externalMetadataPath);
      await symlink(externalMetadataPath, sourceMetadataPath, 'file');

      const module = await loadVariantModule();
      if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
      await expect(
        module.createProjectVariant({
          engineRoot: repositoryRoot,
          projectsRoot,
          sourceName: 'metadata-link-source',
          targetName: `metadata-link-${path.basename(relativePath, '.json')}`,
        }),
      ).rejects.toThrow(/symbolic link/i);
    },
  );

  it('keeps the target unpublished until its complete staged snapshot is ready', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-publication-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'atomic-source',
    });
    await writeVariantReadyEdit(sourcePath, 'atomic-source');
    await writeFile(path.join(sourcePath, 'input/clips/clip.mp4'), Buffer.alloc(1024 * 1024));

    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    let completed = false;
    const creation = module.createProjectVariant({
      engineRoot: repositoryRoot,
      projectsRoot,
      sourceName: 'atomic-source',
      targetName: 'atomic-variant',
    }).finally(() => {
      completed = true;
    });
    let sawStagingProject = false;
    let sawIncompletePublishedTarget = false;
    while (!completed) {
      const entries = await readdir(projectsRoot);
      sawStagingProject ||= entries.some((entry) =>
        entry.startsWith('.variant-atomic-variant.partial-'),
      );
      if (entries.includes('atomic-variant')) {
        try {
          await readFile(path.join(projectsRoot, 'atomic-variant/input/clips/clip.mp4'));
          const edit = JSON.parse(
            await readFile(
              path.join(projectsRoot, 'atomic-variant/edits/edit.json'),
              'utf8',
            ),
          );
          if (edit.reelName !== 'atomic-variant') sawIncompletePublishedTarget = true;
        } catch {
          sawIncompletePublishedTarget = true;
        }
      }
      await delay(0);
    }
    const result = await creation;

    expect(sawStagingProject).toBe(true);
    expect(sawIncompletePublishedTarget).toBe(false);
    await expect(access(result.targetPath)).resolves.toBeUndefined();
    expect(await readdir(projectsRoot)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.variant-atomic-variant\.partial-/)]),
    );
  });

  it('supports a target name whose unbounded staging prefix would exceed a path component', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-long-target-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'long-target-source',
    });
    await writeVariantReadyEdit(sourcePath, 'long-target-source');
    const targetName = 'v'.repeat(240);

    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    await expect(
      module.createProjectVariant({
        engineRoot: repositoryRoot,
        projectsRoot,
        sourceName: 'long-target-source',
        targetName,
        title: 'Long target variant',
      }),
    ).resolves.toEqual(
      expect.objectContaining({targetPath: path.join(projectsRoot, targetName)}),
    );
    await expect(access(path.join(projectsRoot, targetName))).resolves.toBeUndefined();
  });

  it('caps the generated variant title at the brief schema limit', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-title-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'long-title-source',
      title: 'T'.repeat(160),
    });
    await writeVariantReadyEdit(sourcePath, 'long-title-source');

    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    const result = await module.createProjectVariant({
      engineRoot: repositoryRoot,
      projectsRoot,
      sourceName: 'long-title-source',
      targetName: 'long-title-variant',
    });

    const targetBrief = JSON.parse(
      await readFile(path.join(result.targetPath, 'brief.json'), 'utf8'),
    );
    expect(targetBrief.identity.title).toBe(`${'T'.repeat(152)} variant`);
    expect(targetBrief.identity.title).toHaveLength(160);
  });

  it('rejects cached artifacts reached through a symlinked directory', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-symlink-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'symlink-source',
    });
    await writeVariantReadyEdit(sourcePath, 'symlink-source');
    const externalCache = path.join(temporaryRoot, 'external-cache');
    const externalFile = path.join(externalCache, 'escaped.mp4');
    await mkdir(externalCache, {recursive: true});
    await writeFile(externalFile, 'external-cache-bytes');
    await mkdir(path.join(sourcePath, 'work'), {recursive: true});
    await symlink(externalCache, path.join(sourcePath, 'work/proxies'));
    const relativePath = 'work/proxies/escaped.mp4';
    await writeJson(path.join(sourcePath, 'analysis/artifacts.json'), {
      schemaVersion: '1.0.0',
      artifacts: {
        escaped: {
          fingerprint: 'a'.repeat(64),
          generatedAt: '2026-08-27T00:00:00.000Z',
          files: [relativePath],
          checksums: {[relativePath]: await hashFile(externalFile)},
        },
      },
    });

    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    await expect(
      module.createProjectVariant({
        engineRoot: repositoryRoot,
        projectsRoot,
        sourceName: 'symlink-source',
        targetName: 'symlink-variant',
      }),
    ).rejects.toThrow(/symbolic link/i);
    await expect(access(path.join(projectsRoot, 'symlink-variant'))).rejects.toThrow();
  });

  it('creates an isolated derivative that preserves inputs, source facts, edit corrections, and LUT choices', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'approved-source',
      title: 'Approved Source',
      format: 'carousel-1.91:1',
      now: new Date('2026-08-26T00:00:00.000Z'),
    });
    await writeFile(path.join(sourcePath, 'input/clips/clip.mp4'), 'immutable-source-bytes');
    await writeJson(path.join(sourcePath, 'config/sources.json'), {
      schemaVersion: '1.0.0',
      sources: {
        'input/clips/clip.mp4': {
          manufacturer: 'DJI',
          model: 'DJI Mini 4 Pro',
          gamma: 'D-Log M',
          gamut: 'DJI D-Log M',
          profileId: 'dji-mini-4-pro-d-log-m',
          confirmed: true,
        },
      },
    });
    await writeJson(path.join(sourcePath, 'config/luts.json'), {
      schemaVersion: '1.0.0',
      luts: [{id: 'approved-look', kind: 'creative'}],
    });
    await writeJson(path.join(sourcePath, 'edits/edit.json'), {
      schemaVersion: '1.0.0',
      reelName: 'approved-source',
      output: {width: 1910, height: 1000, fps: 30},
      clips: [
        {
          id: 'hero',
          sourceId: 'video-source',
          inSeconds: 1,
          outSeconds: 5.5,
          playbackRate: 1,
          crop: {
            start: {x: 0.5, y: 0.5, scale: 1},
            end: {x: 0.5, y: 0.5, scale: 1},
          },
          stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: false},
          grade: {
            exposureStops: 0.35,
            whiteBalanceKelvin: 6500,
            tint: 0.02,
            technicalLutId: 'approved-normalizer',
            creativeLutId: 'approved-look',
            combinedLutId: null,
            creativeMix: 0.35,
          },
          audio: {muted: true, gainDb: -60},
          textOverlay: null,
          transitionAfter: {type: 'none', durationSeconds: 0},
        },
        {
          id: 'closer',
          sourceId: 'video-source',
          inSeconds: 1,
          outSeconds: 5.5,
          playbackRate: 1,
          crop: {
            start: {x: 0.5, y: 0.5, scale: 1},
            end: {x: 0.5, y: 0.5, scale: 1},
          },
          stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: false},
          grade: {
            exposureStops: 0.15,
            whiteBalanceKelvin: 6500,
            tint: 0,
            technicalLutId: 'approved-normalizer',
            creativeLutId: 'approved-look',
            combinedLutId: null,
            creativeMix: 0.35,
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
    await writeJson(path.join(sourcePath, 'analysis/sources.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-26T00:00:00.000Z',
      sources: [],
    });
    const proxyFiles = [
      'work/proxies/video-source.mp4',
      'analysis/frames/video-source.jpg',
      'analysis/contact-sheets/video-source.jpg',
    ];
    for (const [index, relativePath] of proxyFiles.entries()) {
      const filePath = path.join(sourcePath, relativePath);
      await mkdir(path.dirname(filePath), {recursive: true});
      await writeFile(filePath, `cached-proxy-artifact-${index}`);
    }
    const tamperedProxy = 'work/proxies/tampered.mp4';
    await writeFile(path.join(sourcePath, tamperedProxy), 'tampered-proxy-artifact');
    await writeFile(path.join(sourcePath, 'previews/preview.mp4'), 'source-preview');
    await writeFile(path.join(sourcePath, 'output/delivery.mp4'), 'source-output');
    await writeJson(path.join(sourcePath, 'analysis/artifacts.json'), {
      schemaVersion: '1.0.0',
      artifacts: {
        'proxy:video-source': {
          fingerprint: 'a'.repeat(64),
          generatedAt: '2026-08-26T00:10:00.000Z',
          files: proxyFiles,
          checksums: Object.fromEntries(
            await Promise.all(
              proxyFiles.map(async (relativePath) => [
                relativePath,
                await hashFile(path.join(sourcePath, relativePath)),
              ]),
            ),
          ),
        },
        'proxy:tampered': {
          fingerprint: 'b'.repeat(64),
          generatedAt: '2026-08-26T00:10:00.000Z',
          files: [tamperedProxy],
          checksums: {[tamperedProxy]: '0'.repeat(64)},
        },
        'render:delivery': {
          fingerprint: 'c'.repeat(64),
          generatedAt: '2026-08-26T00:10:00.000Z',
          files: ['output/delivery.mp4'],
          checksums: {
            'output/delivery.mp4': await hashFile(
              path.join(sourcePath, 'output/delivery.mp4'),
            ),
          },
        },
      },
    });
    await writeJson(path.join(sourcePath, 'analysis/proxies.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-26T00:10:00.000Z',
      items: [],
    });
    await writeFile(path.join(sourcePath, 'input/music/track.wav'), 'music-bytes');
    await writeJson(path.join(sourcePath, 'analysis/beats.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-26T00:10:00.000Z',
      relativePath: 'input/music/track.wav',
      checksumSha256: await hashFile(path.join(sourcePath, 'input/music/track.wav')),
      analyzer: 'librosa-0.11.0',
      analyzerImplementationSha256: 'd'.repeat(64),
      durationSeconds: 10,
      sampleRate: 48000,
      tempoBpm: 90,
      beatsSeconds: [0.5, 1.5],
      onsetsSeconds: [0.25, 0.75],
    });

    const module = await loadVariantModule();
    expect(module?.createProjectVariant).toBeTypeOf('function');
    if (!module?.createProjectVariant) return;

    const result = await module.createProjectVariant({
      engineRoot: repositoryRoot,
      projectsRoot,
      sourceName: 'approved-source',
      targetName: 'approved-source-captioned',
      title: 'Approved Source — Captioned',
      now: new Date('2026-08-26T01:00:00.000Z'),
    });

    expect(result.sourcePath).toBe(sourcePath);
    expect(await readFile(path.join(result.targetPath, 'input/clips/clip.mp4'), 'utf8')).toBe(
      'immutable-source-bytes',
    );
    expect(
      JSON.parse(await readFile(path.join(result.targetPath, 'config/sources.json'), 'utf8')),
    ).toEqual(
      expect.objectContaining({
        sources: expect.objectContaining({
          'input/clips/clip.mp4': expect.objectContaining({confirmed: true}),
        }),
      }),
    );
    const targetEdit = JSON.parse(
      await readFile(path.join(result.targetPath, 'edits/edit.json'), 'utf8'),
    );
    expect(targetEdit.reelName).toBe('approved-source-captioned');
    expect(targetEdit.clips.map((clip: {grade: unknown}) => clip.grade)).toEqual([
      expect.objectContaining({exposureStops: 0.35, creativeLutId: 'approved-look'}),
      expect.objectContaining({exposureStops: 0.15, creativeLutId: 'approved-look'}),
    ]);
    const targetBrief = JSON.parse(
      await readFile(path.join(result.targetPath, 'brief.json'), 'utf8'),
    );
    expect(targetBrief.identity).toEqual({
      reelName: 'approved-source-captioned',
      title: 'Approved Source — Captioned',
      createdAt: '2026-08-26T01:00:00.000Z',
    });
    const targetApprovals = JSON.parse(
      await readFile(path.join(result.targetPath, 'analysis/approvals.json'), 'utf8'),
    );
    expect(targetApprovals).toEqual({schemaVersion: '1.0.0', edit: null, color: null});
    expect(
      JSON.parse(await readFile(path.join(result.targetPath, 'analysis/artifacts.json'), 'utf8')),
    ).toEqual(
      expect.objectContaining({
        artifacts: {
          'proxy:video-source': expect.objectContaining({files: proxyFiles}),
        },
      }),
    );
    await expect(access(path.join(result.targetPath, proxyFiles[0]))).resolves.toBeUndefined();
    await expect(access(path.join(result.targetPath, tamperedProxy))).rejects.toThrow();
    await expect(access(path.join(result.targetPath, 'previews/preview.mp4'))).rejects.toThrow();
    await expect(access(path.join(result.targetPath, 'output/delivery.mp4'))).rejects.toThrow();
    await expect(access(path.join(result.targetPath, 'analysis/beats.json'))).resolves.toBeUndefined();
    expect(await readFile(path.join(sourcePath, 'output/delivery.mp4'), 'utf8')).toBe(
      'source-output',
    );
  });

  it('refuses to snapshot a source project while media work is active', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-active-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'active-source',
    });
    const active = await beginMediaOperation(sourcePath, 'proxy', {
      phase: 'transcoding-proxies',
    });
    const module = await loadVariantModule();
    expect(module?.createProjectVariant).toBeTypeOf('function');
    if (!module?.createProjectVariant) return;
    try {
      await expect(
        module.createProjectVariant({
          engineRoot: repositoryRoot,
          projectsRoot,
          sourceName: 'active-source',
          targetName: 'unsafe-snapshot',
        }),
      ).rejects.toThrow(/active media|media work/i);
      await expect(access(path.join(projectsRoot, 'unsafe-snapshot'))).rejects.toThrow();
    } finally {
      if (active.id) await completeMediaOperation(sourcePath, active.id);
      await rm(temporaryRoot, {recursive: true, force: true});
    }
  });

  it('preserves exact rights and color review while requiring a new rough approval', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'reel-variant-approved-'));
    const projectsRoot = path.join(temporaryRoot, 'projects');
    const sourcePath = await createReelProject({
      engineRoot: repositoryRoot,
      projectsRoot,
      reelName: 'approved-color-source',
      title: 'Approved Color Source',
      format: 'carousel-1.91:1',
      now: new Date('2026-08-26T00:00:00.000Z'),
    });
    const clipPath = path.join(sourcePath, 'input/clips/clip.mp4');
    const lutPath = path.join(sourcePath, 'input/luts/technical/identity.cube');
    await writeFile(clipPath, 'synthetic-video-bytes');
    await writeFile(lutPath, 'synthetic-lut-bytes');
    const clipChecksum = await hashFile(clipPath);
    const lutChecksum = await hashFile(lutPath);
    const sourceId = sourceIdFor('video', 'input/clips/clip.mp4', clipChecksum);
    const camera = {
      manufacturer: 'Synthetic',
      model: 'Camera',
      gamma: 'Log',
      gamut: 'Wide',
      profileId: 'synthetic-log',
      confirmed: true,
    } as const;
    await writeJson(path.join(sourcePath, 'config/sources.json'), {
      schemaVersion: '1.0.0',
      sources: {'input/clips/clip.mp4': camera},
    });
    const lut = {
      id: 'synthetic-technical',
      kind: 'technical' as const,
      file: 'input/luts/technical/identity.cube',
      checksumSha256: lutChecksum,
      cameraModel: 'Camera',
      profileId: 'synthetic-log',
      inputGamma: 'Log',
      inputGamut: 'Wide',
      inputColorSpace: 'Log/Wide',
      outputColorSpace: 'Rec.709 Gamma 2.4',
      transformSemantics: 'normalization' as const,
      defaultMix: 1,
    };
    await writeJson(path.join(sourcePath, 'config/luts.json'), {
      schemaVersion: '1.0.0',
      luts: [lut],
    });
    const sourceManifest = SourceManifestSchema.parse({
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-26T00:00:00.000Z',
      sources: [
        {
          id: sourceId,
          relativePath: 'input/clips/clip.mp4',
          checksumSha256: clipChecksum,
          sizeBytes: Buffer.byteLength('synthetic-video-bytes'),
          mediaType: 'video',
          ffprobe: {
            format: {duration: '30'},
            streams: [{codec_type: 'video', avg_frame_rate: '30/1'}],
          },
          camera,
        },
      ],
    });
    await writeJson(path.join(sourcePath, 'analysis/sources.json'), sourceManifest);
    const edit = EditManifestSchema.parse({
      schemaVersion: '1.0.0',
      reelName: 'approved-color-source',
      output: {width: 1910, height: 1000, fps: 30},
      clips: [
        {
          id: 'hero',
          sourceId,
          inSeconds: 2,
          outSeconds: 6.5,
          playbackRate: 1,
          crop: {
            start: {x: 0.5, y: 0.5, scale: 1},
            end: {x: 0.5, y: 0.5, scale: 1},
          },
          stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
          grade: {
            exposureStops: 0.25,
            whiteBalanceKelvin: 6500,
            tint: 0,
            technicalLutId: lut.id,
            creativeLutId: null,
            combinedLutId: null,
            creativeMix: 0,
          },
          audio: {muted: true, gainDb: 0},
          textOverlay: null,
          transitionAfter: {type: 'none', durationSeconds: 0},
        },
        {
          id: 'closer',
          sourceId,
          inSeconds: 8,
          outSeconds: 12.5,
          playbackRate: 1,
          crop: {
            start: {x: 0.5, y: 0.5, scale: 1},
            end: {x: 0.5, y: 0.5, scale: 1},
          },
          stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
          grade: {
            exposureStops: 0.15,
            whiteBalanceKelvin: 6500,
            tint: 0,
            technicalLutId: lut.id,
            creativeLutId: null,
            combinedLutId: null,
            creativeMix: 0,
          },
          audio: {muted: true, gainDb: 0},
          textOverlay: null,
          transitionAfter: {type: 'none', durationSeconds: 0},
        },
      ],
      titles: [],
      music: null,
      captions: null,
    });
    await writeJson(path.join(sourcePath, 'edits/edit.json'), edit);
    const rights = await confirmRights(sourcePath, new Date('2026-08-26T00:01:00.000Z'));
    const previewPath = path.join(sourcePath, 'previews/preview.mp4');
    await writeFile(previewPath, 'source-reviewed-preview');
    const previewRecord = await recordRenderArtifact(
      sourcePath,
      'preview',
      previewPath,
      await expectedRenderFingerprint(sourcePath, 'preview'),
      new Date('2026-08-26T00:02:00.000Z'),
    );
    const stillPaths = [
      path.join(sourcePath, 'previews/graded-stills/hero.png'),
      path.join(sourcePath, 'previews/graded-stills/closer.png'),
    ];
    await mkdir(path.dirname(stillPaths[0]), {recursive: true});
    await writeFile(stillPaths[0], 'source-reviewed-color-still-hero');
    await writeFile(stillPaths[1], 'source-reviewed-color-still-closer');
    await writeJson(path.join(sourcePath, 'analysis/graded-stills.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-26T00:02:00.000Z',
      editManifestHash: createEditHash(edit),
      editReviewHash: createEditReviewHash(createEditHash(edit), previewRecord),
      colorManifestHash: createColorHash(edit, [lut], sourceManifest.sources),
      stills: [
        'previews/graded-stills/hero.png',
        'previews/graded-stills/closer.png',
      ],
      checksums: {
        'previews/graded-stills/hero.png': await hashFile(stillPaths[0]),
        'previews/graded-stills/closer.png': await hashFile(stillPaths[1]),
      },
    });
    await approveEdit(sourcePath, new Date('2026-08-26T00:03:00.000Z'));
    const sourceApprovals = await approveColor(
      sourcePath,
      new Date('2026-08-26T00:04:00.000Z'),
    );
    const gradedClipPath = 'work/graded/hero-cached.mov';
    await mkdir(path.join(sourcePath, 'work/graded'), {recursive: true});
    await writeFile(path.join(sourcePath, gradedClipPath), 'approved-graded-hero');
    await writeJson(path.join(sourcePath, 'analysis/graded-clips.json'), {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-26T00:04:00.000Z',
      editHash: createEditHash(edit),
      colorHash: sourceApprovals.color?.colorHash,
      items: [
        {
          clipId: 'hero',
          sourceId,
          path: gradedClipPath,
          checksumSha256: await hashFile(path.join(sourcePath, gradedClipPath)),
          fingerprint: 'c'.repeat(64),
          cached: false,
          stabilization: 'disabled',
        },
      ],
    });

    const module = await loadVariantModule();
    if (!module?.createProjectVariant) throw new Error('Variant module is unavailable');
    const result = await module.createProjectVariant({
      engineRoot: repositoryRoot,
      projectsRoot,
      sourceName: 'approved-color-source',
      targetName: 'approved-color-captioned',
      now: new Date('2026-08-26T01:00:00.000Z'),
    });

    const targetBrief = JSON.parse(
      await readFile(path.join(result.targetPath, 'brief.json'), 'utf8'),
    );
    expect(targetBrief).toEqual(
      expect.objectContaining({rightsConfirmed: true, rightsConfirmation: rights}),
    );
    const targetApprovals = JSON.parse(
      await readFile(path.join(result.targetPath, 'analysis/approvals.json'), 'utf8'),
    );
    expect(targetApprovals.edit).toBeNull();
    expect(targetApprovals.color).toEqual(sourceApprovals.color);
    await expect(
      access(path.join(result.targetPath, 'previews/graded-stills/hero.png')),
    ).resolves.toBeUndefined();
    await expect(access(path.join(result.targetPath, gradedClipPath))).resolves.toBeUndefined();
    expect(
      JSON.parse(
        await readFile(path.join(result.targetPath, 'analysis/graded-clips.json'), 'utf8'),
      ).items,
    ).toEqual([
      expect.objectContaining({
        clipId: 'hero',
        path: gradedClipPath,
        checksumSha256: await hashFile(path.join(result.targetPath, gradedClipPath)),
      }),
    ]);

    const targetPreviewPath = path.join(result.targetPath, 'previews/preview.mp4');
    await writeFile(targetPreviewPath, 'target-reviewed-preview');
    await recordRenderArtifact(
      result.targetPath,
      'preview',
      targetPreviewPath,
      await expectedRenderFingerprint(result.targetPath, 'preview'),
      new Date('2026-08-26T01:01:00.000Z'),
    );
    await approveEdit(result.targetPath, new Date('2026-08-26T01:02:00.000Z'));
    await expect(readApprovalStatus(result.targetPath)).resolves.toEqual({
      editApproved: true,
      colorApproved: true,
    });
  });
});
