import {Command, Option} from 'commander';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolveProjectPath} from './core/paths';
import {INPUT_KINDS, type InputKind} from './project/ingest';
import type {MediaOperationCommand, MediaOperationContext} from './project/operation';
import {exitCodeForRenderError} from './render/errors';

export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const project = (reelName: string): string => resolveProjectPath(ENGINE_ROOT, reelName);

const runTrackedMediaCommand = async <T>(
  reelName: string,
  command: MediaOperationCommand,
  phase: string,
  operation: (context: MediaOperationContext) => Promise<T>,
): Promise<T> => {
  const projectPath = project(reelName);
  const {assertProjectScaffold} = await import('./project/workspace');
  const {runMediaOperation} = await import('./project/operation');
  await assertProjectScaffold(projectPath);
  return await runMediaOperation(projectPath, command, async ({update, assertOwnership}) => {
    await update({phase});
    return await operation({update, assertOwnership});
  });
};

export const createCli = (): Command => {
  const program = new Command();
  program
    .name('reel')
    .description('Local FFmpeg + Remotion social video engine')
    .version('1.0.0')
    .showHelpAfterError();

  program
    .command('doctor')
    .description('Verify Node, Remotion, FFmpeg, librosa, and the local LUT library')
    .action(async () => {
      const {runDoctor} = await import('./commands/doctor');
      const report = await runDoctor(ENGINE_ROOT);
      print(report);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('new')
    .argument('<reel-name>')
    .option('--title <title>')
    .addOption(
      new Option('--format <format>', 'Video project format')
        .choices(['reel-9:16', 'carousel-1.91:1'])
        .default('reel-9:16'),
    )
    .description('Create a new isolated reel or carousel job from the template')
    .action(async (
      reelName: string,
      options: {title?: string; format: 'reel-9:16' | 'carousel-1.91:1'},
    ) => {
      const {createReelProject} = await import('./project/workspace');
      const projectPath = await createReelProject({
        engineRoot: ENGINE_ROOT,
        reelName,
        title: options.title,
        format: options.format,
      });
      print({created: projectPath});
    });

  program
    .command('ingest')
    .argument('<reel-name>')
    .argument('[files...]')
    .addOption(
      new Option('--kind <kind>', 'Input destination').choices([...INPUT_KINDS]).default('clips'),
    )
    .option('--library <ids...>', 'Install one or more IDs from library/lut-catalog.json')
    .option('--list-library', 'Print the local LUT catalog without copying files')
    .description('Copy immutable inputs or catalog LUTs into a reel job')
    .action(
      async (
        reelName: string,
        files: string[],
        options: {kind: InputKind; library?: string[]; listLibrary?: boolean},
      ) => {
        const {ingestFiles} = await import('./project/ingest');
        const {installCatalogLut, readLutCatalog} = await import('./project/library');
        if (options.listLibrary) {
          print(await readLutCatalog(ENGINE_ROOT));
          return;
        }
        const projectPath = project(reelName);
        const result = files.length
          ? await ingestFiles(projectPath, files.map((file) => path.resolve(file)), options.kind)
          : {added: [], unchanged: []};
        const installed = [];
        for (const id of options.library ?? []) {
          installed.push(await installCatalogLut(projectPath, ENGINE_ROOT, id));
        }
        print({...result, installed});
      },
    );

  program
    .command('analyze')
    .argument('<reel-name>')
    .description('Checksum and ffprobe every supplied input')
    .action(async (reelName: string) => {
      const {analyzeSources} = await import('./media/analyze');
      print(
        await runTrackedMediaCommand(reelName, 'analyze', 'checking-inputs', async () =>
          await analyzeSources(project(reelName)),
        ),
      );
    });

  program
    .command('proxy')
    .argument('<reel-name>')
    .description('Create normalized or visibly watermarked viewing proxies and contact sheets')
    .action(async (reelName: string) => {
      const {generateProxies} = await import('./media/proxy');
      print(
        await runTrackedMediaCommand(reelName, 'proxy', 'preparing-proxies', async ({update}) =>
          await generateProxies(project(reelName), new Date(), {
            onProgress: async (progress) => {
              await update({phase: 'transcoding-proxies', progress});
            },
          }),
        ),
      );
    });

  program
    .command('beats')
    .argument('<reel-name>')
    .description('Analyze supplied music beats and onsets with librosa')
    .action(async (reelName: string) => {
      const {analyzeMusic} = await import('./media/beats');
      print(
        await runTrackedMediaCommand(reelName, 'beats', 'analyzing-beats', async () =>
          await analyzeMusic(project(reelName), ENGINE_ROOT),
        ),
      );
    });

  program
    .command('validate-edit')
    .argument('<reel-name>')
    .description('Validate edit schema, bounds, rates, transitions, media, and duration')
    .action(async (reelName: string) => {
      const {validateEdit} = await import('./edit/validate');
      const result = await validateEdit(project(reelName));
      print(result);
      if (!result.valid) process.exitCode = 1;
    });

  program
    .command('preview')
    .argument('<reel-name>')
    .description('Render an H.264 rough-cut preview in the project format')
    .action(async (reelName: string) => {
      const {renderPreview} = await import('./render/remotion');
      print({
        preview: await runTrackedMediaCommand(reelName, 'preview', 'rendering-preview', async ({update}) =>
          await renderPreview(project(reelName), ENGINE_ROOT, {
            onActivity: async ({phase, progress = null}) => {
              await update({phase, progress});
            },
          }),
        ),
      });
    });

  program
    .command('approve-edit')
    .argument('<reel-name>')
    .description('Approve the exact current editorial hash')
    .action(async (reelName: string) => {
      const {approveEdit} = await import('./edit/approve');
      print(await approveEdit(project(reelName)));
    });

  program
    .command('grade-stills')
    .argument('<reel-name>')
    .description('Generate hash-bound graded reference PNGs for color review')
    .action(async (reelName: string) => {
      const {generateGradedStills} = await import('./media/grade');
      print(
        await runTrackedMediaCommand(reelName, 'grade-stills', 'generating-reference-stills', async ({update}) =>
          await generateGradedStills(project(reelName), new Date(), {
            onProgress: async (progress) => {
              await update({phase: 'generating-reference-stills', progress});
            },
          }),
        ),
      );
    });

  program
    .command('approve-color')
    .argument('<reel-name>')
    .description('Approve the exact current grade and LUT hash after reviewing reference frames')
    .action(async (reelName: string) => {
      const {approveColor} = await import('./edit/approve');
      print(await approveColor(project(reelName)));
    });

  program
    .command('confirm-rights')
    .argument('<reel-name>')
    .description('Record explicit user rights confirmation for the current used asset checksums')
    .action(async (reelName: string) => {
      const {confirmRights} = await import('./edit/rights');
      print(await confirmRights(project(reelName)));
    });

  program
    .command('grade')
    .argument('<reel-name>')
    .description('Create approved 10-bit ProRes shot intermediates with optional stabilization')
    .action(async (reelName: string) => {
      const {gradeSelectedClips} = await import('./media/grade');
      print(
        await runTrackedMediaCommand(reelName, 'grade', 'grading-selected-clips', async ({update}) =>
          await gradeSelectedClips(project(reelName), new Date(), {
            onProgress: async (progress) => {
              await update({phase: 'grading-selected-clips', progress});
            },
          }),
        ),
      );
    });

  program
    .command('render')
    .argument('<reel-name>')
    .description('Render the approved ProRes master and normalized H.264 delivery')
    .action(async (reelName: string) => {
      const {renderMasterAndDelivery} = await import('./render/remotion');
      print(
        await runTrackedMediaCommand(reelName, 'render', 'rendering-master', async ({update}) =>
          await renderMasterAndDelivery(project(reelName), ENGINE_ROOT, {
            onActivity: async ({phase, progress = null}) => {
              await update({phase, progress});
            },
          }),
        ),
      );
    });

  program
    .command('render-carousel')
    .argument('<reel-name>')
    .description('Render approved 1.91:1 carousel cards as ordered H.264 MP4 files')
    .action(async (reelName: string) => {
      const {renderCarouselPackage} = await import('./render/carousel');
      print(
        await runTrackedMediaCommand(
          reelName,
          'render-carousel',
          'rendering-carousel-cards',
          async ({update}) =>
            await renderCarouselPackage(project(reelName), ENGINE_ROOT, {
              onActivity: async ({phase, progress = null}) => {
                await update({phase, progress});
              },
            }),
        ),
      );
    });

  program
    .command('qc')
    .argument('<reel-name>')
    .addOption(
      new Option('--target <target>', 'Output to inspect')
        .choices(['preview', 'master', 'delivery'])
        .default('delivery'),
    )
    .description('Write machine-readable and human-readable output QC')
    .action(async (reelName: string, options: {target: 'preview' | 'master' | 'delivery'}) => {
      const {runQc} = await import('./media/qc-report');
      const report = await runTrackedMediaCommand(
        reelName,
        'qc',
        `checking-${options.target}`,
        async () => await runQc(project(reelName), options.target),
      );
      print(report);
      if (report.failures.length) process.exitCode = 1;
    });

  program
    .command('qc-carousel')
    .argument('<reel-name>')
    .description('Write consolidated machine-readable and human-readable QC for every carousel card')
    .action(async (reelName: string) => {
      const {runCarouselQc} = await import('./media/carousel-qc');
      const report = await runTrackedMediaCommand(
        reelName,
        'qc-carousel',
        'checking-carousel-cards',
        async () => await runCarouselQc(project(reelName)),
      );
      print(report);
      if (report.failures.length) process.exitCode = 1;
    });

  program
    .command('photos')
    .argument('<reel-name>')
    .option('--aspect <profiles...>', 'One or more photo profiles: 9:16, 4:5, 1:1, 16:9')
    .option('--count <count>', 'Number of photos per requested profile', Number.parseInt)
    .description('Create checksum-bound shareable JPEG stills after final video QC')
    .action(async (reelName: string, options: {aspect?: string[]; count?: number}) => {
      const {configurePhotoOutput, generatePhotos, readPhotoConfig} = await import('./media/photos');
      const projectPath = project(reelName);
      const result = await runTrackedMediaCommand(reelName, 'photos', 'creating-photo-candidates', async ({update}) => {
          const current = await readPhotoConfig(projectPath);
          const profiles = (options.aspect ?? (current.enabled ? current.profiles : ['9:16'])) as Array<
            '9:16' | '4:5' | '1:1' | '16:9'
          >;
          const config = await configurePhotoOutput(projectPath, {
            profiles,
            count: options.count ?? current.count,
          });
          await update({phase: 'rendering-photo-stills'});
          return {config, photos: await generatePhotos(projectPath, ENGINE_ROOT)};
        });
      print({photoConfig: result.config, ...result.photos});
    });

  program
    .command('approve-photos')
    .argument('<reel-name>')
    .description('Approve the exact current non-9:16 photo reframe contact sheets')
    .action(async (reelName: string) => {
      const {approvePhotoReframes} = await import('./media/photos');
      print(
        await runTrackedMediaCommand(
          reelName,
          'approve-photos',
          'approving-photo-reframes',
          async () => await approvePhotoReframes(project(reelName)),
        ),
      );
    });

  program
    .command('status')
    .argument('<reel-name>')
    .description('Show the current checkpoint and next action')
    .action(async (reelName: string) => {
      const {getProjectStatus} = await import('./project/workspace');
      print(await getProjectStatus(project(reelName)));
    });

  return program;
};

export const main = async (argv = process.argv): Promise<void> => {
  await createCli().parseAsync(argv);
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`Reel command failed: ${(error as Error).message}\n`);
    process.exitCode = exitCodeForRenderError(error);
  });
}
