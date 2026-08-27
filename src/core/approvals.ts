import type {
  ApprovalState,
  EditManifest,
  LutDefinition,
  SourceEntry,
} from '../contracts/schemas';
import {hashValue} from './hash';

const editorialProjection = (edit: EditManifest) => ({
  schemaVersion: edit.schemaVersion,
  reelName: edit.reelName,
  output: edit.output,
  clips: edit.clips.map(({grade: _grade, ...clip}) => clip),
  titles: edit.titles,
  music: edit.music,
  captions: edit.captions,
});

export const createEditHash = (edit: EditManifest): string =>
  hashValue(editorialProjection(edit));

const selectedColorLutIds = (edit: EditManifest): Set<string> =>
  new Set(
    edit.clips.flatMap((clip) =>
      [
        clip.grade.technicalLutId,
        clip.grade.creativeLutId,
        clip.grade.combinedLutId,
      ].filter((id): id is string => Boolean(id)),
    ),
  );

export const selectedColorLuts = (
  edit: EditManifest,
  luts: readonly LutDefinition[],
): LutDefinition[] => {
  const selectedIds = selectedColorLutIds(edit);
  return luts
    .filter((lut) => selectedIds.has(lut.id))
    .sort((left, right) => left.id.localeCompare(right.id));
};

export const createColorHash = (
  edit: EditManifest,
  luts: readonly (LutDefinition | unknown)[],
  sources: readonly SourceEntry[],
): string => {
  const selectedIds = selectedColorLutIds(edit);
  const selectedLuts = luts
    .filter(
      (lut): lut is {id: string} & Record<string, unknown> =>
        typeof lut === 'object' &&
        lut !== null &&
        'id' in lut &&
        typeof lut.id === 'string' &&
        selectedIds.has(lut.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const referencedSourceFacts = [...new Set(edit.clips.map((clip) => clip.sourceId))]
    .sort((left, right) => left.localeCompare(right))
    .map((sourceId) => {
      const source = sourcesById.get(sourceId);
      return {
        sourceId,
        camera: source
          ? {
              confirmed: source.camera.confirmed,
              profileId: source.camera.profileId,
              model: source.camera.model,
              gamma: source.camera.gamma,
              gamut: source.camera.gamut,
            }
          : null,
      };
    });
  return hashValue({
    output: edit.output,
    clips: edit.clips.map((clip) => ({
      id: clip.id,
      sourceId: clip.sourceId,
      inSeconds: clip.inSeconds,
      outSeconds: clip.outSeconds,
      crop: clip.crop,
      stabilization: clip.stabilization,
      grade: clip.grade,
    })),
    luts: selectedLuts,
    sources: referencedSourceFacts,
  });
};

export const createEditReviewHash = (
  editManifestHash: string,
  preview: {
    fingerprint: string;
    checksumSha256: string;
    reviewContextHash?: string | null;
  },
): string =>
  hashValue({
    editManifestHash,
    previewFingerprint: preview.fingerprint,
    previewChecksumSha256: preview.checksumSha256,
    previewReviewContextHash: preview.reviewContextHash ?? null,
  });

export type ReviewedStillFingerprint = {
  clipId: string;
  file: string;
  checksumSha256: string;
};

export const createColorReviewHash = (
  colorManifestHash: string,
  reviewedStills: readonly ReviewedStillFingerprint[],
): string =>
  hashValue({
    colorManifestHash,
    reviewedStills: [...reviewedStills].sort(
      (left, right) =>
        left.clipId.localeCompare(right.clipId) || left.file.localeCompare(right.file),
    ),
  });

export const approvalStatus = (
  approvals: ApprovalState,
  editReviewHash: string | null,
  colorManifestHash: string | null,
  colorReviewHash: string | null,
): {editApproved: boolean; colorApproved: boolean} => {
  const editApproved = Boolean(editReviewHash && approvals.edit?.hash === editReviewHash);
  const colorApproved =
    editApproved &&
    Boolean(colorManifestHash) &&
    approvals.color?.colorHash === colorManifestHash &&
    approvals.color?.hash === colorReviewHash;
  return {editApproved, colorApproved};
};
