import { McpServer as McpCliSdkServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface McpCliToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<unknown> | unknown;
}

export function registerMcpCliTool(
  mcpCliServer: McpCliSdkServer,
  {
    name,
    description,
    inputSchema,
    outputSchema,
    handler,
  }: McpCliToolDefinition
) {
  mcpCliServer.registerTool(
    name,
    {
      description,
      inputSchema,
      outputSchema,
    },
    async (args) => {
      try {
        return createStructuredToolResult(await handler(args));
      } catch (error) {
        return asErrorContent(error);
      }
    }
  );
}

export function createStructuredToolResult(data: unknown) {
  const text = JSON.stringify(data, null, 2);
  if (text === undefined) {
    throw new Error('MCP CLI tool result is not JSON serializable.');
  }
  const structuredContent = JSON.parse(text);
  if (
    !structuredContent ||
    typeof structuredContent !== 'object' ||
    Array.isArray(structuredContent)
  ) {
    throw new Error('MCP CLI tool result must be a JSON object.');
  }

  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
    structuredContent,
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
