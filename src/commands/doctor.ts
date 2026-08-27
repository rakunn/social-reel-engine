import {access, stat, statfs as readStatfs} from 'node:fs/promises';
import path from 'node:path';
import {hashFile} from '../core/hash';
import {readJson} from '../core/json';
import {FFMPEG, FFPROBE} from '../media/ffmpeg';
import {
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../media/process';
import {LutDefinitionSchema} from '../contracts/schemas';
import {checkRemotionRuntime} from '../render/remotion-runtime';
import {findRenderInterruption} from '../render/errors';
import {SIPS, SRGB_PROFILE} from '../media/photo-conversion';
import {fontCacheStatus, readFontCatalog, readStyleCatalog} from '../style/library';

export type DoctorCheck = {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

type DoctorProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
) => Promise<ProcessResult>;

type StorageStats = {bsize: number | bigint; bavail: number | bigint};

export type DependencyMaterializationCheckOptions = {
  platform?: NodeJS.Platform;
  criticalRoots?: readonly string[];
  runProcess?: DoctorProcessRunner;
};

export type StorageCapacityCheckOptions = {
  statfs?: (target: string) => Promise<StorageStats>;
};

type DependencyMaterializationOutcome = {
  check: DoctorCheck;
  confirmedDataless: boolean;
};

export type RunDoctorOptions = {
  dependencyMaterialization?: DependencyMaterializationCheckOptions;
  storageCapacity?: StorageCapacityCheckOptions;
};

const GIBIBYTE = 1024 ** 3;
const MINIMUM_RENDER_SPACE_GIB = 8;
const RECOMMENDED_RENDER_SPACE_GIB = 40;

const defaultCriticalDependencyRoots = (engineRoot: string): string[] => [
  path.join(engineRoot, 'node_modules/@remotion'),
  path.join(engineRoot, 'node_modules/remotion'),
  path.join(engineRoot, 'node_modules/react'),
  path.join(engineRoot, 'node_modules/react-dom'),
  path.join(engineRoot, 'node_modules/tsx'),
  path.join(engineRoot, 'node_modules/typescript'),
  path.join(engineRoot, '.venv/lib/python3.11/site-packages/librosa'),
  path.join(engineRoot, '.venv/lib/python3.11/site-packages/numpy'),
  path.join(engineRoot, '.venv/lib/python3.11/site-packages/numba'),
  path.join(engineRoot, '.venv/lib/python3.11/site-packages/scipy'),
  path.join(engineRoot, '.venv/lib/python3.11/site-packages/soundfile.py'),
];

const inspectDependencyMaterialization = async (
  engineRoot: string,
  options: DependencyMaterializationCheckOptions = {},
): Promise<DependencyMaterializationOutcome> => {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      check: {
        id: 'dependency-materialization',
        status: 'pass',
        message: `macOS dataless dependency placeholders do not apply on ${platform}`,
      },
      confirmedDataless: false,
    };
  }
  const candidates = [...(options.criticalRoots ?? defaultCriticalDependencyRoots(engineRoot))];
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      roots.push(candidate);
    } catch {
      // Dedicated runtime and command checks report missing dependency roots more precisely.
    }
  }
  if (roots.length === 0) {
    return {
      check: {
        id: 'dependency-materialization',
        status: 'fail',
        message: 'No critical Remotion or Python dependency roots are installed',
      },
      confirmedDataless: false,
    };
  }
  try {
    const result = await (options.runProcess ?? runProcess)(
      '/usr/bin/find',
      [...roots, '-flags', '+dataless', '-print', '-quit'],
      {allowFailure: true, timeoutMs: 30_000},
    );
    if (result.exitCode !== 0) {
      return {
        check: {
          id: 'dependency-materialization',
          status: 'fail',
          message: `Could not inspect dependency materialization: ${result.stderr.trim() || `find exited ${result.exitCode}`}`,
        },
        confirmedDataless: false,
      };
    }
    const firstDatalessPath = result.stdout.trim().split('\n')[0];
    if (firstDatalessPath) {
      const relative = path.relative(engineRoot, firstDatalessPath).split(path.sep).join('/');
      return {
        check: {
          id: 'dependency-materialization',
          status: 'fail',
          message:
            `Critical dependency ${relative || firstDatalessPath} is a macOS dataless/offloaded placeholder. ` +
            'Materialize dependencies in a non-cloud-backed worktree before media work.',
        },
        confirmedDataless: true,
      };
    }
    return {
      check: {
        id: 'dependency-materialization',
        status: 'pass',
        message: `${roots.length} critical Remotion/Python dependency roots are materialized`,
      },
      confirmedDataless: false,
    };
  } catch (error) {
    if (findRenderInterruption(error)) throw error;
    return {
      check: {
        id: 'dependency-materialization',
        status: 'fail',
        message: `Could not inspect dependency materialization: ${(error as Error).message}`,
      },
      confirmedDataless: false,
    };
  }
};

export const dependencyMaterializationCheck = async (
  engineRoot: string,
  options: DependencyMaterializationCheckOptions = {},
): Promise<DoctorCheck> =>
  (await inspectDependencyMaterialization(engineRoot, options)).check;

export const storageCapacityCheck = async (
  engineRoot: string,
  options: StorageCapacityCheckOptions = {},
): Promise<DoctorCheck> => {
  try {
    const stats = await (options.statfs ?? readStatfs)(engineRoot);
    const availableGiB =
      (Number(stats.bavail) * Number(stats.bsize)) / GIBIBYTE;
    if (!Number.isFinite(availableGiB) || availableGiB < 0) {
      throw new Error('filesystem returned an invalid available-space value');
    }
    const formatted = availableGiB.toFixed(1);
    if (availableGiB < MINIMUM_RENDER_SPACE_GIB) {
      return {
        id: 'storage-capacity',
        status: 'fail',
        message: `${formatted} GiB is available; at least ${MINIMUM_RENDER_SPACE_GIB} GiB is required for safe render intermediates`,
      };
    }
    if (availableGiB < RECOMMENDED_RENDER_SPACE_GIB) {
      return {
        id: 'storage-capacity',
        status: 'warn',
        message: `${formatted} GiB is available; ${RECOMMENDED_RENDER_SPACE_GIB} GiB or more is recommended for repeated ProRes renders`,
      };
    }
    return {
      id: 'storage-capacity',
      status: 'pass',
      message: `${formatted} GiB is available for render intermediates`,
    };
  } catch (error) {
    return {
      id: 'storage-capacity',
      status: 'fail',
      message: `Could not inspect render storage capacity: ${(error as Error).message}`,
    };
  }
};

const REQUIRED_FFMPEG_FILTERS = [
  'blackdetect',
  'blend',
  'blurdetect',
  'boxblur',
  'colorbalance',
  'colortemperature',
  'drawbox',
  'drawtext',
  'eq',
  'exposure',
  'format',
  'fps',
  'freezedetect',
  'geq',
  'loudnorm',
  'lut3d',
  'maskedmerge',
  'metadata',
  'scale',
  'setparams',
  'signalstats',
  'split',
  'tile',
  'vidstabdetect',
  'vidstabtransform',
  'zscale',
] as const;

const REQUIRED_FFMPEG_ENCODERS = [
  'aac',
  'libx264',
  'pcm_s16le',
  'png',
  'prores_ks',
] as const;

const hasRequiredFfmpegFilters = (output: string): boolean => {
  const available = new Set(output.split(/\s+/));
  return REQUIRED_FFMPEG_FILTERS.every((name) => available.has(name));
};

const checkCommand = async (
  id: string,
  command: string,
  args: string[],
  predicate: (output: string) => boolean,
  success: string,
): Promise<DoctorCheck> => {
  try {
    const result = await runProcess(command, args, {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    return result.exitCode === 0 && predicate(output)
      ? {id, status: 'pass', message: success}
      : {id, status: 'fail', message: `${command} is present but lacks required capability`};
  } catch (error) {
    if (findRenderInterruption(error)) throw error;
    return {id, status: 'fail', message: `${command} is unavailable: ${(error as Error).message}`};
  }
};

const srgbProfileCheck = async (): Promise<DoctorCheck> => {
  try {
    const profile = await stat(SRGB_PROFILE);
    return profile.isFile() && profile.size > 0
      ? {
          id: 'srgb-profile',
          status: 'pass',
          message: `sRGB conversion profile is available at ${SRGB_PROFILE}`,
        }
      : {
          id: 'srgb-profile',
          status: 'fail',
          message: `sRGB conversion profile is not a readable file: ${SRGB_PROFILE}`,
        };
  } catch (error) {
    return {
      id: 'srgb-profile',
      status: 'fail',
      message: `sRGB conversion profile is unavailable at ${SRGB_PROFILE}: ${(error as Error).message}`,
    };
  }
};

const libraryCheck = async (engineRoot: string): Promise<DoctorCheck> => {
  try {
    const catalog = await readJson<{
      guide?: {file: string; checksumSha256: string};
      technical?: Array<{file: string; checksumSha256: string}>;
      creative?: Array<{file: string; checksumSha256: string}>;
      unclassified?: Array<{file: string; checksumSha256: string}>;
    }>(path.join(engineRoot, 'library/lut-catalog.json'));
    const entries = [
      ...(catalog.guide ? [catalog.guide] : []),
      ...(catalog.technical ?? []),
      ...(catalog.creative ?? []),
      ...(catalog.unclassified ?? []),
    ];
    const failures: string[] = [];
    for (const entry of [...(catalog.technical ?? []), ...(catalog.creative ?? [])]) {
      const parsed = LutDefinitionSchema.safeParse(entry);
      if (!parsed.success) {
        failures.push(`${entry.file} has invalid catalog metadata`);
      }
    }
    for (const entry of entries) {
      const filePath = path.join(engineRoot, entry.file);
      try {
        await access(filePath);
        if ((await hashFile(filePath)) !== entry.checksumSha256) {
          failures.push(`${entry.file} checksum mismatch`);
        }
      } catch {
        failures.push(`${entry.file} missing`);
      }
    }
    return failures.length
      ? {id: 'lut-library', status: 'warn', message: failures.join('; ')}
      : {
          id: 'lut-library',
          status: 'pass',
          message: `${entries.length} local LUT/guide assets match the tracked catalog`,
        };
  } catch {
    return {
      id: 'lut-library',
      status: 'warn',
      message: 'No optional local LUT catalog is available',
    };
  }
};

export const styleLibraryCheck = async (engineRoot: string): Promise<DoctorCheck> => {
  try {
    const [fonts, styles] = await Promise.all([
      readFontCatalog(engineRoot),
      readStyleCatalog(engineRoot),
    ]);
    const fontIds = new Set(fonts.fonts.map(({id}) => id));
    for (const preset of styles.presets) {
      for (const selection of Object.values(preset.typography)) {
        if (!fontIds.has(selection.assetId)) {
          throw new Error(
            `Style preset ${preset.id} references unknown font ${selection.assetId}`,
          );
        }
      }
    }
    const statuses = await Promise.all(
      fonts.fonts.map(async (asset) => ({asset, status: await fontCacheStatus(engineRoot, asset)})),
    );
    const corrupt = statuses.filter(({status}) => status === 'corrupt');
    if (corrupt.length > 0) {
      return {
        id: 'style-library',
        status: 'warn',
        message: `Cached font checksum mismatch or corrupt file: ${corrupt.map(({asset}) => asset.id).join(', ')}`,
      };
    }
    const cached = statuses.filter(({status}) => status === 'cached').length;
    return {
      id: 'style-library',
      status: 'pass',
      message: `Style catalogs are valid; ${cached}/${fonts.fonts.length} fonts cached locally`,
    };
  } catch (error) {
    return {
      id: 'style-library',
      status: 'fail',
      message: `Style library catalog validation failed: ${(error as Error).message}`,
    };
  }
};

export const runDoctor = async (
  engineRoot: string,
  options: RunDoctorOptions = {},
): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [];
  checks.push(
    process.version === 'v24.12.0'
      ? {id: 'node', status: 'pass', message: 'Node.js v24.12.0 matches the project pin'}
      : {
          id: 'node',
          status: 'fail',
          message: `Node.js v24.12.0 is required; current runtime is ${process.version}`,
        },
  );
  try {
    const packageJson = await readJson<{
      dependencies?: Record<string, string>;
    }>(path.join(engineRoot, 'package.json'));
    const versions = Object.entries(packageJson.dependencies ?? {}).filter(
      ([name]) => name === 'remotion' || name.startsWith('@remotion/'),
    );
    const mismatched = versions.filter(([, version]) => version !== '4.0.507');
    checks.push(
      versions.length > 0 && mismatched.length === 0
        ? {
            id: 'remotion-versions',
            status: 'pass',
            message: `${versions.length} Remotion packages are pinned to 4.0.507`,
          }
        : {
            id: 'remotion-versions',
            status: 'fail',
            message: `Remotion version mismatch: ${mismatched.map(([name, version]) => `${name}@${version}`).join(', ')}`,
          },
    );
  } catch (error) {
    checks.push({id: 'remotion-versions', status: 'fail', message: (error as Error).message});
  }
  const storageCapacity = await storageCapacityCheck(engineRoot, options.storageCapacity);
  const dependencyMaterialization = await inspectDependencyMaterialization(
    engineRoot,
    options.dependencyMaterialization,
  );
  checks.push(storageCapacity, dependencyMaterialization.check);
  if (dependencyMaterialization.confirmedDataless) {
    return {ok: false, checks};
  }
  const remotionRuntime = await checkRemotionRuntime(engineRoot);
  checks.push({
    id: 'remotion-runtime',
    status: remotionRuntime.ok ? 'pass' : 'fail',
    message: remotionRuntime.message,
  });

  checks.push(
    await checkCommand('ffmpeg', FFMPEG, ['-hide_banner', '-version'], (output) => /ffmpeg version/i.test(output), 'FFmpeg is available'),
  );
  checks.push(
    await checkCommand('ffprobe', FFPROBE, ['-hide_banner', '-version'], (output) => /ffprobe version/i.test(output), 'ffprobe is available'),
  );
  checks.push(
    await checkCommand(
      'sips',
      SIPS,
      ['--version'],
      (output) => /sips-\d+/i.test(output),
      'sips image conversion is available',
    ),
  );
  checks.push(await srgbProfileCheck());
  checks.push(
    await checkCommand(
      'ffmpeg-filters',
      FFMPEG,
      ['-hide_banner', '-filters'],
      hasRequiredFfmpegFilters,
      `FFmpeg has all ${REQUIRED_FFMPEG_FILTERS.length} pipeline filters`,
    ),
  );
  checks.push(
    await checkCommand(
      'ffmpeg-encoders',
      FFMPEG,
      ['-hide_banner', '-encoders'],
      (output) => {
        const available = new Set(output.split(/\s+/));
        return REQUIRED_FFMPEG_ENCODERS.every((name) => available.has(name));
      },
      `FFmpeg has all ${REQUIRED_FFMPEG_ENCODERS.length} pipeline encoders`,
    ),
  );
  checks.push(
    await checkCommand(
      'librosa',
      path.join(engineRoot, '.venv/bin/python'),
      ['-c', "import librosa; print(librosa.__version__)"],
      (output) => output.trim() === '0.11.0',
      'librosa 0.11.0 is installed in .venv',
    ),
  );
  checks.push(await libraryCheck(engineRoot));
  checks.push(await styleLibraryCheck(engineRoot));
  return {ok: checks.every((check) => check.status !== 'fail'), checks};
};
