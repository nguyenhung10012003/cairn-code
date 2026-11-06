/** The `cairn mcp ...` subcommands. */
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { APP_NAME } from '../config/paths.ts';
import { isTrusted } from '../config/trust.ts';
import { ensureWorkspaceDir } from '../config/workspace.ts';
import { sanitize } from '../ui/render.ts';
import { configPathFor, loadMcpConfig, normalizeServerName, writeServer } from './config.ts';
import { McpManager } from './manager.ts';
import type { McpServerState } from './manager.ts';

const USAGE = `Usage: ${APP_NAME} mcp <command>

  add [options] <name> <command-or-url> [-- args...]
      -t, --transport <stdio|http|sse>   Default: stdio, or http for a URL
      -s, --scope <local|project|user>   Default: local (this project, only you, outside the repository)
      -e, --env KEY=VALUE                Environment for a stdio server (repeatable)
      -H, --header "Name: value"         Header for a remote server (repeatable)
  add-json [-s scope] <name> <json>      Add a server from a JSON definition
  remove [-s scope] <name>               Remove a server
  list                                   List servers and check their connections
  get <name>                             Show one server
  login <name>                           Sign in to a remote server in the browser
  logout <name>                          Delete stored sign-in details
`;

type Scope = 'local' | 'project' | 'user';

function parseScope(value: string | undefined): Scope {
  const scope = value ?? 'local';
  if (scope !== 'local' && scope !== 'project' && scope !== 'user') throw new Error(`Unknown scope: ${scope}`);
  return scope;
}

function statusLine(state: McpServerState): string {
  const details: Record<McpServerState['status'], string> = {
    connected: `connected (${state.toolCount} tools)`,
    failed: `failed: ${state.error ?? 'unknown error'}`,
    'needs-auth': `needs sign-in: run ${APP_NAME} mcp login ${state.name}`,
    disabled: 'disabled',
    connecting: 'connecting',
  };
  // Error text can come from the server, so it must not reach the terminal raw.
  return sanitize(`${state.configName}: ${state.target} (${state.type}, ${state.scope}) - ${details[state.status]}`);
}

function openManager(projectDir: string, only?: string): { manager: McpManager; pending: number; warnings: string[] } {
  const trusted = isTrusted(projectDir);
  const loaded = loadMcpConfig({ projectDir, trusted });
  const servers = only === undefined ? loaded.servers : loaded.servers.filter((s) => s.configName === only || s.name === normalizeServerName(only));
  const manager = new McpManager(servers, {
    projectDir,
    workingDirs: () => [projectDir],
    onNotice: (text) => process.stdout.write(`${sanitize(text)}\n`),
  });
  return { manager, pending: loaded.projectServersPending, warnings: loaded.warnings };
}

function requireArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}.\n\n${USAGE}`);
  return value;
}

function runAdd(argv: string[], projectDir: string): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      transport: { type: 'string', short: 't' },
      scope: { type: 'string', short: 's' },
      env: { type: 'string', short: 'e', multiple: true },
      header: { type: 'string', short: 'H', multiple: true },
    },
  });
  const name = requireArg(positionals[0], 'a server name');
  const target = requireArg(positionals[1], 'a command or URL');
  const transport = values.transport ?? (/^https?:\/\//.test(target) ? 'http' : 'stdio');
  const scope = parseScope(values.scope);

  let entry: Record<string, unknown>;
  if (transport === 'stdio') {
    const env = Object.fromEntries(
      (values.env ?? []).map((pair) => {
        const separator = pair.indexOf('=');
        if (separator < 1) throw new Error(`Expected KEY=VALUE, got: ${pair}`);
        return [pair.slice(0, separator), pair.slice(separator + 1)];
      }),
    );
    entry = {
      type: 'stdio',
      command: target,
      ...(positionals.length > 2 ? { args: positionals.slice(2) } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  } else if (transport === 'http' || transport === 'sse') {
    const headers = Object.fromEntries(
      (values.header ?? []).map((pair) => {
        const separator = pair.indexOf(':');
        if (separator < 1) throw new Error(`Expected "Name: value", got: ${pair}`);
        return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()];
      }),
    );
    entry = { type: transport, url: target, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  } else {
    throw new Error(`Unknown transport: ${transport}`);
  }
  const path = configPathFor(scope, projectDir);
  if (scope === 'local') ensureWorkspaceDir(projectDir);
  writeServer(path, name, entry);
  process.stdout.write(`Added ${name} to ${path} (${scope} scope).\n`);
  if (scope === 'project') process.stdout.write('This file is meant to be committed, so do not put tokens in it. Use ${VARIABLE} references.\n');
}

/** Values often hold tokens, so only their names are printed. */
function describeRecord(label: string, record: Record<string, string> | undefined): string[] {
  const keys = Object.keys(record ?? {});
  return keys.length > 0 ? [`  ${label}: ${keys.join(', ')} (values hidden)`] : [];
}

export async function runMcpCommand(argv: string[]): Promise<number> {
  const projectDir = realpathSync(process.cwd());
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'add':
        runAdd(rest, projectDir);
        return 0;
      case 'add-json': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { scope: { type: 'string', short: 's' } } });
        const name = requireArg(positionals[0], 'a server name');
        const entry = JSON.parse(requireArg(positionals[1], 'a JSON definition')) as Record<string, unknown>;
        const scope = parseScope(values.scope);
        const path = configPathFor(scope, projectDir);
        if (scope === 'local') ensureWorkspaceDir(projectDir);
        writeServer(path, name, entry);
        process.stdout.write(`Added ${name} to ${path} (${scope} scope).\n`);
        return 0;
      }
      case 'remove': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { scope: { type: 'string', short: 's' } } });
        const name = requireArg(positionals[0], 'a server name');
        const scopes: Scope[] = values.scope ? [parseScope(values.scope)] : ['local', 'project', 'user'];
        // So a server an earlier version saved is found where it is now kept.
        if (scopes.includes('local')) ensureWorkspaceDir(projectDir);
        for (const scope of scopes) {
          const path = configPathFor(scope, projectDir);
          if (writeServer(path, name, null)) {
            process.stdout.write(`Removed ${name} from ${path}.\n`);
            return 0;
          }
        }
        process.stderr.write(`No server named ${name}.\n`);
        return 1;
      }
      case 'list': {
        const { manager, pending, warnings } = openManager(projectDir);
        for (const warning of warnings) process.stderr.write(`Warning: ${warning}\n`);
        await manager.connectAll();
        const states = manager.states();
        for (const state of states) process.stdout.write(`${statusLine(state)}\n`);
        if (pending > 0) process.stdout.write(`${pending} server(s) in .mcp.json are pending: trust this directory to use them.\n`);
        if (states.length === 0 && pending === 0) process.stdout.write(`No MCP servers configured. Add one with ${APP_NAME} mcp add.\n`);
        await manager.close();
        return 0;
      }
      case 'get': {
        const name = requireArg(rest[0], 'a server name');
        const { servers } = loadMcpConfig({ projectDir, trusted: isTrusted(projectDir) });
        const server = servers.find((s) => s.configName === name || s.name === name);
        if (!server) {
          process.stderr.write(`No server named ${name}.\n`);
          return 1;
        }
        const { config } = server;
        const lines = [`${server.configName} (${server.scope} scope)`, `  Type: ${config.type}`];
        if (config.type === 'stdio') {
          lines.push(`  Command: ${[config.command, ...(config.args ?? [])].join(' ')}`, ...describeRecord('Environment', config.env));
        } else {
          lines.push(`  URL: ${config.url}`, ...describeRecord('Headers', config.headers));
        }
        lines.push(`  Tool names: mcp__${server.name}__<tool>`);
        process.stdout.write(`${lines.join('\n')}\n`);
        return 0;
      }
      case 'login': {
        const name = requireArg(rest[0], 'a server name');
        const { manager } = openManager(projectDir, name);
        try {
          const state = await manager.login(normalizeServerName(name));
          process.stdout.write(`${statusLine(state)}\n`);
          return state.status === 'connected' ? 0 : 1;
        } finally {
          await manager.close();
        }
      }
      case 'logout': {
        const name = requireArg(rest[0], 'a server name');
        const { manager } = openManager(projectDir, name);
        process.stdout.write(manager.logout(normalizeServerName(name)) ? `Signed out of ${name}.\n` : `No stored sign-in for ${name}.\n`);
        return 0;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        return command === undefined ? 2 : 0;
      default:
        process.stderr.write(`Unknown mcp command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    process.stderr.write(`${sanitize((error as Error).message)}\n`);
    return 1;
  }
}
