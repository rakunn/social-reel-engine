import {access, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
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
import {
  approvePhotoReframes,
  configurePhotoOutput,
  generatePhotos,
  readPhotoOutputStatus,
} from '../src/media/photos';
import {runQc} from '../src/media/qc-report';
import {runCarouselQc} from '../src/media/carousel-qc';
import {ingestFiles} from '../src/project/ingest';
import {createReelProject, getProjectStatus} from '../src/project/workspace';
import {renderMasterAndDelivery, renderPreview} from '../src/render/remotion';
import {renderCarouselPackage} from '../src/render/carousel';

const IDENTITY_CUBE = `TITLE "Synthetic Identity"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`;

const prepareSyntheticReelAtRoot = async (
  engineRoot: string,
  temporaryRoot: string,
  options: {silent?: boolean; carousel?: boolean} = {},
) => {
  const reelName = options.carousel
    ? 'synthetic-carousel-acceptance'
    : options.silent
      ? 'synthetic-silent-acceptance'
      : 'synthetic-acceptance';
  const projectPath = await createReelProject({
    engineRoot,
    projectsRoot: path.join(temporaryRoot, 'projects'),
    reelName,
    title: options.carousel
      ? 'Synthetic Carousel Acceptance'
      : options.silent
        ? 'Synthetic Silent Acceptance Reel'
        : 'Synthetic Acceptance Reel',
    format: options.carousel ? 'carousel-1.91:1' : 'reel-9:16',
  });
  const sourceDirectory = path.join(temporaryRoot, 'originals');
  await import('node:fs/promises').then(({mkdir}) => mkdir(sourceDirectory, {recursive: true}));
  const clipOne = path.join(sourceDirectory, 'SYNTHETIC_A.MP4');
  const clipTwo = path.join(sourceDirectory, 'SYNTHETIC_B.MP4');
  const music = path.join(sourceDirectory, 'SYNTHETIC_MUSIC.wav');
  const lut = path.join(sourceDirectory, 'SYNTHETIC_IDENTITY.cube');
  const clipDuration = options.carousel ? '4.8' : '2.4';

  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=480x270:rate=30:duration=${clipDuration}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=330:sample_rate=48000:duration=${clipDuration}`,
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
    `sine=frequency=550:sample_rate=48000:duration=${clipDuration}`,
    '-t',
    clipDuration,
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
    output: options.carousel
      ? {width: 1910, height: 1000, fps: 30}
      : {width: 1080, height: 1920, fps: 30},
    clips: [
      {
        id: 'synthetic-a',
        sourceId: sourceOne.id,
        inSeconds: options.carousel ? 0.2 : 0.3,
        outSeconds: options.carousel ? 4.7 : 2.3,
        playbackRate: 1,
        crop: {
          start: options.carousel
            ? {x: 0.5, y: 0.5, scale: 1}
            : {x: 0.35, y: 0.5, scale: 1},
          end: options.carousel
            ? {x: 0.5, y: 0.5, scale: 1}
            : {x: 0.65, y: 0.5, scale: 1.12},
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
        transitionAfter: options.carousel
          ? {type: 'none', durationSeconds: 0}
          : {type: 'fade', durationSeconds: 0.3},
      },
      {
        id: 'synthetic-b',
        sourceId: sourceTwo.id,
        inSeconds: 0.2,
        outSeconds: options.carousel ? 4.7 : 2.2,
        playbackRate: 1,
        crop: {
          start: options.carousel
            ? {x: 0.5, y: 0.5, scale: 1}
            : {x: 0.5, y: 0.45, scale: 1.05},
          end: options.carousel
            ? {x: 0.5, y: 0.5, scale: 1}
            : {x: 0.5, y: 0.55, scale: 1.15},
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
    titles: options.carousel
      ? []
      : [
          {
            text: 'SYNTHETIC / REEL',
            startSeconds: 0.2,
            durationSeconds: 1.4,
            position: 'center',
          },
        ],
    music: options.silent || options.carousel
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

const withSyntheticTemporaryRoot = async <T>(
  cleanupAfterSuccess: boolean,
  operation: (temporaryRoot: string) => Promise<T>,
): Promise<T> => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'social-reel-e2e-'));
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation(temporaryRoot);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  if (operationFailed || cleanupAfterSuccess) {
    try {
      await rm(temporaryRoot, {recursive: true, force: true});
    } catch (cleanupError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, cleanupError],
          'Synthetic E2E failed and its temporary fixture could not be removed',
        );
      }
      throw cleanupError;
    }
  }
  if (operationFailed) throw operationError;
  return result as T;
};

export const prepareSyntheticReel = async (
  engineRoot: string,
  options: {silent?: boolean} = {},
) =>
  await withSyntheticTemporaryRoot(false, async (temporaryRoot) =>
    await prepareSyntheticReelAtRoot(engineRoot, temporaryRoot, options),
  );

export const runSyntheticE2e = async (
  engineRoot: string,
  options: {silent?: boolean; cleanup?: boolean} = {},
) =>
  await withSyntheticTemporaryRoot(options.cleanup === true, async (temporaryRoot) => {
    const prepared = await prepareSyntheticReelAtRoot(engineRoot, temporaryRoot, options);
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
    await configurePhotoOutput(projectPath, {profiles: ['9:16', '4:5'], count: 5});
    const photoCandidates = await generatePhotos(projectPath, engineRoot);
    if (
      !photoCandidates.awaitingApproval ||
      photoCandidates.completed ||
      photoCandidates.outputs.length !== 5
    ) {
      throw new Error('Synthetic photo candidates did not wait for 4:5 reframe approval');
    }
    await approvePhotoReframes(projectPath);
    const photos = await generatePhotos(projectPath, engineRoot);
    const photoPackage = JSON.parse(
      await readFile(path.join(projectPath, 'analysis/photos.json'), 'utf8'),
    );
    await writeJson(path.join(projectPath, 'analysis/photo-qc.json'), {
      schemaVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      fingerprint: photoPackage.fingerprint,
      checks: [],
      warnings: [],
      failures: ['synthetic cached-QC failure'],
    });
    if ((await readPhotoOutputStatus(projectPath)) !== 'ready') {
      throw new Error('Failed cached photo QC must make the package non-rendered');
    }
    await generatePhotos(projectPath, engineRoot);
    const recoveredPhotoQc = JSON.parse(
      await readFile(path.join(projectPath, 'analysis/photo-qc.json'), 'utf8'),
    );
    let photoStatus = await readPhotoOutputStatus(projectPath);
    const cachedPhotoQcRecovered =
      recoveredPhotoQc.failures.length === 0 && photoStatus === 'rendered';
    let stalePhotoOutputsPruned = true;
    if (!options.silent) {
      await configurePhotoOutput(projectPath, {profiles: ['9:16'], count: 3});
      const reduced = await generatePhotos(projectPath, engineRoot);
      const remaining = await readdir(path.join(projectPath, 'output/photos/9x16'));
      let removedProfileExists = true;
      try {
        await access(path.join(projectPath, 'output/photos/4x5'));
      } catch {
        removedProfileExists = false;
      }
      stalePhotoOutputsPruned =
        reduced.completed &&
        reduced.outputs.length === 3 &&
        remaining.sort().join(',') === '01.jpg,02.jpg,03.jpg' &&
        !removedProfileExists;
      photoStatus = await readPhotoOutputStatus(projectPath);
    }
    const afterHashes = await Promise.all(originalFiles.map(hashFile));
    const originalsUnchanged = originalHashes.every((hash, index) => hash === afterHashes[index]);
    const result = {
      projectPath,
      outputs: {preview, master, delivery, photos: photos.outputs},
      qc: {preview: previewQc, master: masterQc, delivery: deliveryQc},
      originalsUnchanged,
      renderArtifactsReused,
      photoStatus,
      cachedPhotoQcRecovered,
      stalePhotoOutputsPruned,
      silent: options.silent === true,
    };
    if (
      !originalsUnchanged ||
      !renderArtifactsReused ||
      previewQc.failures.length ||
      masterQc.failures.length ||
      deliveryQc.failures.length ||
      !photos.completed ||
      photos.outputs.length !== 10 ||
      photoStatus !== 'rendered' ||
      !cachedPhotoQcRecovered ||
      !stalePhotoOutputsPruned
    ) {
      throw new Error(`Synthetic acceptance failed: ${JSON.stringify(result, null, 2)}`);
    }
    return result;
  });

export const runSyntheticCarouselE2e = async (
  engineRoot: string,
  options: {cleanup?: boolean} = {},
) =>
  await withSyntheticTemporaryRoot(options.cleanup === true, async (temporaryRoot) => {
    const prepared = await prepareSyntheticReelAtRoot(engineRoot, temporaryRoot, {
      carousel: true,
    });
    const {projectPath, originalFiles, originalHashes} = prepared;

    await renderPreview(projectPath, engineRoot);
    await approveEdit(projectPath);
    await generateGradedStills(projectPath);
    await approveColor(projectPath);
    const packageRecord = await renderCarouselPackage(projectPath, engineRoot);
    const packagePath = path.join(projectPath, 'analysis/carousel.json');
    const packageBeforeRepeat = await import('node:fs/promises').then(({readFile}) =>
      readFile(packagePath, 'utf8'),
    );
    await renderCarouselPackage(projectPath, engineRoot);
    const packageAfterRepeat = await import('node:fs/promises').then(({readFile}) =>
      readFile(packagePath, 'utf8'),
    );
    const packageReused = packageBeforeRepeat === packageAfterRepeat;
    const qc = await runCarouselQc(projectPath);
    const status = await getProjectStatus(projectPath);
    const afterHashes = await Promise.all(originalFiles.map(hashFile));
    const originalsUnchanged = originalHashes.every((hash, index) => hash === afterHashes[index]);
    const cards = packageRecord.cards.map((card) => ({
      ...card,
      absolutePath: path.join(projectPath, ...card.file.split('/')),
    }));
    const result = {
      projectPath,
      cards,
      qc,
      status,
      originalsUnchanged,
      packageReused,
    };
    if (
      !originalsUnchanged ||
      !packageReused ||
      qc.failures.length > 0 ||
      cards.length !== 2 ||
      status.stage !== 'carousel-rendered'
    ) {
      throw new Error(`Synthetic carousel acceptance failed: ${JSON.stringify(result, null, 2)}`);
    }
    return result;
  });

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
