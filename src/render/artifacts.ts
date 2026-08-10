import {access, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  EditManifestSchema,
  LutDefinitionsSchema,
  ReelBriefSchema,
} from '../contracts/schemas';
import {createEditHash} from '../core/approvals';
import {hashFile, hashValue} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {scanInputs} from '../project/ingest';
import {
  readValidatedSourceManifest,
  sourceManifestFingerprintProjection,
} from '../media/source-integrity';
import {
  readRenderSettings,
  renderOptionsFor,
  targetExpectations,
  type OutputTarget,
} from './policy';
import {readPreviewStabilizationContext} from '../media/preview-stabilization-integrity';

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

const indexPath = (projectPath: string): string =>
  path.join(projectPath, 'analysis/render-artifacts.json');

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pipelineFingerprintPromise: Promise<string> | null = null;

const walkImplementationFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, {withFileTypes: true});
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? await walkImplementationFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
};

export const pipelineBuildFingerprint = async (): Promise<string> => {
  pipelineFingerprintPromise ??= (async () => {
    const files = [
      path.join(engineRoot, 'package.json'),
      path.join(engineRoot, 'package-lock.json'),
      path.join(engineRoot, 'remotion.config.ts'),
      ...(await walkImplementationFiles(path.join(engineRoot, 'src'))),
    ].sort();
    return hashValue(
      await Promise.all(
        files.map(async (file) => ({
          file: path.relative(engineRoot, file).split(path.sep).join('/'),
          checksumSha256: await hashFile(file),
        })),
      ),
    );
  })();
  return await pipelineFingerprintPromise;
};

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

export const expectedRenderFingerprint = async (
  projectPath: string,
  target: OutputTarget,
): Promise<string> => {
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  const ingest = await scanInputs(projectPath);
  const [sourceConfirmations, sourceManifest, lutsConfig, settings, pipelineBuild, brief] =
    await Promise.all([
      readJson(path.join(projectPath, 'config/sources.json')),
      readValidatedSourceManifest(projectPath),
      readJson<{schemaVersion: '1.0.0'; luts: unknown[]}>(
        path.join(projectPath, 'config/luts.json'),
      ),
      readRenderSettings(projectPath),
      pipelineBuildFingerprint(),
      readJson(path.join(projectPath, 'brief.json')),
    ]);
  const luts = LutDefinitionsSchema.parse(lutsConfig.luts);
  const rightsConfirmed = ReelBriefSchema.parse(brief).rightsConfirmed;
  const previewLuts = luts.filter((lut) => lut.kind !== 'creative');
  const previewLutFiles = new Set(previewLuts.map((lut) => lut.file));
  const previewInputKinds = new Set(['clips', 'music', 'captions', 'fonts', 'brand']);
  const inputs =
    target === 'preview'
      ? ingest.files.filter(
          (file) => previewInputKinds.has(file.kind) || previewLutFiles.has(file.relativePath),
        )
      : ingest.files;
  return hashValue({
    contractVersion: '1.0.0',
    pipelineBuild,
    target,
    edit: target === 'preview' ? {editorialHash: createEditHash(edit)} : edit,
    inputs,
    sourceConfirmations,
    sourceManifest: sourceManifestFingerprintProjection(sourceManifest),
    luts: target === 'preview' ? previewLuts : luts,
    settings,
    rightsConfirmed: target === 'preview' ? 'not-required' : rightsConfirmed,
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
): Promise<RenderArtifactRecord> => {
  const relativeFile = path.relative(projectPath, outputPath).split(path.sep).join('/');
  const resolved = resolveInside(projectPath, relativeFile);
  const outputStat = await stat(resolved);
  const previewContext =
    target === 'preview'
      ? await readPreviewStabilizationContext(projectPath)
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
  const index = await readIndex(projectPath);
  index.artifacts[target] = record;
  await writeJson(indexPath(projectPath), index);
  return record;
};

export const readRenderArtifactFreshness = async (
  projectPath: string,
  target: OutputTarget,
  options: {expectedFingerprint?: string; verifyChecksum?: boolean} = {},
): Promise<RenderArtifactFreshness> => {
  const expectedFingerprint =
    options.expectedFingerprint ?? (await expectedRenderFingerprint(projectPath, target));
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
    const context = await readPreviewStabilizationContext(projectPath);
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
