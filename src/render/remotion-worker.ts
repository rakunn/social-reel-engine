import {bundle} from '@remotion/bundler';
import {
  makeCancelSignal,
  openBrowser,
  renderMedia,
  selectComposition,
  type CancelSignal,
  type RenderMediaOptions,
} from '@remotion/renderer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {RenderSettingsSchema} from '../contracts/schemas';
import {readJson, writeJson} from '../core/json';
import {renderOptionsFor} from './policy';

export const RemotionWorkerRequestSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  engineRoot: z.string().min(1),
  target: z.enum(['preview', 'master']),
  rawOutput: z.string().min(1),
  inputProps: z.record(z.string(), z.unknown()),
  settings: RenderSettingsSchema,
});

export const RemotionWorkerResultSchema = z.discriminatedUnion('ok', [
  z.object({schemaVersion: z.literal('1.0.0'), ok: z.literal(true)}),
  z.object({
    schemaVersion: z.literal('1.0.0'),
    ok: z.literal(false),
    signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP']).nullable(),
    error: z.object({message: z.string(), stack: z.string().nullable()}),
  }),
]);

export type RemotionWorkerRequest = z.infer<typeof RemotionWorkerRequestSchema>;
export type RemotionWorkerResult = z.infer<typeof RemotionWorkerResultSchema>;
export type WorkerSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

type BrowserResource = {
  close(options: {silent: boolean}): Promise<void>;
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

export type RemotionWorkerDependencies<
  Browser extends BrowserResource = BrowserResource,
  Composition = unknown,
> = {
  bundle(options: BundleInput): Promise<string>;
  openBrowser(browser: 'chrome', options: {logLevel: 'info'}): Promise<Browser>;
  selectComposition(options: SelectCompositionInput<Browser>): Promise<Composition>;
  renderMedia(options: RawRenderInput<Browser, Composition>): Promise<unknown>;
};

type DefaultBrowser = Awaited<ReturnType<typeof openBrowser>>;
type DefaultComposition = Awaited<ReturnType<typeof selectComposition>>;

const defaultDependencies: RemotionWorkerDependencies<DefaultBrowser, DefaultComposition> = {
  bundle: async (options) => await bundle(options),
  openBrowser: async (browser, options) => await openBrowser(browser, options),
  selectComposition: async (options) => await selectComposition(options),
  renderMedia: async (options) =>
    await renderMedia(options as RenderMediaOptions),
};

export type RemotionCancellation = {
  cancelSignal: CancelSignal;
  cancel(): void;
  isCancelled(): boolean;
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
): Promise<void> => {
  const request = RemotionWorkerRequestSchema.parse(rawRequest);
  const serveUrl = await dependencies.bundle({
    entryPoint: path.join(request.engineRoot, 'src/remotion/index.ts'),
    publicDir: path.join(request.engineRoot, 'public'),
    rootDir: request.engineRoot,
    enableCaching: true,
    symlinkPublicDir: true,
  });
  cancellationCheckpoint(cancellation, 'before browser launch');

  let browser: Browser | undefined;
  let renderFailed = false;
  let renderError: unknown;
  try {
    browser = await dependencies.openBrowser('chrome', {logLevel: 'info'});
    cancellationCheckpoint(cancellation, 'before composition selection');
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
  } catch (error) {
    renderFailed = true;
    renderError = error;
  }

  let closeFailed = false;
  let closeError: unknown;
  if (browser !== undefined) {
    try {
      await browser.close({silent: true});
    } catch (error) {
      closeFailed = true;
      closeError = error;
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

const errorDetails = (error: unknown): {message: string; stack: string | null} => {
  if (error instanceof Error) {
    return {message: error.message, stack: error.stack ?? null};
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
      error: errorDetails(error),
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
