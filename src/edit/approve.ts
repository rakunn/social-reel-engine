import path from 'node:path';
import {
  ApprovalStateSchema,
  EditManifestSchema,
  LutDefinitionsSchema,
  type ApprovalState,
} from '../contracts/schemas';
import {
  approvalStatus,
  createColorHash,
  createColorReviewHash,
  createEditHash,
  createEditReviewHash,
  selectedColorLuts,
  type ReviewedStillFingerprint,
} from '../core/approvals';
import {hashFile} from '../core/hash';
import {readJson, writeJson} from '../core/json';
import {resolveInside} from '../core/paths';
import {resolveClipColor} from '../media/grade';
import {validateEdit} from './validate';
import {
  expectedRenderFingerprint,
  readRenderArtifactFreshness,
  readRenderArtifactRecord,
} from '../render/artifacts';
import {
  assertVerifiedInputSnapshotUnchanged,
  createSourceIntegrityContext,
  readValidatedSourceManifest,
  type SourceIntegrityContext,
} from '../media/source-integrity';
import {assertRightsConfirmation} from './rights';

export type ApprovalIntegrityOptions = {
  integrity?: SourceIntegrityContext;
};

const loadState = async (projectPath: string) => {
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  const lutsConfig = await readJson<{luts?: unknown[]}>(path.join(projectPath, 'config/luts.json'));
  const luts = LutDefinitionsSchema.parse(lutsConfig.luts ?? []);
  const approvals = ApprovalStateSchema.parse(
    await readJson(path.join(projectPath, 'analysis/approvals.json')),
  );
  return {edit, luts, approvals};
};

const invalidLutReason = async (
  projectPath: string,
  luts: Awaited<ReturnType<typeof loadState>>['luts'],
): Promise<string | null> => {
  for (const lut of luts) {
    try {
      const observed = await hashFile(resolveInside(projectPath, lut.file));
      if (observed !== lut.checksumSha256) {
        return `Configured LUT checksum no longer matches: ${lut.file}`;
      }
    } catch {
      return `Configured LUT is missing or unreadable: ${lut.file}`;
    }
  }
  return null;
};

const readCurrentGradedStillReview = async (
  projectPath: string,
  edit: Awaited<ReturnType<typeof loadState>>['edit'],
  colorManifestHash: string,
): Promise<{items: ReviewedStillFingerprint[] | null; reason: string | null}> => {
  let report: {
    editManifestHash?: string;
    editReviewHash?: string;
    colorManifestHash?: string;
    stills?: string[];
    checksums?: Record<string, string>;
  };
  try {
    report = await readJson(path.join(projectPath, 'analysis/graded-stills.json'));
  } catch {
    return {items: null, reason: 'Graded reference-frame report is missing or invalid'};
  }
  if (report.colorManifestHash !== colorManifestHash) {
    return {items: null, reason: 'Graded reference frames are stale for the current color treatment'};
  }
  const expected = edit.clips.map((clip) => ({
    clipId: clip.id,
    file: `previews/graded-stills/${clip.id}.png`,
  }));
  const expectedFiles = expected.map((entry) => entry.file).sort();
  const observedFiles = [...(report.stills ?? [])].sort();
  const checksumFiles = Object.keys(report.checksums ?? {}).sort();
  if (
    expectedFiles.length !== observedFiles.length ||
    expectedFiles.some((file, index) => observedFiles[index] !== file) ||
    expectedFiles.length !== checksumFiles.length ||
    expectedFiles.some((file, index) => checksumFiles[index] !== file)
  ) {
    return {
      items: null,
      reason: 'Graded reference frames do not cover every current clip exactly once',
    };
  }
  const items: ReviewedStillFingerprint[] = [];
  for (const entry of expected) {
    const checksumSha256 = report.checksums?.[entry.file];
    if (!checksumSha256) {
      return {items: null, reason: `Graded reference-frame checksum is missing: ${entry.file}`};
    }
    try {
      if ((await hashFile(resolveInside(projectPath, entry.file))) !== checksumSha256) {
        return {items: null, reason: `Graded reference-frame checksum is stale: ${entry.file}`};
      }
    } catch {
      return {items: null, reason: `Graded reference frame is missing or unreadable: ${entry.file}`};
    }
    items.push({...entry, checksumSha256});
  }
  return {items, reason: null};
};

const currentReviewHashes = async (
  projectPath: string,
  state?: Awaited<ReturnType<typeof loadState>>,
  options: ApprovalIntegrityOptions = {},
) => {
  const loaded = state ?? (await loadState(projectPath));
  let previewFingerprint: string;
  try {
    previewFingerprint = await expectedRenderFingerprint(projectPath, 'preview', {
      integrity: options.integrity,
    });
  } catch (error) {
    return {
      ...loaded,
      editReviewHash: null,
      colorManifestHash: null,
      colorReviewHash: null,
      previewReason: (error as Error).message,
      colorReason: (error as Error).message,
    };
  }
  const freshness = await readRenderArtifactFreshness(projectPath, 'preview', {
    expectedFingerprint: previewFingerprint,
    integrity: options.integrity,
  });
  if (!freshness.fresh) {
    return {
      ...loaded,
      editReviewHash: null,
      colorManifestHash: null,
      colorReviewHash: null,
      previewReason: freshness.reason,
      colorReason: freshness.reason,
    };
  }
  const preview = await readRenderArtifactRecord(projectPath, 'preview');
  if (!preview) {
    return {
      ...loaded,
      editReviewHash: null,
      colorManifestHash: null,
      colorReviewHash: null,
      previewReason: 'Preview artifact record is missing',
      colorReason: 'Preview artifact record is missing',
    };
  }
  const editReviewHash = createEditReviewHash(createEditHash(loaded.edit), preview);
  const colorManifestHash = createColorHash(loaded.edit, loaded.luts);
  const invalidLut = await invalidLutReason(
    projectPath,
    selectedColorLuts(loaded.edit, loaded.luts),
  );
  const stillReview = invalidLut
    ? {items: null, reason: invalidLut}
    : await readCurrentGradedStillReview(
        projectPath,
        loaded.edit,
        colorManifestHash,
      );
  const colorReason = invalidLut ?? stillReview.reason;
  return {
    ...loaded,
    editReviewHash,
    colorManifestHash,
    colorReviewHash: colorReason || !stillReview.items
      ? null
      : createColorReviewHash(colorManifestHash, stillReview.items),
    previewReason: null,
    colorReason,
  };
};

export const approveEdit = async (
  projectPath: string,
  now = new Date(),
  options: ApprovalIntegrityOptions = {},
): Promise<ApprovalState> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const validation = await validateEdit(projectPath, undefined, {integrity});
  if (!validation.valid) {
    throw new Error(`Edit is not valid:\n- ${validation.failures.join('\n- ')}`);
  }
  const state = await currentReviewHashes(projectPath, undefined, {integrity});
  if (!state.editReviewHash) {
    throw new Error(
      `The exact current rough-cut preview is missing or stale: ${state.previewReason ?? 'render it first'}`,
    );
  }
  const {approvals} = state;
  const hash = state.editReviewHash;
  const reusableColor =
    state.colorManifestHash &&
    state.colorReviewHash &&
    approvals.color?.colorHash === state.colorManifestHash &&
    approvals.color.hash === state.colorReviewHash
      ? approvals.color
      : null;
  const next = ApprovalStateSchema.parse({
    schemaVersion: '1.0.0',
    edit: {hash, approvedAt: now.toISOString(), approvedBy: 'user'},
    color: reusableColor,
  });
  await assertVerifiedInputSnapshotUnchanged(projectPath, integrity);
  await writeJson(path.join(projectPath, 'analysis/approvals.json'), next);
  return next;
};

export const approveColor = async (
  projectPath: string,
  now = new Date(),
  options: ApprovalIntegrityOptions = {},
): Promise<ApprovalState> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const state = await currentReviewHashes(projectPath, undefined, {integrity});
  const {edit, approvals} = state;
  const editHash = state.editReviewHash;
  if (!editHash || approvals.edit?.hash !== editHash) {
    throw new Error('Edit approval is missing or stale; approve the current rough cut first');
  }
  const manifest = await readValidatedSourceManifest(projectPath, integrity);
  for (const clip of edit.clips) {
    const source = manifest.sources.find((entry) => entry.id === clip.sourceId);
    if (!source) {
      throw new Error(`Missing source ${clip.sourceId}`);
    }
    resolveClipColor(projectPath, source, clip.grade);
  }
  const colorHash = state.colorReviewHash;
  if (!colorHash) {
    throw new Error(
      `Graded reference frames are missing or stale; regenerate and review them first: ${state.colorReason ?? 'unknown mismatch'}`,
    );
  }
  const next = ApprovalStateSchema.parse({
    schemaVersion: '1.0.0',
    edit: approvals.edit,
    color: {
      hash: colorHash,
      editHash,
      colorHash: state.colorManifestHash,
      approvedAt: now.toISOString(),
      approvedBy: 'user',
    },
  });
  await assertVerifiedInputSnapshotUnchanged(projectPath, integrity);
  await writeJson(path.join(projectPath, 'analysis/approvals.json'), next);
  return next;
};

export const readApprovalReadiness = async (
  projectPath: string,
  options: ApprovalIntegrityOptions = {},
) => {
  const state = await currentReviewHashes(projectPath, undefined, options);
  return {
    ...approvalStatus(
      state.approvals,
      state.editReviewHash,
      state.colorManifestHash,
      state.colorReviewHash,
    ),
    colorReviewReady: state.colorReviewHash !== null,
    colorReason: state.colorReason,
  };
};

export const readApprovalStatus = async (
  projectPath: string,
  options: ApprovalIntegrityOptions = {},
) => {
  const {editApproved, colorApproved} = await readApprovalReadiness(projectPath, options);
  return {editApproved, colorApproved};
};

export const assertEditApproval = async (
  projectPath: string,
  options: ApprovalIntegrityOptions = {},
): Promise<string> => {
  const state = await currentReviewHashes(projectPath, undefined, options);
  if (!state.editReviewHash || state.approvals.edit?.hash !== state.editReviewHash) {
    throw new Error('Edit approval is missing or stale for the exact current rough-cut preview');
  }
  return state.editReviewHash;
};

export const assertRenderApprovals = async (
  projectPath: string,
  options: ApprovalIntegrityOptions = {},
): Promise<void> => {
  const status = await readApprovalStatus(projectPath, options);
  if (!status.editApproved || !status.colorApproved) {
    throw new Error('Rendering is blocked because edit or color approval is missing or stale');
  }
};

export const assertFinalReadiness = async (
  projectPath: string,
  options: ApprovalIntegrityOptions = {},
): Promise<void> => {
  const integrity = options.integrity ?? createSourceIntegrityContext();
  const validation = await validateEdit(projectPath, undefined, {integrity});
  if (!validation.valid) {
    throw new Error(`Final export is blocked by invalid or changed inputs:\n- ${validation.failures.join('\n- ')}`);
  }
  await assertRenderApprovals(projectPath, {integrity});
  await assertRightsConfirmation(projectPath, {integrity});
};
