/** Adding, listing and removing providers, saving keys and choosing the default. Used by `cairn provider` and /provider. */
import { existsSync } from 'node:fs';
import { deleteKey, saveKey } from '../config/credentials.ts';
import { userSettingsPath } from '../config/paths.ts';
import { settingsPathFor, updateSettingsFile } from '../config/settings.ts';
import type { SettingsScope } from '../config/settings.ts';
import type { ModelProvider, ProviderConfig } from '../core/provider.ts';
import { BUILTIN_PROVIDERS, createProvider, describeKeySource, keySource, PROVIDER_NAME, PROVIDER_TYPES, providerNames, providerTypeName } from './index.ts';

/** Types a provider can be added with. */
export const ADDABLE_TYPES = Object.keys(PROVIDER_TYPES).filter((type) => !PROVIDER_TYPES[type]!.builtinOnly);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const MODEL_LIST_TIMEOUT_MS = 8_000;

export interface ProviderRow {
  name: string;
  type: string;
  endpoint: string;
  model: string;
  key: string;
  /** It needs a key that it does not have. */
  needsKey: boolean;
}

function defaultModelOf(name: string, config: ProviderConfig): string {
  if (config.model) return config.model;
  try {
    return createProvider(name, config).defaultModel;
  } catch {
    return '';
  }
}

export function providerRows(configs: Record<string, ProviderConfig>): ProviderRow[] {
  return providerNames(configs).map((name) => {
    const config = configs[name] ?? {};
    const type = providerTypeName(name, configs[name]) ?? '?';
    const source = keySource(name, config);
    return {
      name,
      type,
      endpoint: PROVIDER_TYPES[type]?.endpoint(config) ?? '',
      model: defaultModelOf(name, config),
      key: describeKeySource(source),
      needsKey: source.kind === 'stored-elsewhere' || (source.kind === 'none' && !source.optional),
    };
  });
}

/** What is wrong with adding this provider, or undefined. */
export function providerProblem(name: string, config: ProviderConfig): string | undefined {
  if (!PROVIDER_NAME.test(name)) return `"${name}" cannot be a provider name. Use letters, digits, ".", "-" and "_", up to 40 characters.`;
  if (name === 'scripted') return '"scripted" is the mock provider, which has nothing to configure.';
  if (BUILTIN_PROVIDERS.includes(name) && config.type && config.type !== name) return `"${name}" is built in and always speaks its own API. Choose another name.`;
  const type = config.type ?? name;
  if (!ADDABLE_TYPES.includes(type)) return `Unknown type "${type}". Choose one of: ${ADDABLE_TYPES.join(', ')}.`;
  if (PROVIDER_TYPES[type]!.needsBaseUrl && !config.baseUrl) return `A provider of type ${type} needs a base URL, such as https://api.example.com/v1.`;
  if (config.baseUrl) {
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      return `"${config.baseUrl}" is not a URL.`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `The base URL must start with http:// or https://.`;
  }
  return undefined;
}

/** A warning worth showing before a key is saved for this address. */
export function keyWarning(config: ProviderConfig, type: string): string | undefined {
  const endpoint = PROVIDER_TYPES[type]?.endpoint(config);
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) return `${endpoint} is not HTTPS, so the key would cross the network unencrypted.`;
  } catch {
    // Not a URL: nothing to warn about.
  }
  return undefined;
}

/** Adds, replaces or (with null) removes `providers.<name>` in one settings file. */
export function writeProviderConfig(scope: SettingsScope, cwd: string, name: string, config: ProviderConfig | null): string {
  const path = settingsPathFor(scope, cwd);
  updateSettingsFile(path, (settings) => {
    const providers = (settings.providers && typeof settings.providers === 'object' ? settings.providers : {}) as Record<string, unknown>;
    if (config) providers[name] = config;
    else delete providers[name];
    if (Object.keys(providers).length > 0) settings.providers = providers;
    else delete settings.providers;
  });
  return path;
}

/** Removes `providers.<name>` from one settings file. Returns the file when it had one. */
export function removeProviderConfig(scope: SettingsScope, cwd: string, name: string): string | undefined {
  const path = settingsPathFor(scope, cwd);
  if (!existsSync(path)) return undefined;
  let had = false;
  updateSettingsFile(path, (settings) => {
    const providers = settings.providers as Record<string, unknown> | undefined;
    if (!providers || typeof providers !== 'object' || !(name in providers)) return;
    had = true;
    delete providers[name];
    if (Object.keys(providers).length === 0) delete settings.providers;
  });
  return had ? path : undefined;
}

/** Saves the key for the address this configuration sends requests to. */
export function saveProviderKey(name: string, config: ProviderConfig, key: string): void {
  const type = providerTypeName(name, config);
  if (!type) throw new Error(`Unknown provider "${name}".`);
  saveKey(name, key, PROVIDER_TYPES[type]!.endpoint(config));
}

export function forgetProviderKey(name: string): boolean {
  return deleteKey(name);
}

/**
 * Makes this the provider (and model) new sessions start with. Without a model, the provider's
 * own default applies, since a model chosen for another provider would mean nothing here.
 */
export function writeDefaultProvider(name: string, model: string | undefined): string {
  const path = userSettingsPath();
  updateSettingsFile(path, (settings) => {
    settings.provider = name;
    if (model) settings.model = model;
    else delete settings.model;
  });
  return path;
}

/** Takes the default back to the built-in one when it named a provider that is going away. */
export function clearDefaultProvider(name: string): boolean {
  let cleared = false;
  updateSettingsFile(userSettingsPath(), (settings) => {
    if (settings.provider !== name) return;
    delete settings.provider;
    delete settings.model;
    cleared = true;
  });
  return cleared;
}

/** The models to offer for a provider. An error says why the server could not be asked. */
export async function modelChoices(provider: ModelProvider): Promise<{ models: string[]; error?: string }> {
  if (!provider.listModels) return { models: [] };
  try {
    return { models: await provider.listModels(AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS)) };
  } catch (error) {
    const message = (error as Error).name === 'TimeoutError' ? 'it did not answer in time' : (error as Error).message;
    return { models: [], error: `Could not list the models of ${provider.name}: ${message}` };
  }
}

/** A short name for a provider at this address, such as `deepseek` for https://api.deepseek.com/v1. */
export function suggestName(baseUrl: string | undefined, type: string): string {
  if (!baseUrl) return type === 'openai-chat' ? 'chat' : `my-${type}`;
  try {
    const host = new URL(baseUrl).hostname;
    if (LOCAL_HOSTS.has(host)) return 'local';
    const parts = host.split('.').filter((part) => !['api', 'www', 'com', 'ai', 'io', 'net', 'org', 'dev', 'co'].includes(part));
    const name = (parts.at(-1) ?? host).replace(/[^a-z0-9._-]/gi, '');
    return PROVIDER_NAME.test(name) ? name.toLowerCase() : 'custom';
  } catch {
    return 'custom';
  }
}
