import {access} from 'node:fs/promises';
import path from 'node:path';
import {EditManifestSchema} from '../contracts/schemas';
import {hashFile, hashValue} from '../core/hash';
import {readJson} from '../core/json';
import {resolveInside} from '../core/paths';
import type {PreviewStabilizationReport} from './preview-stabilize';
import {readValidatedSourceManifest} from './source-integrity';

export type PreviewStabilizationContext = {
  fresh: boolean;
  reason: string | null;
  reviewContextHash: string | null;
};

const verifiedChecksum = async (
  projectPath: string,
  relativePath: string,
  expectedChecksum: string,
): Promise<string | null> => {
  const filePath = resolveInside(projectPath, relativePath);
  try {
    await access(filePath);
    const checksum = await hashFile(filePath);
    return checksum === expectedChecksum ? checksum : null;
  } catch {
    return null;
  }
};

export const readPreviewStabilizationContext = async (
  projectPath: string,
): Promise<PreviewStabilizationContext> => {
  const edit = EditManifestSchema.parse(
    await readJson(path.join(projectPath, 'edits/edit.json')),
  );
  const stabilizedClips = edit.clips.filter((clip) => clip.stabilization.enabled);
  if (stabilizedClips.length === 0) {
    return {fresh: true, reason: null, reviewContextHash: null};
  }

  let report: PreviewStabilizationReport;
  try {
    report = await readJson<PreviewStabilizationReport>(
      path.join(projectPath, 'analysis/preview-stabilization.json'),
    );
    if (report.schemaVersion !== '1.0.0' || !Array.isArray(report.items)) {
      throw new Error('invalid report');
    }
  } catch {
    return {
      fresh: false,
      reason: 'Preview stabilization report is missing or invalid',
      reviewContextHash: null,
    };
  }

  const manifest = await readValidatedSourceManifest(projectPath);
  const reviewItems: Array<Record<string, unknown>> = [];
  for (const clip of stabilizedClips) {
    const matches = report.items.filter((item) => item.clipId === clip.id);
    if (matches.length !== 1) {
      return {
        fresh: false,
        reason: `${clip.id}: preview stabilization record is missing or duplicated`,
        reviewContextHash: null,
      };
    }
    const item = matches[0];
    const source = manifest.sources.find((candidate) => candidate.id === clip.sourceId);
    if (!source || item.detectionSourceChecksumSha256 !== source.checksumSha256) {
      return {
        fresh: false,
        reason: `${clip.id}: preview stabilization is not bound to the current original source`,
        reviewContextHash: null,
      };
    }
    if (item.stabilization === 'fallback') {
      if (!clip.stabilization.fallbackToUnstabilized) {
        return {
          fresh: false,
          reason: `${clip.id}: preview stabilization fallback is not allowed`,
          reviewContextHash: null,
        };
      }
      reviewItems.push({
        clipId: clip.id,
        fingerprint: item.fingerprint,
        stabilization: item.stabilization,
        detectionSourceChecksumSha256: item.detectionSourceChecksumSha256,
        path: null,
        checksumSha256: null,
        transformPath: null,
        transformChecksumSha256: null,
      });
      continue;
    }
    if (
      item.stabilization !== 'applied' ||
      !item.path ||
      !item.checksumSha256 ||
      !item.transformPath ||
      !item.transformChecksumSha256
    ) {
      return {
        fresh: false,
        reason: `${clip.id}: preview stabilization artifacts are incomplete`,
        reviewContextHash: null,
      };
    }
    const [previewChecksumSha256, transformChecksumSha256] = await Promise.all([
      verifiedChecksum(projectPath, item.path, item.checksumSha256),
      verifiedChecksum(projectPath, item.transformPath, item.transformChecksumSha256),
    ]);
    if (!previewChecksumSha256 || !transformChecksumSha256) {
      return {
        fresh: false,
        reason: `${clip.id}: preview stabilization artifact checksum does not match`,
        reviewContextHash: null,
      };
    }
    reviewItems.push({
      clipId: clip.id,
      fingerprint: item.fingerprint,
      stabilization: item.stabilization,
      detectionSourceChecksumSha256: item.detectionSourceChecksumSha256,
      path: item.path,
      checksumSha256: previewChecksumSha256,
      transformPath: item.transformPath,
      transformChecksumSha256,
    });
  }
  return {
    fresh: true,
    reason: null,
    reviewContextHash: hashValue({schemaVersion: '1.0.0', items: reviewItems}),
  };
};
