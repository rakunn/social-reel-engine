import {hashValue} from '../core/hash';

export type ArtifactRecord = {
  fingerprint: string;
  generatedAt: string;
  files: string[];
  checksums?: Record<string, string>;
};

export type ArtifactIndex = {
  schemaVersion: '1.0.0';
  artifacts: Record<string, ArtifactRecord>;
};

export const artifactFingerprint = (inputs: unknown): string => hashValue(inputs);

export const isArtifactFresh = (
  record: ArtifactRecord | null | undefined,
  expectedFingerprint: string,
): boolean => record?.fingerprint === expectedFingerprint;
