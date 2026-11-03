/**
 * The seam between the agent and whichever model API it talks to. A provider turns a
 * neutral request into a stream of neutral events; nothing else knows about HTTP.
 */
import type { ContentBlock, Message, StopReason, Usage } from './messages.ts';

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Load this definition only when the model searches for it, if the API supports that. */
  deferred?: boolean;
}

export interface SystemBlock {
  text: string;
  /** Marks the end of a stable prefix. Providers with prompt caching may place a breakpoint here. */
  cache?: boolean;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Tools that run on the provider's side. A provider ignores any it does not support. */
export type ServerTool = 'web_search';

export interface ProviderRequest {
  model: string;
  system: SystemBlock[];
  messages: Message[];
  tools: ToolDefinition[];
  serverTools?: ServerTool[];
  /** Limits for the web search server tool, when it is in `serverTools`. */
  webSearch?: { allowedDomains?: string[]; blockedDomains?: string[]; maxUses?: number };
  maxTokens: number;
  effort?: Effort;
  /** For one-off requests, where paying to write a cache entry would be wasted. */
  disableCache?: boolean;
  /** Ask for a final answer that matches this schema. */
  outputSchema?: JsonSchema;
  /** Extra API feature flags, passed through as given. */
  betas?: string[];
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'server_tool'; name: string; summary?: string }
  | {
      type: 'message_end';
      content: ContentBlock[];
      stopReason: StopReason;
      usage: Usage;
      /** Human-readable detail for a refusal or an unusual stop. */
      stopDetail?: string;
      /** Estimated price of this response, when the provider knows its rates. */
      costUsd?: number;
      /** Set when a different model than the one requested produced the response. */
      servedBy?: string;
      notices?: string[];
    };

export interface ModelProvider {
  readonly name: string;
  readonly defaultModel: string;
  /** Secrets the provider reads from the environment. Commands the model runs never see these. */
  readonly credentialEnvVars?: string[];
  /** Server tools this provider can run, as configured. */
  readonly serverTools?: ServerTool[];
  /** What the Agent tool's `model` values (`opus`, `sonnet`, `haiku`, `fable`) mean here. Unlisted ones keep the parent's model. */
  readonly modelAliases?: Record<string, string>;
  stream(request: ProviderRequest): AsyncIterable<StreamEvent>;
  /** Context window for a model, in tokens. Drives auto-compaction. */
  contextWindow(model: string): number;
  /** A problem worth showing at startup, such as missing credentials. */
  configurationWarning?(): string | undefined;
}

/** User-editable settings for one provider, under `providers.<name>` in settings.json. */
export interface ProviderConfig {
  baseUrl?: string;
  /** Read the key from this variable instead of the provider's standard one. */
  apiKeyEnv?: string;
  /** Use API extras even through a custom baseUrl. Set this only if the upstream is the real API. */
  fullApiFeatures?: boolean;
  maxRetries?: number;
  /** Tokens of context, for models the provider does not know. Ollama also loads the model with this many. */
  contextWindow?: number;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}
