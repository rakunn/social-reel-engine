import path from 'node:path';
import {
  SourceManifestSchema,
  type SourceEntry,
  type SourceManifest,
} from '../contracts/schemas';
import {canonicalJson} from '../core/hash';
import {readJson} from '../core/json';
import {scanInputs} from '../project/ingest';
import {
  cameraFromConfirmation,
  mediaTypeForKind,
  type SourcesConfig,
} from './analyze';

type SourceIdentity = Pick<
  SourceEntry,
  'id' | 'relativePath' | 'checksumSha256' | 'sizeBytes' | 'mediaType' | 'camera'
>;

const PIPELINE_MEDIA_TYPES = new Set<SourceEntry['mediaType']>([
  'video',
  'audio',
  'caption',
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
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
});

export const readValidatedSourceManifest = async (
  projectPath: string,
): Promise<SourceManifest> => {
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
        id: `${mediaType}-${file.checksumSha256.slice(0, 16)}`,
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
  return manifest;
};
