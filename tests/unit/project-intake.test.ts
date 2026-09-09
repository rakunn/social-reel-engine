import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readProjectIntake} from '../../src/project/intake';
import {createReelProject, getProjectStatus} from '../../src/project/workspace';
import {validateEdit} from '../../src/edit/validate';
import {hashFile} from '../../src/core/hash';
import * as hashing from '../../src/core/hash';
import {readJson, writeJson} from '../../src/core/json';
import {cameraFromConfirmation, sourceIdFor} from '../../src/media/analyze';
import {scanInputs} from '../../src/project/ingest';
import {EditManifestSchema, ReelBriefSchema} from '../../src/contracts/schemas';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})));
});
const camera = {model: 'Test Camera', gamma: 'Test Log', gamut: 'Test Wide', profileId: 'test-log', confirmed: true};
const makeFixture = async (confirmed = false) => {
  const root = await mkdtemp(path.join(tmpdir(), 'reel-intake-'));
  roots.push(root);
  const project = await createReelProject({engineRoot: repositoryRoot, projectsRoot: path.join(root, 'projects'), reelName: 'intake-test'});
  await writeFile(path.join(project, 'input/clips/clip.mp4'), 'synthetic input');
  if (confirmed) await writeJson(path.join(project, 'config/sources.json'), {
    schemaVersion: '1.0.0', sources: {'input/clips/clip.mp4': camera},
  });
  return {root, project};
};
const addLut = async (root: string, file: string) => {
  await mkdir(path.dirname(path.join(root, file)), {recursive: true});
  await writeFile(path.join(root, file), 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  return {
    id: 'test-normalizer', kind: 'technical', file, checksumSha256: await hashFile(path.join(root, file)),
    cameraModel: camera.model, profileId: camera.profileId, inputGamma: camera.gamma, inputGamut: camera.gamut,
    inputColorSpace: 'Test Log/Test Wide', outputColorSpace: 'Rec.709 Gamma 2.4',
    transformSemantics: 'normalization', defaultMix: 1,
  };
};

const recordSources = async (project: string) => {
  const ingest = await scanInputs(project);
  await writeJson(path.join(project, 'analysis/sources.json'), {
    schemaVersion: '1.0.0', generatedAt: ingest.generatedAt,
    sources: ingest.files.filter((file) => file.kind === 'clips').map((file) => ({
      id: sourceIdFor('video', file.relativePath, file.checksumSha256),
      relativePath: file.relativePath, checksumSha256: file.checksumSha256, sizeBytes: file.sizeBytes,
      mediaType: 'video', camera: cameraFromConfirmation(file.relativePath.endsWith('/clip.mp4') ? camera : {}),
      ffprobe: {format: {duration: '6'}, streams: [{codec_type: 'video', avg_frame_rate: '30/1'}]},
    })),
  });
};

describe('project intake requirements', () => {
  it('hashes each input once per new-project status and refreshes the next snapshot', async () => {
    const {project} = await makeFixture();
    const clipPath = path.join(project, 'input/clips/clip.mp4');
    const hashSpy = vi.spyOn(hashing, 'hashFile');
    const first = await getProjectStatus(project);
    expect(hashSpy.mock.calls.filter(([file]) => file === clipPath)).toHaveLength(1);
    expect(first.inputs).toBe(1);
    expect(first.intake?.rights.assets).toHaveLength(1);

    await writeFile(clipPath, 'changed synthetic input');
    hashSpy.mockClear();
    const second = await getProjectStatus(project);
    expect(hashSpy.mock.calls.filter(([file]) => file === clipPath)).toHaveLength(1);
    expect(second.intake?.rights.assets[0]?.checksumSha256)
      .not.toBe(first.intake?.rights.assets[0]?.checksumSha256);
  });

  it('collects profile, LUT and explicit rights questions before analysis without asserting rights', async () => {
    const {root, project} = await makeFixture();
    const before = await readFile(path.join(project, 'brief.json'), 'utf8');
    const status = await getProjectStatus(project);
    expect(status.stage).toBe('awaiting-analysis');
    expect(status.intake?.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'source-profile', action: 'ask-user'}),
      expect.objectContaining({code: 'rights-confirmation', action: 'ask-user', blocks: 'export'}),
      expect.objectContaining({code: 'edit', action: 'configure'}),
    ]));
    expect(status.intake?.rights).toMatchObject({confirmed: false, requiresExplicitConfirmation: true, assetScope: 'supplied'});
    expect((await readProjectIntake(project, {engineRoot: root})).requirements)
      .toContainEqual(expect.objectContaining({code: 'normalization-lut', action: 'ask-user'}));
    expect(await readFile(path.join(project, 'brief.json'), 'utf8')).toBe(before);
  });

  it('returns an actionable validation result for a new empty edit', async () => {
    const {project} = await makeFixture();
    await expect(validateEdit(project)).resolves.toMatchObject({
      valid: false, durationSeconds: 0,
      failures: [expect.stringMatching(/No clips selected.*edits\/edit.json/i)],
    });
  });

  it('uses verified local catalog availability instead of asking for the same LUT again', async () => {
    const {root, project} = await makeFixture(true);
    const lut = await addLut(root, 'library/normalizer.cube');
    await writeJson(path.join(root, 'library/lut-catalog.json'), {schemaVersion: '1.0.0', technical: [lut], creative: [], unclassified: []});
    const report = await readProjectIntake(project, {engineRoot: root});
    expect(report.requirements).toContainEqual(expect.objectContaining({code: 'lut-selection', action: 'configure'}));
    expect(report.requirements.some((item) => item.code === 'normalization-lut')).toBe(false);
    await writeFile(path.join(root, lut.file), 'corrupt');
    const corrupt = await readProjectIntake(project, {engineRoot: root});
    expect(corrupt.requirements).toContainEqual(expect.objectContaining({code: 'normalization-lut', action: 'ask-user'}));
  });

  it('asks only for metadata when the technical LUT file is already supplied', async () => {
    const {root, project} = await makeFixture(true);
    await addLut(project, 'input/luts/technical/supplied.cube');
    const report = await readProjectIntake(project, {engineRoot: root});
    expect(report.requirements).toContainEqual(expect.objectContaining({code: 'lut-metadata', action: 'configure'}));
    expect(report.requirements.some((item) => item.code === 'normalization-lut')).toBe(false);
  });

  it('does not require a creative LUT or facts for unused footage after selection', async () => {
    const {root, project} = await makeFixture(true);
    const lut = await addLut(project, 'input/luts/technical/normalizer.cube');
    await writeJson(path.join(project, 'config/luts.json'), {schemaVersion: '1.0.0', luts: [lut]});
    await writeFile(path.join(project, 'input/clips/unused.mp4'), 'unconfirmed unused source');
    const sourceId = sourceIdFor('video', 'input/clips/clip.mp4', await hashFile(path.join(project, 'input/clips/clip.mp4')));
    await writeJson(path.join(project, 'edits/edit.json'), {
      schemaVersion: '1.0.0', reelName: 'intake-test', output: {width: 1080, height: 1920, fps: 30},
      clips: [{id: 'shot', sourceId, inSeconds: 0, outSeconds: 5, playbackRate: 1,
        crop: {start: {x: 0.5, y: 0.5, scale: 1}, end: {x: 0.5, y: 0.5, scale: 1}},
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: false},
        grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0, technicalLutId: lut.id},
        audio: {muted: true, gainDb: 0}, transitionAfter: {type: 'none', durationSeconds: 0}}],
      titles: [], music: null, captions: null,
    });
    await recordSources(project);
    expect((await validateEdit(project)).valid).toBe(true);
    const report = await readProjectIntake(project, {engineRoot: root});
    expect(report.scope).toBe('selected');
    expect(report.requirements.map((item) => item.code)).toEqual(['rights-confirmation']);
    await writeFile(path.join(project, lut.file), 'changed bytes');
    expect((await readProjectIntake(project, {engineRoot: root})).requirements)
      .toContainEqual(expect.objectContaining({code: 'lut-file', action: 'ask-user'}));
  });

  it.each(['single-card carousel', 'wrong identity', 'out-of-range trim'])('keeps supplied scope for a semantically invalid edit: %s', async (failure) => {
    const {root, project} = await makeFixture(true);
    await writeFile(path.join(project, 'input/clips/unused.mp4'), 'unconfirmed unused source');
    await recordSources(project);
    const brief = await readJson(path.join(project, 'brief.json'), ReelBriefSchema);
    if (failure === 'single-card carousel') {
      brief.output = {width: 1910, height: 1000, fps: 30};
      await writeJson(path.join(project, 'brief.json'), {...brief, projectType: 'carousel'});
    }
    const sourceId = sourceIdFor('video', 'input/clips/clip.mp4', await hashFile(path.join(project, 'input/clips/clip.mp4')));
    const edit = EditManifestSchema.parse({
      schemaVersion: '1.0.0', reelName: failure === 'wrong identity' ? 'wrong-project' : 'intake-test', output: brief.output,
      clips: [{id: 'shot', sourceId, inSeconds: 0, outSeconds: failure === 'out-of-range trim' ? 7 : 5, playbackRate: 1,
        crop: {start: {x: 0.5, y: 0.5, scale: 1}, end: {x: 0.5, y: 0.5, scale: 1}},
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: false},
        grade: {exposureStops: 0, whiteBalanceKelvin: 6500, tint: 0},
        audio: {muted: true, gainDb: 0}, transitionAfter: {type: 'none', durationSeconds: 0}}],
      titles: [], music: null, captions: null,
    });
    await writeJson(path.join(project, 'edits/edit.json'), edit);
    expect((await validateEdit(project)).valid).toBe(false);
    const report = await readProjectIntake(project, {engineRoot: root});
    expect(report.scope).toBe('supplied');
    expect(report.rights.assetScope).toBe('supplied');
    expect(report.rights.assets.map((asset) => asset.relativePath)).toContain('input/clips/unused.mp4');
    expect(report.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'edit', action: 'configure'}),
      expect.objectContaining({code: 'source-profile', paths: ['input/clips/unused.mp4']}),
    ]));
    const hashSpy = vi.spyOn(hashing, 'hashFile');
    const status = await getProjectStatus(project);
    expect(status.intake?.scope).toBe('supplied');
    expect(hashSpy.mock.calls.filter(([file]) => file === path.join(project, 'input/clips/clip.mp4'))).toHaveLength(1);
  });
});
