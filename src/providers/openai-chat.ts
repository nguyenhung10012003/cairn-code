/**
 * Any server that speaks OpenAI's Chat Completions API (`/chat/completions`): DeepSeek, Groq,
 * OpenRouter, Together, Mistral, LM Studio, vLLM, llama.cpp and many others. It is added under a
 * name of its own, such as `cairn provider add deepseek --type openai-chat --base-url ...`.
 *
 * These servers differ in which optional parameters they accept, so a parameter the server
 * rejects is dropped for that model and the request is sent again. Reasoning text that a server
 * streams is shown but not sent back: few servers accept it in the history.
 */
import { randomBytes } from 'node:crypto';
import type { ContentBlock, Message, StopReason, Usage } from '../core/messages.ts';
import { emptyUsage } from '../core/messages.ts';
import { ProviderError } from '../core/provider.ts';
import type { Effort, ModelProvider, ProviderInit, ProviderRequest, StreamEvent } from '../core/provider.ts';
import { errorMessage, postJson, serverSentEvents } from './http.ts';
import { DEFAULT_MAX_RETRIES, withRetries } from './retry.ts';

const PROVIDER_ID = 'openai-chat';
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_BAD_TOOL_JSON_RETRIES = 2;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

type Json = Record<string, unknown>;

/**
 * An `error` object sent partway through a stream, as OpenRouter and others do, that a later
 * request may not hit: a server fault, an overload or a rate limit, but not a used-up quota.
 */
function transientStreamError(chunk: Json): boolean {
  const error = (typeof chunk.error === 'object' && chunk.error ? chunk.error : { message: chunk.error }) as Json;
  const message = String(error.message ?? '');
  if (/quota|billing|credit|balance/i.test(message)) return false;
  const status = typeof error.code === 'number' ? error.code : Number(error.code);
  if (Number.isFinite(status) && status > 0) return status === 408 || status === 429 || status >= 500;
  return /server_error|overloaded|rate_limit|timeout|unavailable/i.test(`${String(error.code ?? '')} ${String(error.type ?? '')} ${message}`);
}

/** Sent when the request calls for them, and dropped for a model whose server rejects them. */
const OPTIONAL_PARAMS = ['reasoning_effort', 'stream_options', 'response_format', 'parallel_tool_calls'] as const;
type OptionalParam = (typeof OPTIONAL_PARAMS)[number];

/** Chat Completions knows three levels. */
const REASONING_EFFORT: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

export function chatEndpoint(baseUrl: string | undefined): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

/** The neutral history as chat messages, with the system prompt first. */
export function toChatMessages(system: string, messages: readonly Message[]): Json[] {
  const out: Json[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      const calls = message.content.flatMap((block) =>
        block.type === 'tool_use' ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }] : [],
      );
      if (!text && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    const texts: string[] = [];
    const images: Json[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        let content = block.is_error ? `Error: ${block.content}` : block.content;
        for (const attachment of block.attachments ?? []) {
          if (attachment.kind === 'image') images.push({ type: 'image_url', image_url: { url: `data:${attachment.mediaType};base64,${attachment.data}` } });
          else content += '\n\n[A PDF was attached, but this API takes only text and images.]';
        }
        out.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
      } else if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    // Tool messages take text only, so images from a tool follow in a user message.
    if (images.length > 0) {
      out.push({ role: 'user', content: [{ type: 'text', text: texts.join('\n\n') || 'Images from the tool result above.' }, ...images] });
    } else if (texts.length > 0) {
      out.push({ role: 'user', content: texts.join('\n\n') });
    }
  }
  return out;
}

export interface ChatRequestOptions {
  /** Optional parameters this model's server rejected. */
  dropped: ReadonlySet<OptionalParam>;
  /** Sent as max_tokens, or as max_completion_tokens for servers that want that instead. */
  maxOutputTokens?: number;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
}

export function buildChatRequest(request: ProviderRequest, options: ChatRequestOptions): Json {
  const send = (param: OptionalParam): boolean => !options.dropped.has(param);
  const system = request.system.map((block) => block.text).join('\n\n');
  return {
    model: request.model,
    messages: toChatMessages(system, request.messages),
    stream: true,
    ...(send('stream_options') ? { stream_options: { include_usage: true } } : {}),
    ...(options.maxOutputTokens ? { [options.maxTokensField]: Math.min(options.maxOutputTokens, request.maxTokens) } : {}),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
          ...(send('parallel_tool_calls') ? { parallel_tool_calls: true } : {}),
        }
      : {}),
    ...(request.effort && send('reasoning_effort') ? { reasoning_effort: REASONING_EFFORT[request.effort] } : {}),
    ...(request.outputSchema && send('response_format')
      ? { response_format: { type: 'json_schema', json_schema: { name: 'final_answer', schema: request.outputSchema, strict: false } } }
      : {}),
  };
}

/** Which optional parameter a 400 response complains about, if it names one that was sent. */
export function rejectedParam(error: ProviderError, body: Json): OptionalParam | 'max_tokens' | undefined {
  if (error.status !== 400 && error.status !== 422) return undefined;
  const message = error.message.toLowerCase();
  if (/max_completion_tokens/.test(message) && 'max_tokens' in body) return 'max_tokens';
  return OPTIONAL_PARAMS.find((param) => param in body && message.includes(param));
}

class BadToolJson extends Error {}

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

function parseArguments(call: PartialCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.args.trim() || '{}');
  } catch {
    throw new BadToolJson(`The model sent tool arguments that are not valid JSON for ${call.name}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadToolJson(`The model sent tool arguments for ${call.name} that are not an object.`);
  return parsed as Record<string, unknown>;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek's name for cached input. */
  prompt_cache_hit_tokens?: number;
}

export function chatUsage(usage: ChatUsage | null | undefined): Usage {
  if (!usage) return emptyUsage();
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  return { ...emptyUsage(), inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached), cacheReadTokens: cached, outputTokens: usage.completion_tokens ?? 0 };
}

function stopReasonOf(finish: string | undefined, hasCalls: boolean): StopReason {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'content_filter') return 'refusal';
  // Some servers say "stop" even when the message has tool calls.
  return hasCalls ? 'tool_use' : 'end_turn';
}

export class OpenAIChatProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly credentialEnvVars: string[];
  readonly serverTools = [];

  private readonly baseUrl: string;
  private readonly keyVar: string | undefined;
  private readonly storedKey: string | undefined;
  private readonly maxRetries: number;
  private readonly window: number;
  private readonly maxOutputTokens: number | undefined;
  /** Per model, the optional parameters its server rejected. */
  private readonly dropped = new Map<string, Set<OptionalParam>>();
  /** Models whose server wants max_completion_tokens rather than max_tokens. */
  private readonly completionTokens = new Set<string>();

  constructor(init: ProviderInit = {}) {
    this.name = init.name ?? PROVIDER_ID;
    this.defaultModel = init.model ?? '';
    this.baseUrl = chatEndpoint(init.baseUrl);
    this.keyVar = init.apiKeyEnv;
    this.storedKey = init.storedKey;
    this.credentialEnvVars = init.apiKeyEnv ? [init.apiKeyEnv] : [];
    this.maxRetries = init.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.window = init.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.maxOutputTokens = init.maxOutputTokens;
  }

  contextWindow(): number {
    return this.window;
  }

  private key(): string | undefined {
    return (this.keyVar ? process.env[this.keyVar] : undefined) || this.storedKey;
  }

  private isLocal(): boolean {
    try {
      return LOCAL_HOSTS.has(new URL(this.baseUrl).hostname);
    } catch {
      return false;
    }
  }

  configurationWarning(): string | undefined {
    if (!this.baseUrl) return `The provider "${this.name}" has no base URL. Add one with: cairn provider add ${this.name} --base-url <url>`;
    if (!this.defaultModel) return `The provider "${this.name}" has no model set. Choose one with /model.`;
    if (!this.key() && !this.isLocal()) {
      return `No API key for "${this.name}"${this.keyVar ? ` (${this.keyVar} is not set)` : ''}. Save one with: cairn provider key ${this.name}`;
    }
    return undefined;
  }

  private headers(): Record<string, string> {
    const key = this.key();
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  private describeError(status: number, body: string): ProviderError {
    const message = errorMessage(body);
    const options = { status };
    const keyHint = this.keyVar ? `Check ${this.keyVar}, or save a key with \`cairn provider key ${this.name}\`.` : `Save a new key with \`cairn provider key ${this.name}\`.`;
    if (status === 401) return new ProviderError(`${this.name} rejected the API key. ${keyHint} ${message}`, options);
    if (status === 403) return new ProviderError(`${this.name} refused the request (HTTP 403): ${message}`, options);
    if (status === 404) {
      return new ProviderError(`${this.name} has no such model or endpoint at ${this.baseUrl}. The base URL usually ends in /v1; check the model with /model. ${message}`, options);
    }
    if (status === 429) {
      if (/quota|billing|credit|balance/i.test(body)) return new ProviderError(`The ${this.name} account has run out of quota or credit: ${message}`, options);
      return new ProviderError(`Rate limited by ${this.name}. Wait a little and send the message again.`, { ...options, retryable: true });
    }
    if (status >= 500) return new ProviderError(`${this.name} is having trouble (HTTP ${status}): ${message}`, { ...options, retryable: true });
    return new ProviderError(`${this.name} rejected the request (HTTP ${status}): ${message}`, options);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (!this.baseUrl) return [];
    const response = await fetch(`${this.baseUrl}/models`, { headers: this.headers(), ...(signal ? { signal } : {}) });
    if (!response.ok) throw this.describeError(response.status, await response.text().catch(() => ''));
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).flatMap((model) => (typeof model.id === 'string' ? [model.id] : [])).sort();
  }

  stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    return withRetries(this.maxRetries, request.signal, () => this.attempt(request));
  }

  private async *attempt(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    if (!this.baseUrl) throw new ProviderError(`The provider "${this.name}" has no base URL. Add one with: cairn provider add ${this.name} --base-url <url>`);
    if (!request.model) throw new ProviderError(`No model is set for "${this.name}". Choose one with /model, or --model.`);
    for (let attempt = 0; ; attempt++) {
      const dropped = this.dropped.get(request.model) ?? new Set<OptionalParam>();
      const body = buildChatRequest(request, {
        dropped,
        ...(this.maxOutputTokens ? { maxOutputTokens: this.maxOutputTokens } : {}),
        maxTokensField: this.completionTokens.has(request.model) ? 'max_completion_tokens' : 'max_tokens',
      });
      let response: Response;
      try {
        response = await postJson(`${this.baseUrl}/chat/completions`, {
          headers: this.headers(),
          body,
          ...(request.signal ? { signal: request.signal } : {}),
          describeError: (status, text) => this.describeError(status, text),
          describeNetworkError: (error) =>
            new ProviderError(`Could not reach ${this.name} at ${this.baseUrl} (${error.message.replace(/[.?!\s]+$/, '')}).`, { retryable: true, cause: error }),
        });
      } catch (error) {
        const rejected = error instanceof ProviderError ? rejectedParam(error, body) : undefined;
        if (rejected === 'max_tokens') {
          this.completionTokens.add(request.model);
          attempt--;
          continue;
        }
        if (rejected) {
          this.dropped.set(request.model, new Set([...dropped, rejected]));
          attempt--;
          continue;
        }
        throw error;
      }
      try {
        yield* this.read(response);
        return;
      } catch (error) {
        // The tool call never completed, so there is no id to answer: the turn is sent again.
        if (error instanceof BadToolJson && attempt < MAX_BAD_TOOL_JSON_RETRIES) continue;
        if (error instanceof BadToolJson) throw new ProviderError(error.message);
        throw error;
      }
    }
  }

  private async *read(response: Response): AsyncGenerator<StreamEvent> {
    let text = '';
    let finish: string | undefined;
    let usage: ChatUsage | undefined;
    let sawChunk = false;
    const calls = new Map<number, PartialCall>();
    for await (const { data } of serverSentEvents(response)) {
      if (data === '[DONE]') break;
      let chunk: Json;
      try {
        chunk = JSON.parse(data) as Json;
      } catch {
        throw new ProviderError(`${this.name} sent an event that is not JSON: ${data.slice(0, 200)}`);
      }
      if (chunk.error) {
        throw new ProviderError(`${this.name} reported an error during the response: ${errorMessage(JSON.stringify(chunk))}`, { retryable: transientStreamError(chunk) });
      }
      sawChunk = true;
      if (chunk.usage) usage = chunk.usage as ChatUsage;
      const choice = (chunk.choices as Json[] | undefined)?.[0];
      if (!choice) continue;
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
      const delta = (choice.delta ?? {}) as Json;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) yield { type: 'thinking_delta', text: reasoning };
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      for (const raw of (delta.tool_calls as Json[] | undefined) ?? []) {
        const index = typeof raw.index === 'number' ? raw.index : calls.size;
        const fn = (raw.function ?? {}) as Json;
        let call = calls.get(index);
        if (!call) {
          call = { id: typeof raw.id === 'string' && raw.id ? raw.id : `call_${randomBytes(6).toString('hex')}`, name: '', args: '' };
          calls.set(index, call);
        }
        if (typeof fn.name === 'string' && fn.name && !call.name) {
          call.name = fn.name;
          yield { type: 'tool_use_start', id: call.id, name: call.name };
        }
        if (typeof fn.arguments === 'string') call.args += fn.arguments;
        else if (fn.arguments && typeof fn.arguments === 'object') call.args = JSON.stringify(fn.arguments);
      }
    }
    if (!sawChunk) throw new ProviderError(`The ${this.name} stream ended without a response.`);
    const named = [...calls.values()].filter((call) => call.name);
    const content: ContentBlock[] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...named.map((call) => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: parseArguments(call) })),
    ];
    yield { type: 'message_end', content, stopReason: stopReasonOf(finish, named.length > 0), usage: chatUsage(usage) };
  }
}
