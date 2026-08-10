import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {hashFile} from '../../src/core/hash';
import {SourceManifestSchema} from '../../src/contracts/schemas';
import {sourceManifestFingerprintProjection} from '../../src/media/source-integrity';
import {
  evaluateRenderArtifact,
  type RenderArtifactRecord,
} from '../../src/render/artifacts';

describe('render artifact freshness', () => {
  it('does not depend on absolute ffprobe filenames', () => {
    const manifestAt = (filename: string) =>
      SourceManifestSchema.parse({
        schemaVersion: '1.0.0',
        generatedAt: '2026-08-10T00:00:00.000Z',
        sources: [
          {
            id: 'video-source',
            relativePath: 'input/clips/source.mp4',
            checksumSha256: 'a'.repeat(64),
            sizeBytes: 123,
            mediaType: 'video',
            ffprobe: {
              format: {filename, duration: '1'},
              streams: [{codec_type: 'video', avg_frame_rate: '30/1'}],
            },
            camera: {confirmed: false, profileId: null},
          },
        ],
      });

    expect(
      sourceManifestFingerprintProjection(manifestAt('/old/location/source.mp4')),
    ).toEqual(
      sourceManifestFingerprintProjection(manifestAt('/new/location/source.mp4')),
    );
  });

  it('requires the current manifest fingerprint and output checksum', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'render-artifact-'));
    const output = path.join(root, 'delivery.mp4');
    await writeFile(output, 'current-delivery');
    const checksum = await hashFile(output);
    const record: RenderArtifactRecord = {
      fingerprint: 'current-fingerprint',
      generatedAt: '2026-08-10T00:00:00.000Z',
      file: 'output/delivery.mp4',
      checksumSha256: checksum,
      sizeBytes: 16,
    };

    expect(
      evaluateRenderArtifact(record, 'current-fingerprint', checksum, 16),
    ).toEqual({fresh: true, reason: null});
    expect(
      evaluateRenderArtifact(record, 'changed-manifest', checksum, 16),
    ).toEqual({fresh: false, reason: expect.stringMatching(/manifest|fingerprint/i)});
    expect(
      evaluateRenderArtifact(record, 'current-fingerprint', '0'.repeat(64), 16),
    ).toEqual({fresh: false, reason: expect.stringMatching(/checksum/i)});
  });
});
