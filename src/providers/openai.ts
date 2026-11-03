/**
 * OpenAI through the Responses API, with plain fetch. Requests are stateless (`store: false`):
 * the full history is sent each time, and reasoning is carried across turns as the encrypted
 * reasoning items the API returns, replayed unchanged. Everything specific to the API stays in
 * this file; the agent only sees neutral blocks and events.
 */
import type { Attachment, ContentBlock, Message, StopReason, Usage } from '../core/messages.ts';
import { emptyUsage } from '../core/messages.ts';
import { ProviderError } from '../core/provider.ts';
import type { ModelProvider, ProviderConfig, ProviderInit, ProviderRequest, StreamEvent } from '../core/provider.ts';
import { errorMessage, postJson, serverSentEvents } from './http.ts';

const PROVIDER_ID = 'openai';
const DEFAULT_MODEL = 'gpt-6-astra';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_RETRIES = 4;
const MAX_BAD_TOOL_JSON_RETRIES = 2;
/** Above this many input tokens a request is billed at long-context rates. */
const LONG_PROMPT_THRESHOLD = 272_000;

interface OpenAIModelSpec {
  /**
   * The context Cairn lets a conversation grow to before compacting. These models accept
   * 1,050,000 tokens, but a prompt over 272K is billed at twice the input rate for the whole
   * request, so compaction is set to happen before that.
   */
  contextWindow: number;
  maxOutput: number;
  /** USD per million tokens. */
  prices: { input: number; cachedInput: number; cacheWrite: number; output: number };
}

/** From the model pages at developers.openai.com, November 2026. */
const MODELS: Record<string, OpenAIModelSpec> = {
  'gpt-6-astra': { contextWindow: LONG_PROMPT_THRESHOLD, maxOutput: 128_000, prices: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 } },
  'gpt-6.1-sol': { contextWindow: LONG_PROMPT_THRESHOLD, maxOutput: 128_000, prices: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 } },
  'gpt-6-luna': { contextWindow: LONG_PROMPT_THRESHOLD, maxOutput: 128_000, prices: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 } },
};

export function openaiModelSpec(model: string): OpenAIModelSpec | undefined {
  return MODELS[model];
}

/** Undefined for a model with no known price, so the session total is shown as a lower bound. */
export function estimateOpenAICostUsd(model: string, usage: Usage): number | undefined {
  const spec = MODELS[model];
  if (!spec) return undefined;
  const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const long = totalInput > LONG_PROMPT_THRESHOLD;
  const inputScale = long ? 2 : 1;
  const outputScale = long ? 1.5 : 1;
  const { prices } = spec;
  return (
    (usage.inputTokens * prices.input * inputScale +
      usage.cacheReadTokens * prices.cachedInput * inputScale +
      usage.cacheWriteTokens * prices.cacheWrite * inputScale +
      usage.outputTokens * prices.output * outputScale) /
    1_000_000
  );
}

type Item = { type: string; [key: string]: unknown };

/**
 * What an OpenAI output item becomes in the history. The item itself is kept as an opaque block
 * to replay unchanged; when it also has a neutral form (text, a tool call), `covers` marks that
 * the neutral block right after it is the same thing and is not sent a second time.
 */
interface StoredItem {
  item: Item;
  covers?: boolean;
}

function stored(block: ContentBlock): StoredItem | undefined {
  return block.type === 'opaque' && block.provider === PROVIDER_ID ? (block.data as StoredItem) : undefined;
}

function attachmentPart(attachment: Attachment): Item {
  const url = `data:${attachment.mediaType};base64,${attachment.data}`;
  return attachment.kind === 'image'
    ? { type: 'input_image', image_url: url }
    : { type: 'input_file', filename: 'document.pdf', file_data: url };
}

/** The neutral history as Responses API input items. */
export function toOpenAIInput(messages: readonly Message[]): Item[] {
  const input: Item[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const parts: Item[] = [];
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          const text = block.is_error ? `Error: ${block.content}` : block.content;
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: block.attachments?.length ? [{ type: 'input_text', text }, ...block.attachments.map(attachmentPart)] : text,
          });
        } else if (block.type === 'text') {
          parts.push({ type: 'input_text', text: block.text });
        }
      }
      if (parts.length > 0) input.push({ type: 'message', role: 'user', content: parts });
      continue;
    }
    let skipNext = false;
    for (const block of message.content) {
      const own = stored(block);
      if (own) {
        input.push(own.item);
        skipNext = own.covers === true;
        continue;
      }
      if (block.type === 'opaque') continue; // Another provider's block means nothing here.
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (block.type === 'text') {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] });
      } else if (block.type === 'tool_use') {
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      }
    }
  }
  return input;
}

class BadToolJson extends Error {}

/** Output items as neutral blocks. Throws BadToolJson when a call's arguments do not parse. */
export function toNeutralOutput(output: readonly Item[]): { content: ContentBlock[]; refusal?: string } {
  const items = [...output];
  // A reasoning item must be followed by what it led to. One left at the end, from a response
  // cut short, would make the next request fail.
  while (items.length > 0 && items.at(-1)!.type === 'reasoning') items.pop();
  const content: ContentBlock[] = [];
  let refusal: string | undefined;
  for (const item of items) {
    if (item.type === 'message') {
      const parts = (item.content as Item[] | undefined) ?? [];
      const text = parts.filter((part) => part.type === 'output_text').map((part) => String(part.text ?? '')).join('');
      const refused = parts.find((part) => part.type === 'refusal');
      if (refused) refusal = String(refused.refusal ?? '');
      if (text) {
        content.push({ type: 'opaque', provider: PROVIDER_ID, data: { item, covers: true } satisfies StoredItem });
        content.push({ type: 'text', text });
      } else {
        content.push({ type: 'opaque', provider: PROVIDER_ID, data: { item } satisfies StoredItem });
      }
    } else if (item.type === 'function_call') {
      let input: unknown;
      try {
        input = JSON.parse(String(item.arguments ?? '') || '{}');
      } catch {
        throw new BadToolJson(`The model sent tool arguments that are not valid JSON for ${String(item.name)}.`);
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new BadToolJson(`The model sent tool arguments for ${String(item.name)} that are not an object.`);
      content.push({ type: 'opaque', provider: PROVIDER_ID, data: { item, covers: true } satisfies StoredItem });
      content.push({ type: 'tool_use', id: String(item.call_id), name: String(item.name), input: input as Record<string, unknown> });
    } else {
      content.push({ type: 'opaque', provider: PROVIDER_ID, data: { item } satisfies StoredItem });
    }
  }
  return { content, ...(refusal !== undefined ? { refusal } : {}) };
}

interface ApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number } | null;
}

export function neutralUsage(usage: ApiUsage | null | undefined): Usage {
  if (!usage) return emptyUsage();
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const written = usage.input_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_creation_tokens ?? 0;
  return {
    ...emptyUsage(),
    inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached - written),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    outputTokens: usage.output_tokens ?? 0,
  };
}

export interface OpenAIRequestOptions {
  /** False for a model that rejected the `reasoning` parameter. */
  reasoning: boolean;
}

export function buildOpenAIRequest(request: ProviderRequest, options: OpenAIRequestOptions): Record<string, unknown> {
  const spec = MODELS[request.model];
  const instructions = request.system.map((block) => block.text).join('\n\n');
  return {
    model: request.model,
    ...(instructions ? { instructions } : {}),
    input: toOpenAIInput(request.messages),
    stream: true,
    store: false,
    max_output_tokens: Math.min(request.maxTokens, spec?.maxOutput ?? request.maxTokens),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })),
          parallel_tool_calls: true,
        }
      : {}),
    ...(options.reasoning
      ? { reasoning: { ...(request.effort ? { effort: request.effort } : {}), summary: 'auto' }, include: ['reasoning.encrypted_content'] }
      : {}),
    ...(request.outputSchema ? { text: { format: { type: 'json_schema', name: 'final_answer', schema: request.outputSchema, strict: false } } } : {}),
  };
}

function stopReasonOf(status: string, incompleteReason: string | undefined, content: ContentBlock[], refusal: string | undefined): StopReason {
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') return 'max_tokens';
    if (incompleteReason === 'content_filter') return 'refusal';
    return 'other';
  }
  if (refusal !== undefined) return 'refusal';
  return content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
}

/** The API's way of saying a parameter is not available for this model. */
function rejectsReasoning(error: ProviderError): boolean {
  return error.status === 400 && /reasoning|summary|encrypted_content/i.test(error.message) && /not supported|unsupported|unrecognized|unknown/i.test(error.message);
}

/** Where requests go, so a stored key is only sent to the server it was saved for. */
export function openaiEndpoint(config: ProviderConfig): string {
  return (config.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  readonly credentialEnvVars: string[];
  readonly serverTools = [];
  readonly modelAliases: Record<string, string> = { opus: 'gpt-6-astra', fable: 'gpt-6-astra', sonnet: 'gpt-6.1-sol', haiku: 'gpt-6-luna' };

  private readonly baseUrl: string;
  private readonly keyVar: string;
  private readonly storedKey: string | undefined;
  private readonly maxRetries: number;
  private readonly configuredWindow: number | undefined;
  /** Models that rejected the reasoning parameter once are not sent it again. */
  private readonly withoutReasoning = new Set<string>();

  constructor(config: ProviderInit = {}) {
    this.name = config.name ?? PROVIDER_ID;
    this.defaultModel = config.model ?? DEFAULT_MODEL;
    this.baseUrl = openaiEndpoint(config);
    this.keyVar = config.apiKeyEnv ?? 'OPENAI_API_KEY';
    this.storedKey = config.storedKey;
    this.credentialEnvVars = ['OPENAI_API_KEY', ...(config.apiKeyEnv ? [config.apiKeyEnv] : [])];
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.configuredWindow = config.contextWindow;
  }

  contextWindow(model: string): number {
    return MODELS[model]?.contextWindow ?? this.configuredWindow ?? DEFAULT_CONTEXT_WINDOW;
  }

  private key(): string | undefined {
    return process.env[this.keyVar] || this.storedKey;
  }

  configurationWarning(): string | undefined {
    return this.key() ? undefined : `${this.keyVar} is not set, so requests to OpenAI will fail. Save a key with: cairn provider key ${this.name}`;
  }

  async listModels(): Promise<string[]> {
    return Object.keys(MODELS);
  }

  private headers(): Record<string, string> {
    const key = this.key();
    if (!key) throw new ProviderError(`No OpenAI API key found. Set ${this.keyVar}, or save one with \`cairn provider key ${this.name}\`.`);
    return {
      authorization: `Bearer ${key}`,
      ...(process.env.OPENAI_ORG_ID ? { 'openai-organization': process.env.OPENAI_ORG_ID } : {}),
      ...(process.env.OPENAI_PROJECT_ID ? { 'openai-project': process.env.OPENAI_PROJECT_ID } : {}),
    };
  }

  private describeError(status: number, body: string): ProviderError {
    const message = errorMessage(body);
    const options = { status };
    if (status === 401) return new ProviderError(`OpenAI rejected the API key. Check ${this.keyVar}.`, options);
    if (status === 403) return new ProviderError(`This OpenAI key is not allowed to do that: ${message}`, options);
    if (status === 404) return new ProviderError(`OpenAI could not find that model or endpoint. Check the model name with /model. ${message}`, options);
    if (status === 429) {
      if (/quota|billing|credit/i.test(body)) return new ProviderError(`The OpenAI account has run out of quota or credit: ${message}`, options);
      return new ProviderError('Rate limited by OpenAI, even after retrying. Wait a little and send the message again.', { ...options, retryable: true });
    }
    if (status >= 500) return new ProviderError(`OpenAI is having trouble (HTTP ${status}), even after retrying. Send the message again shortly.`, { ...options, retryable: true });
    return new ProviderError(`OpenAI rejected the request (HTTP ${status}): ${message}`, { ...options, retryable: status === 408 || status === 409 });
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    for (let attempt = 0; ; attempt++) {
      const reasoning = !this.withoutReasoning.has(request.model);
      let response: Response;
      try {
        response = await postJson(`${this.baseUrl}/responses`, {
          headers: this.headers(),
          body: buildOpenAIRequest(request, { reasoning }),
          ...(request.signal ? { signal: request.signal } : {}),
          maxRetries: this.maxRetries,
          describeError: (status, body) => this.describeError(status, body),
          describeNetworkError: (error) => new ProviderError(`Could not reach OpenAI at ${this.baseUrl}: ${error.message}`, { retryable: true, cause: error }),
        });
      } catch (error) {
        if (error instanceof ProviderError && reasoning && rejectsReasoning(error)) {
          this.withoutReasoning.add(request.model);
          attempt--;
          continue;
        }
        throw error;
      }
      try {
        yield* this.read(response, request.model);
        return;
      } catch (error) {
        // The tool call never completed, so there is no id to answer: the turn is sent again.
        if (error instanceof BadToolJson && attempt < MAX_BAD_TOOL_JSON_RETRIES) continue;
        if (error instanceof BadToolJson) throw new ProviderError(error.message);
        throw error;
      }
    }
  }

  private async *read(response: Response, requestedModel: string): AsyncGenerator<StreamEvent> {
    let summaryParts = 0;
    for await (const { data } of serverSentEvents(response)) {
      if (data === '[DONE]') break;
      let event: Item;
      try {
        event = JSON.parse(data) as Item;
      } catch {
        throw new ProviderError(`OpenAI sent an event that is not JSON: ${data.slice(0, 200)}`);
      }
      switch (event.type) {
        case 'response.output_text.delta':
          yield { type: 'text_delta', text: String(event.delta ?? '') };
          break;
        case 'response.reasoning_summary_part.added':
          if (summaryParts++ > 0) yield { type: 'thinking_delta', text: '\n\n' };
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          yield { type: 'thinking_delta', text: String(event.delta ?? '') };
          break;
        case 'response.output_item.added': {
          const item = event.item as Item | undefined;
          if (item?.type === 'function_call') yield { type: 'tool_use_start', id: String(item.call_id), name: String(item.name) };
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const final = event.response as { status?: string; model?: string; output?: Item[]; usage?: ApiUsage; incomplete_details?: { reason?: string } | null };
          const { content, refusal } = toNeutralOutput(final.output ?? []);
          const usage = neutralUsage(final.usage);
          const servedBy = final.model ?? requestedModel;
          const stopReason = stopReasonOf(final.status ?? 'completed', final.incomplete_details?.reason, content, refusal);
          const cost = estimateOpenAICostUsd(MODELS[servedBy] ? servedBy : requestedModel, usage);
          const detail = refusal || (stopReason === 'refusal' ? 'the content filter stopped the response' : undefined);
          yield {
            type: 'message_end',
            content,
            stopReason,
            usage,
            ...(detail ? { stopDetail: detail } : {}),
            ...(cost === undefined ? {} : { costUsd: cost }),
            // A dated snapshot of the model asked for is still that model.
            ...(servedBy !== requestedModel && !servedBy.startsWith(`${requestedModel}-`) ? { servedBy } : {}),
          };
          return;
        }
        case 'response.failed': {
          const failure = (event.response as { error?: { code?: string; message?: string } | null } | undefined)?.error;
          throw new ProviderError(`OpenAI could not complete the response: ${failure?.message ?? failure?.code ?? 'no details given'}`, {
            retryable: failure?.code === 'server_error' || failure?.code === 'rate_limit_exceeded',
          });
        }
        case 'error':
          throw new ProviderError(`OpenAI reported an error during the response: ${String(event.message ?? event.code ?? 'no details given')}`);
      }
    }
    throw new ProviderError('The OpenAI stream ended before the response finished.');
  }
}
