/**
 * Runs the real Anthropic SDK against a local server speaking the API's SSE format, so the
 * request sent and the parsing of responses are both exercised without network or cost. It
 * shows the code matches the documented protocol. It cannot show the live API agrees: for
 * that, see test/live/anthropic.live.ts.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'bun:test';
import { createRuntime } from '../src/core/runtime.ts';
import type { Message } from '../src/core/messages.ts';
import type { ProviderConfig, ProviderRequest, StreamEvent } from '../src/core/provider.ts';
import { AnthropicProvider, toApiMessages, toNeutralContent } from '../src/providers/anthropic.ts';
import { estimateCostUsd, modelSpec } from '../src/providers/anthropic-models.ts';
import { createProvider } from '../src/providers/index.ts';
import type { Prompter } from '../src/tools/types.ts';

const FAKE_KEY = 'sk-ant-test-not-a-real-key';
const MODEL = 'claude-opus-5-5';
const CLI = resolve(import.meta.dirname, '../src/cli.ts');

type Json = Record<string, any>;

interface ReplyBlock extends Json {
  type: string;
  /** Sent in deltas after the block starts. */
  stream?: string;
}

interface Reply {
  status?: number;
  body?: Json;
  /** Raw SSE to send verbatim, for malformed streams. */
  raw?: string;
  blocks?: ReplyBlock[];
  stop_reason?: string | null;
  stop_details?: Json | null;
  usage?: Json;
  model?: string;
  input_transformations?: Json[];
}

const served: { body: Json; headers: IncomingHttpHeaders }[] = [];
let replies: Reply[] = [];
let server: Server;
let baseUrl: string;

function sse(type: string, data: Json): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function renderStream(reply: Reply, requestModel: string): string {
  const usage: Json = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...reply.usage };
  let out = sse('message_start', {
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: reply.model ?? requestModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
      ...(reply.input_transformations ? { input_transformations: reply.input_transformations } : {}),
    },
  });
  (reply.blocks ?? []).forEach((block, index) => {
    const { stream, signature, ...start } = block;
    if (start.type === 'text') out += sse('content_block_start', { index, content_block: { text: '', citations: null, ...start, ...(stream !== undefined ? { text: '' } : {}) } });
    else if (start.type === 'thinking') out += sse('content_block_start', { index, content_block: { thinking: '', signature: '', ...start } });
    else if (start.type === 'tool_use' || start.type === 'server_tool_use') out += sse('content_block_start', { index, content_block: { input: {}, ...start } });
    else out += sse('content_block_start', { index, content_block: start });

    if (stream !== undefined) {
      if (start.type === 'text') out += sse('content_block_delta', { index, delta: { type: 'text_delta', text: stream } });
      if (start.type === 'thinking') out += sse('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: stream } });
      if (start.type === 'tool_use' || start.type === 'server_tool_use') out += sse('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: stream } });
    }
    if (start.type === 'thinking' && signature) out += sse('content_block_delta', { index, delta: { type: 'signature_delta', signature } });
    out += sse('content_block_stop', { index });
  });
  out += sse('message_delta', {
    delta: { stop_reason: reply.stop_reason === undefined ? 'end_turn' : reply.stop_reason, stop_sequence: null, ...(reply.stop_details ? { stop_details: reply.stop_details } : {}) },
    usage: { output_tokens: usage.output_tokens, ...(usage.server_tool_use ? { server_tool_use: usage.server_tool_use } : {}), ...(usage.iterations ? { iterations: usage.iterations } : {}) },
  });
  return out + sse('message_stop', {});
}

beforeAll(async () => {
  process.env.CAIRN_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-api-home-')));
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Json;
      served.push({ body, headers: req.headers });
      const reply = replies.shift() ?? { blocks: [{ type: 'text', stream: '(no reply queued)' }] };
      if (reply.status) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body ?? { type: 'error', error: { type: 'api_error', message: 'failed' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(reply.raw ?? renderStream(reply, body.model as string));
    });
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  served.length = 0;
  replies = [];
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
});

function provider(config: ProviderConfig = {}): AnthropicProvider {
  return new AnthropicProvider({ baseUrl, fullApiFeatures: true, maxRetries: 0, ...config });
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: MODEL,
    system: [{ text: 'stable prompt', cache: true }, { text: 'environment', cache: true }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 'Read', description: 'reads', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } } } }],
    maxTokens: 64_000,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function final(events: AsyncIterable<StreamEvent>): Promise<Extract<StreamEvent, { type: 'message_end' }>> {
  return (await drain(events)).at(-1) as Extract<StreamEvent, { type: 'message_end' }>;
}

/** The credential as sent. The SDK decides which header carries it, so accept either. */
function sentKey(index = 0): string | undefined {
  const { headers } = served[index]!;
  return (headers['x-api-key'] as string | undefined) ?? headers.authorization?.replace(/^Bearer /, '');
}

function betaHeader(index = 0): string[] {
  return String(served[index]!.headers['anthropic-beta'] ?? '').split(',').filter(Boolean);
}

describe('the request sent to the API', () => {
  it('sends the key from the environment', async () => {
    await drain(provider().stream(request()));
    assert.equal(sentKey(), FAKE_KEY);
  });

  it('marks the system prompt and the conversation tail for caching', async () => {
    await drain(provider().stream(request()));
    const { body } = served[0]!;
    assert.deepEqual(body.system, [
      { type: 'text', text: 'stable prompt', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'environment', cache_control: { type: 'ephemeral' } },
    ]);
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  });

  it('sends nothing to cache for a one-off request', async () => {
    await drain(provider().stream(request({ disableCache: true })));
    const { body } = served[0]!;
    assert.equal(body.cache_control, undefined);
    assert.ok(body.system.every((block: Json) => block.cache_control === undefined));
  });

  it('asks for summarized thinking, tolerant history checks, and an explicit effort', async () => {
    await drain(provider().stream(request()));
    const { body } = served[0]!;
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.ok(betaHeader().includes('thinking-binding-controls-2026-08-01'));
  });

  it('passes on a chosen effort', async () => {
    await drain(provider().stream(request({ effort: 'xhigh' })));
    assert.deepEqual(served[0]!.body.output_config, { effort: 'xhigh' });
  });

  it('turns on refusal fallback for models that support it', async () => {
    await drain(provider().stream(request()));
    assert.equal(served[0]!.body.fallbacks, 'default');
    assert.ok(betaHeader().includes('server-side-fallback-2026-07-01'));
  });

  it('leaves fallback off for models without it', async () => {
    await drain(provider().stream(request({ model: 'claude-haiku-5-5' })));
    assert.equal(served[0]!.body.fallbacks, undefined);
    assert.ok(!betaHeader().includes('server-side-fallback-2026-07-01'));
  });

  it('declares client tools with eager streaming', async () => {
    await drain(provider().stream(request()));
    assert.deepEqual(served[0]!.body.tools, [
      { name: 'Read', description: 'reads', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } }, eager_input_streaming: true },
    ]);
  });

  it('adds the web search server tool in the form the model accepts, with a limit', async () => {
    await drain(provider().stream(request({ serverTools: ['web_search'] })));
    assert.deepEqual(served[0]!.body.tools.at(-1), { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    await drain(provider().stream(request({ model: 'claude-haiku-5-5', serverTools: ['web_search'] })));
    assert.equal(served[1]!.body.tools.at(-1).type, 'web_search_20250305');
  });

  it('omits the tools field when there are none', async () => {
    await drain(provider().stream(request({ tools: [] })));
    assert.equal(served[0]!.body.tools, undefined);
  });

  it('does not send adaptive thinking or effort to older models that reject them', async () => {
    await drain(provider().stream(request({ model: 'claude-haiku-4-5' })));
    assert.equal(served[0]!.body.thinking, undefined);
    assert.equal(served[0]!.body.output_config, undefined);
  });

  it('caps max_tokens at the model limit', async () => {
    await drain(provider().stream(request({ model: 'claude-haiku-4-5', maxTokens: 128_000 })));
    assert.equal(served[0]!.body.max_tokens, 64_000);
  });

  it('never sends sampling parameters, which current models reject', async () => {
    await drain(provider().stream(request()));
    for (const name of ['temperature', 'top_p', 'top_k', 'tool_choice']) assert.equal(served[0]!.body[name], undefined, name);
  });

  it('through a custom base URL, sends only what any gateway should accept', async () => {
    await drain(new AnthropicProvider({ baseUrl, maxRetries: 0 }).stream(request({ serverTools: ['web_search'] })));
    const { body } = served[0]!;
    assert.equal(body.cache_control, undefined);
    assert.equal(body.fallbacks, undefined);
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].eager_input_streaming, undefined);
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.equal(served[0]!.headers['anthropic-beta'], undefined);
    assert.ok(body.system[0].cache_control, 'explicit cache markers are still safe');
  });

  it('treats ANTHROPIC_BASE_URL as a custom endpoint too', async () => {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
    await drain(new AnthropicProvider({ maxRetries: 0 }).stream(request()));
    assert.equal(served[0]!.body.fallbacks, undefined);
  });

  it('can read the key from a variable the user names', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.MY_GATEWAY_KEY = 'gateway-key';
    try {
      const custom = provider({ apiKeyEnv: 'MY_GATEWAY_KEY' });
      await drain(custom.stream(request()));
      assert.equal(sentKey(), 'gateway-key');
      assert.ok(custom.credentialEnvVars.includes('MY_GATEWAY_KEY'));
    } finally {
      delete process.env.MY_GATEWAY_KEY;
    }
  });
});

describe('reading the response', () => {
  it('streams text and thinking, and ends with the final message', async () => {
    replies = [{
      blocks: [
        { type: 'thinking', stream: 'considering', signature: 'sig123' },
        { type: 'text', stream: 'The answer' },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 },
    }];
    const events = await drain(provider().stream(request()));
    assert.deepEqual(events.filter((e) => e.type !== 'message_end'), [
      { type: 'thinking_delta', text: 'considering' },
      { type: 'text_delta', text: 'The answer' },
    ]);
    const end = events.at(-1) as Extract<StreamEvent, { type: 'message_end' }>;
    assert.equal(end.stopReason, 'end_turn');
    assert.deepEqual(end.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 50, webSearches: 0 });
    assert.deepEqual(end.content.at(-1), { type: 'text', text: 'The answer', extra: { citations: null } });
  });

  it('returns tool calls with parsed input', async () => {
    replies = [{ blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', stream: '{"file_path":"/a/b"}' }], stop_reason: 'tool_use' }];
    const events = await drain(provider().stream(request()));
    assert.deepEqual(events[0], { type: 'tool_use_start', id: 'toolu_1', name: 'Read' });
    const end = events.at(-1) as Extract<StreamEvent, { type: 'message_end' }>;
    assert.equal(end.stopReason, 'tool_use');
    assert.deepEqual(end.content, [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a/b' } }]);
  });

  const stopReasons: [string, string][] = [
    ['end_turn', 'end_turn'], ['stop_sequence', 'end_turn'], ['tool_use', 'tool_use'], ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'], ['refusal', 'refusal'], ['pause_turn', 'pause'], ['something_new', 'other'],
  ];
  for (const [api, neutral] of stopReasons) {
    it(`maps stop reason ${api} to ${neutral}`, async () => {
      replies = [{ blocks: [{ type: 'text', stream: 'x' }], stop_reason: api }];
      assert.equal((await final(provider().stream(request()))).stopReason, neutral);
    });
  }

  it('reports the reason for a refusal, and handles one before any output', async () => {
    replies = [{ blocks: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Not allowed.' } }];
    const end = await final(provider().stream(request()));
    assert.equal(end.stopReason, 'refusal');
    assert.equal(end.stopDetail, 'Not allowed.');
    assert.deepEqual(end.content, []);
  });

  it('copes with a refusal that has no details', async () => {
    replies = [{ blocks: [], stop_reason: 'refusal', stop_details: null }];
    const end = await final(provider().stream(request()));
    assert.equal(end.stopReason, 'refusal');
    assert.equal(end.stopDetail, undefined);
  });

  it('removes trailing thinking from a response cut off while thinking', async () => {
    replies = [{ blocks: [{ type: 'thinking', stream: 'hmm', signature: 's' }], stop_reason: 'max_tokens' }];
    assert.deepEqual((await final(provider().stream(request()))).content, []);
  });

  it('reports a web search as it happens, and counts it', async () => {
    replies = [{
      blocks: [
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', stream: '{"query":"node release"}' },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 't', url: 'https://x', encrypted_content: 'e' }] },
        { type: 'text', stream: 'Found it.' },
      ],
      usage: { server_tool_use: { web_search_requests: 2 } },
    }];
    const events = await drain(provider().stream(request({ serverTools: ['web_search'] })));
    assert.deepEqual(events.find((e) => e.type === 'server_tool'), { type: 'server_tool', name: 'WebSearch', summary: 'node release' });
    const end = events.at(-1) as Extract<StreamEvent, { type: 'message_end' }>;
    assert.equal(end.usage.webSearches, 2);
    assert.deepEqual(end.content.slice(0, 2).map((b) => b.type), ['opaque', 'opaque']);
  });

  it('reports a dropped thinking block only when the history itself changed', async () => {
    replies = [
      { blocks: [{ type: 'text', stream: 'x' }], input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }] },
      { blocks: [{ type: 'text', stream: 'x' }], input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' }] },
      { blocks: [{ type: 'text', stream: 'x' }], input_transformations: [] },
    ];
    assert.match((await final(provider().stream(request()))).notices![0]!, /dropped 1 earlier reasoning/);
    assert.equal((await final(provider().stream(request()))).notices, undefined);
    assert.equal((await final(provider().stream(request()))).notices, undefined);
  });
});

describe('fallback after a refusal', () => {
  const declined = { type: 'fallback', from: { model: MODEL }, to: { model: 'claude-opus-5' } };

  it('does not keep or run the tool call of the model that declined', () => {
    const content = toNeutralContent([
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'text', text: 'partial', citations: null },
      { type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: { command: 'rm -rf x' } },
      declined,
      { type: 'text', text: 'final', citations: null },
      { type: 'tool_use', id: 'toolu_good', name: 'Read', input: { file_path: 'a' } },
    ]);
    assert.deepEqual(content.map((b) => (b.type === 'tool_use' ? b.id : b.type === 'text' ? b.text : b.type)), ['partial', 'final', 'toolu_good']);
  });

  it('keeps a completed server-tool pair, but drops an unfinished call', () => {
    const content = toNeutralContent([
      { type: 'server_tool_use', id: 'done', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 'done', content: [] },
      { type: 'server_tool_use', id: 'unfinished', name: 'web_search', input: {} },
      { type: 'something_internal', data: 1 },
      declined,
      { type: 'text', text: 'final' },
    ]);
    const ids = content.filter((b) => b.type === 'opaque').map((b) => (b as { data: Json }).data.id ?? (b as { data: Json }).data.tool_use_id);
    assert.deepEqual(ids, ['done', 'done']);
  });

  it('only cuts at the last switch when there were several', () => {
    const content = toNeutralContent([
      { type: 'tool_use', id: 'first', name: 'Bash', input: {} },
      declined,
      { type: 'tool_use', id: 'second', name: 'Bash', input: {} },
      declined,
      { type: 'tool_use', id: 'third', name: 'Read', input: {} },
    ]);
    assert.deepEqual(content.map((b) => (b as { id: string }).id), ['third']);
  });

  it('says which model answered, and prices every attempt', async () => {
    replies = [{
      model: 'claude-opus-5',
      blocks: [declined, { type: 'text', stream: 'answer' }],
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        iterations: [
          { type: 'message', model: MODEL, input_tokens: 500, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
        ],
      },
    }];
    const end = await final(provider().stream(request()));
    assert.equal(end.servedBy, 'claude-opus-5');
    const expected = (500 * 4 + 10 * 20 + 1000 * 5 + 100 * 25) / 1_000_000;
    assert.ok(Math.abs(end.costUsd! - expected) < 1e-12, `${end.costUsd} vs ${expected}`);
  });
});

describe('replaying history', () => {
  it('sends thinking back byte for byte, signature included', async () => {
    replies = [
      { blocks: [{ type: 'thinking', stream: 'reasoning', signature: 'sig-abc' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', stream: '{"file_path":"/x"}' }], stop_reason: 'tool_use' },
      { blocks: [{ type: 'text', stream: 'done' }] },
    ];
    const first = await final(provider().stream(request()));
    const messages: Message[] = [
      ...request().messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }] },
    ];
    await drain(provider().stream(request({ messages })));
    const sent = served[1]!.body.messages as Json[];
    assert.deepEqual(sent[1], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig-abc' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } },
      ],
    });
    assert.deepEqual(sent[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }] });
  });

  it('sends citations and unknown fields back unchanged', () => {
    const citations = [{ type: 'web_search_result_location', url: 'https://x', title: 't', cited_text: 'c', encrypted_index: 'e' }];
    const content = toNeutralContent([
      { type: 'text', text: 'cited', citations },
      { type: 'tool_use', id: 't', name: 'Read', input: {}, caller: { type: 'direct' } },
      { type: 'redacted_thinking', data: 'opaque-bytes' },
      { type: 'text', text: 'end' },
    ]);
    assert.deepEqual(toApiMessages([{ role: 'assistant', content }]), [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'cited', citations },
        { type: 'tool_use', id: 't', name: 'Read', input: {}, caller: { type: 'direct' } },
        { type: 'redacted_thinking', data: 'opaque-bytes' },
        { type: 'text', text: 'end' },
      ],
    }]);
  });

  it('survives the trip through a saved session unchanged', () => {
    const content = toNeutralContent([
      { type: 'thinking', thinking: 'r', signature: 's' },
      { type: 'text', text: 'hi', citations: [{ a: 1 }] },
      { type: 'tool_use', id: 't', name: 'Read', input: { x: 1 } },
    ]);
    const direct = toApiMessages([{ role: 'assistant', content }]);
    const reloaded = toApiMessages(JSON.parse(JSON.stringify([{ role: 'assistant', content }])) as Message[]);
    assert.deepEqual(reloaded, direct);
  });

  it('marks failed tool results, and does not send another provider\'s blocks', () => {
    assert.deepEqual(
      toApiMessages([
        { role: 'assistant', content: [{ type: 'opaque', provider: 'openai', data: { secret: 1 } }, { type: 'text', text: 'x' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'bad', is_error: true }] },
        { role: 'assistant', content: [{ type: 'opaque', provider: 'openai', data: {} }] },
      ]),
      [
        { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'bad', is_error: true }] },
      ],
    );
  });

  it('drops empty text blocks, which the API rejects', () => {
    assert.deepEqual(toNeutralContent([{ type: 'text', text: '' }, { type: 'text', text: 'x' }]), [{ type: 'text', text: 'x' }]);
  });
});

describe('errors', () => {
  const failure = (status: number, type: string, message = 'details') => ({ status, body: { type: 'error', error: { type, message } } });

  const cases: [string, Reply, RegExp][] = [
    ['401', failure(401, 'authentication_error'), /rejected these credentials.*ANTHROPIC_API_KEY/],
    ['402', failure(402, 'billing_error'), /billing problem/],
    ['403', failure(403, 'permission_error', 'no access'), /not allowed.*no access/],
    ['404', failure(404, 'not_found_error', 'model: nope'), /Check the model name.*model: nope/],
    ['400', failure(400, 'invalid_request_error', 'bad field'), /HTTP 400.*bad field/],
    ['429', failure(429, 'rate_limit_error'), /Rate limited/],
    ['500', failure(500, 'api_error'), /HTTP 500/],
    ['529', failure(529, 'overloaded_error'), /HTTP 529/],
  ];
  for (const [status, reply, pattern] of cases) {
    it(`explains HTTP ${status} in plain words`, async () => {
      replies = [reply];
      await assert.rejects(drain(provider().stream(request())), pattern);
    });
  }

  it('retries rate limits and overloads before giving up', async () => {
    replies = [
      { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'x' } } },
      { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'x' } } },
      { blocks: [{ type: 'text', stream: 'recovered' }] },
    ];
    const end = await final(provider({ maxRetries: 2 }).stream(request()));
    assert.equal(served.length, 3);
    assert.deepEqual(end.content[0], { type: 'text', text: 'recovered', extra: { citations: null } });
  });

  it('never puts the key in an error message', async () => {
    replies = [failure(401, 'authentication_error')];
    await assert.rejects(drain(provider().stream(request())), (error: Error) => {
      assert.ok(!error.message.includes(FAKE_KEY));
      return true;
    });
  });

  it('says which variable to set when there are no credentials', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const client = provider();
    assert.match(client.configurationWarning()!, /ANTHROPIC_API_KEY is not set/);
    await assert.rejects(drain(client.stream(request())), /No API credentials found\. Set ANTHROPIC_API_KEY/);
    assert.equal(served.length, 0);
  });

  it('has no warning when credentials are present', () => {
    assert.equal(provider().configurationWarning(), undefined);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_AUTH_TOKEN = 'token';
    assert.equal(provider().configurationWarning(), undefined);
  });

  it('reports an unreachable API', async () => {
    await assert.rejects(drain(provider({ baseUrl: 'http://127.0.0.1:9' }).stream(request())), /Could not reach the Anthropic API/);
  });

  const unparseable = { blocks: [{ type: 'tool_use', id: 't', name: 'Read', stream: '{"a":"b" "c":"d"}' }], stop_reason: 'tool_use' };

  it('sends the turn again when the SDK cannot parse a tool input at all', async () => {
    replies = [unparseable, { blocks: [{ type: 'text', stream: 'second try' }] }];
    const end = await final(provider().stream(request()));
    assert.equal(served.length, 2);
    assert.deepEqual(end.content[0], { type: 'text', text: 'second try', extra: { citations: null } });
  });

  it('gives up on unparseable input after a limited number of tries', async () => {
    replies = [unparseable, unparseable, unparseable, unparseable];
    await assert.rejects(drain(provider().stream(request())), /Unable to parse tool parameter JSON/);
    assert.equal(served.length, 3);
  });

  it('does not retry an API error as if it were bad JSON', async () => {
    replies = [failure(400, 'invalid_request_error')];
    await assert.rejects(drain(provider().stream(request())), /HTTP 400/);
    assert.equal(served.length, 1);
  });

  it('stops promptly when interrupted', async () => {
    const hanging = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
    });
    await once(hanging.listen(0, '127.0.0.1'), 'listening');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const client = provider({ baseUrl: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}` });
    await assert.rejects(drain(client.stream(request({ signal: controller.signal }))));
    assert.ok(Date.now() - started < 3000);
    hanging.closeAllConnections();
    hanging.close();
  });
});

describe('model table and prices', () => {
  it('uses the default the user chose', () => {
    assert.equal(provider().defaultModel, 'claude-opus-5-5');
    assert.equal(createProvider().name, 'anthropic');
  });

  it('knows context windows, with a cautious default for unknown models', () => {
    assert.equal(provider().contextWindow(MODEL), 1_000_000);
    assert.equal(provider().contextWindow('claude-haiku-4-5'), 200_000);
    assert.equal(provider().contextWindow('claude-from-the-future'), 200_000);
  });

  const usage = (model: string, input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

  it('prices each kind of token at the published rate', () => {
    assert.equal(estimateCostUsd([usage(MODEL, 1_000_000)], 0), 4);
    assert.equal(estimateCostUsd([usage(MODEL, 0, 1_000_000)], 0), 20);
    assert.equal(estimateCostUsd([usage(MODEL, 0, 0, 1_000_000)], 0), 0.2);
    assert.equal(estimateCostUsd([usage(MODEL, 0, 0, 0, 1_000_000)], 0), 5);
    assert.equal(estimateCostUsd([usage('claude-sonnet-5-5', 0, 0, 1_000_000)], 0), 0.1);
    assert.equal(estimateCostUsd([usage('claude-fable-5-1', 0, 0, 1_000_000)], 0), 0.25);
  });

  it('charges web searches at $10 per thousand', () => {
    assert.equal(estimateCostUsd([usage(MODEL)], 1000), 10);
  });

  it('applies Haiku 5.5 long-prompt pricing past 100K tokens, counting cached input', () => {
    assert.equal(estimateCostUsd([usage('claude-haiku-5-5', 100_000)], 0), 0.01);
    assert.equal(estimateCostUsd([usage('claude-haiku-5-5', 100_001, 0)], 0), (100_001 * 0.5) / 1_000_000);
    const tiered = estimateCostUsd([usage('claude-haiku-5-5', 1000, 0, 100_000)], 0)!;
    assert.ok(Math.abs(tiered - (1000 * 0.5 + 100_000 * 0.05) / 1_000_000) < 1e-12);
  });

  it('gives no estimate rather than a wrong one for an unknown model', () => {
    assert.equal(estimateCostUsd([usage('claude-from-the-future', 100)], 0), undefined);
    assert.ok(modelSpec('claude-opus-5-5')?.serverFallback);
  });

  it('carries the estimate through the stream', async () => {
    replies = [{ blocks: [{ type: 'text', stream: 'x' }], usage: { input_tokens: 1_000_000, output_tokens: 0 } }];
    assert.equal((await final(provider().stream(request()))).costUsd, 4);
  });
});

describe('through the whole app', () => {
  const prompter: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };

  function dir(): string {
    return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-api-')));
  }

  it('runs a tool loop, replaying thinking, with stable tools and system prompt', async () => {
    const cwd = dir();
    const file = join(cwd, 'a.txt');
    writeFileSync(file, 'file body');
    replies = [
      { blocks: [{ type: 'thinking', stream: 'plan', signature: 's1' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', stream: JSON.stringify({ file_path: file }) }], stop_reason: 'tool_use' },
      { blocks: [{ type: 'text', stream: 'It says file body.' }] },
    ];
    const runtime = await createRuntime({ cwd, prompter, provider: provider() });
    const events = [];
    for await (const event of runtime.agent.run('read it', new AbortController().signal)) events.push(event);

    assert.equal(served.length, 2);
    assert.equal(JSON.stringify(served[0]!.body.system), JSON.stringify(served[1]!.body.system));
    assert.equal(JSON.stringify(served[0]!.body.tools), JSON.stringify(served[1]!.body.tools));
    const replay = served[1]!.body.messages as Json[];
    assert.deepEqual(replay[1]!.content[0], { type: 'thinking', thinking: 'plan', signature: 's1' });
    assert.match(replay[2]!.content[0].content, /file body/);
    assert.equal(events.filter((e) => e.type === 'thinking_delta').length, 1);
  });

  it('sends byte-identical history and system prompt after a resume', async () => {
    const cwd = dir();
    replies = [
      { blocks: [{ type: 'thinking', stream: 'plan', signature: 's1' }, { type: 'text', stream: 'one' }] },
      { blocks: [{ type: 'text', stream: 'two' }] },
    ];
    const first = await createRuntime({ cwd, prompter, provider: provider() });
    for await (const _ of first.agent.run('first', new AbortController().signal)) { /* drain */ }
    writeFileSync(join(cwd, 'CAIRN.md'), 'Instructions added later would change the prompt.');

    const second = await createRuntime({ cwd, prompter, provider: provider(), continueLast: true });
    for await (const _ of second.agent.run('second', new AbortController().signal)) { /* drain */ }

    assert.equal(JSON.stringify(served[0]!.body.system), JSON.stringify(served[1]!.body.system));
    assert.equal(JSON.stringify(served[0]!.body.tools), JSON.stringify(served[1]!.body.tools));
    assert.deepEqual((served[1]!.body.messages as Json[]).slice(0, 2), [
      served[0]!.body.messages[0],
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 's1' }, { type: 'text', text: 'one', citations: null }] },
    ]);
  });

  it('resends a paused server-tool turn with no extra user message', async () => {
    const cwd = dir();
    replies = [
      { blocks: [{ type: 'server_tool_use', id: 'srv', name: 'web_search', stream: '{"query":"q"}' }], stop_reason: 'pause_turn' },
      { blocks: [{ type: 'text', stream: 'done' }] },
    ];
    const runtime = await createRuntime({ cwd, prompter, provider: provider() });
    for await (const _ of runtime.agent.run('search', new AbortController().signal)) { /* drain */ }
    const resent = served[1]!.body.messages as Json[];
    assert.equal(resent.length, 2);
    assert.equal(resent.at(-1)!.role, 'assistant');
    assert.equal(resent.at(-1)!.content.at(-1).type, 'server_tool_use');
  });

  it('does not run a tool whose input the SDK silently cut short', async () => {
    const cwd = dir();
    const target = join(cwd, 'partial.txt');
    replies = [
      // The SDK's tolerant parser drops the unterminated string and raises no error.
      { blocks: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', stream: `{"file_path":${JSON.stringify(target)},"content":"cut sho` }], stop_reason: 'tool_use' },
      { blocks: [{ type: 'text', stream: 'I will retry.' }] },
    ];
    const runtime = await createRuntime({ cwd, prompter, provider: provider(), mode: 'bypassPermissions' });
    for await (const _ of runtime.agent.run('write it', new AbortController().signal)) { /* drain */ }
    assert.equal(existsSync(target), false);
    const result = (served[1]!.body.messages as Json[]).at(-1)!.content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /Invalid input for Write: input\.content is required/);
  });

  it('does not run a tool call cut off by max_tokens, even when it looks complete', async () => {
    const cwd = dir();
    const target = join(cwd, 'looks-complete.txt');
    replies = [
      { blocks: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', stream: JSON.stringify({ file_path: target, content: 'looks whole' }) }], stop_reason: 'max_tokens' },
      { blocks: [{ type: 'text', stream: 'ok' }] },
    ];
    const runtime = await createRuntime({ cwd, prompter, provider: provider(), mode: 'bypassPermissions' });
    for await (const _ of runtime.agent.run('write it', new AbortController().signal)) { /* drain */ }
    assert.equal(existsSync(target), false);
  });

  it('runs nothing from a refusal, and the next request stays valid', async () => {
    const cwd = dir();
    const target = join(cwd, 'refused.txt');
    replies = [
      { blocks: [{ type: 'tool_use', id: 'toolu_r', name: 'Write', stream: JSON.stringify({ file_path: target, content: 'x' }) }], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } },
      { blocks: [], stop_reason: 'refusal', stop_details: null },
      { blocks: [{ type: 'text', stream: 'fine' }] },
    ];
    const runtime = await createRuntime({ cwd, prompter, provider: provider(), mode: 'bypassPermissions' });
    for (const prompt of ['one', 'two', 'three']) {
      for await (const _ of runtime.agent.run(prompt, new AbortController().signal)) { /* drain */ }
    }
    assert.equal(existsSync(target), false);
    const last = served[2]!.body.messages as Json[];
    assert.ok(last.every((m) => m.role === 'user'), 'nothing from the refused turns was kept');
    assert.ok(last.every((m) => m.content.length > 0));
  });

  it('a compaction request carries only plain text and caches nothing', async () => {
    const cwd = dir();
    replies = [
      { blocks: [{ type: 'thinking', stream: 'p', signature: 's' }, { type: 'text', stream: 'one' }] },
      { blocks: [{ type: 'text', stream: 'SUMMARY' }] },
      { blocks: [{ type: 'text', stream: 'after' }] },
    ];
    const runtime = await createRuntime({ cwd, prompter, provider: provider() });
    for await (const _ of runtime.agent.run('first', new AbortController().signal)) { /* drain */ }
    await runtime.agent.compact('focus');
    for await (const _ of runtime.agent.run('next', new AbortController().signal)) { /* drain */ }

    const summarizer = served[1]!.body;
    assert.equal(summarizer.tools, undefined);
    assert.equal(summarizer.cache_control, undefined);
    assert.equal(typeof summarizer.messages[0].content[0].text, 'string');
    assert.doesNotMatch(JSON.stringify(served[2]!.body.messages), /"thinking"/);
    assert.match(JSON.stringify(served[2]!.body.messages), /SUMMARY/);
  });

  it('hides the key from commands, and from the transcript sent back, in a real CLI run', async () => {
    const cwd = dir();
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-api-home2-')));
    replies = [
      { blocks: [{ type: 'tool_use', id: 'toolu_env', name: 'Bash', stream: '{"command":"env"}' }], stop_reason: 'tool_use', usage: { input_tokens: 100_000, output_tokens: 0 } },
      { blocks: [{ type: 'text', stream: 'All done.' }], usage: { input_tokens: 0, output_tokens: 0 } },
    ];
    const settings = JSON.stringify({ provider: 'anthropic', providers: { anthropic: { baseUrl, maxRetries: 0 } } });
    const child = spawn(process.execPath, [CLI, '-p', 'print env', '--settings', settings, '--allowedTools', 'Bash(env)', '--output-format', 'json'], {
      cwd,
      env: { ...process.env, CAIRN_HOME: home, ANTHROPIC_API_KEY: FAKE_KEY },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const [code] = (await once(child, 'close')) as [number | null];
    assert.equal(code, 0, stderr);

    const result = JSON.parse(stdout) as Json;
    assert.equal(result.result, 'All done.');
    assert.equal(result.total_cost_usd, 0.4);
    assert.equal(served.length, 2);
    assert.equal(sentKey(), FAKE_KEY);
    const sentBack = JSON.stringify(served[1]!.body.messages);
    assert.match(sentBack, /CAIRN_HOME=/);
    assert.doesNotMatch(sentBack, new RegExp(FAKE_KEY));
  });
});
