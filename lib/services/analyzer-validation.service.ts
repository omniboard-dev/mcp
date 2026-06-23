import cp from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AgenticRunValidationResponse } from '../interface.js';
import {
  getAgenticRun,
  reportAgenticRunProgressSafely,
} from './agentic-runs.service.js';

const execFile = promisify(cp.execFile);
const OUTPUT_PATH = './dist/omniboard.json';
const MAX_BUFFER_SIZE = 1 * 1024 * 1024;
const NPX_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';

export async function validateAgenticRun(
  runKey: string,
): Promise<AgenticRunValidationResponse> {
  const apiKey = process.env.OMNIBOARD_API_KEY;
  const outputPath = path.resolve(process.cwd(), OUTPUT_PATH);
  const { run } = await getAgenticRun(runKey);
  const checkName = run.checkName;
  const command = `npx @omniboard/analyzer --ak <OMNIBOARD_API_KEY> --cp ${shellQuote(
    checkName,
  )} --json`;

  if (!apiKey) {
    const progressReport = await reportAgenticRunProgressSafely(run.runKey, {
      status: 'implemented',
      notes:
        'Analyzer validation was skipped because OMNIBOARD_API_KEY was not provided.',
      verification: {
        analyzer: {
          skipped: true,
          skipReason:
            'OMNIBOARD_API_KEY environment variable was not provided.',
        },
      },
    });

    return {
      checkName,
      runKey: run.runKey,
      run,
      skipped: true,
      skipReason: 'OMNIBOARD_API_KEY environment variable was not provided.',
      command,
      outputPath: OUTPUT_PATH,
      generatedJsonCleanedUp: false,
      progressReport,
    };
  }

  let stdout = '';
  let stderr = '';
  let response: Omit<AgenticRunValidationResponse, 'generatedJsonCleanedUp'>;
  let generatedJsonCleanedUp = false;

  const startedProgressReport = await reportAgenticRunProgressSafely(
    run.runKey,
    {
      status: 'implemented',
      notes: 'Analyzer validation started.',
    },
  );

  try {
    const result = await execFile(
      NPX_COMMAND,
      ['@omniboard/analyzer', '--ak', apiKey, '--cp', checkName, '--json'],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: MAX_BUFFER_SIZE,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;

    const json = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    const check = json?.checks?.[checkName];
    const stillMatches = check?.value === true;

    response = {
      checkName,
      runKey: run.runKey,
      run,
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
    response.progressReport = await reportAgenticRunProgressSafely(run.runKey, {
      status: stillMatches ? 'needs_input' : 'verified',
      error: stillMatches
        ? `Agentic check "${checkName}" still matches.`
        : null,
      notes: stillMatches
        ? `Analyzer validation completed and "${checkName}" still matches.`
        : `Analyzer validation completed and "${checkName}" is resolved.`,
      verification: {
        analyzer: {
          skipped: false,
          value: check?.value,
          stillMatches,
          resolved: !stillMatches,
          outputPath: OUTPUT_PATH,
        },
      },
    });
  } catch (error) {
    await reportAgenticRunProgressSafely(run.runKey, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      notes: 'Analyzer validation failed to complete.',
      verification: {
        analyzer: {
          skipped: false,
          failed: true,
          outputPath: OUTPUT_PATH,
        },
      },
    });
    throw error;
  } finally {
    generatedJsonCleanedUp = await cleanupGeneratedJson(outputPath);
  }

  return {
    ...response!,
    generatedJsonCleanedUp,
    progressReport: response!.progressReport ?? startedProgressReport,
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
