import { run } from './shell.service.js';

export async function getCurrentBranch(
  targetDir: string = '.'
): Promise<string> {
  try {
    const { stdout } = await run(`git branch --show-current`, targetDir);
    return stdout.trim();
  } catch {
    return '';
  }
}
