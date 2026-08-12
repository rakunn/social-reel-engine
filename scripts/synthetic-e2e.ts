import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {approveColor, approveEdit} from '../src/edit/approve';
import {confirmRights} from '../src/edit/rights';
import {hashFile} from '../src/core/hash';
import {writeJson} from '../src/core/json';
import {analyzeSources} from '../src/media/analyze';
import {runFfmpeg} from '../src/media/ffmpeg';
import {generateGradedStills} from '../src/media/grade';
import {runQc} from '../src/media/qc-report';
import {ingestFiles} from '../src/project/ingest';
import {createReelProject} from '../src/project/workspace';
import {renderMasterAndDelivery, renderPreview} from '../src/render/remotion';

const IDENTITY_CUBE = `TITLE "Synthetic Identity"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;

export const prepareSyntheticReel = async (
  engineRoot: string,
  options: {silent?: boolean} = {},
) => {
  const reelName = options.silent ? 'synthetic-silent-acceptance' : 'synthetic-acceptance';
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'social-reel-e2e-'));
  const projectPath = await createReelProject({
    engineRoot,
    projectsRoot: path.join(temporaryRoot, 'projects'),
    reelName,
    title: options.silent ? 'Synthetic Silent Acceptance Reel' : 'Synthetic Acceptance Reel',
  });
  const sourceDirectory = path.join(temporaryRoot, 'originals');
  await import('node:fs/promises').then(({mkdir}) => mkdir(sourceDirectory, {recursive: true}));
  const clipOne = path.join(sourceDirectory, 'SYNTHETIC_A.MP4');
  const clipTwo = path.join(sourceDirectory, 'SYNTHETIC_B.MP4');
  const music = path.join(sourceDirectory, 'SYNTHETIC_MUSIC.wav');
  const lut = path.join(sourceDirectory, 'SYNTHETIC_IDENTITY.cube');

  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=480x270:rate=30:duration=2.4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:sample_rate=48000:duration=2.4',
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    clipOne,
  ]);
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'smptebars=size=480x270:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=550:sample_rate=48000:duration=2.4',
    '-t',
    '2.4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    clipTwo,
  ]);
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,0.7*sin(2*PI*880*t)\\,0):s=48000:d=5',
    '-c:a',
    'pcm_s16le',
    music,
  ]);
  await writeFile(lut, IDENTITY_CUBE, 'utf8');
  const originalHashes = await Promise.all([clipOne, clipTwo, music, lut].map(hashFile));

  await ingestFiles(projectPath, [clipOne, clipTwo], 'clips');
  await ingestFiles(projectPath, [music], 'music');
  await ingestFiles(projectPath, [lut], 'technical-lut');
  await writeJson(path.join(projectPath, 'config/sources.json'), {
    schemaVersion: '1.0.0',
    sources: {
      'input/clips/SYNTHETIC_A.MP4': {
        manufacturer: 'Synthetic',
        model: 'Test Generator',
        gamma: 'Synthetic Log',
        gamut: 'Synthetic Gamut',
        profileId: 'synthetic-log-gamut',
        confirmed: true,
      },
      'input/clips/SYNTHETIC_B.MP4': {
        manufacturer: 'Synthetic',
        model: 'Test Generator',
        gamma: 'Synthetic Log',
        gamut: 'Synthetic Gamut',
        profileId: 'synthetic-log-gamut',
        confirmed: true,
      },
    },
  });
  const ingestedLut = path.join(projectPath, 'input/luts/technical/SYNTHETIC_IDENTITY.cube');
  await writeJson(path.join(projectPath, 'config/luts.json'), {
    schemaVersion: '1.0.0',
    luts: [
      {
        id: 'synthetic-to-rec709',
        kind: 'technical',
        file: 'input/luts/technical/SYNTHETIC_IDENTITY.cube',
        checksumSha256: await hashFile(ingestedLut),
        cameraModel: 'Test Generator',
        profileId: 'synthetic-log-gamut',
        inputGamma: 'Synthetic Log',
        inputGamut: 'Synthetic Gamut',
        inputColorSpace: 'Synthetic Log/Synthetic Gamut',
        outputColorSpace: 'Rec.709 Gamma 2.4',
        transformSemantics: 'normalization',
        defaultMix: 1,
      },
    ],
  });
  const manifest = await analyzeSources(projectPath);
  const sourceOne = manifest.sources.find((source) => source.relativePath.endsWith('SYNTHETIC_A.MP4'))!;
  const sourceTwo = manifest.sources.find((source) => source.relativePath.endsWith('SYNTHETIC_B.MP4'))!;
  const musicSource = manifest.sources.find((source) => source.relativePath.endsWith('SYNTHETIC_MUSIC.wav'))!;
  await writeJson(path.join(projectPath, 'edits/edit.json'), {
    schemaVersion: '1.0.0',
    reelName,
    output: {width: 1080, height: 1920, fps: 30},
    clips: [
      {
        id: 'synthetic-a',
        sourceId: sourceOne.id,
        inSeconds: 0.3,
        outSeconds: 2.3,
        playbackRate: 1,
        crop: {
          start: {x: 0.35, y: 0.5, scale: 1},
          end: {x: 0.65, y: 0.5, scale: 1.12},
        },
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
        grade: {
          exposureStops: 0,
          whiteBalanceKelvin: 6500,
          tint: 0,
          technicalLutId: 'synthetic-to-rec709',
          creativeLutId: null,
          combinedLutId: null,
          creativeMix: 0,
        },
        audio: {muted: true, gainDb: 0},
        transitionAfter: {type: 'fade', durationSeconds: 0.3},
      },
      {
        id: 'synthetic-b',
        sourceId: sourceTwo.id,
        inSeconds: 0.2,
        outSeconds: 2.2,
        playbackRate: 1,
        crop: {
          start: {x: 0.5, y: 0.45, scale: 1.05},
          end: {x: 0.5, y: 0.55, scale: 1.15},
        },
        stabilization: {enabled: false, strength: 0, fallbackToUnstabilized: true},
        grade: {
          exposureStops: 0,
          whiteBalanceKelvin: 6500,
          tint: 0,
          technicalLutId: 'synthetic-to-rec709',
          creativeLutId: null,
          combinedLutId: null,
          creativeMix: 0,
        },
        audio: {muted: true, gainDb: 0},
        transitionAfter: {type: 'none', durationSeconds: 0},
      },
    ],
    titles: [
      {
        text: 'SYNTHETIC / REEL',
        startSeconds: 0.2,
        durationSeconds: 1.4,
        position: 'center',
      },
    ],
    music: options.silent
      ? null
      : {sourceId: musicSource.id, startSeconds: 0.25, gainDb: -6},
    captions: null,
  });
  await confirmRights(projectPath);

  return {
    temporaryRoot,
    projectPath,
    reelName,
    originalFiles: [clipOne, clipTwo, music, lut],
    originalHashes,
    sourceIds: {
      clipOne: sourceOne.id,
      clipTwo: sourceTwo.id,
      music: musicSource.id,
    },
  };
};

export const runSyntheticE2e = async (
  engineRoot: string,
  options: {silent?: boolean; cleanup?: boolean} = {},
) => {
  const prepared = await prepareSyntheticReel(engineRoot, options);
  try {
    const {projectPath, originalFiles, originalHashes} = prepared;

    const preview = await renderPreview(projectPath, engineRoot);
    await approveEdit(projectPath);
    await generateGradedStills(projectPath);
    await approveColor(projectPath);
    const {master, delivery} = await renderMasterAndDelivery(projectPath, engineRoot);
    const renderIndexPath = path.join(projectPath, 'analysis/render-artifacts.json');
    const renderIndexBeforeRepeat = await import('node:fs/promises').then(({readFile}) =>
      readFile(renderIndexPath, 'utf8'),
    );
    await renderMasterAndDelivery(projectPath, engineRoot);
    const renderIndexAfterRepeat = await import('node:fs/promises').then(({readFile}) =>
      readFile(renderIndexPath, 'utf8'),
    );
    const renderArtifactsReused = renderIndexBeforeRepeat === renderIndexAfterRepeat;
    const previewQc = await runQc(projectPath, 'preview');
    const masterQc = await runQc(projectPath, 'master');
    const deliveryQc = await runQc(projectPath, 'delivery');
    const afterHashes = await Promise.all(originalFiles.map(hashFile));
    const originalsUnchanged = originalHashes.every((hash, index) => hash === afterHashes[index]);
    const result = {
      projectPath,
      outputs: {preview, master, delivery},
      qc: {preview: previewQc, master: masterQc, delivery: deliveryQc},
      originalsUnchanged,
      renderArtifactsReused,
      silent: options.silent === true,
    };
    if (
      !originalsUnchanged ||
      !renderArtifactsReused ||
      previewQc.failures.length ||
      masterQc.failures.length ||
      deliveryQc.failures.length
    ) {
      throw new Error(`Synthetic acceptance failed: ${JSON.stringify(result, null, 2)}`);
    }
    return result;
  } finally {
    if (options.cleanup) {
      await rm(prepared.temporaryRoot, {recursive: true, force: true});
    }
  }
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const engineRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  runSyntheticE2e(engineRoot)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${(error as Error).stack ?? (error as Error).message}\n`);
      process.exitCode = 1;
    });
}
