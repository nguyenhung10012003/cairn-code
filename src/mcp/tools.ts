/** Presents what MCP servers offer as ordinary tools. */
import { createHash } from 'node:crypto';
import type { JsonSchema } from '../core/provider.ts';
import type { Tool, ToolOutput } from '../tools/types.ts';

/** Past this many tools, definitions are loaded on demand. The API docs suggest 10 or more. */
export const DEFER_TOOLS_AT = 10;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_CHARS = 2048;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean };
}

export interface McpToolBackend {
  callTool(server: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput>;
}

export function mcpToolName(server: string, tool: string): string {
  const safe = tool.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `mcp__${server}__${safe}`;
  if (full.length <= MAX_TOOL_NAME_LENGTH) return full;
  // The API limits name length, so a long name keeps a hash of the original to stay unique.
  const hash = createHash('sha256').update(tool).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`;
}

/** Top-level `$schema` is metadata, and the API validates against its own draft. */
function cleanSchema(schema: JsonSchema | undefined): JsonSchema {
  const { $schema: _ignored, ...rest } = schema ?? {};
  return { type: 'object', ...rest };
}

export function buildMcpTool(server: string, info: McpToolInfo, backend: McpToolBackend, deferred: boolean): Tool {
  const readOnlyHint = info.annotations?.readOnlyHint === true;
  return {
    name: mcpToolName(server, info.name),
    description: (info.description ?? `Tool ${info.name} from MCP server ${server}.`).slice(0, MAX_DESCRIPTION_CHARS),
    inputSchema: cleanSchema(info.inputSchema),
    ...(deferred ? { deferred: true } : {}),
    isReadOnly: () => readOnlyHint,
    access: () => ({ kind: 'mcp', readOnlyHint }),
    execute: (input, ctx) => backend.callTool(server, info.name, input, ctx.signal),
  };
}

interface McpContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

/**
 * Tool results are text for now, so anything else is described rather than silently dropped:
 * the model needs to know a picture existed and that it cannot see it.
 */
export function renderMcpContent(content: readonly McpContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text ?? '';
        case 'image':
        case 'audio':
          return `[${block.type} result not shown: ${block.mimeType ?? 'unknown type'}, ${Buffer.byteLength(block.data ?? '', 'base64')} bytes]`;
        case 'resource': {
          const resource = block.resource;
          if (typeof resource?.text === 'string') return resource.text;
          return `[binary resource not shown: ${resource?.uri ?? 'unknown'} (${resource?.mimeType ?? 'unknown type'})]`;
        }
        case 'resource_link':
          return `[resource: ${block.name ?? ''} ${block.uri ?? ''}]`.replace(/ +/g, ' ');
        default:
          return `[unsupported ${block.type} result not shown]`;
      }
    })
    .join('\n');
}

export function formatToolResult(result: Record<string, unknown>): ToolOutput {
  const blocks = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
  let content = renderMcpContent(blocks);
  // Servers on the oldest protocol version answer with `toolResult`.
  const structured = result.structuredContent ?? result.toolResult;
  if (!content && structured !== undefined) content = JSON.stringify(structured, null, 2);
  return { content: content || '(no output)', ...(result.isError === true ? { isError: true } : {}) };
}
