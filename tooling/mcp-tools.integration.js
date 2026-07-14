import assert from 'node:assert/strict';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: {
    ...process.env,
    OMNIBOARD_API_KEY_MCP: 'registration-test-key',
  },
});
const client = new Client({ name: 'runner-tools-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  assert(names.includes('omniboard_runner_list_agentic_runs'));
  assert(names.includes('omniboard_runner_list_agentic_run_projects'));
  assert(names.includes('omniboard_runner_prepare_agentic_run_workspace'));
  assert(names.includes('omniboard_runner_finalize_agentic_run_workspace'));
  assert(names.includes('omniboard_runner_report_agentic_run_progress'));

  const runnerProgressTool = tools.find(
    (tool) => tool.name === 'omniboard_runner_report_agentic_run_progress'
  );
  const progressProperties = runnerProgressTool.inputSchema.properties;
  for (const property of [
    'mergeRequestState',
    'mergeRequestDetailedStatus',
    'pipelineStatus',
    'pipelineUrl',
    'pipelineFailureSummary',
  ]) {
    assert(property in progressProperties);
  }

  console.log('Dedicated runner MCP tool registration test passed.');
} finally {
  await client.close();
}
