import path from 'node:path';
import {
  EditManifestSchema,
  LutDefinitionsSchema,
  ReelBriefSchema,
  type ReelBrief,
} from '../contracts/schemas';
import {hashFile, hashValue} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {
  assertVerifiedInputSnapshotUnchanged,
  createSourceIntegrityContext,
  readValidatedSourceManifest,
  type SourceIntegrityContext,
} from '../media/source-integrity';
import {referencedRenderLuts, referencedRenderSources} from '../render/artifacts';
import {validateEdit} from './validate';

type RightsAsset = {
  kind: 'video' | 'audio' | 'caption' | 'font' | 'lut';
  relativePath: string;
  checksumSha256: string;
};

export type RightsConfirmationStatus = {
  confirmed: boolean;
  reason: string | null;
  currentAssetSetFingerprintSha256: string | null;
  confirmedAssetSetFingerprintSha256: string | null;
};

export type RightsIntegrityOptions = {
  integrity?: SourceIntegrityContext;
};

const currentRightsAssets = async (
  projectPath: string,
  options: RightsIntegrityOptions = {},
): Promise<RightsAsset[]> => {
  const [edit, sourceManifest, lutsConfig] = await Promise.all([
    readJson(path.join(projectPath, 'edits/edit.json'), EditManifestSchema),
    readValidatedSourceManifest(projectPath, options.integrity),
    readJson<{luts?: unknown[]}>(path.join(projectPath, 'config/luts.json')),
  ]);
  const luts = LutDefinitionsSchema.parse(lutsConfig.luts ?? []);
  const sources = referencedRenderSources(edit, sourceManifest);
  const selectedLuts = referencedRenderLuts('master', edit, sources, luts);
  const assets: RightsAsset[] = sources.map((source) => ({
    kind: source.mediaType as RightsAsset['kind'],
    relativePath: source.relativePath,
    checksumSha256: source.checksumSha256,
  }));
  for (const lut of selectedLuts) {
    const checksumSha256 = await hashFile(resolveInside(projectPath, lut.file));
    if (checksumSha256 !== lut.checksumSha256) {
      throw new Error(`Configured LUT checksum no longer matches: ${lut.file}`);
    }
    assets.push({kind: 'lut', relativePath: lut.file, checksumSha256});
  }
  return assets.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.relativePath.localeCompare(right.relativePath),
  );
};

export const currentRightsAssetSetFingerprint = async (
  projectPath: string,
  options: RightsIntegrityOptions = {},
): Promise<string> =>
  hashValue({
    contractVersion: '1.0.0',
    assets: await currentRightsAssets(projectPath, options),
  });

export const confirmRights = async (
  projectPath: string,
  now = new Date(),
  options: RightsIntegrityOptions = {},
): Promise<NonNullable<ReelBrief['rightsConfirmation']>> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const validation = await validateEdit(projectPath, undefined, {integrity});
  if (!validation.valid) {
    throw new Error(
      `Rights confirmation requires a valid current edit:\n- ${validation.failures.join('\n- ')}`,
    );
  }
  const briefPath = path.join(projectPath, 'brief.json');
  const brief = ReelBriefSchema.parse(await readJson(briefPath));
  const rightsConfirmation = {
    assetSetFingerprintSha256: await currentRightsAssetSetFingerprint(projectPath, {integrity}),
    confirmedAt: now.toISOString(),
    confirmedBy: 'user',
  };
  const next = ReelBriefSchema.parse({
    ...brief,
    rightsConfirmed: true,
    rightsConfirmation,
  });
  await assertVerifiedInputSnapshotUnchanged(projectPath, integrity);
  await writeJson(briefPath, next);
  return rightsConfirmation;
};

export const readRightsConfirmationStatus = async (
  projectPath: string,
  options: RightsIntegrityOptions = {},
): Promise<RightsConfirmationStatus> => {
  const brief = ReelBriefSchema.parse(
    await readJson(path.join(projectPath, 'brief.json')),
  );
  const confirmedAssetSetFingerprintSha256 =
    brief.rightsConfirmation?.assetSetFingerprintSha256 ?? null;
  if (!brief.rightsConfirmed) {
    return {
      confirmed: false,
      reason: 'Usage rights are not confirmed',
      currentAssetSetFingerprintSha256: null,
      confirmedAssetSetFingerprintSha256,
    };
  }
  if (!confirmedAssetSetFingerprintSha256) {
    return {
      confirmed: false,
      reason: 'Rights confirmation is not bound to the current asset set',
      currentAssetSetFingerprintSha256: null,
      confirmedAssetSetFingerprintSha256: null,
    };
  }
  const currentAssetSetFingerprintSha256 =
    await currentRightsAssetSetFingerprint(projectPath, options);
  if (confirmedAssetSetFingerprintSha256 !== currentAssetSetFingerprintSha256) {
    return {
      confirmed: false,
      reason: 'The referenced asset set changed after rights were confirmed',
      currentAssetSetFingerprintSha256,
      confirmedAssetSetFingerprintSha256,
    };
  }
  return {
    confirmed: true,
    reason: null,
    currentAssetSetFingerprintSha256,
    confirmedAssetSetFingerprintSha256,
  };
};

export const assertRightsConfirmation = async (
  projectPath: string,
  options: RightsIntegrityOptions = {},
): Promise<void> => {
  const status = await readRightsConfirmationStatus(projectPath, options);
  if (!status.confirmed) {
    throw new Error(
      `Final export is blocked by rights confirmation: ${status.reason ?? 'unknown mismatch'}`,
    );
  }
};
