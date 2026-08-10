import {spawn} from 'node:child_process';

export type ProcessResult = {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const runProcess = async (
  command: string,
  args: readonly string[],
  options: {cwd?: string; allowFailure?: boolean; env?: NodeJS.ProcessEnv} = {},
): Promise<ProcessResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const result = {command, args: [...args], stdout, stderr, exitCode: exitCode ?? -1};
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `${command} exited with code ${result.exitCode}\n${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
