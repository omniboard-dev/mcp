import cp from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { ActionableCheckValidationResponse } from '../interface.js';

const execFile = promisify(cp.execFile);
const OUTPUT_PATH = './dist/omniboard.json';
const MAX_BUFFER_SIZE = 1 * 1024 * 1024;
const NPX_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export async function validateActionableCheckFix(
  name: string
): Promise<ActionableCheckValidationResponse> {
  const apiKey = process.env.OMNIBOARD_API_KEY;
  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  const command = `npx @omniboard/analyzer --ak <OMNIBOARD_API_KEY> --cp ${shellQuote(
    name
  )} --json`;

  if (!apiKey) {
    return {
      checkName: name,
      skipped: true,
      skipReason: 'OMNIBOARD_API_KEY environment variable was not provided.',
      command,
      outputPath: OUTPUT_PATH,
      generatedJsonCleanedUp: false,
    };
  }

  let stdout = '';
  let stderr = '';
  let response: Omit<
    ActionableCheckValidationResponse,
    'generatedJsonCleanedUp'
  >;
  let generatedJsonCleanedUp = false;

  try {
    const result = await execFile(
      NPX_COMMAND,
      ['@omniboard/analyzer', '--ak', apiKey, '--cp', name, '--json'],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: MAX_BUFFER_SIZE,
      }
    );
    stdout = result.stdout;
    stderr = result.stderr;

    const json = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const check = json?.checks?.[name];
    const stillMatches = check?.value === true;

    response = {
      checkName: name,
      skipped: false,
      command,
      outputPath: OUTPUT_PATH,
      value: check?.value,
      stillMatches,
      resolved: !stillMatches,
      result: check ?? null,
      stdout,
      stderr,
    };
  } finally {
    generatedJsonCleanedUp = await cleanupGeneratedJson(outputPath);
  }

  return {
    ...response!,
    generatedJsonCleanedUp,
  };
}

async function cleanupGeneratedJson(outputPath: string) {
  try {
    await fs.rm(outputPath, { force: true });
    await fs.rmdir(path.dirname(outputPath)).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
