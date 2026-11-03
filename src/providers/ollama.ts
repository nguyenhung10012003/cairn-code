/**
 * Ollama through its native chat API (`/api/chat`), with plain fetch. The native API is used
 * rather than Ollama's OpenAI-compatible one because only the native API takes `num_ctx`:
 * through the compatible endpoint a model loads with Ollama's default context (often 4,096
 * tokens) and silently drops the start of a long prompt, which would cut off Cairn's system
 * prompt and tool definitions.
 */
import { randomBytes } from 'node:crypto';
import { APP_DISPLAY_NAME } from '../config/paths.ts';
import type { ContentBlock, Message, StopReason, Usage } from '../core/messages.ts';
import { emptyUsage } from '../core/messages.ts';
import { ProviderError } from '../core/provider.ts';
import type { Effort, ModelProvider, ProviderInit, ProviderRequest, StreamEvent } from '../core/provider.ts';
import { errorMessage, jsonLines, postJson } from './http.ts';

const PROVIDER_ID = 'ollama';
const DEFAULT_MODEL = 'qwen3-coder:30b';
const DEFAULT_HOST = 'http://localhost:11434';
/** Cairn's system prompt and tool definitions alone take a large part of a small window. */
const DEFAULT_CONTEXT_WINDOW = 65_536;
/** A local server that is not running will not start in the next few seconds. */
const DEFAULT_MAX_RETRIES = 1;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

type Json = Record<string, unknown>;

/** Accepts `host:port`, a full URL, or an OpenAI-style base URL ending in /v1. */
export function ollamaHost(raw: string | undefined): string {
  const value = (raw ?? DEFAULT_HOST).trim();
  const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
  return withScheme.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** Thinking models take `think` as a level or a boolean; which one depends on the model. */
const THINK_LEVELS: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'max' };

interface StoredThinking {
  thinking: string;
}

/** The neutral history, with the system prompt first, as Ollama chat messages. */
export function toOllamaMessages(system: string, messages: readonly Message[]): Json[] {
  const out: Json[] = system ? [{ role: 'system', content: system }] : [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      let text = '';
      let thinking = '';
      const calls: Json[] = [];
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolNames.set(block.id, block.name);
          calls.push({ id: block.id, function: { name: block.name, arguments: block.input } });
        } else if (block.type === 'opaque' && block.provider === PROVIDER_ID) {
          thinking += (block.data as StoredThinking).thinking;
        }
      }
      out.push({ role: 'assistant', content: text, ...(thinking ? { thinking } : {}), ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    const texts: string[] = [];
    const images: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        let content = block.is_error ? `Error: ${block.content}` : block.content;
        for (const attachment of block.attachments ?? []) {
          if (attachment.kind === 'image') images.push(attachment.data);
          else content += '\n\n[A PDF was attached, but only images can be shown to this model.]';
        }
        out.push({ role: 'tool', content, tool_name: toolNames.get(block.tool_use_id) ?? 'tool', tool_call_id: block.tool_use_id });
      } else if (block.type === 'text') {
        texts.push(block.text);
      }
    }
    // Ollama takes images on messages, not on tool results, so they follow in a user message.
    if (texts.length > 0 || images.length > 0) {
      out.push({ role: 'user', content: texts.join('\n\n') || 'Images from the tool result above.', ...(images.length > 0 ? { images } : {}) });
    }
  }
  return out;
}

export interface OllamaRequestOptions {
  contextWindow: number;
  /** What to send as `think`, or undefined to leave it to the model. */
  think: string | boolean | undefined;
}

export function buildOllamaRequest(request: ProviderRequest, options: OllamaRequestOptions): Json {
  const system = request.system.map((block) => block.text).join('\n\n');
  return {
    model: request.model,
    messages: toOllamaMessages(system, request.messages),
    stream: true,
    ...(request.tools.length > 0
      ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) }
      : {}),
    options: { num_ctx: options.contextWindow, num_predict: request.maxTokens },
    ...(options.think !== undefined ? { think: options.think } : {}),
    ...(request.outputSchema ? { format: request.outputSchema } : {}),
  };
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw || '{}') as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Falls through to an error the model can act on.
    }
  }
  throw new ProviderError('The model sent tool arguments that are not a JSON object.');
}

function stopReasonOf(doneReason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return 'tool_use';
  if (doneReason === 'length') return 'max_tokens';
  return 'end_turn';
}

function rejectsThink(error: ProviderError): boolean {
  return error.status === 400 && /think/i.test(error.message);
}

export class OllamaProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly credentialEnvVars: string[];
  readonly serverTools = [];

  private readonly host: string;
  private readonly keyVar: string;
  private readonly storedKey: string | undefined;
  private readonly maxRetries: number;
  private readonly window: number;
  /** Per model, the `think` value that worked after a rejection, so it is not tried again. */
  private readonly thinkFallback = new Map<string, string | boolean | undefined>();

  constructor(config: ProviderInit = {}) {
    this.name = config.name ?? PROVIDER_ID;
    this.defaultModel = config.model ?? DEFAULT_MODEL;
    this.host = ollamaHost(config.baseUrl ?? process.env.OLLAMA_HOST);
    this.keyVar = config.apiKeyEnv ?? 'OLLAMA_API_KEY';
    this.storedKey = config.storedKey;
    this.credentialEnvVars = ['OLLAMA_API_KEY', ...(config.apiKeyEnv ? [config.apiKeyEnv] : [])];
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.window = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  contextWindow(): number {
    return this.window;
  }

  /** The models this Ollama server has downloaded. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const key = process.env[this.keyVar] || this.storedKey;
    const response = await fetch(`${this.host}/api/tags`, { headers: key ? { authorization: `Bearer ${key}` } : {}, ...(signal ? { signal } : {}) });
    if (!response.ok) throw new ProviderError(`Ollama at ${this.host} did not list its models (HTTP ${response.status}).`);
    const body = (await response.json()) as { models?: { name?: unknown }[] };
    return (body.models ?? []).flatMap((model) => (typeof model.name === 'string' ? [model.name] : [])).sort();
  }

  /** A local model costs nothing per token. A remote host may charge, at a rate Cairn does not know. */
  private isLocal(): boolean {
    try {
      return LOCAL_HOSTS.has(new URL(this.host).hostname);
    } catch {
      return false;
    }
  }

  private describeError(status: number, body: string, model: string): ProviderError {
    const message = errorMessage(body);
    const options = { status };
    if (status === 404 && /not found|pull/i.test(message)) {
      return new ProviderError(`Ollama does not have the model "${model}". Download it with \`ollama pull ${model}\`, or choose another with --model.`, options);
    }
    if (/does not support tools/i.test(message)) {
      return new ProviderError(`The model "${model}" does not support tool calling, which ${APP_DISPLAY_NAME} needs. Choose one that does: https://ollama.com/search?c=tools`, options);
    }
    if (status === 401 || status === 403) return new ProviderError(`Ollama refused the request (HTTP ${status}). Check ${this.keyVar}. ${message}`, options);
    if (status >= 500) return new ProviderError(`Ollama failed (HTTP ${status}): ${message}`, { ...options, retryable: true });
    return new ProviderError(`Ollama rejected the request (HTTP ${status}): ${message}`, options);
  }

  private thinkCandidates(model: string, effort: Effort | undefined): (string | boolean | undefined)[] {
    if (this.thinkFallback.has(model)) return [this.thinkFallback.get(model)];
    if (!effort) return [undefined];
    // A level first, then plain thinking, then none, for models that know fewer of these.
    return [THINK_LEVELS[effort], true, undefined];
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const key = process.env[this.keyVar] || this.storedKey;
    const candidates = this.thinkCandidates(request.model, request.effort);
    let response: Response | undefined;
    for (const [index, think] of candidates.entries()) {
      try {
        response = await postJson(`${this.host}/api/chat`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          body: buildOllamaRequest(request, { contextWindow: this.window, think }),
          ...(request.signal ? { signal: request.signal } : {}),
          maxRetries: this.maxRetries,
          describeError: (status, body) => this.describeError(status, body, request.model),
          describeNetworkError: (error) =>
            new ProviderError(`Could not reach Ollama at ${this.host} (${error.message.replace(/[.?!\s]+$/, '')}). Start it with \`ollama serve\`, or set providers.ollama.baseUrl.`, { cause: error }),
        });
        if (index > 0) this.thinkFallback.set(request.model, think);
        break;
      } catch (error) {
        if (error instanceof ProviderError && rejectsThink(error) && index + 1 < candidates.length) continue;
        throw error;
      }
    }
    yield* this.read(response!, request.model);
  }

  private async *read(response: Response, model: string): AsyncGenerator<StreamEvent> {
    let text = '';
    let thinking = '';
    const calls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    for await (const chunk of jsonLines(response)) {
      if (typeof chunk.error === 'string') throw new ProviderError(`Ollama reported an error during the response: ${chunk.error}`);
      const message = chunk.message as { content?: string; thinking?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } | undefined;
      if (message?.thinking) {
        thinking += message.thinking;
        yield { type: 'thinking_delta', text: message.thinking };
      }
      if (message?.content) {
        text += message.content;
        yield { type: 'text_delta', text: message.content };
      }
      for (const call of message?.tool_calls ?? []) {
        const name = call.function?.name;
        if (!name) continue;
        const id = call.id || `call_${randomBytes(6).toString('hex')}`;
        calls.push({ id, name, input: parseArguments(call.function?.arguments) });
        yield { type: 'tool_use_start', id, name };
      }
      if (chunk.done === true) {
        const content: ContentBlock[] = [
          ...(thinking ? [{ type: 'opaque' as const, provider: PROVIDER_ID, data: { thinking } satisfies StoredThinking }] : []),
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...calls.map((call) => ({ type: 'tool_use' as const, ...call })),
        ];
        const prompt = Number(chunk.prompt_eval_count ?? 0);
        const cached = Number(chunk.prompt_eval_cached_count ?? 0);
        const usage: Usage = { ...emptyUsage(), inputTokens: Math.max(0, prompt - cached), cacheReadTokens: cached, outputTokens: Number(chunk.eval_count ?? 0) };
        const servedBy = typeof chunk.model === 'string' ? chunk.model : model;
        yield {
          type: 'message_end',
          content,
          stopReason: stopReasonOf(typeof chunk.done_reason === 'string' ? chunk.done_reason : undefined, calls.length > 0),
          usage,
          ...(this.isLocal() ? { costUsd: 0 } : {}),
          ...(servedBy !== model && servedBy !== `${model}:latest` ? { servedBy } : {}),
        };
        return;
      }
    }
    throw new ProviderError('Ollama stopped streaming before the response finished.');
  }
}
