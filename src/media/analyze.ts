import path from 'node:path';
import {
  SourceManifestSchema,
  type SourceEntry,
  type SourceManifest,
} from '../contracts/schemas';
import {readJson, writeJson} from '../core/json';
import {hashValue} from '../core/hash';
import {probeFile} from './ffmpeg';
import {scanInputs, type InputKind} from '../project/ingest';

export type SourceConfirmation = {
  manufacturer?: string | null;
  model?: string | null;
  gamma?: string | null;
  gamut?: string | null;
  profileId?: string | null;
  confirmed?: boolean;
};

export type SourcesConfig = {
  schemaVersion: '1.0.0';
  sources: Record<string, SourceConfirmation>;
};

export const mediaTypeForKind = (kind: InputKind): SourceEntry['mediaType'] => {
  switch (kind) {
    case 'clips':
      return 'video';
    case 'music':
      return 'audio';
    case 'captions':
      return 'caption';
    case 'technical-lut':
    case 'creative-lut':
      return 'lut';
    case 'fonts':
      return 'font';
    case 'brand':
      return 'brand';
  }
};

export const sourceIdFor = (
  mediaType: SourceEntry['mediaType'],
  relativePath: string,
  checksumSha256: string,
): string =>
  `${mediaType}-${hashValue({relativePath, checksumSha256}).slice(0, 16)}`;

export const cameraFromConfirmation = (confirmation: SourceConfirmation = {}) => ({
  manufacturer: confirmation.manufacturer ?? null,
  model: confirmation.model ?? null,
  gamma: confirmation.gamma ?? null,
  gamut: confirmation.gamut ?? null,
  profileId: confirmation.profileId ?? null,
  confirmed: confirmation.confirmed === true,
});

export const analyzeSources = async (
  projectPath: string,
  now = new Date(),
): Promise<SourceManifest> => {
  const ingest = await scanInputs(projectPath, now);
  await writeJson(path.join(projectPath, 'analysis/ingest.json'), ingest);
  const config = await readJson<SourcesConfig>(path.join(projectPath, 'config/sources.json'));
  const sources: SourceEntry[] = [];

  for (const file of ingest.files) {
    const mediaType = mediaTypeForKind(file.kind);
    const shouldProbe = mediaType === 'video' || mediaType === 'audio';
    const confirmation = config.sources[file.relativePath] ?? {};
    const entry = {
      id: sourceIdFor(mediaType, file.relativePath, file.checksumSha256),
      relativePath: file.relativePath,
      checksumSha256: file.checksumSha256,
      sizeBytes: file.sizeBytes,
      mediaType,
      ffprobe: shouldProbe
        ? await probeFile(path.join(projectPath, file.relativePath))
        : {format: {}, streams: []},
      camera: cameraFromConfirmation(confirmation),
    };
    sources.push(SourceManifestSchema.shape.sources.element.parse(entry));
  }

  const manifest = SourceManifestSchema.parse({
    schemaVersion: '1.0.0',
    generatedAt: now.toISOString(),
    sources,
  });
  await writeJson(path.join(projectPath, 'analysis/sources.json'), manifest);
  return manifest;
};
