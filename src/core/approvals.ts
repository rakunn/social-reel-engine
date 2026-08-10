import type {
  ApprovalState,
  EditManifest,
  LutDefinition,
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

export const createColorHash = (
  edit: EditManifest,
  luts: readonly (LutDefinition | unknown)[],
): string =>
  hashValue({
    editHash: createEditHash(edit),
    grades: edit.clips.map((clip) => ({id: clip.id, grade: clip.grade})),
    luts,
  });

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
  editReviewHash: string,
  colorManifestHash: string,
  reviewedStills: readonly ReviewedStillFingerprint[],
): string =>
  hashValue({
    editReviewHash,
    colorManifestHash,
    reviewedStills: [...reviewedStills].sort(
      (left, right) =>
        left.clipId.localeCompare(right.clipId) || left.file.localeCompare(right.file),
    ),
  });

export const approvalStatus = (
  approvals: ApprovalState,
  editReviewHash: string | null,
  colorReviewHash: string | null,
): {editApproved: boolean; colorApproved: boolean} => {
  const editApproved = Boolean(editReviewHash && approvals.edit?.hash === editReviewHash);
  const colorApproved =
    editApproved &&
    approvals.color?.editHash === editReviewHash &&
    approvals.color?.hash === colorReviewHash;
  return {editApproved, colorApproved};
};
