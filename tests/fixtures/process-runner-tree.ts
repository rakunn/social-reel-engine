import {spawn} from 'node:child_process';

const mode = process.argv[2];

if (mode === 'idle-then-exit') {
  console.log(`group:${process.pid}`);
  setTimeout(() => process.exit(0), 500);
} else if (mode === 'leave-child' || mode === 'leave-child-error') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
    stdio: 'ignore',
  });
  child.unref();
  console.log(`group:${process.pid}`);
  console.log(`child:${child.pid}`);
  if (mode === 'leave-child-error') process.exitCode = 7;
} else {
  throw new Error(`Unknown process-runner fixture mode: ${mode ?? '<missing>'}`);
}
