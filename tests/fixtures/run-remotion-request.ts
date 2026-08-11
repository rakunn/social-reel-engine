import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJson} from '../../src/core/json';
import {
  exitCodeForRenderError,
  superviseRemotionRender,
} from '../../src/render/remotion-supervisor';
import {RemotionWorkerRequestSchema} from '../../src/render/remotion-worker';

const main = async (): Promise<void> => {
  const requestPath = process.argv[2];
  if (requestPath === undefined) {
    throw new Error('Usage: run-remotion-request.ts <request.json>');
  }
  const request = await readJson(requestPath, RemotionWorkerRequestSchema);
  await superviseRemotionRender(request, {
    onWorkerSpawn: (pid) => {
      process.stdout.write(`REMOTION_WORKER_STARTED ${pid}\n`);
    },
  });
};

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  await main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = exitCodeForRenderError(error);
  });
}
