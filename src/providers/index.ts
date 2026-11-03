import { sameEndpoint, storedKey } from '../config/credentials.ts';
import type { ModelProvider, ProviderConfig, ProviderInit } from '../core/provider.ts';
import { anthropicEndpoint, AnthropicProvider } from './anthropic.ts';
import { ollamaHost, OllamaProvider } from './ollama.ts';
import { chatEndpoint, OpenAIChatProvider } from './openai-chat.ts';
import { openaiEndpoint, OpenAIProvider } from './openai.ts';
import { ScriptedProvider } from './scripted.ts';

export class ProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export const DEFAULT_PROVIDER = 'anthropic';

/** An API Cairn can speak. A provider is one of these, under its own name or another. */
export interface ProviderType {
  description: string;
  create(init: ProviderInit): ModelProvider;
  /** Where requests go with this configuration. A stored key is only sent there. */
  endpoint(config: ProviderConfig): string;
  /** Variables a key is read from, which take precedence over a stored key. */
  keyVars(config: ProviderConfig): string[];
  /** Works without a key, as a server on this machine usually does. */
  keyOptional: boolean;
  /** Has no default address, so a base URL must be configured. */
  needsBaseUrl?: boolean;
  /** Only usable under its own name. */
  builtinOnly?: boolean;
}

/**
 * To add an API: implement ModelProvider in its own file, translating to and from the neutral
 * types in core/messages.ts, and add an entry here. Nothing else changes.
 */
export const PROVIDER_TYPES: Record<string, ProviderType> = {
  anthropic: {
    description: 'Anthropic Messages API, or a gateway that serves it',
    create: (init) => new AnthropicProvider(init),
    endpoint: anthropicEndpoint,
    keyVars: (config) => (config.apiKeyEnv ? [config.apiKeyEnv] : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
    keyOptional: false,
  },
  openai: {
    description: 'OpenAI Responses API',
    create: (init) => new OpenAIProvider(init),
    endpoint: openaiEndpoint,
    keyVars: (config) => [config.apiKeyEnv ?? 'OPENAI_API_KEY'],
    keyOptional: false,
  },
  'openai-chat': {
    description: 'Chat Completions: DeepSeek, Groq, OpenRouter, Mistral, LM Studio, vLLM and others',
    create: (init) => new OpenAIChatProvider(init),
    endpoint: (config) => chatEndpoint(config.baseUrl),
    keyVars: (config) => (config.apiKeyEnv ? [config.apiKeyEnv] : []),
    keyOptional: true,
    needsBaseUrl: true,
  },
  ollama: {
    description: 'Ollama, on this machine or another',
    create: (init) => new OllamaProvider(init),
    endpoint: (config) => ollamaHost(config.baseUrl ?? process.env.OLLAMA_HOST),
    keyVars: (config) => [config.apiKeyEnv ?? 'OLLAMA_API_KEY'],
    keyOptional: true,
  },
  scripted: {
    description: 'Mock replies from a script, without an API',
    create: () => {
      const script = process.env.CAIRN_SCRIPT;
      if (!script) return ScriptedProvider.demo();
      try {
        return ScriptedProvider.fromFile(script);
      } catch (error) {
        throw new ProviderNotConfiguredError(`CAIRN_SCRIPT ${script}: ${(error as Error).message}`);
      }
    },
    endpoint: () => 'scripted',
    keyVars: () => [],
    keyOptional: true,
    builtinOnly: true,
  },
};

/** Available under their own names without any configuration, in this order. */
export const BUILTIN_PROVIDERS = ['anthropic', 'openai', 'ollama', 'scripted'];

/** Names a provider can be added under: letters, digits, dot, dash and underscore. */
export const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/** The type a configured name speaks, or undefined when the name means nothing. */
export function providerTypeName(name: string, config: ProviderConfig | undefined): string | undefined {
  const type = config?.type ?? name;
  if (!PROVIDER_TYPES[type]) return undefined;
  // A built-in name always means its own API, so `openai` cannot be pointed at another type.
  if (BUILTIN_PROVIDERS.includes(name) && type !== name) return undefined;
  if (PROVIDER_TYPES[type]!.builtinOnly && type !== name) return undefined;
  // A type with no default address only exists once configured.
  if (!config && PROVIDER_TYPES[type]!.needsBaseUrl) return undefined;
  return type;
}

/** Built-in providers, then configured ones, in the order to show them. */
export function providerNames(configs: Record<string, ProviderConfig>): string[] {
  const configured = Object.keys(configs).filter((name) => !BUILTIN_PROVIDERS.includes(name) && providerTypeName(name, configs[name]) !== undefined).sort();
  return [...BUILTIN_PROVIDERS.filter((name) => name !== 'scripted'), ...configured, 'scripted'];
}

/**
 * Every variable any configured provider reads a key from. Commands the model runs never see
 * these, whichever provider is in use, since the session can switch between them.
 */
export function allCredentialVars(configs: Record<string, ProviderConfig>, active?: ModelProvider): string[] {
  const names = new Set<string>(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN', 'OPENAI_API_KEY', 'OLLAMA_API_KEY']);
  for (const [name, config] of Object.entries(configs)) {
    const type = providerTypeName(name, config);
    if (type) for (const variable of PROVIDER_TYPES[type]!.keyVars(config)) names.add(variable);
  }
  for (const variable of active?.credentialEnvVars ?? []) names.add(variable);
  return [...names];
}

export type KeySource =
  | { kind: 'env'; variable: string }
  | { kind: 'stored' }
  /** Saved for another endpoint than the one now configured, so it is not sent. */
  | { kind: 'stored-elsewhere'; endpoint: string }
  | { kind: 'none'; optional: boolean };

/** Where this provider's key would come from, without reading the key into anything. */
export function keySource(name: string, config: ProviderConfig = {}): KeySource {
  const typeName = providerTypeName(name, config);
  const type = typeName ? PROVIDER_TYPES[typeName]! : undefined;
  if (!type || typeName === 'scripted') return { kind: 'none', optional: true };
  const variable = type.keyVars(config).find((candidate) => process.env[candidate]);
  if (variable) return { kind: 'env', variable };
  const stored = storedKey(name);
  if (stored) return sameEndpoint(stored.endpoint, type.endpoint(config)) ? { kind: 'stored' } : { kind: 'stored-elsewhere', endpoint: stored.endpoint };
  return { kind: 'none', optional: type.keyOptional };
}

export function describeKeySource(source: KeySource): string {
  switch (source.kind) {
    case 'env':
      return `from ${source.variable}`;
    case 'stored':
      return 'saved';
    case 'stored-elsewhere':
      return `saved for ${source.endpoint} only`;
    case 'none':
      return source.optional ? 'none needed' : 'missing';
  }
}

/**
 * Builds the provider configured under `name`. A saved key is passed in only when it was saved
 * for the endpoint this configuration sends requests to; `notes` explains when it was not.
 */
export function createProvider(name: string = DEFAULT_PROVIDER, config: ProviderConfig = {}, notes?: string[]): ModelProvider {
  const typeName = providerTypeName(name, config);
  if (!typeName) {
    const hint = config.type ? ` Its type "${config.type}" is not one of: ${Object.keys(PROVIDER_TYPES).filter((t) => !PROVIDER_TYPES[t]!.builtinOnly).join(', ')}.` : '';
    throw new ProviderNotConfiguredError(`Unknown provider "${name}".${hint} Available: ${providerNames({}).join(', ')}.`);
  }
  const type = PROVIDER_TYPES[typeName]!;
  if (type.needsBaseUrl && !config.baseUrl) throw new ProviderNotConfiguredError(`The provider "${name}" needs a base URL. Set it with: cairn provider add ${name} --base-url <url>`);
  // Only these fields come from settings; a key never does.
  const { type: _type, model, baseUrl, apiKeyEnv, fullApiFeatures, maxRetries, contextWindow, maxOutputTokens } = config;
  const init: ProviderInit = {
    name,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(fullApiFeatures === undefined ? {} : { fullApiFeatures }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
  const source = keySource(name, config);
  if (source.kind === 'stored') init.storedKey = storedKey(name)!.apiKey;
  if (source.kind === 'stored-elsewhere') {
    notes?.push(
      `The key saved for "${name}" was for ${source.endpoint}, but "${name}" now sends requests to ${type.endpoint(config)}, so the key is not sent. Save one for the new address with: cairn provider key ${name}`,
    );
  }
  return type.create(init);
}
