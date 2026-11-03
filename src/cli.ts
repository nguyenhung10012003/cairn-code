#!/usr/bin/env -S bun --no-env-file --config=/dev/null
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runDoctor, runPurge } from './commands/maintenance.ts';
import { parseTokenCount } from './commands/slash.ts';
import { APP_NAME, VERSION } from './config/paths.ts';
import { loadSettings, SETTING_SOURCES } from './config/settings.ts';
import type { SettingSource } from './config/settings.ts';
import { isTrusted, markTrusted } from './config/trust.ts';
import { configureDebug } from './core/debug.ts';
import type { Effort, JsonSchema } from './core/provider.ts';
import { createRuntime } from './core/runtime.ts';
import type { Runtime, RuntimeOptions } from './core/runtime.ts';
import { runMcpCommand } from './mcp/cli.ts';
import { runPluginCommand } from './plugins/plugins.ts';
import { PERMISSION_MODES } from './permissions/engine.ts';
import type { PermissionMode } from './permissions/engine.ts';
import { splitRuleList } from './permissions/rules.ts';
import { ProviderNotConfiguredError } from './providers/index.ts';
import { createWorktree, finishWorktree } from './session/worktree.ts';
import type { Worktree } from './session/worktree.ts';
import { McpToolPrompter, NonInteractivePrompter, runPrint } from './ui/print.ts';
import type { OutputFormat } from './ui/print.ts';
import { sanitize } from './ui/render.ts';
import { createTerminalPrompter, runRepl } from './ui/repl.ts';

const PIPED_INPUT_WAIT_MS = 1_000;

const HELP = `Usage: ${APP_NAME} [options] [prompt]

Starts an interactive session. With -p, prints one response and exits.

Options:
  -p, --print                       Run non-interactively and print the result
  -c, --continue                    Continue the latest session in this directory
  -r, --resume <id>                 Resume a session by id
      --fork-session                With --continue or --resume, copy into a new session
      --session-id <uuid>           Use this id for a new session
      --no-session-persistence      Do not save this session to disk
      --model <name>                Model for this session
      --effort <level>              low, medium, high, xhigh or max
      --provider <name>             Which model API to use: anthropic (default), openai, ollama
      --permission-mode <mode>      ${PERMISSION_MODES.join(', ')}
      --dangerously-skip-permissions  Same as --permission-mode bypassPermissions
      --allow-dangerously-skip-permissions
                                    Let Shift+Tab reach bypassPermissions, without starting there
      --allowedTools <rules>        Rules to allow, for example "Bash(npm test *),Edit"
      --disallowedTools <rules>     Rules to deny
      --tools <names>               Limit the built-in tools, for example "Read,Grep"
      --add-dir <dir>               Allow another directory (repeatable)
      --mcp-config <file-or-json>   Load MCP servers from here (repeatable)
      --strict-mcp-config           Use only the servers from --mcp-config
      --settings <file-or-json>     Extra settings to load
      --setting-sources <list>      Which settings layers to read: user, project, local
      --trust                       Trust this directory's project settings for this run
      --system-prompt <text>        Replace the system prompt
      --append-system-prompt <text> Add to the system prompt
      --agent <name>                Run the session as this agent
      --agents <file-or-json>       Define more agents
      --plugin-dir <dir>            Load a plugin from a directory, for this run (repeatable)
      --disable-slash-commands      Turn off skills and custom commands
      --bare                        Skip hooks, installed plugins, and finding instructions and skills
      --safe-mode                   Turn off every customization, to troubleshoot a broken setup
      --restricted                  Remove tools that run code, and ignore settings files
  -w, --worktree [name]             Run in a new git worktree under .cairn/worktrees
  -n, --name <name>                 Name this session, so --resume can find it
      --output-format <format>      With -p: text, json or stream-json
      --input-format <format>       With -p: text, or stream-json for one JSON message per line
      --include-partial-messages    With stream-json output: also stream text as it arrives
      --replay-user-messages        With stream-json in and out: echo input messages back
      --include-hook-events         With stream-json output: report each hook that runs
      --json-schema <file-or-json>  Ask for a final answer matching this JSON Schema
      --permission-prompt-tool <t>  With -p: let this MCP tool answer permission prompts
      --max-turns <n>               Stop after this many model responses
      --max-budget-usd <amount>     Stop when the estimated spend reaches this
      --fallback-model <list>       Try these, in order, when the model is overloaded or unavailable
      --autocompact <auto|tokens>   When to compact automatically, such as 200k
      --betas <list>                Extra API feature flags to send
      --verbose                     Report tool calls on stderr in print mode
  -d, --debug [filter]              Log details, such as --debug=hooks,mcp or --debug=!hooks
      --debug-file <path>           Write the debug log to a file
  -v, --version                     Print the version
  -h, --help                        Show this help

Commands:
  mcp                               Add, list and sign in to MCP servers
  plugin                            Validate, install and manage plugins
  doctor                            Check this installation
  purge [path]                      Delete a project's saved data from this machine
`;

/** These take an optional value, which parseArgs cannot express, so a bare flag gets an empty one. */
export function normalizeOptionalFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (arg === '-w' || arg === '--worktree') {
      if (next !== undefined && !next.startsWith('-')) {
        out.push(`--worktree=${next}`);
        i++;
      } else {
        out.push('--worktree=');
      }
    } else if (arg === '-d' || arg === '--debug') {
      // A prompt can follow, so only something shaped like a filter is taken as one.
      if (next !== undefined && /^!?[a-z]+(,!?[a-z]+)*$/.test(next)) {
        out.push(`--debug=${next}`);
        i++;
      } else {
        out.push('--debug=');
      }
    } else {
      out.push(arg);
    }
  }
  return out;
}

function readJsonArg(arg: string, cwd: string): unknown {
  const trimmed = arg.trim();
  return JSON.parse(trimmed.startsWith('{') ? trimmed : readFileSync(resolve(cwd, trimmed), 'utf8'));
}

/**
 * With a prompt already on the command line, piped input is optional. A parent process may leave
 * stdin open and never write to it, so waiting for it is limited by `firstChunkTimeoutMs`.
 */
function readPipedInput(firstChunkTimeoutMs?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const finish = (): void => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = firstChunkTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          process.stdin.destroy();
          finish();
        }, firstChunkTimeoutMs);
    process.stdin.on('data', (chunk: Buffer) => {
      clearTimeout(timer);
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main(): Promise<number> {
  const subcommand = process.argv[2];
  if (subcommand === 'mcp') return runMcpCommand(process.argv.slice(3));
  if (subcommand === 'plugin' || subcommand === 'plugins') return runPluginCommand(process.argv.slice(3));
  if (subcommand === 'doctor') return runDoctor(realpathSync(process.cwd()));
  if (subcommand === 'purge') return runPurge(process.argv.slice(3), realpathSync(process.cwd()));
  const { values, positionals } = parseArgs({
    args: normalizeOptionalFlags(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      'allow-dangerously-skip-permissions': { type: 'boolean' },
      'setting-sources': { type: 'string' },
      agent: { type: 'string' },
      agents: { type: 'string' },
      'plugin-dir': { type: 'string', multiple: true },
      'disable-slash-commands': { type: 'boolean' },
      bare: { type: 'boolean' },
      'safe-mode': { type: 'boolean' },
      restricted: { type: 'boolean' },
      worktree: { type: 'string' },
      name: { type: 'string', short: 'n' },
      'input-format': { type: 'string' },
      'include-partial-messages': { type: 'boolean' },
      'replay-user-messages': { type: 'boolean' },
      'include-hook-events': { type: 'boolean' },
      'json-schema': { type: 'string' },
      'permission-prompt-tool': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      'fallback-model': { type: 'string' },
      autocompact: { type: 'string' },
      betas: { type: 'string', multiple: true },
      verbose: { type: 'boolean' },
      debug: { type: 'string' },
      'debug-file': { type: 'string' },
      print: { type: 'boolean', short: 'p' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'string', short: 'r' },
      'fork-session': { type: 'boolean' },
      'session-id': { type: 'string' },
      'no-session-persistence': { type: 'boolean' },
      model: { type: 'string' },
      effort: { type: 'string' },
      provider: { type: 'string' },
      'permission-mode': { type: 'string' },
      'dangerously-skip-permissions': { type: 'boolean' },
      allowedTools: { type: 'string', multiple: true },
      'allowed-tools': { type: 'string', multiple: true },
      disallowedTools: { type: 'string', multiple: true },
      'disallowed-tools': { type: 'string', multiple: true },
      tools: { type: 'string', multiple: true },
      'add-dir': { type: 'string', multiple: true },
      'mcp-config': { type: 'string', multiple: true },
      'strict-mcp-config': { type: 'boolean' },
      settings: { type: 'string' },
      trust: { type: 'boolean' },
      'system-prompt': { type: 'string' },
      'append-system-prompt': { type: 'string' },
      'output-format': { type: 'string' },
      'max-turns': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const fail = (message: string): number => {
    process.stderr.write(`${message}\n`);
    return 2;
  };

  let mode = values['permission-mode'] as PermissionMode | undefined;
  if (values['dangerously-skip-permissions']) mode = 'bypassPermissions';
  if (mode !== undefined && !PERMISSION_MODES.includes(mode)) return fail(`Unknown permission mode: ${mode}`);
  const effort = values.effort as Effort | undefined;
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) return fail(`Unknown effort level: ${effort}`);
  const format = (values['output-format'] ?? 'text') as OutputFormat;
  if (!['text', 'json', 'stream-json'].includes(format)) return fail(`Unknown output format: ${format}`);
  let maxTurns: number | undefined;
  if (values['max-turns'] !== undefined) {
    maxTurns = Number.parseInt(values['max-turns'], 10);
    if (!Number.isInteger(maxTurns) || maxTurns < 1) return fail('--max-turns must be a positive integer.');
  }

  const inputFormat = values['input-format'] ?? 'text';
  if (!['text', 'stream-json'].includes(inputFormat)) return fail(`Unknown input format: ${inputFormat}`);
  const streamInput = inputFormat === 'stream-json';
  if (streamInput && format !== 'stream-json') return fail('--input-format stream-json needs --output-format stream-json.');
  if (values['include-partial-messages'] && format !== 'stream-json') return fail('--include-partial-messages needs --output-format stream-json.');
  if (values['include-hook-events'] && format !== 'stream-json') return fail('--include-hook-events needs --output-format stream-json.');
  if (values['replay-user-messages'] && !streamInput) return fail('--replay-user-messages needs --input-format stream-json.');
  let maxBudgetUsd: number | undefined;
  if (values['max-budget-usd'] !== undefined) {
    maxBudgetUsd = Number(values['max-budget-usd']);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) return fail('--max-budget-usd must be a positive number.');
  }
  let autoCompactTokens: number | undefined;
  if (values.autocompact !== undefined && values.autocompact !== 'auto') {
    autoCompactTokens = parseTokenCount(values.autocompact);
    if (autoCompactTokens === undefined) return fail('--autocompact takes auto, or a number of tokens from 100k to 1m.');
  }
  let settingSources: SettingSource[] | undefined;
  if (values['setting-sources'] !== undefined) {
    const names = values['setting-sources'].split(',').map((name) => name.trim()).filter(Boolean);
    const unknown = names.find((name) => !SETTING_SOURCES.includes(name as SettingSource));
    if (unknown) return fail(`Unknown setting source: ${unknown}. Use ${SETTING_SOURCES.join(', ')}.`);
    settingSources = names as SettingSource[];
  }
  const startDir = realpathSync(process.cwd());
  let outputSchema: JsonSchema | undefined;
  if (values['json-schema'] !== undefined) {
    try {
      outputSchema = readJsonArg(values['json-schema'], startDir) as JsonSchema;
    } catch (error) {
      return fail(`--json-schema: ${(error as Error).message}`);
    }
  }
  if (values.debug !== undefined || values['debug-file'] !== undefined) configureDebug(values.debug, values['debug-file']);

  const interactiveTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const printMode = values.print === true || !interactiveTerminal;

  let prompt = positionals.join(' ');
  if (process.stdin.isTTY !== true && !streamInput) {
    const piped = await readPipedInput(prompt.trim() ? PIPED_INPUT_WAIT_MS : undefined);
    if (piped.trim()) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  }
  if (printMode && !streamInput && !prompt.trim()) return fail('No prompt given. Pass one as an argument or on stdin.');
  if (values['permission-prompt-tool'] !== undefined && !printMode) return fail('--permission-prompt-tool needs -p.');

  const allowed = [...(values.allowedTools ?? []), ...(values['allowed-tools'] ?? [])];
  const denied = [...(values.disallowedTools ?? []), ...(values['disallowed-tools'] ?? [])];
  const tools = values.tools ? splitRuleList(values.tools) : undefined;

  let worktree: Worktree | undefined;
  if (values.worktree !== undefined) {
    worktree = createWorktree(startDir, values.worktree);
    process.chdir(worktree.path);
  }
  const cwd = realpathSync(process.cwd());
  const terminal = createTerminalPrompter();

  const noCustomization = values['safe-mode'] === true || values.restricted === true;
  let trust = values.trust === true;
  if (!printMode && !trust && !noCustomization && !isTrusted(cwd)) {
    const probe = loadSettings({ cwd, trusted: false });
    if (probe.needsTrust) {
      process.stdout.write(
        `This directory defines hooks, pre-approved tools, MCP servers, skills or agents, which can run commands on this machine:\n  ${cwd}\n`,
      );
      const answer = (await terminal.input.read('Trust this directory? [y/N]: '))?.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        markTrusted(cwd);
        trust = true;
      }
    }
  }

  const options: RuntimeOptions = {
    cwd,
    prompter: printMode ? new NonInteractivePrompter() : terminal.prompter,
    trust,
    persist: values['no-session-persistence'] !== true,
    onNotice: (text) => (printMode ? process.stderr : process.stdout).write(`\n${sanitize(text)}\n`),
    ...(printMode ? {} : { onProgress: (text: string) => process.stdout.write(`${text}\n`) }),
    ...(values['mcp-config'] === undefined ? {} : { mcpConfig: values['mcp-config'] }),
    ...(values['strict-mcp-config'] ? { strictMcpConfig: true } : {}),
    ...(values.provider === undefined ? {} : { providerName: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(effort === undefined ? {} : { effort }),
    ...(mode === undefined ? {} : { mode }),
    ...(allowed.length > 0 ? { allowedTools: splitRuleList(allowed) } : {}),
    ...(denied.length > 0 ? { disallowedTools: splitRuleList(denied) } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(values.settings === undefined ? {} : { settingsArg: values.settings }),
    ...(values['add-dir'] === undefined ? {} : { addDirs: values['add-dir'] }),
    ...(values['system-prompt'] === undefined ? {} : { systemPrompt: values['system-prompt'] }),
    ...(values['append-system-prompt'] === undefined ? {} : { appendSystemPrompt: values['append-system-prompt'] }),
    ...(values.resume === undefined ? {} : { resume: values.resume }),
    ...(values.continue ? { continueLast: true } : {}),
    ...(values['fork-session'] ? { fork: true } : {}),
    ...(values['session-id'] === undefined ? {} : { sessionId: values['session-id'] }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(printMode ? { unattended: true } : { backgroundAgents: true, generateTitles: true }),
    ...(values.agent === undefined ? {} : { agentName: values.agent }),
    ...(values.agents === undefined ? {} : { agentsArg: values.agents }),
    ...(values['plugin-dir'] === undefined ? {} : { pluginDirs: values['plugin-dir'].map((dir) => resolve(startDir, dir)) }),
    ...(settingSources === undefined ? {} : { settingSources }),
    ...(values['disable-slash-commands'] ? { disableSlashCommands: true } : {}),
    ...(values.bare ? { bare: true } : {}),
    ...(values['safe-mode'] ? { safeMode: true } : {}),
    ...(values.restricted ? { restricted: true } : {}),
    ...(values['allow-dangerously-skip-permissions'] ? { allowBypassMode: true } : {}),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(values['fallback-model'] === undefined ? {} : { fallbackModels: values['fallback-model'].split(',').map((name) => name.trim()).filter(Boolean) }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(values.betas === undefined ? {} : { betas: values.betas.flatMap((list) => list.split(',')).map((beta) => beta.trim()).filter(Boolean) }),
    ...(autoCompactTokens === undefined ? {} : { autoCompactTokens }),
    ...(values.name === undefined ? {} : { name: values.name }),
  };

  let runtime: Runtime;
  try {
    runtime = await createRuntime(options);
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) return fail(error.message);
    throw error;
  }
  if (values['permission-prompt-tool'] !== undefined) runtime.context.prompter = new McpToolPrompter(runtime, values['permission-prompt-tool']);

  try {
    if (printMode) {
      return await runPrint(runtime, prompt, {
        format,
        ...(streamInput ? { streamInput } : {}),
        ...(values['include-partial-messages'] ? { includePartialMessages: true } : {}),
        ...(values['replay-user-messages'] ? { replayUserMessages: true } : {}),
        ...(values['include-hook-events'] ? { includeHookEvents: true } : {}),
        ...(outputSchema ? { structured: true } : {}),
        ...(values.verbose ? { verbose: true } : {}),
      });
    }
    await runRepl(runtime, terminal, prompt.trim() || undefined);
    return 0;
  } finally {
    await runtime.shutdown();
    if (worktree) process.stderr.write(`${finishWorktree(worktree)}\n`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 2;
}
