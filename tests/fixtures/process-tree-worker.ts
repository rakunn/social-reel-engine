import {spawn} from 'node:child_process';

const mode = process.argv[2];

if (!['leave-child', 'error-exit', 'ignore-term'].includes(mode ?? '')) {
  throw new Error(`Unknown process-tree fixture mode: ${mode ?? '<missing>'}`);
}

const childSource = `
  ${mode === 'ignore-term' ? "process.on('SIGTERM', () => undefined);" : ''}
  process.kill(process.ppid, 'SIGUSR2');
  setInterval(() => undefined, 1_000);
`;

await new Promise<void>((resolve, reject) => {
  const ready = () => {
    child.unref();
    console.log(child.pid);
    process.exitCode = mode === 'error-exit' ? 7 : 0;
    resolve();
  };
  process.once('SIGUSR2', ready);

  const child = spawn(process.execPath, ['-e', childSource], {stdio: 'ignore'});
  child.once('error', (error) => {
    process.off('SIGUSR2', ready);
    reject(error);
  });
});
