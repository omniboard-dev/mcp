import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function runWorkspaceCredentialsIntegration(context: any) {
  const { root, withGitCredentials } = context;
  const workspaces = path.join(root, '.omniboard', 'mcp', 'workspaces');
  const targetDir = path.join(workspaces, 'credential-test-workspace');
  const unavailableAmbientTemp = path.join(root, 'ambient-temp-does-not-exist');
  const originalTempEnvironment = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  let temporaryDirectory: string | undefined;

  await fs.mkdir(workspaces, { recursive: true });
  try {
    process.env.TEMP = unavailableAmbientTemp;
    process.env.TMP = unavailableAmbientTemp;
    process.env.TMPDIR = unavailableAmbientTemp;

    await withGitCredentials(
      {
        provider: 'gitlab',
        host: 'gitlab.example.com',
        apiBaseUrl: 'https://gitlab.example.com/api/v4',
        token: 'test-token',
      },
      targetDir,
      async (env: NodeJS.ProcessEnv) => {
        assert(env.GIT_ASKPASS);
        assert(env.TEMP);
        assert.equal(env.TEMP, env.TMP);
        assert.equal(env.TEMP, env.TMPDIR);
        assert.equal(path.dirname(env.TEMP), workspaces);
        assert.equal(path.dirname(env.GIT_ASKPASS), env.TEMP);
        temporaryDirectory = env.TEMP;

        await fs.access(env.GIT_ASKPASS);
        assert.equal(
          await fs
            .readFile(env.GIT_ASKPASS, 'utf8')
            .then((content) => content.includes('test-token')),
          false
        );
      }
    );
  } finally {
    restoreEnvironmentVariable('TEMP', originalTempEnvironment.TEMP);
    restoreEnvironmentVariable('TMP', originalTempEnvironment.TMP);
    restoreEnvironmentVariable('TMPDIR', originalTempEnvironment.TMPDIR);
  }

  assert(temporaryDirectory);
  await assert.rejects(fs.access(temporaryDirectory), { code: 'ENOENT' });
  await assert.rejects(fs.access(unavailableAmbientTemp), { code: 'ENOENT' });
}

function restoreEnvironmentVariable(
  name: 'TEMP' | 'TMP' | 'TMPDIR',
  value: string | undefined
) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
