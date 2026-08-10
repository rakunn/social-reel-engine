import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeAll, describe, expect, it} from 'vitest';
import {hashFile} from '../../src/core/hash';
import {writeJson} from '../../src/core/json';
import {analyzeSources} from '../../src/media/analyze';
import {analyzeMusic} from '../../src/media/beats';
import {generateProxies} from '../../src/media/proxy';
import {
  generateGradedStills,
  gradeSelectedClips,
  resolveClipColor,
} from '../../src/media/grade';
import {probeFile, runFfmpeg} from '../../src/media/ffmpeg';
import {approveColor, approveEdit, readApprovalStatus} from '../../src/edit/approve';
import {ingestFiles} from '../../src/project/ingest';
import {createReelProject} from '../../src/project/workspace';
import {
  expectedRenderFingerprint,
  recordRenderArtifact,
} from '../../src/render/artifacts';
import {prepareRenderProps} from '../../src/render/stage';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const identityCube = `TITLE "Identity"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;

let projectPath: string;
let originalClipPath: string;
let originalClipHash: string;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), String.raw`reel-media-o'\-`));
  projectPath = await createReelProject({
    engineRoot: repositoryRoot,
    projectsRoot: path.join(root, 'projects'),
    reelName: 'synthetic-media',
  });
  originalClipPath = path.join(root, 'DJI_SYNTHETIC.MP4');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=60:duration=2.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2.5',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    originalClipPath,
  ]);
  originalClipHash = await hashFile(originalClipPath);
  await ingestFiles(projectPath, [originalClipPath], 'clips');

  const musicPath = path.join(root, 'clicks.wav');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(lt(mod(t\\,0.5)\\,0.02)\\,0.9*sin(2*PI*1000*t)\\,0):s=22050:d=4',
    '-c:a',
    'pcm_s16le',
    musicPath,
  ]);
  await ingestFiles(projectPath, [musicPath], 'music');
}, 30_000);

const confirmSyntheticColor = async () => {
  const relativeClip = 'input/clips/DJI_SYNTHETIC.MP4';
  await writeJson(path.join(projectPath, 'config/sources.json'), {
    schemaVersion: '1.0.0',
    sources: {
      [relativeClip]: {
        manufacturer: 'Synthetic',
        model: 'Synthetic Camera',
        gamma: 'Synthetic Log',
        gamut: 'Synthetic Gamut',
        profileId: 'synthetic-log-gamut',
        confirmed: true,
      },
    },
  });
  const lutPath = path.join(projectPath, 'input/luts/technical/identity.cube');
  await writeFile(lutPath, identityCube);
  await writeJson(path.join(projectPath, 'config/luts.json'), {
    schemaVersion: '1.0.0',
    luts: [
      {
        id: 'synthetic-to-rec709',
        kind: 'technical',
        file: 'input/luts/technical/identity.cube',
        checksumSha256: await hashFile(lutPath),
        cameraModel: 'Synthetic Camera',
        profileId: 'synthetic-log-gamut',
        inputGamma: 'Synthetic Log',
        inputGamut: 'Synthetic Gamut',
        inputColorSpace: 'Synthetic Log/Synthetic Gamut',
        outputColorSpace: 'Rec.709 Gamma 2.4',
        transformSemantics: 'normalization',
        defaultMix: 1,
      },
    ],
  });
};

describe('source analysis and viewing proxies', () => {
  it('probes and checksums sources without mutating originals', async () => {
    const manifest = await analyzeSources(projectPath);
    const video = manifest.sources.find((source) => source.mediaType === 'video');
    expect(video).toEqual(
      expect.objectContaining({
        relativePath: 'input/clips/DJI_SYNTHETIC.MP4',
        checksumSha256: originalClipHash,
        camera: expect.objectContaining({confirmed: false, profileId: null}),
      }),
    );
    expect(video?.ffprobe.streams[0]).toEqual(expect.objectContaining({width: 640, height: 360}));
    expect(await hashFile(originalClipPath)).toBe(originalClipHash);
  });

  it('creates watermarked flat-log proxies, stills, and contact sheets when profile is unknown', async () => {
    const result = await generateProxies(projectPath);
    expect(result.items[0]).toEqual(
      expect.objectContaining({normalization: 'unconfirmed-watermarked', cached: false}),
    );
    const proxyPath = path.join(projectPath, result.items[0].proxy);
    const probe = await probeFile(proxyPath);
    expect(probe.streams?.[0]).toEqual(expect.objectContaining({codec_name: 'h264'}));
    expect(await hashFile(originalClipPath)).toBe(originalClipHash);
    const second = await generateProxies(projectPath);
    expect(second.items[0].cached).toBe(true);
    await writeFile(path.join(projectPath, second.items[0].representativeFrame), 'corrupt');
    const afterArtifactTamper = await generateProxies(projectPath);
    expect(afterArtifactTamper.items[0].cached).toBe(false);
    expect((await generateProxies(projectPath)).items[0].cached).toBe(true);
    const settingsPath = path.join(projectPath, 'config/settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    await writeJson(settingsPath, {
      ...settings,
      proxy: {...settings.proxy, crf: 22},
    });
    const afterConfigurationChange = await generateProxies(projectPath);
    expect(afterConfigurationChange.items[0].cached).toBe(false);
  });
});

describe('strict color gating', () => {
  it('blocks a graded still until exact profile and transform metadata are confirmed', async () => {
    const manifest = await analyzeSources(projectPath);
    const source = manifest.sources.find((entry) => entry.mediaType === 'video')!;
    expect(() => resolveClipColor(projectPath, source, {technicalLutId: null})).toThrow(
      /unconfirmed/i,
    );
    await expect(generateGradedStills(projectPath)).rejects.toThrow(/valid edit/i);
  });

  it('normalizes proxies when the LUT path contains apostrophes and backslashes', async () => {
    await confirmSyntheticColor();
    await analyzeSources(projectPath);
    expect((await generateProxies(projectPath)).items[0].normalization).toBe('technical');
  });

  it('resolves and applies a matching technical LUT after explicit confirmation', async () => {
    await confirmSyntheticColor();
    const manifest = await analyzeSources(projectPath);
    const source = manifest.sources.find((entry) => entry.mediaType === 'video')!;
    expect(resolveClipColor(projectPath, source, {technicalLutId: 'synthetic-to-rec709'})).toEqual(
      expect.objectContaining({operations: expect.arrayContaining([expect.objectContaining({type: 'technical-lut'})])}),
    );
    expect(() =>
      resolveClipColor(projectPath, source, {
        technicalLutId: 'synthetic-to-rec709',
        creativeLutId: 'not-declared',
      }),
    ).toThrow(/not declared/i);
    expect(() =>
      resolveClipColor(
        projectPath,
        {...source, camera: {...source.camera, model: 'Different Camera'}},
        {technicalLutId: 'synthetic-to-rec709'},
      ),
    ).toThrow(/camera|model/i);
    expect(() =>
      resolveClipColor(
        projectPath,
        {...source, camera: {...source.camera, gamma: 'HLG'}},
        {technicalLutId: 'synthetic-to-rec709'},
      ),
    ).toThrow(/gamma/i);
    expect(() =>
      resolveClipColor(
        projectPath,
        {...source, camera: {...source.camera, gamut: 'BT.2020'}},
        {technicalLutId: 'synthetic-to-rec709'},
      ),
    ).toThrow(/gamut/i);

    await writeJson(path.join(projectPath, 'config/sources.json'), {
      schemaVersion: '1.0.0',
      sources: {
        'input/clips/DJI_SYNTHETIC.MP4': {
          manufacturer: 'Synthetic',
          model: 'Synthetic Camera',
          gamma: 'HLG',
          gamut: 'BT.2020',
          profileId: 'synthetic-log-gamut',
          confirmed: true,
        },
      },
    });
    await analyzeSources(projectPath);
    expect((await generateProxies(projectPath)).items[0].normalization).toBe(
      'unconfirmed-watermarked',
    );
    await confirmSyntheticColor();
    await analyzeSources(projectPath);

    const lutsPath = path.join(projectPath, 'config/luts.json');
    const luts = JSON.parse(await readFile(lutsPath, 'utf8'));
    await writeJson(lutsPath, {
      ...luts,
      luts: [{...luts.luts[0], outputColorSpace: 'Display P3'}],
    });
    expect(() =>
      resolveClipColor(projectPath, source, {technicalLutId: 'synthetic-to-rec709'}),
    ).toThrow(/Rec\.709/i);
    await confirmSyntheticColor();

    const lutPath = path.join(projectPath, 'input/luts/technical/identity.cube');
    await writeFile(lutPath, `${identityCube}\n# changed`);
    await expect(generateProxies(projectPath)).rejects.toThrow(/checksum/i);
    await writeFile(lutPath, identityCube);
  });

  it('grades approved selections to reusable 10-bit ProRes intermediates', async () => {
    await confirmSyntheticColor();
    const manifest = await analyzeSources(projectPath);
    const source = manifest.sources.find((entry) => entry.mediaType === 'video')!;
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      schemaVersion: '1.0.0',
      reelName: 'synthetic-media',
      output: {width: 1080, height: 1920, fps: 30},
      clips: [
        {
          id: 'shot-1',
          sourceId: source.id,
          inSeconds: 0.25,
          outSeconds: 2.25,
          playbackRate: 1,
          crop: {
            start: {x: 0.45, y: 0.5, scale: 1},
            end: {x: 0.55, y: 0.5, scale: 1.08},
          },
          stabilization: {enabled: true, strength: 0.2, fallbackToUnstabilized: false},
          grade: {
            exposureStops: 0,
            whiteBalanceKelvin: 6500,
            tint: 0,
            technicalLutId: 'synthetic-to-rec709',
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
      captions: null,
    });
    const stagedPreview = await prepareRenderProps(projectPath, repositoryRoot, 'preview');
    expect(stagedPreview.props.trimBeforeFramesByClip?.['shot-1']).toBe(0);
    const previewStabilization = JSON.parse(
      await readFile(path.join(projectPath, 'analysis/preview-stabilization.json'), 'utf8'),
    );
    const reviewedStabilization = previewStabilization.items[0];
    expect(reviewedStabilization).toEqual(
      expect.objectContaining({
        clipId: 'shot-1',
        stabilization: 'applied',
        detectionSourceChecksumSha256: source.checksumSha256,
        transformPath: expect.stringMatching(/\.trf$/),
        transformChecksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );

    const previewPath = path.join(projectPath, 'previews/preview.mp4');
    await writeFile(previewPath, 'integration-reviewed-preview');
    await recordRenderArtifact(
      projectPath,
      'preview',
      previewPath,
      await expectedRenderFingerprint(projectPath, 'preview'),
    );
    await approveEdit(projectPath);
    const stills = await generateGradedStills(projectPath);
    expect(stills.stills).toHaveLength(1);
    await approveColor(projectPath);
    const transformPath = path.join(projectPath, reviewedStabilization.transformPath);
    const reviewedTransform = await readFile(transformPath);
    await writeFile(transformPath, Buffer.concat([reviewedTransform, Buffer.from('\n# tampered')]));
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
    await expect(gradeSelectedClips(projectPath)).rejects.toThrow(
      /stabilization|preview|checksum|approval.*stale/i,
    );
    await writeFile(transformPath, reviewedTransform);
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: true,
      colorApproved: true,
    });
    const replacementTransform = Buffer.concat([
      reviewedTransform,
      Buffer.from('\n# replacement with self-consistent report'),
    ]);
    await writeFile(transformPath, replacementTransform);
    await writeJson(path.join(projectPath, 'analysis/preview-stabilization.json'), {
      ...previewStabilization,
      items: [
        {
          ...reviewedStabilization,
          transformChecksumSha256: await hashFile(transformPath),
        },
      ],
    });
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
    await writeFile(transformPath, reviewedTransform);
    await writeJson(
      path.join(projectPath, 'analysis/preview-stabilization.json'),
      previewStabilization,
    );
    const result = await gradeSelectedClips(projectPath);
    expect(result.items[0].stabilization).toBe('applied');
    const graded = await probeFile(path.join(projectPath, result.items[0].path));
    expect(graded.streams?.[0]).toEqual(
      expect.objectContaining({codec_name: 'prores', pix_fmt: 'yuv422p10le'}),
    );
    expect(await hashFile(originalClipPath)).toBe(originalClipHash);
    expect((await gradeSelectedClips(projectPath)).items[0].cached).toBe(true);
  });
});

describe('music analysis', () => {
  it('writes deterministic duration, tempo, beat, and onset timestamps through librosa', async () => {
    const result = await analyzeMusic(projectPath, repositoryRoot);
    expect(result.durationSeconds).toBeGreaterThan(3.9);
    expect(result.tempoBpm).toBeGreaterThan(0);
    expect(result.onsetsSeconds.length).toBeGreaterThan(2);
    expect(JSON.parse(await readFile(path.join(projectPath, 'analysis/beats.json'), 'utf8'))).toEqual(
      expect.objectContaining({schemaVersion: '1.0.0'}),
    );
  });
});
