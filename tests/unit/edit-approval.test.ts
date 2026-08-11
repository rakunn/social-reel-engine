import {mkdir, mkdtemp, readFile, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  LutDefinitionSchema,
  SourceManifestSchema,
} from '../../src/contracts/schemas';
import {
  createColorHash,
  createEditHash,
  createEditReviewHash,
} from '../../src/core/approvals';
import {hashFile} from '../../src/core/hash';
import {writeJson} from '../../src/core/json';
import {
  approveColor,
  approveEdit,
  assertFinalReadiness,
  assertRenderApprovals,
  readApprovalStatus,
} from '../../src/edit/approve';
import {validateEdit} from '../../src/edit/validate';
import {confirmRights, readRightsConfirmationStatus} from '../../src/edit/rights';
import {sourceIdFor} from '../../src/media/analyze';
import {createSourceIntegrityContext} from '../../src/media/source-integrity';
import {
  expectedRenderFingerprint,
  readRenderArtifactFreshness,
  recordRenderArtifact,
} from '../../src/render/artifacts';
import {getProjectStatus} from '../../src/project/workspace';

const makeFixture = async () => {
  const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-approval-'));
  await Promise.all(
    [
      'input/clips',
      'input/music',
      'input/captions',
      'input/luts/technical',
      'input/luts/creative',
      'input/fonts',
      'input/brand',
      'config',
      'analysis',
      'edits',
      'previews',
    ].map((directory) =>
      import('node:fs/promises').then(({mkdir}) =>
        mkdir(path.join(projectPath, directory), {recursive: true}),
      ),
    ),
  );
  const clipPath = path.join(projectPath, 'input/clips/clip.mp4');
  const alternateClipPath = path.join(projectPath, 'input/clips/alternate.mp4');
  const lutPath = path.join(projectPath, 'input/luts/technical/identity.cube');
  const creativeLutPath = path.join(projectPath, 'input/luts/creative/look.cube');
  await writeFile(clipPath, 'synthetic-media-marker');
  await writeFile(alternateClipPath, 'alternate-media-marker');
  await writeFile(lutPath, 'synthetic-lut-marker');
  await writeFile(creativeLutPath, 'synthetic-creative-lut-marker');
  const clipChecksum = await hashFile(clipPath);
  const alternateClipChecksum = await hashFile(alternateClipPath);
  const technicalLutChecksum = await hashFile(lutPath);
  const creativeLutChecksum = await hashFile(creativeLutPath);
  const sourceId = sourceIdFor('video', 'input/clips/clip.mp4', clipChecksum);
  const camera = {
    manufacturer: 'Synthetic',
    model: 'Camera',
    gamma: 'Log',
    gamut: 'Wide',
    profileId: 'synthetic-log',
    confirmed: true,
  } as const;
  const sources = SourceManifestSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: '2026-08-10T00:00:00.000Z',
    sources: [
      {
        id: sourceId,
        relativePath: 'input/clips/clip.mp4',
        checksumSha256: clipChecksum,
        sizeBytes: Buffer.byteLength('synthetic-media-marker'),
        mediaType: 'video',
        ffprobe: {
          format: {duration: '30'},
          streams: [{codec_type: 'video', avg_frame_rate: '30/1'}],
        },
        camera,
      },
      {
        id: sourceIdFor('video', 'input/clips/alternate.mp4', alternateClipChecksum),
        relativePath: 'input/clips/alternate.mp4',
        checksumSha256: alternateClipChecksum,
        sizeBytes: Buffer.byteLength('alternate-media-marker'),
        mediaType: 'video',
        ffprobe: {
          format: {duration: '30'},
          streams: [{codec_type: 'video', avg_frame_rate: '30/1'}],
        },
        camera,
      },
      {
        id: sourceIdFor('lut', 'input/luts/technical/identity.cube', technicalLutChecksum),
        relativePath: 'input/luts/technical/identity.cube',
        checksumSha256: technicalLutChecksum,
        sizeBytes: Buffer.byteLength('synthetic-lut-marker'),
        mediaType: 'lut',
        ffprobe: {format: {}, streams: []},
        camera: {confirmed: false, profileId: null},
      },
      {
        id: sourceIdFor('lut', 'input/luts/creative/look.cube', creativeLutChecksum),
        relativePath: 'input/luts/creative/look.cube',
        checksumSha256: creativeLutChecksum,
        sizeBytes: Buffer.byteLength('synthetic-creative-lut-marker'),
        mediaType: 'lut',
        ffprobe: {format: {}, streams: []},
        camera: {confirmed: false, profileId: null},
      },
    ],
  });
  const luts = {
    schemaVersion: '1.0.0',
    luts: [
      {
        id: 'synthetic-technical',
        kind: 'technical',
        file: 'input/luts/technical/identity.cube',
        checksumSha256: technicalLutChecksum,
        cameraModel: 'Camera',
        profileId: 'synthetic-log',
        inputGamma: 'Log',
        inputGamut: 'Wide',
        inputColorSpace: 'Log/Wide',
        outputColorSpace: 'Rec.709 Gamma 2.4',
        transformSemantics: 'normalization',
        defaultMix: 1,
      },
      {
        id: 'synthetic-creative',
        kind: 'creative',
        file: 'input/luts/creative/look.cube',
        checksumSha256: creativeLutChecksum,
        cameraModel: null,
        profileId: null,
        inputColorSpace: 'Rec.709',
        outputColorSpace: 'Rec.709',
        transformSemantics: 'look',
        defaultMix: 0.35,
      },
    ],
  };
  const edit = EditManifestSchema.parse({
    schemaVersion: '1.0.0',
    reelName: 'approval-test',
    output: {width: 1080, height: 1920, fps: 30},
    clips: [
      {
        id: 'shot-1',
        sourceId,
        inSeconds: 2,
        outSeconds: 27,
        playbackRate: 1,
        crop: {
          start: {x: 0.5, y: 0.5, scale: 1},
          end: {x: 0.55, y: 0.5, scale: 1.08},
        },
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
        grade: {
          exposureStops: 0,
          whiteBalanceKelvin: 6500,
          tint: 0,
          technicalLutId: 'synthetic-technical',
          creativeLutId: 'synthetic-creative',
          combinedLutId: null,
          creativeMix: 0.35,
        },
        audio: {muted: true, gainDb: 0},
        transitionAfter: {type: 'none', durationSeconds: 0},
      },
    ],
    titles: [],
    music: null,
    captions: null,
  });
  const parsedLuts = luts.luts.map((lut) => LutDefinitionSchema.parse(lut));
  await writeJson(path.join(projectPath, 'analysis/sources.json'), sources);
  await writeJson(path.join(projectPath, 'brief.json'), {
    schemaVersion: '1.0.0',
    identity: {
      reelName: 'approval-test',
      title: 'Approval Test',
      createdAt: '2026-08-10T00:00:00.000Z',
    },
    target: {minSeconds: 20, idealSeconds: 25, maxSeconds: 30},
    output: {width: 1080, height: 1920, fps: 30},
    style: 'cinematic-minimal',
    options: {music: false, captions: false, cameraAudio: false},
    rightsConfirmed: true,
    notes: '',
  });
  await writeJson(path.join(projectPath, 'analysis/approvals.json'), {
    schemaVersion: '1.0.0',
    edit: null,
    color: null,
  });
  await writeJson(path.join(projectPath, 'config/sources.json'), {
    schemaVersion: '1.0.0',
    sources: {
      'input/clips/clip.mp4': camera,
      'input/clips/alternate.mp4': camera,
    },
  });
  await writeJson(path.join(projectPath, 'config/settings.json'), {
    schemaVersion: '1.0.0',
    proxy: {width: 540, height: 960, crf: 23},
    preview: {width: 540, height: 960, crf: 20},
    master: {},
    delivery: {},
  });
  await writeJson(path.join(projectPath, 'config/luts.json'), luts);
  await writeJson(path.join(projectPath, 'edits/edit.json'), edit);
  await confirmRights(projectPath, new Date('2026-08-10T00:00:00.000Z'));
  const previewPath = path.join(projectPath, 'previews/preview.mp4');
  await writeFile(previewPath, 'reviewed-rough-cut-preview');
  const previewRecord = await recordRenderArtifact(
    projectPath,
    'preview',
    previewPath,
    await expectedRenderFingerprint(projectPath, 'preview'),
    new Date('2026-08-10T00:00:00.000Z'),
  );
  const editReviewHash = createEditReviewHash(createEditHash(edit), previewRecord);
  const stillPath = path.join(projectPath, 'previews/graded-stills/shot-1.png');
  await import('node:fs/promises').then(({mkdir}) =>
    mkdir(path.dirname(stillPath), {recursive: true}),
  );
  await writeFile(stillPath, 'reviewed-reference-frame');
  await writeJson(path.join(projectPath, 'analysis/graded-stills.json'), {
    schemaVersion: '1.0.0',
    generatedAt: '2026-08-10T00:00:00.000Z',
    editManifestHash: createEditHash(edit),
    editReviewHash,
    colorManifestHash: createColorHash(edit, parsedLuts),
    stills: ['previews/graded-stills/shot-1.png'],
    checksums: {
      'previews/graded-stills/shot-1.png': await hashFile(stillPath),
    },
  });
  return {projectPath, edit, creativeLutPath, sourceId};
};

const addAnalyzedInput = async (
  projectPath: string,
  relativePath: string,
  contents: string,
  mediaType: 'audio' | 'caption' | 'font',
) => {
  const filePath = path.join(projectPath, relativePath);
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, contents);
  const checksumSha256 = await hashFile(filePath);
  const entry = {
    id: sourceIdFor(mediaType, relativePath, checksumSha256),
    relativePath,
    checksumSha256,
    sizeBytes: Buffer.byteLength(contents),
    mediaType,
    ffprobe:
      mediaType === 'audio'
        ? {
            format: {duration: '30'},
            streams: [{codec_type: 'audio', duration: '30'}],
          }
        : {format: {}, streams: []},
    camera: {
      manufacturer: null,
      model: null,
      gamma: null,
      gamut: null,
      profileId: null,
      confirmed: false,
    },
  };
  const manifestPath = path.join(projectPath, 'analysis/sources.json');
  const manifest = SourceManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  await writeJson(
    manifestPath,
    SourceManifestSchema.parse({...manifest, sources: [...manifest.sources, entry]}),
  );
  return entry;
};

const recordFinalArtifacts = async (projectPath: string) => {
  const outputDirectory = path.join(projectPath, 'output');
  await mkdir(outputDirectory, {recursive: true});
  const masterPath = path.join(outputDirectory, 'master.mov');
  const deliveryPath = path.join(outputDirectory, 'delivery.mp4');
  await writeFile(masterPath, 'current-master');
  await recordRenderArtifact(
    projectPath,
    'master',
    masterPath,
    await expectedRenderFingerprint(projectPath, 'master'),
  );
  await writeFile(deliveryPath, 'current-delivery');
  await recordRenderArtifact(
    projectPath,
    'delivery',
    deliveryPath,
    await expectedRenderFingerprint(projectPath, 'delivery'),
  );
  return {masterPath, deliveryPath};
};

describe('edit validation', () => {
  it('checks missing media, bounds, frame-safe playback, transitions, and target duration', async () => {
    const {projectPath, edit} = await makeFixture();
    const result = await validateEdit(projectPath, edit);
    expect(result).toEqual(
      expect.objectContaining({valid: true, durationSeconds: 25, failures: []}),
    );
    const unsafe = EditManifestSchema.parse({
      ...edit,
      clips: [{...edit.clips[0], playbackRate: 0.5}],
    });
    expect((await validateEdit(projectPath, unsafe)).failures).toContainEqual(
      expect.stringMatching(/frame synthesis/i),
    );
  });

  it('uses the project brief duration target instead of a fixed 20–30 second range', async () => {
    const {projectPath, edit} = await makeFixture();
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(
      await import('node:fs/promises').then(({readFile}) => readFile(briefPath, 'utf8')),
    );
    await writeJson(briefPath, {
      ...brief,
      target: {minSeconds: 12, idealSeconds: 12.5, maxSeconds: 13},
    });
    const onTarget = {
      ...edit,
      clips: [{...edit.clips[0], outSeconds: 14.5}],
    };
    expect((await validateEdit(projectPath, onTarget)).warnings).toEqual([]);

    const outsideTarget = {
      ...edit,
      clips: [{...edit.clips[0], outSeconds: 22}],
    };
    expect((await validateEdit(projectPath, outsideTarget)).warnings).toEqual([
      expect.stringMatching(/12.*13/),
    ]);
  });

  it('reuses a supplied verified-input context across validation calls', async () => {
    const {projectPath, edit} = await makeFixture();
    const integrity = createSourceIntegrityContext();

    await expect(validateEdit(projectPath, edit, {integrity})).resolves.toMatchObject({valid: true});
    const firstSnapshot = integrity.snapshot;
    await expect(validateEdit(projectPath, edit, {integrity})).resolves.toMatchObject({valid: true});

    expect(firstSnapshot).not.toBeNull();
    expect(integrity.snapshot).toBe(firstSnapshot);
  });
});

describe('hash-bound approvals', () => {
  it('makes rights confirmation stale when the referenced asset set changes', async () => {
    const {projectPath, edit} = await makeFixture();
    const confirmation = await confirmRights(
      projectPath,
      new Date('2026-08-10T00:01:00.000Z'),
    );
    expect(JSON.parse(await readFile(path.join(projectPath, 'brief.json'), 'utf8'))).toEqual(
      expect.objectContaining({rightsConfirmed: true, rightsConfirmation: confirmation}),
    );
    expect((await readRightsConfirmationStatus(projectPath)).confirmed).toBe(true);

    const manifest = SourceManifestSchema.parse(
      JSON.parse(await readFile(path.join(projectPath, 'analysis/sources.json'), 'utf8')),
    );
    const alternate = manifest.sources.find(
      (source) => source.relativePath === 'input/clips/alternate.mp4',
    );
    if (!alternate) throw new Error('Fixture alternate source is missing');
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      clips: [{...edit.clips[0], sourceId: alternate.id}],
    });

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        confirmed: false,
        reason: expect.stringMatching(/asset set.*changed|changed.*asset set/i),
      }),
    );
  });

  it('makes rights confirmation stale when selected music changes', async () => {
    const {projectPath, edit} = await makeFixture();
    const first = await addAnalyzedInput(
      projectPath,
      'input/music/first.wav',
      'first-music-bytes',
      'audio',
    );
    const second = await addAnalyzedInput(
      projectPath,
      'input/music/second.wav',
      'second-music-bytes',
      'audio',
    );
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {
      ...brief,
      options: {...brief.options, music: true},
    });
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      music: {sourceId: first.id, startSeconds: 0, gainDb: -8},
    });
    await confirmRights(projectPath);

    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      music: {sourceId: second.id, startSeconds: 0, gainDb: -8},
    });

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: false, reason: expect.stringMatching(/asset set/i)}),
    );
  });

  it('makes rights confirmation stale when selected captions change', async () => {
    const {projectPath, edit} = await makeFixture();
    await addAnalyzedInput(
      projectPath,
      'input/captions/first.srt',
      '1\n00:00:00,000 --> 00:00:01,000\nFirst caption\n',
      'caption',
    );
    await addAnalyzedInput(
      projectPath,
      'input/captions/second.srt',
      '1\n00:00:00,000 --> 00:00:01,000\nSecond caption\n',
      'caption',
    );
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {
      ...brief,
      options: {...brief.options, captions: true},
    });
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      captions: {relativePath: 'input/captions/first.srt', format: 'srt'},
    });
    await confirmRights(projectPath);

    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      captions: {relativePath: 'input/captions/second.srt', format: 'srt'},
    });

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: false, reason: expect.stringMatching(/asset set/i)}),
    );
  });

  it('makes rights confirmation stale when the active custom font changes', async () => {
    const {projectPath} = await makeFixture();
    await addAnalyzedInput(
      projectPath,
      'input/fonts/B-Director.ttf',
      'first-font-bytes',
      'font',
    );
    await confirmRights(projectPath);

    await addAnalyzedInput(
      projectPath,
      'input/fonts/A-Director.ttf',
      'replacement-font-bytes',
      'font',
    );

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: false, reason: expect.stringMatching(/asset set/i)}),
    );
  });

  it('makes rights confirmation stale when a selected LUT is removed', async () => {
    const {projectPath, edit} = await makeFixture();
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      clips: [
        {
          ...edit.clips[0],
          grade: {
            ...edit.clips[0].grade,
            creativeLutId: null,
            creativeMix: 0,
          },
        },
      ],
    });

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: false, reason: expect.stringMatching(/asset set/i)}),
    );
  });

  it('keeps rights confirmation current when edit details change without changing assets', async () => {
    const {projectPath, edit} = await makeFixture();
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      clips: [{...edit.clips[0], inSeconds: 3, outSeconds: 26}],
    });

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: true, reason: null}),
    );
  });

  it('keeps rights confirmation current when only unreferenced footage changes', async () => {
    const {projectPath} = await makeFixture();
    const alternatePath = path.join(projectPath, 'input/clips/alternate.mp4');
    const alternateBytes = 'changed-but-still-unreferenced-media';
    await writeFile(alternatePath, alternateBytes);
    const alternateChecksum = await hashFile(alternatePath);
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const alternate = manifest.sources.find(
      (source: {relativePath: string}) =>
        source.relativePath === 'input/clips/alternate.mp4',
    );
    Object.assign(alternate, {
      id: sourceIdFor('video', 'input/clips/alternate.mp4', alternateChecksum),
      checksumSha256: alternateChecksum,
      sizeBytes: Buffer.byteLength(alternateBytes),
    });
    await writeJson(manifestPath, manifest);

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: true, reason: null}),
    );
  });

  it('keeps rights confirmation current for unreferenced music, LUT, and brand inputs', async () => {
    const {projectPath} = await makeFixture();
    await addAnalyzedInput(
      projectPath,
      'input/music/unused.wav',
      'unused-music-bytes',
      'audio',
    );
    const unusedLutPath = path.join(projectPath, 'input/luts/creative/unused.cube');
    await writeFile(unusedLutPath, 'unused-lut-bytes');
    const lutsPath = path.join(projectPath, 'config/luts.json');
    const luts = JSON.parse(await readFile(lutsPath, 'utf8'));
    await writeJson(lutsPath, {
      ...luts,
      luts: [
        ...luts.luts,
        {
          id: 'unused-creative',
          kind: 'creative',
          file: 'input/luts/creative/unused.cube',
          checksumSha256: await hashFile(unusedLutPath),
          cameraModel: null,
          profileId: null,
          inputColorSpace: 'Rec.709',
          outputColorSpace: 'Rec.709',
          transformSemantics: 'look',
          defaultMix: 0.25,
        },
      ],
    });
    await writeFile(path.join(projectPath, 'input/brand/unused-logo.svg'), '<svg/>');

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({confirmed: true, reason: null}),
    );
  });

  it('does not accept a legacy true Boolean without an asset fingerprint', async () => {
    const {projectPath} = await makeFixture();
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {...brief, rightsConfirmed: true, rightsConfirmation: null});

    await expect(readRightsConfirmationStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        confirmed: false,
        reason: expect.stringMatching(/not bound.*asset set/i),
      }),
    );
  });

  it('reuses a supplied verified-input context while calculating render fingerprints', async () => {
    const {projectPath} = await makeFixture();
    const integrity = createSourceIntegrityContext();

    const first = await expectedRenderFingerprint(projectPath, 'preview', {integrity});
    const firstSnapshot = integrity.snapshot;
    const second = await expectedRenderFingerprint(projectPath, 'preview', {integrity});

    expect(second).toBe(first);
    expect(firstSnapshot).not.toBeNull();
    expect(integrity.snapshot).toBe(firstSnapshot);
  });

  it('reuses one verified-input snapshot across preview and final fingerprint paths', async () => {
    const {projectPath} = await makeFixture();
    const integrity = createSourceIntegrityContext();

    await expectedRenderFingerprint(projectPath, 'preview', {integrity});
    const snapshot = integrity.snapshot;
    await expectedRenderFingerprint(projectPath, 'master', {integrity});
    await expectedRenderFingerprint(projectPath, 'delivery', {integrity});

    expect(snapshot).not.toBeNull();
    expect(integrity.snapshot).toBe(snapshot);
  });

  it('keeps render fingerprints stable when unreferenced footage changes', async () => {
    const {projectPath} = await makeFixture();
    const before = {
      preview: await expectedRenderFingerprint(projectPath, 'preview'),
      master: await expectedRenderFingerprint(projectPath, 'master'),
      delivery: await expectedRenderFingerprint(projectPath, 'delivery'),
    };
    const alternatePath = path.join(projectPath, 'input/clips/alternate.mp4');
    const alternateBytes = 'changed-unreferenced-media';
    await writeFile(alternatePath, alternateBytes);
    const alternateChecksum = await hashFile(alternatePath);
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const alternate = manifest.sources.find(
      (source: {relativePath: string}) =>
        source.relativePath === 'input/clips/alternate.mp4',
    );
    Object.assign(alternate, {
      id: sourceIdFor('video', 'input/clips/alternate.mp4', alternateChecksum),
      checksumSha256: alternateChecksum,
      sizeBytes: Buffer.byteLength(alternateBytes),
    });
    await writeJson(manifestPath, manifest);

    expect({
      preview: await expectedRenderFingerprint(projectPath, 'preview'),
      master: await expectedRenderFingerprint(projectPath, 'master'),
      delivery: await expectedRenderFingerprint(projectPath, 'delivery'),
    }).toEqual(before);
  });

  it('requires fresh source analysis when a renderable font is added', async () => {
    const {projectPath} = await makeFixture();
    await writeFile(path.join(projectPath, 'input/fonts/Director.ttf'), 'new-render-font');

    await expect(expectedRenderFingerprint(projectPath, 'preview')).rejects.toThrow(
      /source manifest|analy/i,
    );
  });

  it('keeps preview and master fingerprints stable for delivery-only settings', async () => {
    const {projectPath} = await makeFixture();
    const before = {
      preview: await expectedRenderFingerprint(projectPath, 'preview'),
      master: await expectedRenderFingerprint(projectPath, 'master'),
      delivery: await expectedRenderFingerprint(projectPath, 'delivery'),
    };
    const settingsPath = path.join(projectPath, 'config/settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    await writeJson(settingsPath, {
      ...settings,
      delivery: {...settings.delivery, audioBitrate: '192k'},
    });

    expect(await expectedRenderFingerprint(projectPath, 'preview')).toBe(before.preview);
    expect(await expectedRenderFingerprint(projectPath, 'master')).toBe(before.master);
    expect(await expectedRenderFingerprint(projectPath, 'delivery')).not.toBe(before.delivery);
  });

  it('changes only the preview fingerprint for preview encoder settings', async () => {
    const {projectPath} = await makeFixture();
    const before = {
      preview: await expectedRenderFingerprint(projectPath, 'preview'),
      master: await expectedRenderFingerprint(projectPath, 'master'),
      delivery: await expectedRenderFingerprint(projectPath, 'delivery'),
    };
    const settingsPath = path.join(projectPath, 'config/settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    await writeJson(settingsPath, {
      ...settings,
      preview: {...settings.preview, crf: 19},
    });

    expect(await expectedRenderFingerprint(projectPath, 'preview')).not.toBe(before.preview);
    expect(await expectedRenderFingerprint(projectPath, 'master')).toBe(before.master);
    expect(await expectedRenderFingerprint(projectPath, 'delivery')).toBe(before.delivery);
  });

  it('changes only the preview fingerprint for proxy settings', async () => {
    const {projectPath} = await makeFixture();
    const before = {
      preview: await expectedRenderFingerprint(projectPath, 'preview'),
      master: await expectedRenderFingerprint(projectPath, 'master'),
      delivery: await expectedRenderFingerprint(projectPath, 'delivery'),
    };
    const settingsPath = path.join(projectPath, 'config/settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    await writeJson(settingsPath, {
      ...settings,
      proxy: {...settings.proxy, crf: 22},
    });

    expect(await expectedRenderFingerprint(projectPath, 'preview')).not.toBe(before.preview);
    expect(await expectedRenderFingerprint(projectPath, 'master')).toBe(before.master);
    expect(await expectedRenderFingerprint(projectPath, 'delivery')).toBe(before.delivery);
  });

  it('binds final fingerprints to the reviewed stabilization outcome', async () => {
    const {projectPath, edit} = await makeFixture();
    const stabilizedEdit = {
      ...edit,
      clips: [
        {
          ...edit.clips[0],
          stabilization: {enabled: true, strength: 0.2, fallbackToUnstabilized: true},
        },
      ],
    };
    await writeJson(path.join(projectPath, 'edits/edit.json'), stabilizedEdit);
    const sourceChecksum = await hashFile(path.join(projectPath, 'input/clips/clip.mp4'));
    const reportPath = path.join(projectPath, 'analysis/preview-stabilization.json');
    const previewPath = path.join(projectPath, 'previews/preview.mp4');
    await writeJson(reportPath, {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-10T00:00:00.000Z',
      items: [
        {
          clipId: 'shot-1',
          fingerprint: 'fallback-review',
          path: null,
          checksumSha256: null,
          detectionSourceChecksumSha256: sourceChecksum,
          transformPath: null,
          transformChecksumSha256: null,
          stabilization: 'fallback',
          cached: false,
        },
      ],
    });
    await writeFile(previewPath, 'reviewed-fallback-preview');
    const previewFingerprint = await expectedRenderFingerprint(projectPath, 'preview');
    await recordRenderArtifact(projectPath, 'preview', previewPath, previewFingerprint);
    const fallback = {
      master: await expectedRenderFingerprint(projectPath, 'master'),
      delivery: await expectedRenderFingerprint(projectPath, 'delivery'),
    };

    const stabilizedPath = path.join(projectPath, 'work/preview-stabilized/shot-1.mp4');
    const transformPath = path.join(projectPath, 'work/stabilization/shot-1.trf');
    await mkdir(path.dirname(stabilizedPath), {recursive: true});
    await mkdir(path.dirname(transformPath), {recursive: true});
    await writeFile(stabilizedPath, 'stabilized-review-media');
    await writeFile(transformPath, 'reviewed-transform');
    await writeJson(reportPath, {
      schemaVersion: '1.0.0',
      generatedAt: '2026-08-10T00:01:00.000Z',
      items: [
        {
          clipId: 'shot-1',
          fingerprint: 'applied-review',
          path: 'work/preview-stabilized/shot-1.mp4',
          checksumSha256: await hashFile(stabilizedPath),
          detectionSourceChecksumSha256: sourceChecksum,
          transformPath: 'work/stabilization/shot-1.trf',
          transformChecksumSha256: await hashFile(transformPath),
          stabilization: 'applied',
          cached: false,
        },
      ],
    });
    await writeFile(previewPath, 'reviewed-applied-preview');
    expect(await expectedRenderFingerprint(projectPath, 'preview')).toBe(previewFingerprint);
    await recordRenderArtifact(projectPath, 'preview', previewPath, previewFingerprint);

    expect(await expectedRenderFingerprint(projectPath, 'master')).not.toBe(fallback.master);
    expect(await expectedRenderFingerprint(projectPath, 'delivery')).not.toBe(
      fallback.delivery,
    );
  });

  it('marks final artifacts stale when rights confirmation is withdrawn', async () => {
    const {projectPath} = await makeFixture();
    const outputDirectory = path.join(projectPath, 'output');
    await mkdir(outputDirectory, {recursive: true});
    const deliveryPath = path.join(outputDirectory, 'delivery.mp4');
    await writeFile(deliveryPath, 'rights-bound-delivery');
    await recordRenderArtifact(
      projectPath,
      'delivery',
      deliveryPath,
      await expectedRenderFingerprint(projectPath, 'delivery'),
    );
    expect((await readRenderArtifactFreshness(projectPath, 'delivery')).fresh).toBe(true);

    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(
      await import('node:fs/promises').then(({readFile}) => readFile(briefPath, 'utf8')),
    );
    await writeJson(briefPath, {...brief, rightsConfirmed: false});

    expect((await readRenderArtifactFreshness(projectPath, 'delivery')).fresh).toBe(false);
  });

  it('marks final artifacts stale when the confirmed rights asset fingerprint changes', async () => {
    const {projectPath} = await makeFixture();
    const outputDirectory = path.join(projectPath, 'output');
    await mkdir(outputDirectory, {recursive: true});
    const deliveryPath = path.join(outputDirectory, 'delivery.mp4');
    await writeFile(deliveryPath, 'asset-bound-rights-delivery');
    await recordRenderArtifact(
      projectPath,
      'delivery',
      deliveryPath,
      await expectedRenderFingerprint(projectPath, 'delivery'),
    );
    expect((await readRenderArtifactFreshness(projectPath, 'delivery')).fresh).toBe(true);

    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {
      ...brief,
      rightsConfirmation: {
        ...brief.rightsConfirmation,
        assetSetFingerprintSha256: '0'.repeat(64),
      },
    });

    expect((await readRenderArtifactFreshness(projectPath, 'delivery')).fresh).toBe(false);
  });

  it('returns awaiting-analysis instead of throwing for a stale source manifest', async () => {
    const {projectPath} = await makeFixture();
    await writeFile(path.join(projectPath, 'input/clips/clip.mp4'), 'changed-source-bytes');

    await expect(getProjectStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        stage: 'awaiting-analysis',
        nextAction: expect.stringMatching(/analy/i),
      }),
    );
  });

  it('directs status to render a missing rough cut before approval', async () => {
    const {projectPath} = await makeFixture();
    await unlink(path.join(projectPath, 'previews/preview.mp4'));

    await expect(getProjectStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        stage: 'awaiting-preview',
        nextAction: expect.stringMatching(/run preview|render.*rough cut/i),
      }),
    );
  });

  it('directs status to generate missing graded reference frames before color approval', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await unlink(path.join(projectPath, 'analysis/graded-stills.json'));

    await expect(getProjectStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        stage: 'awaiting-color-approval',
        editApproved: true,
        colorApproved: false,
        nextAction: expect.stringMatching(/grade-stills/i),
      }),
    );
  });

  it('surfaces unconfirmed rights before reporting render readiness', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {...brief, rightsConfirmed: false});

    await expect(getProjectStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        stage: 'awaiting-rights-confirmation',
        editApproved: true,
        colorApproved: true,
        nextAction: expect.stringMatching(/rights.*confirm-rights/i),
      }),
    );
  });

  it('surfaces a stale rights asset fingerprint before reporting render readiness', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    await confirmRights(projectPath, new Date('2026-08-10T00:03:00.000Z'));
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {
      ...brief,
      rightsConfirmation: {
        ...brief.rightsConfirmation,
        assetSetFingerprintSha256: '0'.repeat(64),
      },
    });

    await expect(getProjectStatus(projectPath)).resolves.toEqual(
      expect.objectContaining({
        stage: 'awaiting-rights-confirmation',
        editApproved: true,
        colorApproved: true,
        nextAction: expect.stringMatching(/rights.*asset set|asset set.*rights/i),
      }),
    );
  });

  it('does not report a same-size corrupted delivery as rendered', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const {deliveryPath} = await recordFinalArtifacts(projectPath);
    expect((await getProjectStatus(projectPath)).stage).toBe('rendered');

    await writeFile(deliveryPath, 'changed-delivery');

    expect((await getProjectStatus(projectPath)).stage).toBe('ready-to-render');
  });

  it('does not report rendered when the current master is missing', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const {masterPath} = await recordFinalArtifacts(projectPath);
    expect((await getProjectStatus(projectPath)).stage).toBe('rendered');

    await unlink(masterPath);

    expect((await getProjectStatus(projectPath)).stage).toBe('ready-to-render');
  });

  it('requires the exact current rough-cut preview before edit approval', async () => {
    const {projectPath, edit} = await makeFixture();
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      titles: [
        {text: 'Changed after preview', startSeconds: 0, durationSeconds: 1, position: 'center'},
      ],
    });
    await expect(approveEdit(projectPath)).rejects.toThrow(/preview|stale/i);
  });

  it('invalidates edit and color approvals after timeline changes', async () => {
    const {projectPath, edit} = await makeFixture();
    await approveEdit(projectPath, new Date('2026-08-10T00:01:00.000Z'));
    await approveColor(projectPath, new Date('2026-08-10T00:02:00.000Z'));
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: true,
      colorApproved: true,
    });
    await expect(assertRenderApprovals(projectPath)).resolves.toBeUndefined();

    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      clips: [{...edit.clips[0], outSeconds: 26}],
    });
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
    await expect(assertRenderApprovals(projectPath)).rejects.toThrow(/stale|approval/i);
  });

  it('invalidates only color when grade settings change', async () => {
    const {projectPath, edit} = await makeFixture();
    const approved = await approveEdit(projectPath, new Date('2026-08-10T00:01:00.000Z'));
    await approveColor(projectPath, new Date('2026-08-10T00:02:00.000Z'));
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      clips: [
        {
          ...edit.clips[0],
          grade: {...edit.clips[0].grade, exposureStops: 0.25},
        },
      ],
    });
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: true,
      colorApproved: false,
    });
    expect(
      ApprovalStateSchema.parse(
        JSON.parse(await import('node:fs/promises').then(({readFile}) => readFile(
          path.join(projectPath, 'analysis/approvals.json'),
          'utf8',
        ))),
      ).edit?.hash,
    ).toBe(approved.edit?.hash);
  });

  it('invalidates approvals when reviewed input bytes or the preview change', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    await writeFile(path.join(projectPath, 'previews/preview.mp4'), 'changed-preview-bytes');
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });

    const fresh = await makeFixture();
    await approveEdit(fresh.projectPath);
    await approveColor(fresh.projectPath);
    await writeFile(path.join(fresh.projectPath, 'input/clips/clip.mp4'), 'changed-input-bytes');
    expect(await readApprovalStatus(fresh.projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
    await expect(assertFinalReadiness(fresh.projectPath)).rejects.toThrow(/approval|changed|input/i);
  });

  it('keeps editorial approval but invalidates color approval when creative LUT bytes change', async () => {
    const {projectPath, creativeLutPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    await writeFile(creativeLutPath, 'changed-creative-lut-bytes');
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: true,
      colorApproved: false,
    });
    await expect(assertRenderApprovals(projectPath)).rejects.toThrow(/stale|approval/i);
  });

  it('keeps color approval current when an unselected LUT definition is added', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const configPath = path.join(projectPath, 'config/luts.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeJson(configPath, {
      ...config,
      luts: [
        ...config.luts,
        {
          ...config.luts[1],
          id: 'unselected-creative',
          file: 'input/luts/creative/unselected.cube',
          checksumSha256: 'f'.repeat(64),
        },
      ],
    });

    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: true,
      colorApproved: true,
    });
  });

  it('invalidates approvals when the generated source ID mapping is modified', async () => {
    const {projectPath, sourceId} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const manifestPath = path.join(projectPath, 'analysis/sources.json');
    const manifest = JSON.parse(
      await import('node:fs/promises').then(({readFile}) => readFile(manifestPath, 'utf8')),
    );
    const selected = manifest.sources.find((source: {id: string}) => source.id === sourceId);
    const alternate = manifest.sources.find(
      (source: {relativePath: string}) => source.relativePath === 'input/clips/alternate.mp4',
    );
    Object.assign(selected, {
      relativePath: alternate.relativePath,
      checksumSha256: alternate.checksumSha256,
      sizeBytes: alternate.sizeBytes,
    });
    await writeJson(manifestPath, manifest);
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
    await expect(assertFinalReadiness(projectPath)).rejects.toThrow(/source manifest|analyze/i);
  });

  it('invalidates an approved color review when a reference frame changes afterward', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    await writeFile(
      path.join(projectPath, 'previews/graded-stills/shot-1.png'),
      'changed-after-color-approval',
    );
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: true,
      colorApproved: false,
    });
    await expect(assertRenderApprovals(projectPath)).rejects.toThrow(/stale|approval/i);
  });

  it('treats per-shot stabilization fallback as an editorial decision', async () => {
    const {projectPath, edit} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    await writeJson(path.join(projectPath, 'edits/edit.json'), {
      ...edit,
      clips: [
        {
          ...edit.clips[0],
          stabilization: {
            ...edit.clips[0].stabilization,
            fallbackToUnstabilized: false,
          },
        },
      ],
    });
    expect(await readApprovalStatus(projectPath)).toEqual({
      editApproved: false,
      colorApproved: false,
    });
  });

  it('refuses color approval when a reviewed reference frame was modified', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await writeFile(
      path.join(projectPath, 'previews/graded-stills/shot-1.png'),
      'modified-after-generation',
    );
    await expect(approveColor(projectPath)).rejects.toThrow(/reference frame|checksum|stale/i);
  });

  it('requires exactly one current graded reference frame for every edit clip', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    const reportPath = path.join(projectPath, 'analysis/graded-stills.json');
    const report = JSON.parse(
      await import('node:fs/promises').then(({readFile}) => readFile(reportPath, 'utf8')),
    );
    await writeJson(reportPath, {...report, stills: [], checksums: {}});
    await expect(approveColor(projectPath)).rejects.toThrow(/every current clip|reference frame/i);
  });

  it('blocks final export when media and asset rights are not confirmed', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(
      await import('node:fs/promises').then(({readFile}) => readFile(briefPath, 'utf8')),
    );
    await writeJson(briefPath, {...brief, rightsConfirmed: false});
    await expect(assertFinalReadiness(projectPath)).rejects.toThrow(/rights/i);
  });

  it('blocks final export when rights cover a different asset set', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    await confirmRights(projectPath, new Date('2026-08-10T00:03:00.000Z'));
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {
      ...brief,
      rightsConfirmation: {
        ...brief.rightsConfirmation,
        assetSetFingerprintSha256: '0'.repeat(64),
      },
    });

    await expect(assertFinalReadiness(projectPath)).rejects.toThrow(
      /rights.*asset set|asset set.*rights/i,
    );
  });

  it('blocks final export for a legacy rights Boolean without an asset fingerprint', async () => {
    const {projectPath} = await makeFixture();
    await approveEdit(projectPath);
    await approveColor(projectPath);
    const briefPath = path.join(projectPath, 'brief.json');
    const brief = JSON.parse(await readFile(briefPath, 'utf8'));
    await writeJson(briefPath, {
      ...brief,
      rightsConfirmed: true,
      rightsConfirmation: null,
    });

    await expect(assertFinalReadiness(projectPath)).rejects.toThrow(
      /rights.*not bound|not bound.*asset set/i,
    );
  });
});
