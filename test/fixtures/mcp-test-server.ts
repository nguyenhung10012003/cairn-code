/**
 * A real MCP server built on the official SDK, so tests exercise the actual protocol. Run
 * directly it speaks stdio; tests also mount it over HTTP. Environment variables pick behaviours.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const objectSchema = { type: 'object', properties: { text: { type: 'string' }, ms: { type: 'number' } } };

export function buildTestServer(): Server {
  const server = new Server(
    { name: 'fixture', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      instructions: 'Use echo for testing.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: { name: string; description: string; inputSchema: typeof objectSchema; annotations?: { readOnlyHint: boolean } }[] = [
      ...(process.env.FIXTURE_APPROVER ? [{ name: 'approve', description: 'Answers permission prompts.', inputSchema: { type: 'object', properties: {} } as unknown as typeof objectSchema }] : []),
      { name: 'echo', description: 'Echoes text back.', inputSchema: objectSchema, annotations: { readOnlyHint: true } },
      { name: 'write', description: 'Pretends to change something.', inputSchema: objectSchema },
      { name: 'fail', description: 'Reports a tool error.', inputSchema: objectSchema },
      { name: 'slow', description: 'Waits before answering.', inputSchema: objectSchema },
      { name: 'crash', description: 'Kills the server.', inputSchema: objectSchema },
      { name: 'image', description: 'Returns an image.', inputSchema: objectSchema },
      { name: 'structured', description: 'Returns only structured content.', inputSchema: objectSchema },
      { name: 'env', description: 'Returns the environment.', inputSchema: objectSchema },
      { name: 'roots', description: 'Asks the client for its roots.', inputSchema: objectSchema },
      { name: 'change_tools', description: 'Announces a tool list change.', inputSchema: objectSchema },
      { name: 'dotted.name', description: 'A name the API would reject as written.', inputSchema: { ...objectSchema, $schema: 'http://json-schema.org/draft-07/schema#' } as typeof objectSchema },
    ];
    const count = Number(process.env.FIXTURE_TOOL_COUNT ?? 0);
    for (let i = 0; i < count; i++) tools.push({ name: `extra_${i}`, description: `Extra tool ${i}.`, inputSchema: objectSchema });
    if (process.env.FIXTURE_EXTRA_TOOL_FILE && existsSync(process.env.FIXTURE_EXTRA_TOOL_FILE)) {
      tools.push({ name: 'added_later', description: 'Appeared after a change.', inputSchema: objectSchema });
    }
    return { tools: process.env.FIXTURE_ONLY_ECHO ? tools.slice(0, 1) : tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as { text?: string; ms?: number };
    switch (request.params.name) {
      case 'echo':
      case 'write':
      case 'dotted.name':
        return { content: [{ type: 'text', text: `echo: ${args.text ?? ''}` }] };
      case 'fail':
        return { content: [{ type: 'text', text: 'it went wrong' }], isError: true };
      case 'approve': {
        const call = args as { tool_name?: string; input?: { command?: string } };
        const allowed = call.tool_name === 'Bash' && !call.input?.command?.includes('forbidden');
        return { content: [{ type: 'text', text: JSON.stringify(allowed ? { behavior: 'allow' } : { behavior: 'deny', message: 'the approver said no' }) }] };
      }
      case 'slow':
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, args.ms ?? 30_000);
          extra.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return { content: [{ type: 'text', text: 'finished waiting' }] };
      case 'crash':
        process.exit(3);
        break;
      case 'image':
        return { content: [{ type: 'text', text: 'here is a picture' }, { type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }] };
      case 'structured':
        return { content: [], structuredContent: { answer: 42 } };
      case 'env':
        return { content: [{ type: 'text', text: JSON.stringify(process.env) }] };
      case 'roots': {
        const result = await server.listRoots();
        return { content: [{ type: 'text', text: JSON.stringify(result.roots) }] };
      }
      case 'change_tools':
        await server.sendToolListChanged();
        return { content: [{ type: 'text', text: 'announced' }] };
    }
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'test://hello', name: 'Hello', description: 'A greeting.' },
      { uri: 'test://blob', name: 'Blob' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === 'test://hello') return { contents: [{ uri, text: 'hello from a resource', mimeType: 'text/plain' }] };
    if (uri === 'test://blob') return { contents: [{ uri, blob: 'QUJD', mimeType: 'application/octet-stream' }] };
    throw new Error(`No such resource: ${uri}`);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'greet', description: 'Greets someone.', arguments: [{ name: 'who', required: true }, { name: 'tone' }] }],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Greet ${request.params.arguments?.who} in a ${request.params.arguments?.tone ?? 'plain'} tone.` } }],
  }));

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.FIXTURE_STDERR) process.stderr.write(`${process.env.FIXTURE_STDERR}\n`);
  if (process.env.FIXTURE_EXIT) process.exit(Number(process.env.FIXTURE_EXIT));
  if (process.env.FIXTURE_HANG) {
    setInterval(() => {}, 1000);
  } else {
    await buildTestServer().connect(new StdioServerTransport());
  }
}
