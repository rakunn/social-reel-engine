import {EventEmitter} from 'node:events';
import {describe, expect, it, vi} from 'vitest';
import {
  createRemotionCancellation,
  installWorkerSignalHandlers,
  runRawRemotionRender,
  serializeWorkerError,
  type RemotionWorkerRequest,
} from '../../src/render/remotion-worker';
import {DEFAULT_RENDER_SETTINGS} from '../../src/render/policy';

const request: RemotionWorkerRequest = {
  schemaVersion: '1.0.0',
  engineRoot: '/engine',
  publicDir: '/project/public',
  target: 'preview',
  rawOutput: '/project/work/render/preview-remotion.mp4',
  inputProps: {reelName: 'lifecycle-test'},
  settings: DEFAULT_RENDER_SETTINGS,
};

describe('Remotion worker lifecycle', () => {
  it('uses one browser, preserves preview options, and awaits browser closure', async () => {
    let releaseClose!: () => void;
    const close = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseClose = resolve;
      }),
    );
    const browser = {close};
    const composition = {id: 'SocialReel'};
    const selectComposition = vi.fn(async () => composition);
    const renderMedia = vi.fn(async (_options: unknown) => undefined);
    const bundle = vi.fn(async () => '/bundle');
    const openBrowser = vi.fn(async () => browser);
    let settled = false;

    const running = runRawRemotionRender(request, {
      bundle,
      openBrowser,
      selectComposition,
      renderMedia,
    }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(close).toHaveBeenCalledWith({silent: true}));
    expect(settled).toBe(false);
    expect(bundle).toHaveBeenCalledWith({
      entryPoint: '/engine/src/remotion/index.ts',
      publicDir: request.publicDir,
      rootDir: '/engine',
      enableCaching: true,
      symlinkPublicDir: true,
    });
    expect(openBrowser).toHaveBeenCalledWith('chrome', {
      logLevel: 'info',
      chromeMode: 'headless-shell',
    });
    expect(selectComposition).toHaveBeenCalledWith({
      serveUrl: '/bundle',
      id: 'SocialReel',
      inputProps: request.inputProps,
      timeoutInMilliseconds: 120_000,
      puppeteerInstance: browser,
    });
    expect(renderMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        serveUrl: '/bundle',
        composition,
        inputProps: request.inputProps,
        outputLocation: request.rawOutput,
        codec: 'h264',
        pixelFormat: 'yuv420p',
        imageFormat: 'jpeg',
        audioCodec: 'aac',
        colorSpace: 'bt709',
        scale: 0.5,
        crf: 20,
        audioBitrate: '192k',
        overwrite: true,
        enforceAudioTrack: true,
        logLevel: 'info',
        timeoutInMilliseconds: 120_000,
        puppeteerInstance: browser,
        cancelSignal: expect.any(Function),
      }),
    );

    releaseClose();
    await running;
  });

  it('preserves target-specific master render options', async () => {
    const close = vi.fn(async () => undefined);
    const renderMedia = vi.fn(async (_options: unknown) => undefined);
    await runRawRemotionRender(
      {
        ...request,
        target: 'master',
        rawOutput: '/project/work/render/master-remotion.mov',
      },
      {
        bundle: vi.fn(async () => '/bundle'),
        openBrowser: vi.fn(async () => ({close})),
        selectComposition: vi.fn(async () => ({id: 'SocialReel'})),
        renderMedia,
      },
    );

    const options = renderMedia.mock.calls[0]?.[0];
    expect(options).toEqual(
      expect.objectContaining({
        codec: 'prores',
        pixelFormat: 'yuv422p10le',
        imageFormat: 'png',
        audioCodec: 'pcm-16',
        colorSpace: 'bt709',
        scale: 1,
        proResProfile: 'hq',
        sampleRate: 48_000,
      }),
    );
    expect(options).not.toHaveProperty('crf');
    expect(options).not.toHaveProperty('audioBitrate');
    expect(close).toHaveBeenCalledWith({silent: true});
  });

  it('prepares and passes an owned browser launcher to Remotion', async () => {
    const prepareBrowserLauncher = vi.fn(async () => undefined);
    const openBrowser = vi.fn(async () => ({close: vi.fn(async () => undefined)}));
    const browserLifecycle = {
      launcherPath: '/project/work/render/.remotion-browser-launcher.cjs',
      pgidPath: '/project/work/render/.remotion-browser.pgid',
    };

    await runRawRemotionRender(
      {...request, browserLifecycle},
      {
        bundle: vi.fn(async () => '/bundle'),
        prepareBrowserLauncher,
        openBrowser,
        selectComposition: vi.fn(async () => ({id: 'SocialReel'})),
        renderMedia: vi.fn(async () => undefined),
      },
    );

    expect(prepareBrowserLauncher).toHaveBeenCalledWith(browserLifecycle);
    expect(openBrowser).toHaveBeenCalledWith('chrome', {
      logLevel: 'info',
      chromeMode: 'headless-shell',
      ...(process.platform === 'darwin'
        ? {}
        : {browserExecutable: browserLifecycle.launcherPath}),
    });
  });

  it('bounds browser closure so the supervisor can verify its process group', async () => {
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const forgetEventLoop = vi.fn();

    await expect(
      runRawRemotionRender(
        request,
        {
          bundle: vi.fn(async () => '/bundle'),
          openBrowser: vi.fn(async () => ({
            close,
            runner: {forgetEventLoop},
          })),
          selectComposition: vi.fn(async () => ({id: 'SocialReel'})),
          renderMedia: vi.fn(async () => undefined),
        },
        createRemotionCancellation(),
        {browserCloseTimeoutMs: 5},
      ),
    ).rejects.toThrow(/browser did not close within 5ms/i);
    expect(close).toHaveBeenCalledWith({silent: true});
    expect(forgetEventLoop).toHaveBeenCalledTimes(1);
  });

  it('reports both rendering and browser cleanup failures', async () => {
    const renderError = new Error('render failed');
    const closeError = new Error('close failed');
    let thrown: unknown;

    try {
      await runRawRemotionRender(request, {
        bundle: vi.fn(async () => '/bundle'),
        openBrowser: vi.fn(async () => ({
          close: vi.fn(async () => {
            throw closeError;
          }),
        })),
        selectComposition: vi.fn(async () => ({id: 'SocialReel'})),
        renderMedia: vi.fn(async () => {
          throw renderError;
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe(
      'Remotion render and browser cleanup both failed',
    );
    expect((thrown as AggregateError).errors).toEqual([renderError, closeError]);
  });

  it('serializes every nested aggregate error for the supervisor protocol', () => {
    const details = serializeWorkerError(
      new AggregateError(
        [new Error('render failed'), new Error('browser close failed')],
        'render and cleanup failed',
      ),
    );

    expect(details.message).toBe('render and cleanup failed');
    expect(details.stack).toMatch(/render failed/);
    expect(details.stack).toMatch(/browser close failed/);
  });

  it('cancels on the first signal and removes every installed handler', () => {
    const emitter = new EventEmitter();
    const cancel = vi.fn();
    const installed = installWorkerSignalHandlers(cancel, emitter);

    emitter.emit('SIGTERM');
    emitter.emit('SIGHUP');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(installed.receivedSignal()).toBe('SIGTERM');

    installed.remove();
    expect(emitter.listenerCount('SIGINT')).toBe(0);
    expect(emitter.listenerCount('SIGTERM')).toBe(0);
    expect(emitter.listenerCount('SIGHUP')).toBe(0);
  });

  it('does not open Chrome when cancellation arrives during bundling', async () => {
    let releaseBundle!: () => void;
    const bundle = vi.fn(
      () => new Promise<string>((resolve) => {
        releaseBundle = () => resolve('/bundle');
      }),
    );
    const openBrowser = vi.fn(async () => ({close: vi.fn(async () => undefined)}));
    const cancellation = createRemotionCancellation();
    const running = runRawRemotionRender(
      request,
      {
        bundle,
        openBrowser,
        selectComposition: vi.fn(async () => ({id: 'SocialReel'})),
        renderMedia: vi.fn(async () => undefined),
      },
      cancellation,
    );

    await vi.waitFor(() => expect(bundle).toHaveBeenCalledTimes(1));
    cancellation.cancel();
    releaseBundle();

    await expect(running).rejects.toThrow(/cancelled before browser launch/i);
    expect(openBrowser).not.toHaveBeenCalled();
  });
});
