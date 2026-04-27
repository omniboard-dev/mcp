#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  getActionableCheckResults,
  listActionableChecks,
} from './services/actionable-checks.service.js';

const server = new McpServer({
  name: '@omniboard/mcp',
  version: '1.0.0',
});

server.tool(
  'omniboard_list_actionable_checks',
  'List actionable Omniboard checks that currently have results for the resolved project.',
  {},
  async () => {
    try {
      const result = await listActionableChecks();
      return asJsonContent(result);
    } catch (error) {
      return asErrorContent(error);
    }
  }
);

server.tool(
  'omniboard_get_actionable_check_results',
  'Get actionable prompt and check results for an actionable Omniboard check by name.',
  {
    name: z.string().min(1),
  },
  async ({ name }) => {
    try {
      const result = await getActionableCheckResults(name);
      return asJsonContent(result);
    } catch (error) {
      return asErrorContent(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function asJsonContent(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function asErrorContent(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
