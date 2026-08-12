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
} else if (mode === 'leave-stubborn-child') {
  const cleanupMarker = process.argv[3];
  if (cleanupMarker === undefined) {
    throw new Error('leave-stubborn-child requires a cleanup marker path');
  }
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const fs = require('node:fs'); const marker = process.argv[1]; process.on('SIGTERM', () => fs.writeFileSync(marker, 'term')); process.send('ready'); process.disconnect(); setInterval(() => undefined, 1_000)",
      cleanupMarker,
    ],
    {stdio: ['ignore', 'ignore', 'ignore', 'ipc']},
  );
  child.once('message', () => {
    child.unref();
    console.log(`group:${process.pid}`);
    console.log(`child:${child.pid}`);
  });
} else {
  throw new Error(`Unknown process-runner fixture mode: ${mode ?? '<missing>'}`);
}
