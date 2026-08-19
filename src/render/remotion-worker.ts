import {bundle} from '@remotion/bundler';
import {
  ensureBrowser,
  makeCancelSignal,
  openBrowser,
  renderMedia,
  renderStill,
  selectComposition,
  type CancelSignal,
  type RenderMediaOptions,
} from '@remotion/renderer';
import {chmod, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJson, writeJson} from '../core/json';
import {renderOptionsFor} from './policy';
import {
  RemotionWorkerRequestSchema,
  RemotionWorkerResultSchema,
  type BrowserLifecycleFiles,
  type RemotionWorkerRequest,
  type RemotionWorkerResult,
  type WorkerSignal,
} from './remotion-protocol';

export {
  RemotionWorkerRequestSchema,
  RemotionWorkerResultSchema,
  type BrowserLifecycleFiles,
  type RemotionWorkerRequest,
  type RemotionWorkerResult,
  type WorkerSignal,
} from './remotion-protocol';

// Headless Shell is the reliable, non-GUI Remotion runtime on macOS and Linux.
// Chrome for Testing aborts on this managed macOS desktop before rendering.
const RENDER_CHROME_MODE = 'headless-shell' as const;

export const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 10_000;

type BrowserResource = {
  close(options: {silent: boolean}): Promise<void>;
  runner?: {
    forgetEventLoop(): void;
  };
};

type BundleInput = {
  entryPoint: string;
  publicDir: string;
  rootDir: string;
  enableCaching: boolean;
  symlinkPublicDir: boolean;
};

type SelectCompositionInput<Browser extends BrowserResource> = {
  serveUrl: string;
  id: string;
  inputProps: Record<string, unknown>;
  timeoutInMilliseconds: number;
  puppeteerInstance: Browser;
};

type RawRenderInput<Browser extends BrowserResource, Composition> = {
  serveUrl: string;
  composition: Composition;
  inputProps: Record<string, unknown>;
  outputLocation: string;
  codec: 'h264' | 'prores';
  pixelFormat: 'yuv420p' | 'yuv422p10le';
  imageFormat: 'jpeg' | 'png';
  audioCodec: 'aac' | 'pcm-16';
  colorSpace: 'bt709';
  scale: number;
  overwrite: true;
  enforceAudioTrack: true;
  logLevel: 'info';
  timeoutInMilliseconds: number;
  puppeteerInstance: Browser;
  cancelSignal: CancelSignal;
  crf?: number;
  audioBitrate?: string;
  proResProfile?: 'hq';
  sampleRate?: number;
};

type RawStillInput<Browser extends BrowserResource, Composition> = {
  serveUrl: string;
  composition: Composition;
  inputProps: Record<string, unknown>;
  output: string;
  imageFormat: 'jpeg';
  jpegQuality: number;
  overwrite: true;
  logLevel: 'info';
  timeoutInMilliseconds: number;
  puppeteerInstance: Browser;
  cancelSignal: CancelSignal;
};

export type RemotionWorkerDependencies<
  Browser extends BrowserResource = BrowserResource,
  Composition = unknown,
> = {
  bundle(options: BundleInput): Promise<string>;
  prepareBrowserLauncher?(lifecycle: BrowserLifecycleFiles): Promise<void>;
  openBrowser(
    browser: 'chrome',
    options: {
      logLevel: 'info';
      browserExecutable?: string;
      chromeMode?: 'chrome-for-testing' | 'headless-shell';
    },
  ): Promise<Browser>;
  selectComposition(options: SelectCompositionInput<Browser>): Promise<Composition>;
  renderMedia(options: RawRenderInput<Browser, Composition>): Promise<unknown>;
  renderStill?(options: RawStillInput<Browser, Composition>): Promise<unknown>;
};

type DefaultBrowser = Awaited<ReturnType<typeof openBrowser>>;
type DefaultComposition = Awaited<ReturnType<typeof selectComposition>>;

export const writeOwnedBrowserLauncher = async (
  lifecycle: BrowserLifecycleFiles,
  browserExecutable: string,
): Promise<void> => {
  const source = `#!/usr/bin/env node
const {spawn} = require('node:child_process');
const {writeFileSync} = require('node:fs');

const browserExecutable = ${JSON.stringify(browserExecutable)};
const pgidPath = ${JSON.stringify(lifecycle.pgidPath)};
writeFileSync(pgidPath, String(process.pid), 'utf8');

const browser = spawn(browserExecutable, process.argv.slice(2), {stdio: 'inherit'});
let settled = false;
browser.once('error', (error) => {
  if (settled) return;
  settled = true;
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
browser.once('close', (code, signal) => {
  if (settled) return;
  settled = true;
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code === null ? 1 : code;
});
`;
  await mkdir(path.dirname(lifecycle.launcherPath), {recursive: true});
  await writeFile(lifecycle.launcherPath, source, 'utf8');
  await chmod(lifecycle.launcherPath, 0o755);
};

const defaultDependencies: RemotionWorkerDependencies<DefaultBrowser, DefaultComposition> = {
  bundle: async (options) => await bundle(options),
  prepareBrowserLauncher: async (lifecycle) => {
    const status = await ensureBrowser({
      logLevel: 'info',
      chromeMode: RENDER_CHROME_MODE,
    });
    if (!('path' in status)) {
      throw new Error(`Remotion browser is unavailable: ${status.type}`);
    }
    await writeOwnedBrowserLauncher(lifecycle, status.path);
  },
  openBrowser: async (browser, options) => await openBrowser(browser, options),
  selectComposition: async (options) => await selectComposition(options),
  renderMedia: async (options) =>
    await renderMedia(options as RenderMediaOptions),
  renderStill: async (options) => await renderStill(options as never),
};

export type RemotionCancellation = {
  cancelSignal: CancelSignal;
  cancel(): void;
  isCancelled(): boolean;
};

export type RemotionWorkerRunOptions = {
  browserCloseTimeoutMs?: number;
};

export const createRemotionCancellation = (
  factory: typeof makeCancelSignal = makeCancelSignal,
): RemotionCancellation => {
  const underlying = factory();
  let cancelled = false;
  return {
    cancelSignal: underlying.cancelSignal,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      underlying.cancel();
    },
    isCancelled: () => cancelled,
  };
};

const cancellationCheckpoint = (
  cancellation: RemotionCancellation,
  phase: string,
): void => {
  if (cancellation.isCancelled()) {
    throw new Error(`Remotion render cancelled ${phase}`);
  }
};

export const runRawRemotionRender = async <
  Browser extends BrowserResource = DefaultBrowser,
  Composition = DefaultComposition,
>(
  rawRequest: RemotionWorkerRequest,
  dependencies: RemotionWorkerDependencies<Browser, Composition> =
    defaultDependencies as unknown as RemotionWorkerDependencies<Browser, Composition>,
  cancellation = createRemotionCancellation(),
  runOptions: RemotionWorkerRunOptions = {},
): Promise<void> => {
  const request = RemotionWorkerRequestSchema.parse(rawRequest);
  const serveUrl = await dependencies.bundle({
    entryPoint: path.join(request.engineRoot, 'src/remotion/index.ts'),
    publicDir: request.publicDir,
    rootDir: request.engineRoot,
    // Bundler caching does not distinguish disposable public directories. Photo renders use
    // namespaced staged media, so rebuild their bundle while retaining the stable public root.
    enableCaching: request.target !== 'photo',
    symlinkPublicDir: true,
  });
  cancellationCheckpoint(cancellation, 'before browser launch');

  if (request.browserLifecycle !== undefined) {
    if (dependencies.prepareBrowserLauncher === undefined) {
      throw new Error('Owned browser launcher preparation is unavailable');
    }
    await dependencies.prepareBrowserLauncher(request.browserLifecycle);
    cancellationCheckpoint(cancellation, 'before owned browser launch');
  }

  let browser: Browser | undefined;
  let renderFailed = false;
  let renderError: unknown;
  try {
    browser = await dependencies.openBrowser('chrome', {
      logLevel: 'info',
      chromeMode: RENDER_CHROME_MODE,
      ...(request.browserLifecycle === undefined || process.platform === 'darwin'
        ? {}
        : {browserExecutable: request.browserLifecycle.launcherPath}),
    });
    cancellationCheckpoint(cancellation, 'before composition selection');
    if (request.target === 'photo') {
      if (dependencies.renderStill === undefined) {
        throw new Error('Photo rendering is unavailable in this Remotion worker');
      }
      for (const photo of request.photoOutputs ?? []) {
        const composition = await dependencies.selectComposition({
          serveUrl,
          id: 'SharePhoto',
          inputProps: photo.inputProps,
          timeoutInMilliseconds: 120_000,
          puppeteerInstance: browser,
        });
        cancellationCheckpoint(cancellation, 'before photo rendering');
        await dependencies.renderStill({
          serveUrl,
          composition,
          inputProps: photo.inputProps,
          output: photo.output,
          imageFormat: 'jpeg',
          jpegQuality: photo.jpegQuality,
          overwrite: true,
          logLevel: 'info',
          timeoutInMilliseconds: 120_000,
          puppeteerInstance: browser,
          cancelSignal: cancellation.cancelSignal,
        });
      }
    } else {
      const composition = await dependencies.selectComposition({
        serveUrl,
        id: 'SocialReel',
        inputProps: request.inputProps,
        timeoutInMilliseconds: 120_000,
        puppeteerInstance: browser,
      });
      cancellationCheckpoint(cancellation, 'before media rendering');
      const options = renderOptionsFor(request.target, request.settings);
      await dependencies.renderMedia({
        serveUrl,
        composition,
        inputProps: request.inputProps,
        outputLocation: request.rawOutput,
        codec: options.codec,
        pixelFormat: options.pixelFormat,
        imageFormat: options.imageFormat,
        audioCodec: options.audioCodec,
        colorSpace: options.colorSpace,
        scale: options.scale,
        overwrite: true,
        enforceAudioTrack: true,
        logLevel: 'info',
        timeoutInMilliseconds: 120_000,
        puppeteerInstance: browser,
        cancelSignal: cancellation.cancelSignal,
        ...(request.target === 'preview'
          ? {crf: options.crf, audioBitrate: options.audioBitrate}
          : {proResProfile: options.proResProfile, sampleRate: options.sampleRate}),
      });
    }
  } catch (error) {
    renderFailed = true;
    renderError = error;
  }

  let closeFailed = false;
  let closeError: unknown;
  if (browser !== undefined) {
    const closeTimeoutMs = Math.max(
      0,
      runOptions.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
    );
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        browser.close({silent: true}),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(`Remotion browser did not close within ${closeTimeoutMs}ms`),
              ),
            closeTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      closeFailed = true;
      closeError = error;
      try {
        browser.runner?.forgetEventLoop();
      } catch (forgetError) {
        closeError = new AggregateError(
          [error, forgetError],
          'Remotion browser close and event-loop release both failed',
        );
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  if (renderFailed && closeFailed) {
    throw new AggregateError(
      [renderError, closeError],
      'Remotion render and browser cleanup both failed',
    );
  }
  if (renderFailed) throw renderError;
  if (closeFailed) throw closeError;
};

type WorkerSignalTarget = {
  on(signal: WorkerSignal, listener: () => void): unknown;
  off(signal: WorkerSignal, listener: () => void): unknown;
};

export const installWorkerSignalHandlers = (
  cancel: () => void,
  target: WorkerSignalTarget = process,
): {
  receivedSignal(): WorkerSignal | null;
  remove(): void;
} => {
  let received: WorkerSignal | null = null;
  const listeners = new Map<WorkerSignal, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const listener = () => {
      if (received !== null) return;
      received = signal;
      cancel();
    };
    listeners.set(signal, listener);
    target.on(signal, listener);
  }
  return {
    receivedSignal: () => received,
    remove: () => {
      for (const [signal, listener] of listeners) {
        target.off(signal, listener);
      }
    },
  };
};

const exitCodeForSignal = (signal: WorkerSignal | null): number => {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 1;
};

const describeNestedError = (error: unknown, seen: Set<unknown>): string => {
  if (seen.has(error)) return '[circular error]';
  if (error instanceof Error) {
    seen.add(error);
    const details = [error.stack ?? error.message];
    if (error instanceof AggregateError) {
      error.errors.forEach((nested, index) => {
        details.push(`Aggregate error ${index + 1}:\n${describeNestedError(nested, seen)}`);
      });
    }
    if (error.cause !== undefined) {
      details.push(`Caused by:\n${describeNestedError(error.cause, seen)}`);
    }
    return details.join('\n');
  }
  return String(error);
};

export const serializeWorkerError = (
  error: unknown,
): {message: string; stack: string | null} => {
  if (error instanceof Error) {
    return {message: error.message, stack: describeNestedError(error, new Set())};
  }
  return {message: String(error), stack: null};
};

export const runRemotionWorkerMain = async (
  requestPath: string,
  resultPath: string,
): Promise<RemotionWorkerResult> => {
  const cancellation = createRemotionCancellation();
  const handlers = installWorkerSignalHandlers(cancellation.cancel);
  let result: RemotionWorkerResult;
  let exitCode = 0;
  try {
    const request = await readJson(requestPath, RemotionWorkerRequestSchema);
    await runRawRemotionRender(request, defaultDependencies, cancellation);
    result = {schemaVersion: '1.0.0', ok: true};
  } catch (error) {
    const signal = handlers.receivedSignal();
    result = {
      schemaVersion: '1.0.0',
      ok: false,
      signal,
      error: serializeWorkerError(error),
    };
    exitCode = exitCodeForSignal(signal);
    console.error(result.error.stack ?? result.error.message);
  }

  try {
    const validated = RemotionWorkerResultSchema.parse(result);
    await writeJson(resultPath, validated);
    process.exitCode = exitCode;
    return validated;
  } finally {
    handlers.remove();
  }
};

const isDirectInvocation =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectInvocation) {
  const requestPath = process.argv[2];
  const resultPath = process.argv[3];
  if (requestPath === undefined || resultPath === undefined) {
    console.error('Usage: remotion-worker.ts <request.json> <result.json>');
    process.exitCode = 1;
  } else {
    await runRemotionWorkerMain(requestPath, resultPath).catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
