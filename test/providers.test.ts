/**
 * The OpenAI and Ollama providers against local servers that speak each API's streaming
 * format, so the requests sent and the parsing of replies are both exercised without network
 * or cost. They show the code matches the documented protocols, not that the live APIs agree.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'bun:test';
import type { ContentBlock, Message } from '../src/core/messages.ts';
import type { ProviderRequest, StreamEvent } from '../src/core/provider.ts';
import { createRuntime } from '../src/core/runtime.ts';
import { createProvider } from '../src/providers/index.ts';
import { buildOllamaRequest, ollamaHost, OllamaProvider, toOllamaMessages } from '../src/providers/ollama.ts';
import { estimateOpenAICostUsd, OpenAIProvider, toOpenAIInput } from '../src/providers/openai.ts';
import type { Prompter } from '../src/tools/types.ts';

type Json = Record<string, any>;

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** The response body, sent as is. */
  body: string;
}

const requests: { path: string; headers: Headers; body: Json }[] = [];
let replies: Reply[] = [];
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({ path: new URL(request.url).pathname, headers: request.headers, body: (await request.json()) as Json });
      const reply = replies.shift() ?? { status: 500, body: '{"error":"no reply scripted"}' };
      return new Response(reply.body, { status: reply.status ?? 200, headers: reply.headers ?? {} });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
  requests.length = 0;
  replies = [];
});

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'gpt-6-astra',
    system: [{ text: 'Shared part.', cache: true }, { text: 'Session part.', cache: true }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    maxTokens: 64_000,
    ...overrides,
  };
}

const end = (events: StreamEvent[]): Extract<StreamEvent, { type: 'message_end' }> =>
  events.at(-1) as Extract<StreamEvent, { type: 'message_end' }>;

// --- OpenAI -----------------------------------------------------------------------------------

function sse(events: Json[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan.' }], encrypted_content: 'ENC' };
const callItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"a.ts"}', status: 'completed' };
const textItem = (text: string): Json => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

function completed(output: Json[], usage: Json = { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 800 } }, status = 'completed', extra: Json = {}): Json {
  return { type: `response.${status}`, response: { id: 'resp_1', status, model: 'gpt-6-astra', output, usage, ...extra } };
}

describe('OpenAI', () => {
  let previousKey: string | undefined;
  beforeEach(() => {
    previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const provider = (maxRetries = 0): OpenAIProvider => new OpenAIProvider({ baseUrl: `${base}/v1`, maxRetries });

  it('sends a stateless Responses request with the system prompt as instructions', async () => {
    replies = [{ body: sse([completed([textItem('hi')])]) }];
    await drain(provider().stream(request({ effort: 'high' })));
    const sent = requests[0]!;
    assert.equal(sent.path, '/v1/responses');
    assert.equal(sent.headers.get('authorization'), 'Bearer sk-test-not-real');
    assert.equal(sent.body.instructions, 'Shared part.\n\nSession part.');
    assert.equal(sent.body.store, false);
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.reasoning, { effort: 'high', summary: 'auto' });
    assert.deepEqual(sent.body.include, ['reasoning.encrypted_content']);
    assert.equal(sent.body.max_output_tokens, 64_000);
    assert.deepEqual(sent.body.tools[0], { type: 'function', name: 'Read', description: 'Reads a file.', parameters: request().tools[0]!.inputSchema, strict: false });
    assert.deepEqual(sent.body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
  });

  it('streams reasoning, text and tool calls, and keeps the items to replay', async () => {
    replies = [{
      body: sse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
        { type: 'response.reasoning_summary_part.added', summary_index: 0 },
        { type: 'response.reasoning_summary_text.delta', delta: 'Plan.' },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read' } },
        { type: 'response.function_call_arguments.delta', delta: '{"file_path":"a.ts"}' },
        completed([reasoningItem, callItem]),
      ]),
    }];
    const events = await drain(provider().stream(request()));
    assert.deepEqual(events.filter((e) => e.type === 'thinking_delta'), [{ type: 'thinking_delta', text: 'Plan.' }]);
    assert.deepEqual(events.find((e) => e.type === 'tool_use_start'), { type: 'tool_use_start', id: 'call_1', name: 'Read' });
    const final = end(events);
    assert.equal(final.stopReason, 'tool_use');
    assert.deepEqual(final.content.map((b) => b.type), ['opaque', 'opaque', 'tool_use']);
    assert.deepEqual(final.content[2], { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } });
    assert.deepEqual(final.usage, { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0, webSearches: 0 });
    assert.equal(final.costUsd, estimateOpenAICostUsd('gpt-6-astra', final.usage));
  });

  it('replays its own items once, and rebuilds them for history from elsewhere', () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'opaque', provider: 'openai', data: { item: reasoningItem } },
          { type: 'opaque', provider: 'openai', data: { item: callItem, covers: true } },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'contents' }, { type: 'text', text: '<system-reminder>x</system-reminder>' }] },
      // As a session from another provider would leave it.
      { role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', data: { type: 'thinking' } }, { type: 'text', text: 'done' }, { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'bad', is_error: true }] },
    ];
    assert.deepEqual(toOpenAIInput(history), [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      reasoningItem,
      callItem,
      { type: 'function_call_output', call_id: 'call_1', output: 'contents' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>x</system-reminder>' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] },
      { type: 'function_call', call_id: 'toolu_2', name: 'Read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'toolu_2', output: 'Error: bad' },
    ]);
  });

  it('sends a tool result picture as part of the call output', () => {
    const input = toOpenAIInput([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'a picture', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] }] }]);
    assert.deepEqual(input[0]!.output, [{ type: 'input_text', text: 'a picture' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]);
  });

  it('reports a response cut short by the output limit, without a dangling reasoning item', async () => {
    replies = [{ body: sse([completed([textItem('partial'), reasoningItem], undefined, 'incomplete', { incomplete_details: { reason: 'max_output_tokens' } })]) }];
    const final = end(await drain(provider().stream(request())));
    assert.equal(final.stopReason, 'max_tokens');
    assert.deepEqual(final.content.map((b) => b.type), ['opaque', 'text']);
  });

  it('reports a refusal with its text', async () => {
    const refusal = { type: 'message', id: 'msg_r', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] };
    replies = [{ body: sse([completed([refusal])]) }];
    const final = end(await drain(provider().stream(request())));
    assert.equal(final.stopReason, 'refusal');
    assert.equal(final.stopDetail, 'I cannot help with that.');
  });

  it('says which key to check when it is rejected, and retries a rate limit', async () => {
    replies = [{ status: 401, body: '{"error":{"message":"Incorrect API key"}}' }];
    await assert.rejects(drain(provider().stream(request())), /rejected the API key\. Check OPENAI_API_KEY/);
    replies = [{ status: 429, headers: { 'retry-after-ms': '1' }, body: '{"error":{"message":"slow down"}}' }, { body: sse([completed([textItem('ok')])]) }];
    const final = end(await drain(provider(2).stream(request())));
    assert.equal(requests.length, 3);
    assert.equal(final.stopReason, 'end_turn');
  });

  it('does not retry when the account is out of quota', async () => {
    replies = [{ status: 429, body: '{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}' }];
    await assert.rejects(drain(provider(3).stream(request())), /run out of quota/);
    assert.equal(requests.length, 1);
  });

  it('drops the reasoning parameter for a model that rejects it, and remembers', async () => {
    const shared = provider();
    replies = [
      { status: 400, body: '{"error":{"message":"Unsupported parameter: reasoning.effort is not supported with this model."}}' },
      { body: sse([completed([textItem('ok')])]) },
      { body: sse([completed([textItem('again')])]) },
    ];
    await drain(shared.stream(request({ model: 'gpt-4.1', effort: 'low' })));
    await drain(shared.stream(request({ model: 'gpt-4.1', effort: 'low' })));
    assert.ok(requests[0]!.body.reasoning);
    assert.equal(requests[1]!.body.reasoning, undefined);
    assert.equal(requests[2]!.body.reasoning, undefined);
  });

  it('fails clearly with no key, before sending anything', async () => {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(drain(provider().stream(request())), /No OpenAI API key found\. Set OPENAI_API_KEY/);
    assert.equal(requests.length, 0);
  });
});

// --- Ollama -----------------------------------------------------------------------------------

function ndjson(chunks: Json[]): string {
  return chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join('');
}

const done = (extra: Json = {}): Json => ({ model: 'qwen3-coder:30b', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 300, prompt_eval_cached_count: 200, eval_count: 20, ...extra });

describe('Ollama', () => {
  const provider = (): OllamaProvider => new OllamaProvider({ baseUrl: base });
  const ollamaRequest = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => request({ model: 'qwen3-coder:30b', ...overrides });

  it('reads the host in the forms people write it', () => {
    assert.equal(ollamaHost('127.0.0.1:11434'), 'http://127.0.0.1:11434');
    assert.equal(ollamaHost('http://box:11434/v1/'), 'http://box:11434');
    assert.equal(ollamaHost(undefined), 'http://localhost:11434');
  });

  it('uses the native chat API, with a context window big enough for the prompt', async () => {
    replies = [{ body: ndjson([{ message: { role: 'assistant', content: 'hi' }, done: false }, done()]) }];
    await drain(provider().stream(ollamaRequest()));
    const sent = requests[0]!;
    assert.equal(sent.path, '/api/chat');
    assert.deepEqual(sent.body.options, { num_ctx: 65_536, num_predict: 64_000 });
    assert.equal(sent.body.think, undefined);
    assert.deepEqual(sent.body.messages[0], { role: 'system', content: 'Shared part.\n\nSession part.' });
    assert.deepEqual(sent.body.tools[0], { type: 'function', function: { name: 'Read', description: 'Reads a file.', parameters: request().tools[0]!.inputSchema } });
  });

  it('takes the context window from settings', async () => {
    replies = [{ body: ndjson([done()]) }];
    await drain(new OllamaProvider({ baseUrl: base, contextWindow: 131_072 }).stream(ollamaRequest()));
    assert.equal(requests[0]!.body.options.num_ctx, 131_072);
  });

  it('streams thinking, text and tool calls, giving ids to calls that have none', async () => {
    replies = [{
      body: ndjson([
        { message: { role: 'assistant', content: '', thinking: 'Let me look.' }, done: false },
        { message: { role: 'assistant', content: 'Reading.' }, done: false },
        { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Read', arguments: { file_path: 'a.ts' } } }] }, done: false },
        done(),
      ]),
    }];
    const events = await drain(provider().stream(ollamaRequest()));
    assert.deepEqual(events.filter((e) => e.type === 'thinking_delta'), [{ type: 'thinking_delta', text: 'Let me look.' }]);
    const final = end(events);
    assert.equal(final.stopReason, 'tool_use');
    assert.deepEqual(final.content.map((b) => b.type), ['opaque', 'text', 'tool_use']);
    const call = final.content[2] as Extract<ContentBlock, { type: 'tool_use' }>;
    assert.match(call.id, /^call_[0-9a-f]{12}$/);
    assert.deepEqual(call.input, { file_path: 'a.ts' });
    assert.deepEqual(final.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 200, cacheWriteTokens: 0, webSearches: 0 });
    assert.equal(final.costUsd, 0, 'a local model costs nothing');
  });

  it('names the tool in each result, and moves pictures to a user message', () => {
    const messages = toOllamaMessages('sys', [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
      {
        role: 'assistant',
        content: [
          { type: 'opaque', provider: 'ollama', data: { thinking: 'hmm' } },
          { type: 'opaque', provider: 'anthropic', data: { type: 'thinking' } },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.png' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'an image', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA' }] }] },
    ]);
    assert.deepEqual(messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'look' },
      { role: 'assistant', content: '', thinking: 'hmm', tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: { file_path: 'a.png' } } }] },
      { role: 'tool', content: 'an image', tool_name: 'Read', tool_call_id: 'call_1' },
      { role: 'user', content: 'Images from the tool result above.', images: ['AAAA'] },
    ]);
  });

  it('reports a response cut off by the length limit', async () => {
    replies = [{ body: ndjson([{ message: { role: 'assistant', content: 'part' }, done: false }, done({ done_reason: 'length' })]) }];
    assert.equal(end(await drain(provider().stream(ollamaRequest()))).stopReason, 'max_tokens');
  });

  it('falls back to plain thinking for a model that does not take a level, and remembers', async () => {
    const shared = provider();
    replies = [
      { status: 400, body: '{"error":"think value \\"high\\" is not supported for this model"}' },
      { body: ndjson([done()]) },
      { body: ndjson([done()]) },
    ];
    await drain(shared.stream(ollamaRequest({ effort: 'high' })));
    await drain(shared.stream(ollamaRequest({ effort: 'high' })));
    assert.deepEqual(requests.map((r) => r.body.think), ['high', true, true]);
  });

  it('says how to get a missing model, and which models can call tools', async () => {
    replies = [{ status: 404, body: '{"error":"model \\"qwen3-coder:30b\\" not found, try pulling it first"}' }];
    await assert.rejects(drain(provider().stream(ollamaRequest())), /ollama pull qwen3-coder:30b/);
    replies = [{ status: 400, body: '{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}' }];
    await assert.rejects(drain(provider().stream(ollamaRequest({ model: 'gemma:2b' }))), /does not support tool calling/);
  });

  it('says how to start Ollama when nothing is listening', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = closed.port;
    closed.stop(true);
    await assert.rejects(drain(new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}`, maxRetries: 0 }).stream(ollamaRequest())), /Could not reach Ollama[\s\S]*ollama serve/);
  });

  it('builds the request without think when no effort is asked for', () => {
    assert.equal(buildOllamaRequest(ollamaRequest(), { contextWindow: 1000, think: undefined }).think, undefined);
  });
});

// --- Through the agent ------------------------------------------------------------------------

describe('through the agent loop', () => {
  const allowAll: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };
  let dir: string;
  let previousHome: string | undefined;
  let previousKey: string | undefined;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-providers-')));
    previousHome = process.env.CAIRN_HOME;
    process.env.CAIRN_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-providers-home-')));
    previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-not-real';
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CAIRN_HOME;
    else process.env.CAIRN_HOME = previousHome;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const todo = { todos: [{ content: 'a', status: 'pending' }] };

  async function turn(providerName: 'openai' | 'ollama'): Promise<void> {
    const provider = createProvider(providerName, { baseUrl: providerName === 'openai' ? `${base}/v1` : base, maxRetries: 0 });
    const runtime = await createRuntime({ cwd: dir, prompter: allowAll, provider, trust: true, persist: false });
    for await (const _event of runtime.agent.run('make a list', new AbortController().signal)) {
      // Run it to the end.
    }
    await runtime.shutdown();
  }

  it('runs an OpenAI tool loop, replaying the call it answers', async () => {
    const call = { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'TodoWrite', arguments: JSON.stringify(todo), status: 'completed' };
    replies = [{ body: sse([completed([reasoningItem, call])]) }, { body: sse([completed([textItem('Listed.')])]) }];
    await turn('openai');
    const input = requests[1]!.body.input as Json[];
    assert.deepEqual(input.slice(-3, -1), [reasoningItem, call]);
    assert.equal(input.at(-1)!.type, 'function_call_output');
    assert.equal(input.at(-1)!.call_id, 'call_9');
    assert.match(input.at(-1)!.output, /Checklist updated/);
  });

  it('maps a subagent model tier to the provider, or keeps the parent model when it has none', async () => {
    const agentCall = { description: 'look', prompt: 'p', model: 'haiku' };
    replies = [
      { body: sse([completed([{ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'Agent', arguments: JSON.stringify(agentCall), status: 'completed' }])]) },
      { body: sse([completed([textItem('report')])]) },
      { body: sse([completed([textItem('done')])]) },
    ];
    await turn('openai');
    assert.equal(requests[1]!.body.model, 'gpt-6-luna');

    requests.length = 0;
    replies = [
      { body: ndjson([{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'a1', function: { name: 'Agent', arguments: agentCall } }] }, done: false }, done()]) },
      { body: ndjson([{ message: { role: 'assistant', content: 'report' }, done: false }, done()]) },
      { body: ndjson([{ message: { role: 'assistant', content: 'done' }, done: false }, done()]) },
    ];
    await turn('ollama');
    assert.equal(requests[1]!.body.model, 'qwen3-coder:30b');
  });

  it('runs an Ollama tool loop, naming the tool in its result', async () => {
    replies = [
      { body: ndjson([{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'TodoWrite', arguments: todo } }] }, done: false }, done()]) },
      { body: ndjson([{ message: { role: 'assistant', content: 'Listed.' }, done: false }, done()]) },
    ];
    await turn('ollama');
    const last = (requests[1]!.body.messages as Json[]).find((m) => m.role === 'tool')!;
    assert.equal(last.tool_name, 'TodoWrite');
    assert.match(last.content, /Checklist updated/);
  });
});
