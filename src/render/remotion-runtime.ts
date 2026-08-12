import {access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {runProcess, type ProcessResult} from '../media/process';
import {findRenderInterruption} from './errors';

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
    options: {allowFailure: boolean; env: NodeJS.ProcessEnv; timeoutMs: number},
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
  if (platform === 'win32') {
    return [`@remotion/compositor-win32-${arch}-msvc`];
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

const resolveRemotionRuntimes = async (
  engineRoot: string,
  options: ResolveRemotionRuntimeOptions = {},
): Promise<ResolvedRemotionRuntime[]> => {
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
  const failures: string[] = [];
  const runtimes: ResolvedRemotionRuntime[] = [];
  const environment = {...(options.environment ?? process.env)};
  for (const candidate of candidates) {
    try {
      const packageJson = resolvePackage(`${candidate}/package.json`);
      const compositorDirectory = path.dirname(packageJson);
      const ffprobePath = path.join(
        compositorDirectory,
        platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      );
      await access(ffprobePath);
      const workerEnvironment =
        platform === 'darwin'
          ? prependLibraryDirectory(environment, compositorDirectory)
          : environment;
      runtimes.push({
        compositorPackage: candidate,
        compositorDirectory,
        ffprobePath,
        workerEnvironment,
      });
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (runtimes.length === 0) {
    throw new Error(
      `Could not resolve the installed Remotion compositor (${candidates.join(' or ')}). Run npm install in ${engineRoot}. ${failures.join(' ')}`.trim(),
    );
  }
  return runtimes;
};

export const resolveRemotionRuntime = async (
  engineRoot: string,
  options: ResolveRemotionRuntimeOptions = {},
): Promise<ResolvedRemotionRuntime> => {
  const [runtime] = await resolveRemotionRuntimes(engineRoot, options);
  return runtime;
};

export const checkRemotionRuntime = async (
  engineRoot: string,
  options: CheckRemotionRuntimeOptions = {},
): Promise<RemotionRuntimeCheck> => {
  try {
    const runtimes = await resolveRemotionRuntimes(engineRoot, options.runtime);
    const processRunner = options.runProcess ?? runProcess;
    const failures: string[] = [];
    for (const runtime of runtimes) {
      try {
        const result = await processRunner(
          runtime.ffprobePath,
          ['-hide_banner', '-version'],
          {allowFailure: true, env: runtime.workerEnvironment, timeoutMs: 30_000},
        );
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || !/ffprobe version/i.test(output)) {
          failures.push(`${runtime.compositorPackage}, exit ${result.exitCode}`);
          continue;
        }
        return {
          ok: true,
          message: `Remotion compositor runtime is ready (${runtime.compositorPackage})`,
          runtime,
        };
      } catch (error) {
        if (findRenderInterruption(error)) throw error;
        failures.push(
          `${runtime.compositorPackage}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      ok: false,
      message:
        `Remotion compositor ffprobe failed before render (${failures.join('; ')}). ` +
        'The render worker will use a compositor-local DYLD_LIBRARY_PATH; reinstall the matching Remotion compositor if this persists.',
    };
  } catch (error) {
    if (findRenderInterruption(error)) throw error;
    return {
      ok: false,
      message: `Remotion compositor runtime is unavailable before render: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
