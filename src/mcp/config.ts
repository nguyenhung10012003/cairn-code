/**
 * Which MCP servers exist, and where they were configured. Precedence: --mcp-config, then local,
 * then project, then user. A repo's `.mcp.json` can start arbitrary programs, so it counts only
 * once the directory is trusted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appHome, sessionsDir } from '../config/paths.ts';

export type McpScope = 'user' | 'project' | 'local' | 'flag' | 'plugin';

export interface McpOAuthConfig {
  /** A pre-registered client. Without one, the client registers itself dynamically. */
  clientId?: string;
  /** Space-separated scopes to request. */
  scopes?: string;
  /** A fixed port for the redirect, needed by most pre-registered clients. */
  callbackPort?: number;
}

export interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
  disabled?: boolean;
}

export interface RemoteServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  timeout?: number;
  disabled?: boolean;
}

export type McpServerConfig = StdioServerConfig | RemoteServerConfig;

export interface NamedServer {
  /** The name written in the config. */
  configName: string;
  /** The name in tool names: `mcp__<name>__<tool>`. */
  name: string;
  scope: McpScope;
  config: McpServerConfig;
}

export interface LoadedMcpConfig {
  servers: NamedServer[];
  warnings: string[];
  /** Servers in `.mcp.json` were left out because the directory is not trusted. */
  projectServersPending: number;
}

export interface McpLoadOptions {
  projectDir: string;
  trusted: boolean;
  /** Paths or JSON strings, from --mcp-config. */
  configArgs?: string[];
  /** Use only --mcp-config. */
  strict?: boolean;
  /** The active provider's secrets, which must never reach a remote server through expansion. */
  credentialEnvVars?: string[];
  /** Servers declared by enabled plugins, under names that say so. */
  pluginServers?: Record<string, unknown>;
}

/** Sent to a remote server by mistake, these would hand it your own credentials. */
const NEVER_EXPANDED_FOR_REMOTE = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'OPENAI_API_KEY', 'NPM_TOKEN', 'HTTPS_PROXY'];

export function userConfigPath(): string {
  return join(appHome(), 'mcp.json');
}

export function projectConfigPath(projectDir: string): string {
  return join(projectDir, '.mcp.json');
}

/** Kept outside the repo so a token in it cannot be committed by accident. */
export function localConfigPath(projectDir: string): string {
  return join(sessionsDir(projectDir), 'mcp.json');
}

export function configPathFor(scope: 'user' | 'project' | 'local', projectDir: string): string {
  if (scope === 'user') return userConfigPath();
  return scope === 'project' ? projectConfigPath(projectDir) : localConfigPath(projectDir);
}

/** Server names become part of tool names, and `__` separates the parts. */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{2,}/g, '_').replace(/_+$/, '') || 'server';
}

interface ExpandContext {
  remote: boolean;
  projectDir: string;
  blocked: Set<string>;
  warnings: string[];
  serverName: string;
}

function expandValue(value: string, ctx: ExpandContext): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name: string, fallback: string | undefined) => {
    if (ctx.remote && ctx.blocked.has(name)) {
      ctx.warnings.push(`MCP server "${ctx.serverName}": \${${name}} reads as empty, so that credential is not sent to a remote server. Copy it into a variable of your own to pass it.`);
      return '';
    }
    const actual = name === 'CAIRN_PROJECT_DIR' ? ctx.projectDir : process.env[name];
    if (actual !== undefined) return actual;
    if (fallback !== undefined) return fallback;
    ctx.warnings.push(`MCP server "${ctx.serverName}": \${${name}} is not set.`);
    return match;
  });
}

function expandRecord(record: unknown, ctx: ExpandContext): Record<string, string> | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') out[key] = expandValue(value, ctx);
  }
  return out;
}

function parseEntry(name: string, raw: unknown, base: Omit<ExpandContext, 'remote' | 'serverName'>): McpServerConfig | null {
  const entry = raw as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) {
    base.warnings.push(`MCP server "${name}": expected an object.`);
    return null;
  }
  const rawType = entry.type === 'streamable-http' ? 'http' : entry.type;
  const type = rawType ?? (typeof entry.url === 'string' ? 'http' : 'stdio');
  const shared = {
    ...(typeof entry.timeout === 'number' && entry.timeout >= 1000 ? { timeout: entry.timeout } : {}),
    ...(entry.disabled === true ? { disabled: true } : {}),
  };
  if (type === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command) {
      base.warnings.push(`MCP server "${name}": a stdio server needs a command.`);
      return null;
    }
    const ctx = { ...base, remote: false, serverName: name };
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : undefined;
    const env = expandRecord(entry.env, ctx);
    return {
      type: 'stdio',
      command: expandValue(entry.command, ctx),
      ...(args ? { args: args.map((arg) => expandValue(arg, ctx)) } : {}),
      ...(env ? { env } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: expandValue(entry.cwd, ctx) } : {}),
      ...shared,
    };
  }
  if (type === 'http' || type === 'sse') {
    if (typeof entry.url !== 'string' || !entry.url) {
      base.warnings.push(`MCP server "${name}": a ${type} server needs a url.`);
      return null;
    }
    const ctx = { ...base, remote: true, serverName: name };
    const url = expandValue(entry.url, ctx);
    if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
      base.warnings.push(`MCP server "${name}": ${url} is not an http or https URL.`);
      return null;
    }
    const headers = expandRecord(entry.headers, ctx);
    const oauth = typeof entry.oauth === 'object' && entry.oauth !== null ? (entry.oauth as McpOAuthConfig) : undefined;
    return { type, url, ...(headers ? { headers } : {}), ...(oauth ? { oauth } : {}), ...shared };
  }
  base.warnings.push(`MCP server "${name}": transport "${String(type)}" is not supported. Use stdio, http or sse.`);
  return null;
}

function readConfigObject(text: string, label: string, warnings: string[]): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as { mcpServers?: unknown };
    const servers = parsed.mcpServers;
    if (typeof servers === 'object' && servers !== null && !Array.isArray(servers)) return servers as Record<string, unknown>;
    warnings.push(`${label}: expected an "mcpServers" object.`);
  } catch (error) {
    warnings.push(`${label}: ${(error as Error).message}`);
  }
  return {};
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> {
  return existsSync(path) ? readConfigObject(readFileSync(path, 'utf8'), path, warnings) : {};
}

export function loadMcpConfig(options: McpLoadOptions): LoadedMcpConfig {
  const warnings: string[] = [];
  const blocked = new Set([...NEVER_EXPANDED_FOR_REMOTE, ...(options.credentialEnvVars ?? [])]);
  const byConfigName = new Map<string, { raw: unknown; scope: McpScope }>();
  const add = (entries: Record<string, unknown>, scope: McpScope): void => {
    for (const [name, raw] of Object.entries(entries)) byConfigName.set(name, { raw, scope });
  };

  let pending = 0;
  if (!options.strict) {
    add(options.pluginServers ?? {}, 'plugin');
    add(readConfigFile(userConfigPath(), warnings), 'user');
    const project = readConfigFile(projectConfigPath(options.projectDir), warnings);
    if (options.trusted) add(project, 'project');
    else pending = Object.keys(project).length;
    add(readConfigFile(localConfigPath(options.projectDir), warnings), 'local');
  }
  for (const arg of options.configArgs ?? []) {
    const trimmed = arg.trim();
    if (trimmed.startsWith('{')) {
      add(readConfigObject(trimmed, '--mcp-config', warnings), 'flag');
    } else {
      const path = resolve(options.projectDir, trimmed);
      if (!existsSync(path)) warnings.push(`--mcp-config: ${path} does not exist.`);
      add(readConfigFile(path, warnings), 'flag');
    }
  }

  const servers: NamedServer[] = [];
  const taken = new Map<string, string>();
  for (const [configName, { raw, scope }] of byConfigName) {
    const name = normalizeServerName(configName);
    const earlier = taken.get(name);
    if (earlier !== undefined) {
      warnings.push(`MCP servers "${earlier}" and "${configName}" would have the same tool names. Skipping "${configName}"; rename one.`);
      continue;
    }
    const config = parseEntry(configName, raw, { projectDir: options.projectDir, blocked, warnings });
    if (!config) continue;
    taken.set(name, configName);
    servers.push({ configName, name, scope, config });
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, warnings, projectServersPending: pending };
}

export function writeServer(path: string, name: string, entry: Record<string, unknown> | null): boolean {
  let document: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) document = JSON.parse(readFileSync(path, 'utf8')) as typeof document;
  const servers = (document.mcpServers ??= {});
  const existed = name in servers;
  if (entry) servers[name] = entry;
  else delete servers[name];
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return existed;
}
