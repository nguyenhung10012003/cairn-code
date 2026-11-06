/** The `cairn provider ...` subcommands. */
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { APP_NAME, credentialsPath } from '../config/paths.ts';
import { loadSettings } from '../config/settings.ts';
import type { SettingsScope } from '../config/settings.ts';
import { isTrusted } from '../config/trust.ts';
import type { ProviderConfig } from '../core/provider.ts';
import { pickFromList, readSecret } from '../ui/picker.ts';
import { sanitize } from '../ui/render.ts';
import { BUILTIN_PROVIDERS, createProvider, DEFAULT_PROVIDER, keySource, PROVIDER_TYPES, providerTypeName } from './index.ts';
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
  writeDefaultProvider,
  writeProviderConfig,
} from './manage.ts';

const USAGE = `Usage: ${APP_NAME} provider <command>

  list                                  Providers, their models, and where their keys come from
  add <name> [options]                  Add a provider, or replace its settings
      -t, --type <type>                 ${ADDABLE_TYPES.join(', ')}
      -u, --base-url <url>              Where its API is, such as https://api.deepseek.com/v1
      -m, --model <model>               The model to use with it
      -k, --key-env <VAR>               Read its key from this variable instead of saving one
          --key-stdin                   Read the key to save from standard input
          --no-key                      Do not ask for a key
          --context-window <tokens>     For a model the provider does not know
          --max-output-tokens <tokens>  openai-chat: the most to ask for in a response
      -s, --scope <user|project|local>  Default: user. local is this project, only you, outside the repository.
                                        Keys are only saved for you, never in these files
  key <name> [--stdin | --delete]       Save, replace or delete a provider's key
  use <name> [-m <model>]               Make it the default for new sessions
  remove <name> [-s scope]              Remove a provider and its saved key

Keys are saved in ${credentialsPath()} (readable only by you), each for the address it was entered for.
In a session, /provider and /model switch without restarting.
`;

const interactive = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.\n\n${USAGE}`);
  return value;
}

function parseScope(value: string | undefined): SettingsScope {
  const scope = value ?? 'user';
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') throw new Error(`Unknown scope: ${scope}`);
  return scope;
}

function parseTokens(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/k$/i, '000'));
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a whole number of tokens, such as 128000 or 128k.`);
  return parsed;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function loadConfigs(cwd: string): { providers: Record<string, ProviderConfig>; defaultProvider: string; warnings: string[] } {
  const settings = loadSettings({ cwd, trusted: isTrusted(cwd) });
  return { providers: settings.providers, defaultProvider: settings.provider ?? DEFAULT_PROVIDER, warnings: settings.warnings };
}

function runList(cwd: string): number {
  const { providers, defaultProvider, warnings } = loadConfigs(cwd);
  for (const warning of warnings) process.stderr.write(`Warning: ${sanitize(warning)}\n`);
  const rows = providerRows(providers);
  const width = (pick: (row: (typeof rows)[number]) => string) => Math.max(...rows.map((row) => pick(row).length));
  const [n, t, m, k] = [width((r) => r.name), width((r) => r.type), width((r) => r.model || '(none)'), width((r) => r.key)];
  process.stdout.write(`  ${'NAME'.padEnd(n)}  ${'TYPE'.padEnd(t)}  ${'MODEL'.padEnd(m)}  ${'KEY'.padEnd(k)}  ADDRESS\n`);
  for (const row of rows) {
    const mark = row.name === defaultProvider ? '*' : ' ';
    process.stdout.write(sanitize(`${mark} ${row.name.padEnd(n)}  ${row.type.padEnd(t)}  ${(row.model || '(none)').padEnd(m)}  ${row.key.padEnd(k)}  ${row.endpoint}`) + '\n');
  }
  process.stdout.write(`\n* is the default for new sessions. Change it with: ${APP_NAME} provider use <name>\n`);
  return 0;
}

async function runAdd(argv: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: 'string', short: 't' },
      'base-url': { type: 'string', short: 'u' },
      model: { type: 'string', short: 'm' },
      'key-env': { type: 'string', short: 'k' },
      'key-stdin': { type: 'boolean' },
      'no-key': { type: 'boolean' },
      'context-window': { type: 'string' },
      'max-output-tokens': { type: 'string' },
      scope: { type: 'string', short: 's' },
    },
  });
  const name = requireArg(positionals[0], 'a provider name').toLowerCase();
  const scope = parseScope(values.scope);
  const { providers } = loadConfigs(cwd);

  let type = values.type ?? (BUILTIN_PROVIDERS.includes(name) ? name : providers[name]?.type);
  if (!type && interactive()) {
    type = (await pickFromList(
      'What does the provider speak?',
      ADDABLE_TYPES.map((value) => ({ value, label: value, detail: PROVIDER_TYPES[value]!.description })),
      { initial: 'openai-chat' },
    )) ?? undefined;
  }
  if (!type) throw new Error(`Missing --type: one of ${ADDABLE_TYPES.join(', ')}.`);

  let baseUrl = values['base-url'] ?? providers[name]?.baseUrl;
  if (!baseUrl && PROVIDER_TYPES[type]?.needsBaseUrl && interactive()) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    baseUrl = (await rl.question('Base URL, such as https://api.deepseek.com/v1: ')).trim() || undefined;
    rl.close();
  }

  const contextWindow = parseTokens(values['context-window'], '--context-window');
  const maxOutputTokens = parseTokens(values['max-output-tokens'], '--max-output-tokens');
  // The entry is replaced; only its type and address carry over when not given again.
  const config: ProviderConfig = {
    // A built-in name always speaks its own API, so its type is not written down.
    ...(BUILTIN_PROVIDERS.includes(name) ? {} : { type }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values['key-env'] ? { apiKeyEnv: values['key-env'] } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
  const problem = providerProblem(name, BUILTIN_PROVIDERS.includes(name) ? { ...config, type: name } : config);
  if (problem) throw new Error(problem);

  let savedKey = false;
  if (!values['key-env'] && !values['no-key']) {
    let key = '';
    if (values['key-stdin']) key = await readAllStdin();
    else if (interactive()) {
      const warning = keyWarning(config, type);
      if (warning) process.stderr.write(`Warning: ${warning}\n`);
      key = (await readSecret(`API key for ${name} (Enter for none): `)) ?? '';
    }
    if (key) {
      saveProviderKey(name, config, key);
      savedKey = true;
    }
  }

  if (!config.model && interactive()) {
    const { models, error } = await modelChoices(createProvider(name, config));
    if (error) process.stderr.write(`${sanitize(error)}\n`);
    const model = await pickFromList(`Model for ${name}`, models.map((value) => ({ value, label: value })), { allowCustom: true });
    if (model) config.model = model;
  }

  const existed = providers[name] !== undefined;
  const path = writeProviderConfig(scope, cwd, name, config);
  process.stdout.write(`${existed ? 'Updated' : 'Added'} ${name} in ${path} (${scope} scope).${savedKey ? ` Saved its key in ${credentialsPath()}.` : ''}\n`);
  if (scope === 'project') process.stdout.write('This file is meant to be committed. The key is not in it.\n');
  if (!config.model && PROVIDER_TYPES[type]?.needsBaseUrl) process.stdout.write(`It has no model yet. Set one with: ${APP_NAME} provider add ${name} --model <model>\n`);
  const source = keySource(name, config);
  if (source.kind === 'none' && !source.optional) process.stdout.write(`It has no key yet. Save one with: ${APP_NAME} provider key ${name}\n`);
  process.stdout.write(`Try it: ${APP_NAME} --provider ${name}   Make it the default: ${APP_NAME} provider use ${name}\n`);
  return 0;
}

async function runKey(argv: string[], cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { stdin: { type: 'boolean' }, delete: { type: 'boolean' } } });
  const name = requireArg(positionals[0], 'a provider name');
  const { providers } = loadConfigs(cwd);
  const type = providerTypeName(name, providers[name]);
  if (!type || type === 'scripted') throw new Error(`Unknown provider "${name}". See: ${APP_NAME} provider list`);
  if (values.delete) {
    process.stdout.write(forgetProviderKey(name) ? `Deleted the saved key for ${name}.\n` : `No saved key for ${name}.\n`);
    return 0;
  }
  const config = providers[name] ?? {};
  const warning = keyWarning(config, type);
  if (warning) process.stderr.write(`Warning: ${warning}\n`);
  let key: string | null;
  if (values.stdin) key = await readAllStdin();
  else if (interactive()) key = await readSecret(`API key for ${name}: `);
  else throw new Error('No terminal to type the key into. Pipe it in with --stdin.');
  if (!key) {
    process.stdout.write('No key entered, so nothing changed.\n');
    return 1;
  }
  saveProviderKey(name, config, key);
  process.stdout.write(`Saved the key for ${name} in ${credentialsPath()}, for ${PROVIDER_TYPES[type]!.endpoint(config)} only.\n`);
  return 0;
}

function runUse(argv: string[], cwd: string): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { model: { type: 'string', short: 'm' } } });
  const name = requireArg(positionals[0], 'a provider name');
  const { providers } = loadConfigs(cwd);
  if (!providerTypeName(name, providers[name])) throw new Error(`Unknown provider "${name}". See: ${APP_NAME} provider list`);
  const model = values.model ?? providers[name]?.model;
  const path = writeDefaultProvider(name, model);
  process.stdout.write(`New sessions use ${name}${model ? ` with ${model}` : ' with its default model'}. Saved in ${path}.\n`);
  const source = keySource(name, providers[name]);
  if (source.kind === 'stored-elsewhere' || (source.kind === 'none' && !source.optional)) {
    process.stdout.write(`It has no key for its address yet. Save one with: ${APP_NAME} provider key ${name}\n`);
  }
  return 0;
}

function runRemove(argv: string[], cwd: string): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { scope: { type: 'string', short: 's' } } });
  const name = requireArg(positionals[0], 'a provider name');
  const scopes: SettingsScope[] = values.scope ? [parseScope(values.scope)] : ['user', 'project', 'local'];
  const lines: string[] = [];
  for (const scope of scopes) {
    const path = removeProviderConfig(scope, cwd, name);
    if (path) lines.push(`Removed ${name} from ${path}.`);
  }
  if (forgetProviderKey(name)) lines.push(`Deleted the saved key for ${name}.`);
  if (clearDefaultProvider(name)) lines.push('New sessions start with the built-in default again.');
  if (lines.length === 0) {
    process.stderr.write(`Nothing saved for "${name}".\n`);
    return 1;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export async function runProviderCommand(argv: string[]): Promise<number> {
  const cwd = realpathSync(process.cwd());
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
      case 'ls':
        return runList(cwd);
      case 'add':
        return await runAdd(rest, cwd);
      case 'key':
        return await runKey(rest, cwd);
      case 'use':
        return runUse(rest, cwd);
      case 'remove':
      case 'rm':
        return runRemove(rest, cwd);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        return command === undefined ? 2 : 0;
      default:
        process.stderr.write(`Unknown provider command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${sanitize((error as Error).message)}\n`);
    return 1;
  }
}
