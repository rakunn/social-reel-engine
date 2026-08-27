import {access, stat} from 'node:fs/promises';
import path from 'node:path';
import {
  EditManifestSchema,
  LutDefinitionsSchema,
  ReelBriefSchema,
  type EditManifest,
  type LutDefinition,
  type RenderSettings,
  type SourceEntry,
  type SourceManifest,
} from '../contracts/schemas';
import {createEditHash} from '../core/approvals';
import {hashFile, hashValue} from '../core/hash';
import {implementationFingerprint} from '../core/implementation-fingerprint';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import type {SourcesConfig} from '../media/analyze';
import {lutCompatibilityFailures} from '../core/lut-compatibility';
import {
  assertVerifiedInputSnapshotUnchanged,
  readVerifiedInputSnapshot,
  sourceManifestFingerprintProjection,
  type SourceIntegrityContext,
} from '../media/source-integrity';
import {
  readRenderSettings,
  renderOptionsFor,
  targetExpectations,
  type OutputTarget,
} from './policy';
import {readPreviewStabilizationContext} from '../media/preview-stabilization-integrity';
import {readProjectStyle, resolveStyleFontSources, styleForRenderFingerprint} from '../style/project';
import type {StyleConfig} from '../style/contracts';

export type RenderArtifactRecord = {
  fingerprint: string;
  generatedAt: string;
  file: string;
  checksumSha256: string;
  sizeBytes: number;
  reviewContextHash?: string | null;
};

export type RenderArtifactIndex = {
  schemaVersion: '1.0.0';
  artifacts: Partial<Record<OutputTarget, RenderArtifactRecord>>;
};

export type RenderArtifactFreshness = {
  fresh: boolean;
  reason: string | null;
};

export type ExpectedRenderFingerprintOptions = {
  integrity?: SourceIntegrityContext;
};

export type RenderArtifactOptions = {
  integrity?: SourceIntegrityContext;
};

const indexPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/render-artifacts.json');

const readIndex = async (projectPath: string): Promise<RenderArtifactIndex> => {
  try {
    const value = await readJson<RenderArtifactIndex>(indexPath(projectPath));
    if (value.schemaVersion === '1.0.0' && value.artifacts) return value;
  } catch {
    // A missing or invalid index is treated as having no current render.
  }
  return {schemaVersion: '1.0.0', artifacts: {}};
};

export const evaluateRenderArtifact = (
  record: RenderArtifactRecord | null | undefined,
  expectedFingerprint: string,
  observedChecksum: string | null,
  observedSizeBytes: number | null,
): RenderArtifactFreshness => {
  if (!record) return {fresh: false, reason: 'No render artifact record exists'};
  if (record.fingerprint !== expectedFingerprint) {
    return {fresh: false, reason: 'Render fingerprint does not match the current manifests'};
  }
  if (observedSizeBytes === null || record.sizeBytes !== observedSizeBytes) {
    return {fresh: false, reason: 'Rendered output size does not match its artifact record'};
  }
  if (observedChecksum === null || record.checksumSha256 !== observedChecksum) {
    return {fresh: false, reason: 'Rendered output checksum does not match its artifact record'};
  }
  return {fresh: true, reason: null};
};

const renderSettingsFingerprintProjection = (
  target: OutputTarget,
  settings: RenderSettings,
): Record<string, unknown> => {
  if (target === 'preview') {
    return {
      schemaVersion: settings.schemaVersion,
      proxy: settings.proxy,
      preview: settings.preview,
    };
  }
  if (target === 'master') {
    return {schemaVersion: settings.schemaVersion, master: settings.master};
  }
  return {
    schemaVersion: settings.schemaVersion,
    master: settings.master,
    delivery: settings.delivery,
  };
};

export const referencedRenderSources = (
  edit: EditManifest,
  sourceManifest: SourceManifest,
  style: StyleConfig,
): SourceEntry[] => {
  const sourceIds = new Set(edit.clips.map((clip) => clip.sourceId));
  if (edit.music) sourceIds.add(edit.music.sourceId);
  if (edit.captions) {
    const caption = sourceManifest.sources.find(
      (source) => source.relativePath === edit.captions?.relativePath,
    );
    if (caption) sourceIds.add(caption.id);
  }
  for (const font of resolveStyleFontSources(style, sourceManifest)) sourceIds.add(font.id);
  return sourceManifest.sources.filter((source) => sourceIds.has(source.id));
};

export const referencedRenderLuts = (
  target: OutputTarget,
  edit: EditManifest,
  sources: readonly SourceEntry[],
  luts: readonly LutDefinition[],
): LutDefinition[] => {
  if (target === 'preview') {
    const videoSourceIds = new Set(edit.clips.map((clip) => clip.sourceId));
    const videoSources = sources.filter(
      (source) => source.mediaType === 'video' && videoSourceIds.has(source.id),
    );
    return luts.filter(
      (lut) =>
        lut.kind !== 'creative' &&
        videoSources.some(
          (source) =>
            source.camera.confirmed && lutCompatibilityFailures(source, lut).length === 0,
        ),
    );
  }
  const lutIds = new Set(
    edit.clips.flatMap((clip) =>
      [
        clip.grade.technicalLutId,
        clip.grade.creativeLutId,
        clip.grade.combinedLutId,
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  return luts.filter((lut) => lutIds.has(lut.id));
};

export const expectedRenderFingerprint = async (
  projectPath: string,
  target: OutputTarget,
  options: ExpectedRenderFingerprintOptions = {},
): Promise<string> => {
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  const integrity = await readVerifiedInputSnapshot(projectPath, options.integrity);
  const {ingest, sourceManifest} = integrity;
  const [sourceConfirmations, lutsConfig, settings, pipelineBuild, brief] =
    await Promise.all([
      readJson<SourcesConfig>(path.join(projectPath, 'config/sources.json')),
      readJson<{schemaVersion: '1.0.0'; luts: unknown[]}>(
        path.join(projectPath, 'config/luts.json'),
      ),
      readRenderSettings(projectPath),
      implementationFingerprint(target),
      readJson(path.join(projectPath, 'brief.json')),
    ]);
  const luts = LutDefinitionsSchema.parse(lutsConfig.luts);
  const parsedBrief = ReelBriefSchema.parse(brief);
  const style = await readProjectStyle(projectPath, sourceManifest);
  const renderSources = referencedRenderSources(edit, sourceManifest, style);
  const renderLuts = referencedRenderLuts(target, edit, renderSources, luts);
  const renderInputPaths = new Set([
    ...renderSources.map((source) => source.relativePath),
    ...renderLuts.map((lut) => lut.file),
  ]);
  const inputs = ingest.files.filter((file) => renderInputPaths.has(file.relativePath));
  const referencedVideoPaths = new Set(
    renderSources
      .filter((source) => source.mediaType === 'video')
      .map((source) => source.relativePath),
  );
  const scopedSourceConfirmations = {
    schemaVersion: sourceConfirmations.schemaVersion,
    sources: Object.fromEntries(
      [...referencedVideoPaths]
        .sort((left, right) => left.localeCompare(right))
        .map((relativePath) => [
          relativePath,
          sourceConfirmations.sources[relativePath] ?? {},
        ]),
    ),
  };
  const stabilizationReviewContext =
    target === 'preview'
      ? {fresh: true, reason: null, reviewContextHash: null}
      : await readPreviewStabilizationContext(projectPath, {integrity: options.integrity});
  if (!stabilizationReviewContext.fresh) {
    throw new Error(
      `Final render fingerprint requires a fresh preview stabilization context: ${stabilizationReviewContext.reason ?? 'unknown mismatch'}`,
    );
  }
  return hashValue({
    contractVersion: '1.0.0',
    pipelineBuild,
    target,
    edit: target === 'preview' ? {editorialHash: createEditHash(edit)} : edit,
    inputs,
    sourceConfirmations: scopedSourceConfirmations,
    sourceManifest: sourceManifestFingerprintProjection({
      ...sourceManifest,
      sources: renderSources,
    }),
    stabilizationReviewContextHash:
      target === 'preview' ? 'not-required' : stabilizationReviewContext.reviewContextHash,
    luts: renderLuts,
    settings: renderSettingsFingerprintProjection(target, settings),
    style: styleForRenderFingerprint(style),
    rightsConfirmation:
      target === 'preview'
        ? 'not-required'
        : {
            confirmed: parsedBrief.rightsConfirmed,
            assetSetFingerprintSha256:
              parsedBrief.rightsConfirmation?.assetSetFingerprintSha256 ?? null,
          },
    outputPolicy: targetExpectations(target, settings),
    renderer:
      target === 'delivery'
        ? {pipeline: 'ffmpeg-two-pass-loudnorm-v1'}
        : renderOptionsFor(target, settings),
  });
};

export const readRenderArtifactRecord = async (
  projectPath: string,
  target: OutputTarget,
): Promise<RenderArtifactRecord | null> =>
  (await readIndex(projectPath)).artifacts[target] ?? null;

export const recordRenderArtifact = async (
  projectPath: string,
  target: OutputTarget,
  outputPath: string,
  fingerprint: string,
  now = new Date(),
  options: RenderArtifactOptions = {},
): Promise<RenderArtifactRecord> => {
  const relativeFile = path.relative(projectPath, outputPath).split(path.sep).join('/');
  const resolved = resolveInside(projectPath, relativeFile);
  const outputStat = await stat(resolved);
  const previewContext =
    target === 'preview'
      ? await readPreviewStabilizationContext(projectPath, {integrity: options.integrity})
      : {fresh: true, reason: null, reviewContextHash: null};
  if (!previewContext.fresh) {
    throw new Error(
      `Cannot record preview artifact: ${previewContext.reason ?? 'stabilization review context is invalid'}`,
    );
  }
  const record: RenderArtifactRecord = {
    fingerprint,
    generatedAt: now.toISOString(),
    file: relativeFile,
    checksumSha256: await hashFile(resolved),
    sizeBytes: outputStat.size,
    reviewContextHash: previewContext.reviewContextHash,
  };
  await assertVerifiedInputSnapshotUnchanged(projectPath, options.integrity);
  const index = await readIndex(projectPath);
  index.artifacts[target] = record;
  await writeJson(indexPath(projectPath), index);
  return record;
};

export const readRenderArtifactFreshness = async (
  projectPath: string,
  target: OutputTarget,
  options: {
    expectedFingerprint?: string;
    verifyChecksum?: boolean;
    integrity?: SourceIntegrityContext;
  } = {},
): Promise<RenderArtifactFreshness> => {
  const expectedFingerprint =
    options.expectedFingerprint ??
    (await expectedRenderFingerprint(projectPath, target, {integrity: options.integrity}));
  const record = (await readIndex(projectPath)).artifacts[target];
  if (!record) return evaluateRenderArtifact(null, expectedFingerprint, null, null);
  const outputPath = resolveInside(projectPath, record.file);
  try {
    await access(outputPath);
    const outputStat = await stat(outputPath);
    const checksum =
      options.verifyChecksum === false ? record.checksumSha256 : await hashFile(outputPath);
    const freshness = evaluateRenderArtifact(
      record,
      expectedFingerprint,
      checksum,
      outputStat.size,
    );
    if (!freshness.fresh || target !== 'preview') {
      return freshness;
    }
    const context = await readPreviewStabilizationContext(projectPath, {
      integrity: options.integrity,
    });
    if (!context.fresh) {
      return {fresh: false, reason: context.reason};
    }
    if ((record.reviewContextHash ?? null) !== context.reviewContextHash) {
      return {
        fresh: false,
        reason: 'Preview stabilization context does not match the rendered artifact record',
      };
    }
    return {fresh: true, reason: null};
  } catch {
    return {fresh: false, reason: 'Rendered output is missing or unreadable'};
  }
};
