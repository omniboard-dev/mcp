import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (args: any) => Promise<unknown> | unknown;
}

export function registerTool(
  server: McpServer,
  { name, description, inputSchema, handler }: McpToolDefinition
) {
  server.tool(name, description, inputSchema, async (args) => {
    try {
      return asJsonContent(await handler(args));
    } catch (error) {
      return asErrorContent(error);
    }
  });
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
