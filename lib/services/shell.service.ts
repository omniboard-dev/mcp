import cp from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(cp.exec);
const execFileAsync = promisify(cp.execFile);
const MAX_BUFFER_SIZE = 1 * 1024 * 1024;

export async function run(
  command: string,
  targetDir: string
): Promise<CommandResult> {
  return await execAsync(command, {
    cwd: targetDir,
    maxBuffer: MAX_BUFFER_SIZE,
  });
}

export async function runFile(
  command: string,
  args: string[],
  targetDir: string,
  env?: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return await execFileAsync(command, args, {
    cwd: targetDir,
    env: env ?? process.env,
    maxBuffer: MAX_BUFFER_SIZE,
  });
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}
