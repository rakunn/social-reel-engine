import path from 'node:path';
import {
  SourceManifestSchema,
  type SourceEntry,
  type SourceManifest,
} from '../contracts/schemas';
import {canonicalJson} from '../core/hash';
import {readJson} from '../core/json';
import {scanInputs, type IngestManifest} from '../project/ingest';
import {
  cameraFromConfirmation,
  mediaTypeForKind,
  sourceIdFor,
  type SourcesConfig,
} from './analyze';

type SourceIdentity = Pick<
  SourceEntry,
  'id' | 'relativePath' | 'checksumSha256' | 'sizeBytes' | 'mediaType' | 'camera'
>;

export type VerifiedInputSnapshot = {
  ingest: IngestManifest;
  sourceManifest: SourceManifest;
};

export type SourceIntegrityContext = {
  snapshot: VerifiedInputSnapshot | null;
  pending: Promise<VerifiedInputSnapshot> | null;
};

export const createSourceIntegrityContext = (): SourceIntegrityContext => ({
  snapshot: null,
  pending: null,
});

export const setVerifiedInputSnapshot = (
  context: SourceIntegrityContext,
  snapshot: VerifiedInputSnapshot,
): void => {
  context.snapshot = snapshot;
  context.pending = null;
};

const PIPELINE_MEDIA_TYPES = new Set<SourceEntry['mediaType']>([
  'video',
  'audio',
  'caption',
  'font',
]);

const identityOf = (source: SourceEntry): SourceIdentity => ({
  id: source.id,
  relativePath: source.relativePath,
  checksumSha256: source.checksumSha256,
  sizeBytes: source.sizeBytes,
  mediaType: source.mediaType,
  camera: source.camera,
});

export const sourceManifestFingerprintProjection = (manifest: SourceManifest) => ({
  schemaVersion: manifest.schemaVersion,
  sources: manifest.sources
    .filter((source) => PIPELINE_MEDIA_TYPES.has(source.mediaType))
    .map((source) => {
      const {filename: _absoluteFilename, ...format} = source.ffprobe.format ?? {};
      return {...source, ffprobe: {...source.ffprobe, format}};
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
});

const verifyInputSnapshot = async (projectPath: string): Promise<VerifiedInputSnapshot> => {
  const manifest = SourceManifestSchema.parse(
    await readJson(path.join(projectPath, 'analysis/sources.json')),
  );
  const [ingest, config] = await Promise.all([
    scanInputs(projectPath),
    readJson<SourcesConfig>(path.join(projectPath, 'config/sources.json')),
  ]);
  const expected = ingest.files
    .map((file): SourceIdentity => {
      const mediaType = mediaTypeForKind(file.kind);
      return {
        id: sourceIdFor(mediaType, file.relativePath, file.checksumSha256),
        relativePath: file.relativePath,
        checksumSha256: file.checksumSha256,
        sizeBytes: file.sizeBytes,
        mediaType,
        camera: cameraFromConfirmation(config.sources[file.relativePath]),
      };
    })
    .filter((source) => PIPELINE_MEDIA_TYPES.has(source.mediaType));
  const failures: string[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  const observedMedia = manifest.sources.filter((source) =>
    PIPELINE_MEDIA_TYPES.has(source.mediaType),
  );
  for (const source of observedMedia) {
    if (ids.has(source.id)) failures.push(`duplicate source ID ${source.id}`);
    if (paths.has(source.relativePath)) {
      failures.push(`duplicate source path ${source.relativePath}`);
    }
    ids.add(source.id);
    paths.add(source.relativePath);
  }
  const expectedByPath = new Map(expected.map((source) => [source.relativePath, source]));
  const observedByPath = new Map(
    observedMedia.map((source) => [source.relativePath, identityOf(source)]),
  );
  for (const [relativePath, expectedSource] of expectedByPath) {
    const observed = observedByPath.get(relativePath);
    if (!observed) {
      failures.push(`missing entry for ${relativePath}`);
      continue;
    }
    if (canonicalJson(observed) !== canonicalJson(expectedSource)) {
      failures.push(`identity, checksum, type, size, or camera facts differ for ${relativePath}`);
    }
  }
  for (const relativePath of observedByPath.keys()) {
    if (!expectedByPath.has(relativePath)) failures.push(`unexpected entry ${relativePath}`);
  }
  if (failures.length) {
    throw new Error(
      `Source manifest is stale or inconsistent; run analyze again:\n- ${failures.join('\n- ')}`,
    );
  }
  return {ingest, sourceManifest: manifest};
};

export const readVerifiedInputSnapshot = async (
  projectPath: string,
  context?: SourceIntegrityContext,
): Promise<VerifiedInputSnapshot> => {
  if (!context) return await verifyInputSnapshot(projectPath);
  if (context.snapshot) return context.snapshot;
  context.pending ??= verifyInputSnapshot(projectPath);
  try {
    context.snapshot = await context.pending;
    return context.snapshot;
  } finally {
    context.pending = null;
  }
};

export const assertVerifiedInputSnapshotUnchanged = async (
  projectPath: string,
  context?: SourceIntegrityContext,
): Promise<VerifiedInputSnapshot> => {
  if (!context?.snapshot) {
    return await verifyInputSnapshot(projectPath);
  }
  const observed = await verifyInputSnapshot(projectPath);
  const expected = context.snapshot;
  if (
    canonicalJson(expected.ingest.files) !== canonicalJson(observed.ingest.files) ||
    canonicalJson(sourceManifestFingerprintProjection(expected.sourceManifest)) !==
      canonicalJson(sourceManifestFingerprintProjection(observed.sourceManifest))
  ) {
    throw new Error(
      'Verified inputs changed during the media operation; retry the command before publishing artifacts',
    );
  }
  return observed;
};

export const readValidatedSourceManifest = async (
  projectPath: string,
  context?: SourceIntegrityContext,
): Promise<SourceManifest> => {
  const snapshot = await readVerifiedInputSnapshot(projectPath, context);
  return snapshot.sourceManifest;
};
