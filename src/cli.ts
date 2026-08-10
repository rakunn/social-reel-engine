import {Command, Option} from 'commander';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runDoctor} from './commands/doctor';
import {resolveProjectPath} from './core/paths';
import {analyzeSources} from './media/analyze';
import {analyzeMusic} from './media/beats';
import {generateGradedStills, gradeSelectedClips} from './media/grade';
import {generateProxies} from './media/proxy';
import {runQc} from './media/qc-report';
import {approveColor, approveEdit} from './edit/approve';
import {validateEdit} from './edit/validate';
import {ingestFiles, INPUT_KINDS, type InputKind} from './project/ingest';
import {installCatalogLut, readLutCatalog} from './project/library';
import {createReelProject, getProjectStatus} from './project/workspace';
import {renderMasterAndDelivery, renderPreview} from './render/remotion';

export const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const project = (reelName: string): string => resolveProjectPath(ENGINE_ROOT, reelName);

export const createCli = (): Command => {
  const program = new Command();
  program
    .name('reel')
    .description('Local FFmpeg + Remotion social reel engine')
    .version('1.0.0')
    .showHelpAfterError();

  program
    .command('doctor')
    .description('Verify Node, Remotion, FFmpeg, librosa, and the local LUT library')
    .action(async () => {
      const report = await runDoctor(ENGINE_ROOT);
      print(report);
      if (!report.ok) process.exitCode = 1;
    });

  program
    .command('new')
    .argument('<reel-name>')
    .option('--title <title>')
    .description('Create a new isolated reel job from the template')
    .action(async (reelName: string, options: {title?: string}) => {
      const projectPath = await createReelProject({
        engineRoot: ENGINE_ROOT,
        reelName,
        title: options.title,
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
    .action(async (reelName: string) => print(await analyzeSources(project(reelName))));

  program
    .command('proxy')
    .argument('<reel-name>')
    .description('Create normalized or visibly watermarked viewing proxies and contact sheets')
    .action(async (reelName: string) => print(await generateProxies(project(reelName))));

  program
    .command('beats')
    .argument('<reel-name>')
    .description('Analyze supplied music beats and onsets with librosa')
    .action(async (reelName: string) => print(await analyzeMusic(project(reelName), ENGINE_ROOT)));

  program
    .command('validate-edit')
    .argument('<reel-name>')
    .description('Validate edit schema, bounds, rates, transitions, media, and duration')
    .action(async (reelName: string) => {
      const result = await validateEdit(project(reelName));
      print(result);
      if (!result.valid) process.exitCode = 1;
    });

  program
    .command('preview')
    .argument('<reel-name>')
    .description('Render a 540×960 H.264 rough-cut preview')
    .action(async (reelName: string) => print({preview: await renderPreview(project(reelName), ENGINE_ROOT)}));

  program
    .command('approve-edit')
    .argument('<reel-name>')
    .description('Approve the exact current editorial hash')
    .action(async (reelName: string) => print(await approveEdit(project(reelName))));

  program
    .command('grade-stills')
    .argument('<reel-name>')
    .description('Generate hash-bound graded reference PNGs for color review')
    .action(async (reelName: string) => print(await generateGradedStills(project(reelName))));

  program
    .command('approve-color')
    .argument('<reel-name>')
    .description('Approve the exact current grade and LUT hash after reviewing reference frames')
    .action(async (reelName: string) => print(await approveColor(project(reelName))));

  program
    .command('grade')
    .argument('<reel-name>')
    .description('Create approved 10-bit ProRes shot intermediates with optional stabilization')
    .action(async (reelName: string) => print(await gradeSelectedClips(project(reelName))));

  program
    .command('render')
    .argument('<reel-name>')
    .description('Render the approved ProRes master and normalized H.264 delivery')
    .action(async (reelName: string) =>
      print(await renderMasterAndDelivery(project(reelName), ENGINE_ROOT)),
    );

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
      const report = await runQc(project(reelName), options.target);
      print(report);
      if (report.failures.length) process.exitCode = 1;
    });

  program
    .command('status')
    .argument('<reel-name>')
    .description('Show the current checkpoint and next action')
    .action(async (reelName: string) => print(await getProjectStatus(project(reelName))));

  return program;
};

export const main = async (argv = process.argv): Promise<void> => {
  await createCli().parseAsync(argv);
};

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`Reel command failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
