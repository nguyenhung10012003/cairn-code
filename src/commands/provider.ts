/** /provider and /model: switching what answers, mid-session, and adding providers. */
import { credentialsPath } from '../config/paths.ts';
import type { ModelProvider, ProviderConfig } from '../core/provider.ts';
import type { Runtime } from '../core/runtime.ts';
import { BUILTIN_PROVIDERS, createProvider, keySource, PROVIDER_TYPES, ProviderNotConfiguredError, providerTypeName } from '../providers/index.ts';
import {
  ADDABLE_TYPES,
  clearDefaultProvider,
  forgetProviderKey,
  keyWarning,
  modelChoices,
  providerProblem,
  providerRows,
  removeProviderConfig,
  saveProviderKey,
  suggestName,
  writeProviderConfig,
} from '../providers/manage.ts';
import type { CommandIO, CommandResult, PickItem } from './slash.ts';

const ADD = '+add';

function listText(runtime: Runtime): string {
  const rows = providerRows(runtime.providerConfigs());
  const width = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row) => {
    const mark = row.name === runtime.providerName ? '*' : ' ';
    return `${mark} ${row.name.padEnd(width)}  ${row.type.padEnd(11)}  ${(row.model || '(no model)').padEnd(20)}  key: ${row.key}`;
  });
  return [...lines, '', 'Switch with /provider <name>, add one with /provider add, save a key with /provider key <name>.'].join('\n');
}

/** Asks for and saves a key when the provider needs one it does not have. False if the user gave none. */
async function ensureKey(name: string, config: ProviderConfig, io: CommandIO, out: string[]): Promise<boolean> {
  const source = keySource(name, config);
  const missing = source.kind === 'stored-elsewhere' || (source.kind === 'none' && !source.optional);
  if (!missing) return true;
  if (!io.ask) {
    out.push(`"${name}" has no API key. Save one with: cairn provider key ${name}`);
    return false;
  }
  const type = providerTypeName(name, config)!;
  const warning = keyWarning(config, type);
  if (warning) out.push(`Warning: ${warning}`);
  const key = await io.ask(`API key for ${name} (saved in ${credentialsPath()}): `, { secret: true });
  if (!key) {
    out.push('No key entered, so nothing changed.');
    return false;
  }
  saveProviderKey(name, config, key);
  out.push(`Saved the key for ${name}.`);
  return true;
}

/** Offers the provider's models, with whatever the user types as a choice too. */
async function chooseModel(runtime: Runtime, provider: ModelProvider, current: string | undefined, io: CommandIO, out: string[]): Promise<string | null> {
  const { models, error } = await modelChoices(provider);
  if (error) out.push(error);
  if (io.pick) {
    const list = current && !models.includes(current) ? [current, ...models] : models;
    const items: PickItem[] = list.map((model) => ({ value: model, label: model, ...(model === runtime.agent.model && provider.name === runtime.providerName ? { detail: 'current' } : {}) }));
    return io.pick(`Model for ${provider.name}`, items, { ...(current ? { initial: current } : {}), allowCustom: true });
  }
  if (io.ask) return (await io.ask(`Model for ${provider.name}: `)) || null;
  return null;
}

function savedNote(runtime: Runtime): string {
  const path = runtime.saveDefaults();
  return path ? ` New sessions start with it too (${path}).` : '';
}

async function switchTo(runtime: Runtime, name: string, model: string | undefined, io: CommandIO): Promise<CommandResult> {
  const config = runtime.providerConfigs()[name];
  if (!providerTypeName(name, config)) return { output: `Unknown provider "${name}".\n\n${listText(runtime)}` };
  const out: string[] = [];
  if (!(await ensureKey(name, config ?? {}, io, out))) return { output: out.join('\n') };
  let chosen = model;
  if (!chosen && !config?.model && providerTypeName(name, config) === 'openai-chat') {
    const candidate = createProvider(name, config);
    chosen = (await chooseModel(runtime, candidate, undefined, io, out)) ?? undefined;
    if (!chosen) return { output: [...out, `"${name}" has no model set, so the provider stays ${runtime.providerName}.`].join('\n') };
  }
  try {
    out.push(...runtime.useProvider(name, chosen));
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) return { output: [...out, error.message].join('\n') };
    throw error;
  }
  out.unshift(`Now using ${name} with ${runtime.agent.model}.${savedNote(runtime)}`);
  return { output: out.join('\n') };
}

async function addFlow(runtime: Runtime, io: CommandIO, presetName: string | undefined): Promise<CommandResult> {
  if (!io.pick || !io.ask) return { output: 'Adding a provider needs the interactive session. From a shell: cairn provider add <name> --type <type> --base-url <url>' };
  const type = await io.pick(
    'What does the provider speak?',
    ADDABLE_TYPES.map((value) => ({ value, label: value, detail: PROVIDER_TYPES[value]!.description })),
    { initial: 'openai-chat' },
  );
  if (!type) return { output: 'Nothing added.' };
  const needsUrl = PROVIDER_TYPES[type]!.needsBaseUrl === true;
  const baseUrl = (await io.ask(needsUrl ? 'Base URL, such as https://api.deepseek.com/v1: ' : 'Base URL (Enter for the standard one): '))?.trim() ?? '';
  if (needsUrl && !baseUrl) return { output: 'A base URL is needed, so nothing was added.' };
  const suggested = presetName ?? suggestName(baseUrl || undefined, type);
  const name = ((await io.ask(`Name [${suggested}]: `))?.trim() || suggested).toLowerCase();
  const config: ProviderConfig = { type, ...(baseUrl ? { baseUrl } : {}) };
  const problem = providerProblem(name, config);
  if (problem) return { output: problem };
  if (runtime.providerConfigs()[name] || BUILTIN_PROVIDERS.includes(name)) {
    return { output: `"${name}" already exists. Remove it first with /provider remove ${name}, or choose another name.` };
  }

  const out: string[] = [];
  const warning = keyWarning(config, type);
  if (warning) out.push(`Warning: ${warning}`);
  const key = await io.ask(`API key for ${name} (Enter for none; saved in ${credentialsPath()}): `, { secret: true });
  if (key === null) return { output: 'Nothing added.' };
  if (key) saveProviderKey(name, config, key);

  const candidate = createProvider(name, config);
  const model = await chooseModel(runtime, candidate, undefined, io, out);
  if (model) config.model = model;
  const path = writeProviderConfig('user', runtime.projectDir, name, config);
  runtime.configureProvider(name, config);
  out.push(`Added ${name} to ${path}.${key ? ' Its key is saved.' : ''}`);
  if (!model) {
    out.push(`It has no model yet. Switch to it with /provider ${name} <model>.`);
    return { output: out.join('\n') };
  }
  const switched = await switchTo(runtime, name, model, io);
  return { output: [...out, switched.output ?? ''].join('\n').trim() };
}

async function keyFlow(runtime: Runtime, name: string, io: CommandIO): Promise<CommandResult> {
  const config = runtime.providerConfigs()[name] ?? {};
  const type = providerTypeName(name, runtime.providerConfigs()[name]);
  if (!type || type === 'scripted') return { output: `Unknown provider "${name}".` };
  if (!io.ask) return { output: `Save a key from a shell with: cairn provider key ${name}` };
  const out: string[] = [];
  const warning = keyWarning(config, type);
  if (warning) out.push(`Warning: ${warning}`);
  const key = await io.ask(`API key for ${name} (saved in ${credentialsPath()}): `, { secret: true });
  if (!key) return { output: [...out, 'No key entered, so nothing changed.'].join('\n') };
  saveProviderKey(name, config, key);
  out.push(`Saved the key for ${name}.`);
  // The running provider read its key when it was created, so it is made again to pick this one up.
  if (name === runtime.providerName) out.push(...runtime.useProvider(name, runtime.agent.model));
  return { output: out.join('\n') };
}

function removeFlow(runtime: Runtime, name: string): CommandResult {
  const lines: string[] = [];
  const path = removeProviderConfig('user', runtime.projectDir, name);
  if (path) {
    lines.push(`Removed ${name} from ${path}.`);
    runtime.configureProvider(name, null);
  }
  if (forgetProviderKey(name)) lines.push(`Deleted the saved key for ${name}.`);
  if (clearDefaultProvider(name)) lines.push('New sessions start with the built-in default again.');
  if (lines.length === 0) return { output: `Nothing saved for "${name}" in your settings. A provider in project settings is removed from that file.` };
  if (name === runtime.providerName) lines.push(`This session keeps using ${name} until you switch.`);
  return { output: lines.join('\n') };
}

export async function providerCommand(args: string, runtime: Runtime, io: CommandIO): Promise<CommandResult> {
  const [first, ...rest] = args.split(/\s+/).filter(Boolean);
  if (!first) {
    if (!io.pick) return { output: listText(runtime) };
    const rows = providerRows(runtime.providerConfigs());
    const items: PickItem[] = rows.map((row) => ({
      value: row.name,
      label: row.name,
      detail: [row.type, row.model || 'no model', row.needsKey ? 'needs a key' : `key: ${row.key}`, row.name === runtime.providerName ? 'current' : ''].filter(Boolean).join(' · '),
    }));
    items.push({ value: ADD, label: 'Add a provider…', detail: 'DeepSeek, Groq, OpenRouter, LM Studio, a gateway…' });
    const choice = await io.pick('Provider', items, { initial: runtime.providerName });
    if (!choice) return {};
    if (choice === ADD) return addFlow(runtime, io, undefined);
    if (choice === runtime.providerName) return { output: `Already using ${choice}. /model changes its model.` };
    return switchTo(runtime, choice, undefined, io);
  }
  switch (first) {
    case 'list':
      return { output: listText(runtime) };
    case 'add':
      return addFlow(runtime, io, rest[0]);
    case 'key':
      return keyFlow(runtime, rest[0] ?? runtime.providerName, io);
    case 'remove':
      if (!rest[0]) return { output: 'Usage: /provider remove <name>' };
      return removeFlow(runtime, rest[0]);
    default:
      return switchTo(runtime, first, rest.join(' ') || undefined, io);
  }
}

export async function modelCommand(args: string, runtime: Runtime, io: CommandIO): Promise<CommandResult> {
  let model: string | null = args.trim() || null;
  const out: string[] = [];
  if (!model && io.pick) {
    model = await chooseModel(runtime, runtime.provider, runtime.agent.model, io, out);
    if (!model) return out.length ? { output: out.join('\n') } : {};
  }
  if (!model) return { output: `Model: ${runtime.agent.model} (${runtime.providerName})` };
  runtime.agent.model = model;
  return { output: [...out, `Model: ${model} (${runtime.providerName}).${savedNote(runtime)}`].join('\n') };
}
