import {access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {runProcess, type ProcessResult} from '../media/process';

export type ResolvedRemotionRuntime = {
  compositorPackage: string;
  compositorDirectory: string;
  ffprobePath: string;
  workerEnvironment: NodeJS.ProcessEnv;
};

export type ResolveRemotionRuntimeOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  resolvePackage?: (request: string) => string;
};

export type RemotionRuntimeCheck = {
  ok: boolean;
  message: string;
  runtime?: ResolvedRemotionRuntime;
};

export type CheckRemotionRuntimeOptions = {
  runtime?: ResolveRemotionRuntimeOptions;
  runProcess?: (
    command: string,
    args: readonly string[],
    options: {allowFailure: boolean; env: NodeJS.ProcessEnv},
  ) => Promise<ProcessResult>;
};

const compositorCandidates = (platform: NodeJS.Platform, arch: string): string[] => {
  if (platform === 'darwin') {
    return [`@remotion/compositor-darwin-${arch}`];
  }
  if (platform === 'linux') {
    return [
      `@remotion/compositor-linux-${arch}-gnu`,
      `@remotion/compositor-linux-${arch}-musl`,
    ];
  }
  return [];
};

const prependLibraryDirectory = (
  environment: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv => {
  const existing = environment.DYLD_LIBRARY_PATH
    ?.split(path.delimiter)
    .filter((entry) => entry.length > 0) ?? [];
  const values = [directory, ...existing.filter((entry) => entry !== directory)];
  return {...environment, DYLD_LIBRARY_PATH: values.join(path.delimiter)};
};

export const resolveRemotionRuntime = async (
  engineRoot: string,
  options: ResolveRemotionRuntimeOptions = {},
): Promise<ResolvedRemotionRuntime> => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const candidates = compositorCandidates(platform, arch);
  if (candidates.length === 0) {
    throw new Error(
      `No supported Remotion compositor package exists for ${platform}-${arch}; reinstall the local dependencies for this platform`,
    );
  }
  const resolvePackage =
    options.resolvePackage ??
    ((request: string): string =>
      createRequire(path.join(engineRoot, 'package.json')).resolve(request));
  let packageName: string | null = null;
  let packageJson: string | null = null;
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      packageJson = resolvePackage(`${candidate}/package.json`);
      packageName = candidate;
      break;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!packageName || !packageJson) {
    throw new Error(
      `Could not resolve the installed Remotion compositor (${candidates.join(' or ')}). Run npm install in ${engineRoot}. ${failures[0] ?? ''}`.trim(),
    );
  }
  const compositorDirectory = path.dirname(packageJson);
  const ffprobePath = path.join(compositorDirectory, 'ffprobe');
  try {
    await access(ffprobePath);
  } catch (error) {
    throw new Error(
      `Remotion compositor ${packageName} is missing its bundled ffprobe at ${ffprobePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const environment = {...(options.environment ?? process.env)};
  const workerEnvironment =
    platform === 'darwin'
      ? prependLibraryDirectory(environment, compositorDirectory)
      : environment;
  return {compositorPackage: packageName, compositorDirectory, ffprobePath, workerEnvironment};
};

export const checkRemotionRuntime = async (
  engineRoot: string,
  options: CheckRemotionRuntimeOptions = {},
): Promise<RemotionRuntimeCheck> => {
  try {
    const runtime = await resolveRemotionRuntime(engineRoot, options.runtime);
    const processRunner = options.runProcess ?? runProcess;
    const result = await processRunner(
      runtime.ffprobePath,
      ['-hide_banner', '-version'],
      {allowFailure: true, env: runtime.workerEnvironment},
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0 || !/ffprobe version/i.test(output)) {
      return {
        ok: false,
        message:
          `Remotion compositor ffprobe failed before render (${runtime.compositorPackage}, exit ${result.exitCode}). ` +
          'The render worker will use a compositor-local DYLD_LIBRARY_PATH; reinstall the matching Remotion compositor if this persists.',
      };
    }
    return {
      ok: true,
      message: `Remotion compositor runtime is ready (${runtime.compositorPackage})`,
      runtime,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Remotion compositor runtime is unavailable before render: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
