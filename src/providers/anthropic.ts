/**
 * The Anthropic Messages API, through the official SDK. Everything specific to that API stays
 * in this file and anthropic-models.ts; the agent only ever sees neutral blocks and events.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message, StopReason, Usage } from '../core/messages.ts';
import { ProviderError } from '../core/provider.ts';
import type { ModelProvider, ProviderConfig, ProviderInit, ProviderRequest, ServerTool, StreamEvent } from '../core/provider.ts';
import { estimateCostUsd, knownModelIds, modelSpec } from './anthropic-models.ts';
import type { AttemptUsage } from './anthropic-models.ts';
import { DEFAULT_MAX_RETRIES, retryAfterMs, withRetries } from './retry.ts';

const PROVIDER_ID = 'anthropic';
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_EFFORT = 'medium';
const WEB_SEARCH_MAX_USES_PER_REQUEST = 5;
const MAX_BAD_TOOL_JSON_RETRIES = 2;
/** Error types the API can send partway through a stream that a later request may not hit. */
const TRANSIENT_ERROR_TYPES = new Set(['api_error', 'overloaded_error', 'rate_limit_error', 'timeout_error']);

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

const STANDARD_CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN'];

type ApiParams = Parameters<Anthropic['beta']['messages']['stream']>[0];
type ApiMessage = Awaited<ReturnType<ReturnType<Anthropic['beta']['messages']['stream']>['finalMessage']>>;
type ApiBlock = { type: string; [key: string]: unknown };

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

function withoutKeys(block: ApiBlock, keys: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block)) {
    if (!keys.includes(key) && value !== undefined) rest[key] = value;
  }
  return rest;
}

/**
 * Replayed blocks must match what the API sent. Fields Cairn has no use for, such as citations
 * on text, are kept in `extra` so they go back unchanged.
 */
export function toNeutralContent(apiBlocks: readonly ApiBlock[]): ContentBlock[] {
  let blocks = [...apiBlocks];

  // After a mid-output fallback, the blocks before the last switch came from a model that
  // declined. Its thinking and tool calls must be neither run nor replayed. Text and completed
  // server-tool pairs stay.
  const boundary = blocks.findLastIndex((block) => block.type === 'fallback');
  if (boundary >= 0) {
    const resultIds = new Set(
      blocks.slice(0, boundary).filter((b) => b.type.endsWith('_tool_result')).map((b) => b.tool_use_id),
    );
    const serverCallIds = new Set(
      blocks.slice(0, boundary).filter((b) => b.type === 'server_tool_use').map((b) => b.id),
    );
    blocks = blocks.filter((block, index) => {
      if (index > boundary) return true;
      if (block.type === 'text') return true;
      if (block.type === 'server_tool_use') return resultIds.has(block.id);
      if (block.type.endsWith('_tool_result')) return serverCallIds.has(block.tool_use_id);
      return false;
    });
  }

  // The API rejects an assistant message that ends in thinking, which is how a response cut off
  // during thinking would look. Dropping the end of the run leaves earlier blocks valid.
  while (blocks.length > 0 && THINKING_TYPES.has(blocks.at(-1)!.type)) blocks.pop();

  const neutral: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = String(block.text ?? '');
      if (!text) continue;
      const extra = withoutKeys(block, ['type', 'text', 'parsed_output']);
      neutral.push({ type: 'text', text, ...(Object.keys(extra).length > 0 ? { extra } : {}) });
    } else if (block.type === 'tool_use') {
      const extra = withoutKeys(block, ['type', 'id', 'name', 'input']);
      neutral.push({
        type: 'tool_use',
        id: String(block.id),
        name: String(block.name),
        input: (block.input ?? {}) as Record<string, unknown>,
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      });
    } else {
      neutral.push({ type: 'opaque', provider: PROVIDER_ID, data: block });
    }
  }
  return neutral;
}

export function toApiMessages(messages: readonly Message[]): unknown[] {
  const converted: unknown[] = [];
  for (const message of messages) {
    const content: unknown[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          content.push({ type: 'text', text: block.text, ...block.extra });
          break;
        case 'tool_use':
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input, ...block.extra });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.attachments?.length
              ? [
                  { type: 'text', text: block.content },
                  ...block.attachments.map(({ kind, mediaType, data }) => ({ type: kind, source: { type: 'base64', media_type: mediaType, data } })),
                ]
              : block.content,
            ...(block.is_error ? { is_error: true } : {}),
          });
          break;
        case 'image':
          content.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } });
          break;
        case 'opaque':
          // A block from another provider means nothing here, so it cannot be sent.
          if (block.provider === PROVIDER_ID) content.push(block.data);
          break;
      }
    }
    if (content.length > 0) converted.push({ role: message.role, content });
  }
  return converted;
}

export function buildParams(request: ProviderRequest, fullApiFeatures: boolean): ApiParams {
  const spec = modelSpec(request.model);
  const betas: string[] = [];
  const params: Record<string, unknown> = {
    model: request.model,
    max_tokens: Math.min(request.maxTokens, spec?.maxOutput ?? request.maxTokens),
    messages: toApiMessages(request.messages),
    system: request.system.map((block) => ({
      type: 'text',
      text: block.text,
      ...(block.cache && !request.disableCache ? { cache_control: { type: 'ephemeral' } } : {}),
    })),
  };

  // An explicit marker on the stable system prefix, plus automatic caching of the growing tail.
  if (fullApiFeatures && !request.disableCache) params.cache_control = { type: 'ephemeral' };

  // A model missing from the table is most likely newer than it, so it gets the current shape.
  if (spec?.adaptiveThinking !== false) {
    params.thinking = {
      type: 'adaptive',
      display: 'summarized',
      // History is append-only, so a mismatch is rare, such as resuming with different tools.
      // Losing old reasoning is then better than the session failing outright.
      ...(fullApiFeatures ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } } : {}),
    };
    if (fullApiFeatures) betas.push(THINKING_BINDING_BETA);
  }
  const outputConfig: Record<string, unknown> = {};
  if (spec?.effort !== false) outputConfig.effort = request.effort ?? DEFAULT_EFFORT;
  if (request.outputSchema) outputConfig.format = { type: 'json_schema', schema: request.outputSchema };
  if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;

  const useToolSearch = fullApiFeatures && request.tools.some((tool) => tool.deferred);
  const tools: unknown[] = request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    // Proxies may reject this field. Without it, large inputs arrive in one late burst.
    ...(fullApiFeatures ? { eager_input_streaming: true } : {}),
    ...(useToolSearch && tool.deferred ? { defer_loading: true } : {}),
  }));
  // Every definition is still sent, but deferred ones stay out of context until searched for.
  if (useToolSearch) tools.push({ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });
  if (fullApiFeatures && request.serverTools?.includes('web_search')) {
    const limits = request.webSearch;
    tools.push({
      type: spec?.webSearchType ?? 'web_search_20260209',
      name: 'web_search',
      max_uses: limits?.maxUses ?? WEB_SEARCH_MAX_USES_PER_REQUEST,
      ...(limits?.allowedDomains?.length ? { allowed_domains: limits.allowedDomains } : {}),
      ...(limits?.blockedDomains?.length ? { blocked_domains: limits.blockedDomains } : {}),
    });
  }
  if (tools.length > 0) params.tools = tools;

  if (fullApiFeatures && spec?.serverFallback) {
    params.fallbacks = 'default';
    betas.push(FALLBACK_BETA);
  }
  for (const beta of request.betas ?? []) {
    if (!betas.includes(beta)) betas.push(beta);
  }
  if (betas.length > 0) params.betas = betas;
  return params as unknown as ApiParams;
}

function neutralStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}

interface ApiUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
  iterations?: ({ type: string; model?: string | null } & Partial<ApiUsage>)[] | null;
}

function attemptOf(usage: Partial<ApiUsage>, model: string): AttemptUsage {
  return {
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/** Top-level usage covers only the attempt that answered, while `iterations` lists them all. */
function costOf(usage: ApiUsage, servedBy: string, requested: string): number | undefined {
  const attempts = (usage.iterations ?? [])
    .filter((entry) => entry.type === 'message' || entry.type === 'fallback_message')
    .map((entry) => attemptOf(entry, entry.model ?? requested));
  return estimateCostUsd(
    attempts.length > 0 ? attempts : [attemptOf(usage, servedBy)],
    usage.server_tool_use?.web_search_requests ?? 0,
  );
}

function refusalDetail(message: ApiMessage): string | undefined {
  const details = (message as unknown as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
  if (!details) return undefined;
  return details.explanation ?? details.category ?? undefined;
}

function historyMismatchNotices(message: ApiMessage): string[] {
  const entries = (message as unknown as { input_transformations?: { type?: string; reason?: string; path?: string }[] | null })
    .input_transformations ?? [];
  const mismatched = entries.filter((e) => e.type === 'thinking_dropped' && e.reason === 'prefix_binding_mismatch');
  if (mismatched.length === 0) return [];
  return [`The API dropped ${mismatched.length} earlier reasoning block(s) because the conversation prefix changed. This is harmless but raises cost; it usually follows resuming with different tools.`];
}

/** What the SDK would retry, were it left to: the server's `x-should-retry` first, then the status. */
function retryableResponse(error: InstanceType<typeof Anthropic.APIError>): boolean {
  const header = error.headers?.get('x-should-retry');
  if (header === 'true' || header === 'false') return header === 'true';
  const status = error.status ?? 0;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Turns SDK failures into messages that say what to do, and never into a stack trace. */
export function translateError(error: unknown, credentialHint: string): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('The request to the Anthropic API timed out.', { retryable: true, cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Could not reach the Anthropic API: ${error.message}`, { retryable: true, cause: error });
  }
  if (error instanceof Anthropic.APIError && error.status === undefined) {
    // An `error` event in a stream that had already started, such as an overload.
    const detail = (error.error as { error?: { message?: unknown } } | undefined)?.error?.message;
    return new ProviderError(`The API reported an error during the response: ${typeof detail === 'string' ? detail : error.message}`, {
      retryable: TRANSIENT_ERROR_TYPES.has(error.type ?? ''),
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const options = { status, cause: error };
    const wait = retryAfterMs(error.headers);
    const transient = { ...options, retryable: retryableResponse(error), ...(wait === undefined ? {} : { retryAfterMs: wait }) };
    if (error instanceof Anthropic.AuthenticationError) {
      return new ProviderError(`The API rejected these credentials. Check ${credentialHint}.`, options);
    }
    if (status === 402 || error.type === 'billing_error') {
      return new ProviderError('The API reports a billing problem. Check the credit balance in the Console.', options);
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return new ProviderError(`This API key is not allowed to do that: ${error.message}`, options);
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new ProviderError(`The API could not find that resource. Check the model name with /model. ${error.message}`, options);
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new ProviderError('Rate limited by the API. Wait a little and send the message again.', transient);
    }
    if (status >= 500) {
      return new ProviderError(`The API is having trouble (HTTP ${status}). Send the message again shortly.`, transient);
    }
    return new ProviderError(`The API rejected the request (HTTP ${status}): ${error.message}`, transient);
  }
  if (error instanceof Anthropic.AnthropicError && /Could not resolve authentication/.test(error.message)) {
    return new ProviderError(`No API credentials found. Set ${credentialHint}.`, { cause: error });
  }
  // The SDK wraps a failure to read a started stream, such as a dropped connection, keeping its cause.
  if (error instanceof Anthropic.AnthropicError && error.cause instanceof Error) {
    return new ProviderError(`The connection to the Anthropic API dropped during the response: ${error.message}`, { retryable: true, cause: error });
  }
  // A stream that ended cleanly but early (no chunks, or no `message_stop`), or one spliced onto
  // another: Bun's fetch resends a request whose reused connection dies, and appends the new body.
  if (error instanceof Anthropic.AnthropicError && /request ended without sending any chunks|stream ended without producing a Message|Unexpected event order/.test(error.message)) {
    return new ProviderError('The Anthropic API stream ended before the response finished.', { retryable: true, cause: error });
  }
  return error;
}

function isBadToolJson(error: unknown): boolean {
  return (
    error instanceof Anthropic.AnthropicError &&
    !(error instanceof Anthropic.APIError) &&
    /Unable to parse tool parameter JSON/.test(error.message)
  );
}

/** Where requests go, so a stored key is only sent to the server it was saved for. */
export function anthropicEndpoint(config: ProviderConfig): string {
  return (config.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
}

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly credentialEnvVars: string[];
  readonly serverTools: ServerTool[];
  readonly modelAliases: Record<string, string> = {
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-5-5',
    fable: 'claude-fable-5-1',
  };

  private readonly client: Anthropic;
  private readonly fullApiFeatures: boolean;
  private readonly credentialHint: string;
  private readonly hasStoredKey: boolean;
  private readonly configuredWindow: number | undefined;
  private readonly maxRetries: number;

  constructor(config: ProviderInit = {}) {
    this.name = config.name ?? PROVIDER_ID;
    this.defaultModel = config.model ?? DEFAULT_MODEL;
    const baseUrl = config.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
    // The extras are only known to work on the real API; a proxy may reject them.
    this.fullApiFeatures = config.fullApiFeatures ?? !baseUrl;
    this.serverTools = this.fullApiFeatures ? ['web_search'] : [];
    this.credentialEnvVars = [...STANDARD_CREDENTIAL_VARS, ...(config.apiKeyEnv ? [config.apiKeyEnv] : [])];
    this.credentialHint = config.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    this.configuredWindow = config.contextWindow;
    const envKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
    // With no variable named, the SDK reads the standard ones itself, and they come first.
    const standardKeySet = !config.apiKeyEnv && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    const key = envKey || (standardKeySet ? undefined : config.storedKey);
    this.hasStoredKey = Boolean(config.storedKey);
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.client = new Anthropic({
      // Retries happen in withRetries, which also covers a stream that fails partway and waits longer.
      maxRetries: 0,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      ...(key ? { apiKey: key } : {}),
    });
  }

  contextWindow(model: string): number {
    return modelSpec(model)?.contextWindow ?? this.configuredWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  configurationWarning(): string | undefined {
    const names = this.credentialHint === 'ANTHROPIC_API_KEY' ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] : [this.credentialHint];
    if (this.hasStoredKey || names.some((name) => process.env[name])) return undefined;
    return `${this.credentialHint} is not set, so requests will fail unless an \`ant auth login\` profile exists. Save a key with: cairn provider key ${this.name}`;
  }

  async listModels(): Promise<string[]> {
    return knownModelIds();
  }

  stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const params = buildParams(request, this.fullApiFeatures);
    return withRetries(this.maxRetries, request.signal, () => this.attempt(params, request));
  }

  private async *attempt(params: ApiParams, request: ProviderRequest): AsyncGenerator<StreamEvent> {
    let refreshToken = false;
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream(params, {
        ...(request.signal ? { signal: request.signal } : {}),
        // Only a retry inside the SDK can refresh an `ant auth login` token that a 401 says is stale.
        ...(refreshToken ? { maxRetries: 1 } : {}),
      });
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') yield { type: 'text_delta', text: event.delta.text };
            else if (event.delta.type === 'thinking_delta') yield { type: 'thinking_delta', text: event.delta.thinking };
          } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name };
          } else if (event.type === 'content_block_stop') {
            const block = stream.currentMessage?.content[event.index] as unknown as ApiBlock | undefined;
            if (block?.type === 'server_tool_use') {
              const query = (block.input as { query?: unknown } | undefined)?.query;
              const name = block.name === 'web_search' ? 'WebSearch' : String(block.name).startsWith('tool_search') ? 'ToolSearch' : String(block.name);
              yield { type: 'server_tool', name, ...(typeof query === 'string' ? { summary: query } : {}) };
            }
          }
        }
        const message = await stream.finalMessage();
        yield this.finalEvent(message, request.model);
        return;
      } catch (error) {
        // The tool call never completed, so there is no id to answer: the turn is sent again.
        if (isBadToolJson(error) && attempt < MAX_BAD_TOOL_JSON_RETRIES) continue;
        if (error instanceof Anthropic.AuthenticationError && !refreshToken && this.client.apiKey == null) {
          refreshToken = true;
          attempt--;
          continue;
        }
        throw translateError(error, this.credentialHint);
      }
    }
  }

  private finalEvent(message: ApiMessage, requestedModel: string): StreamEvent {
    const usage = message.usage as unknown as ApiUsage;
    const neutralUsage: Usage = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      webSearches: usage.server_tool_use?.web_search_requests ?? 0,
    };
    const stopReason = neutralStopReason(message.stop_reason);
    const detail = stopReason === 'refusal' ? refusalDetail(message) : undefined;
    const servedBy = String(message.model);
    const cost = costOf(usage, servedBy, requestedModel);
    const notices = historyMismatchNotices(message);
    return {
      type: 'message_end',
      content: toNeutralContent(message.content as unknown as ApiBlock[]),
      stopReason,
      usage: neutralUsage,
      ...(detail ? { stopDetail: detail } : {}),
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(servedBy !== requestedModel ? { servedBy } : {}),
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
}
