import type { ModelProvider, ProviderConfig } from '../core/provider.ts';
import { AnthropicProvider } from './anthropic.ts';
import { OllamaProvider } from './ollama.ts';
import { OpenAIProvider } from './openai.ts';
import { ScriptedProvider } from './scripted.ts';

export class ProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
  }
}

export const DEFAULT_PROVIDER = 'anthropic';

/**
 * To add a provider: implement ModelProvider in its own file, translating to and from the
 * neutral types in core/messages.ts, and add one line here. Nothing else changes.
 */
const FACTORIES: Record<string, (config: ProviderConfig) => ModelProvider> = {
  anthropic: (config) => new AnthropicProvider(config),
  openai: (config) => new OpenAIProvider(config),
  ollama: (config) => new OllamaProvider(config),
  scripted: () => {
    const script = process.env.CAIRN_SCRIPT;
    if (!script) throw new ProviderNotConfiguredError('The scripted provider needs CAIRN_SCRIPT set to a JSON file of responses.');
    return ScriptedProvider.fromFile(script);
  },
};

export function createProvider(name: string = DEFAULT_PROVIDER, config: ProviderConfig = {}): ModelProvider {
  const factory = FACTORIES[name];
  if (!factory) {
    throw new ProviderNotConfiguredError(`Unknown provider "${name}". Available: ${Object.keys(FACTORIES).join(', ')}.`);
  }
  return factory(config);
}
