import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildFfmpegColorGraph} from '../../src/media/color-ffmpeg';
import {runFfmpeg} from '../../src/media/ffmpeg';

const identityCube = `TITLE "Identity"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('FFmpeg color treatment execution', () => {
  it('renders the land-haze branch as valid RGB input to the shared Rec.709 tail', async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), 'reel-land-haze-'));
    const relativeLut = 'input/luts/technical/identity.cube';
    const lutPath = path.join(projectPath, relativeLut);
    try {
      await mkdir(path.dirname(lutPath), {recursive: true});
      await writeFile(lutPath, identityCube, 'utf8');
      const graph = buildFfmpegColorGraph(
        {
          operations: [
            {
              type: 'pre-transform',
              exposureStops: 0,
              whiteBalanceKelvin: 6500,
              tint: 0,
            },
            {
              type: 'technical-lut',
              lut: {
                id: 'identity',
                kind: 'technical',
                file: relativeLut,
                checksumSha256: 'a'.repeat(64),
                cameraModel: 'Synthetic',
                profileId: 'synthetic-log',
                inputGamma: 'Synthetic Log',
                inputGamut: 'Synthetic Gamut',
                inputColorSpace: 'Synthetic Log/Synthetic Gamut',
                outputColorSpace: 'Rec.709 Gamma 2.4',
                transformSemantics: 'normalization',
                defaultMix: 1,
              },
              mix: 1,
            },
            {type: 'land-haze', strength: 0.5},
            {
              type: 'rec709-output',
              primaries: 'bt709',
              transfer: 'bt709',
              matrix: 'bt709',
            },
          ],
        },
        projectPath,
      );

      const result = await runFfmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x64:rate=1:duration=1',
        '-filter_complex',
        graph.filterComplex,
        '-map',
        '[color_out]',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);

      expect(result.exitCode).toBe(0);
    } finally {
      await rm(projectPath, {recursive: true, force: true});
    }
  });
});
