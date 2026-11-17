/**
 * Language servers for the files the agent edits. After an Edit or Write, the file's new text goes
 * to the server for its language and the errors it reports go back to the model with the tool's
 * result, so a mistake is seen at once rather than at the next build.
 *
 * TypeScript and JavaScript come built in, through typescript-language-server, which Karst ships
 * with. Servers for other languages are started when they are on the PATH, and settings can add
 * more or turn any off. Servers run code from the project they open (TypeScript plugins, build
 * scripts), so none starts in a directory that is not trusted.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, relative } from 'node:path';
import { LspClient } from './client.ts';
import type { Diagnostic, LspServerConfig } from './client.ts';

export type { Diagnostic, LspServerConfig };

/** What settings say under `"lsp"`. */
export interface LspSettings {
  /** false turns every language server off. */
  enabled?: boolean;
  /** Servers to add, or `false` to turn off a built-in one by name. */
  servers?: Record<string, Omit<LspServerConfig, 'name' | 'args'> & { args?: string[] } | false>;
}

const TYPESCRIPT_LANGUAGES: Record<string, string> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
};

/** Started when their program is on the PATH. */
const ON_PATH: LspServerConfig[] = [
  { name: 'pyright', command: 'pyright-langserver', args: ['--stdio'], extensionToLanguage: { '.py': 'python', '.pyi': 'python' } },
  { name: 'gopls', command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } },
  { name: 'rust-analyzer', command: 'rust-analyzer', args: [], extensionToLanguage: { '.rs': 'rust' } },
  { name: 'clangd', command: 'clangd', args: [], extensionToLanguage: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp' } },
];

/** How long one edit waits for its diagnostics. The first waits longer, while the server loads the project. */
const FIRST_WAIT_MS = 15_000;
const WAIT_MS = 4_000;
const MAX_REPORTED = 10;

export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command.includes('/')) return existsSync(command) ? command : undefined;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, command))) return join(dir, command);
  }
  return undefined;
}

/**
 * typescript-language-server: the copy Karst depends on, run with the Node or Bun that runs Karst,
 * or one on the PATH. Undefined when neither is there.
 */
function typescriptServer(): LspServerConfig | undefined {
  try {
    const cli = createRequire(import.meta.url).resolve('typescript-language-server/lib/cli.mjs');
    return { name: 'typescript', command: process.execPath, args: [cli, '--stdio'], extensionToLanguage: TYPESCRIPT_LANGUAGES };
  } catch {
    const found = findOnPath('typescript-language-server');
    return found ? { name: 'typescript', command: found, args: ['--stdio'], extensionToLanguage: TYPESCRIPT_LANGUAGES } : undefined;
  }
}

/** The servers to use: settings' own first, then the built-in ones that are installed and not turned off. */
export function lspServers(settings: LspSettings | undefined, env: NodeJS.ProcessEnv = process.env): { servers: LspServerConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  if (settings?.enabled === false) return { servers: [], warnings };
  const configured = settings?.servers ?? {};
  const servers: LspServerConfig[] = [];
  for (const [name, config] of Object.entries(configured)) {
    if (config === false) continue;
    if (!config || typeof config.command !== 'string' || typeof config.extensionToLanguage !== 'object' || config.extensionToLanguage === null) {
      warnings.push(`lsp.servers.${name} needs "command" and "extensionToLanguage"; skipping it.`);
      continue;
    }
    servers.push({ name, command: config.command, args: Array.isArray(config.args) ? config.args : [], extensionToLanguage: config.extensionToLanguage, ...(config.env ? { env: config.env } : {}), ...(config.initializationOptions !== undefined ? { initializationOptions: config.initializationOptions } : {}) });
  }
  const builtIn = [typescriptServer(), ...ON_PATH.filter((server) => findOnPath(server.command, env))];
  for (const server of builtIn) {
    if (server && configured[server.name] === undefined) servers.push(server);
  }
  return { servers, warnings };
}

export interface LspManagerOptions {
  rootDir: string;
  servers: LspServerConfig[];
  /** Told once for each server that cannot start or stops working. */
  onWarning?: (text: string) => void;
}

export class LspManager {
  private readonly options: LspManagerOptions;
  private readonly clients = new Map<string, LspClient>();
  private readonly broken = new Set<string>();
  private readonly warmed = new Set<string>();

  constructor(options: LspManagerOptions) {
    this.options = options;
  }

  get serverNames(): string[] {
    return this.options.servers.map((server) => server.name);
  }

  private serverFor(path: string): { server: LspServerConfig; languageId: string } | undefined {
    const extension = extname(path).toLowerCase();
    for (const server of this.options.servers) {
      const languageId = server.extensionToLanguage[extension];
      if (languageId && !this.broken.has(server.name)) return { server, languageId };
    }
    return undefined;
  }

  /** The diagnostics for the file as it is now, or null when no server covers it or none answered in time. */
  async diagnostics(path: string, text: string): Promise<Diagnostic[] | null> {
    const match = this.serverFor(path);
    if (!match) return null;
    const { server, languageId } = match;
    let client = this.clients.get(server.name);
    if (!client) {
      client = new LspClient(server, this.options.rootDir);
      this.clients.set(server.name, client);
    }
    const wait = this.warmed.has(server.name) ? WAIT_MS : FIRST_WAIT_MS;
    try {
      const found = await client.diagnostics(path, text, languageId, wait);
      this.warmed.add(server.name);
      return found;
    } catch (error) {
      this.broken.add(server.name);
      this.clients.delete(server.name);
      this.options.onWarning?.(`The ${server.name} language server is off for this session: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * A note for the model about the errors in a file it just changed, or null when there are none
   * or nothing could be learned. Warnings are left out: half-way through a change there are many.
   */
  async report(path: string, text: string): Promise<{ note: string; errors: number } | null> {
    const found = await this.diagnostics(path, text);
    const errors = (found ?? []).filter((item) => item.severity === 1);
    if (errors.length === 0) return null;
    const shown = errors
      .slice(0, MAX_REPORTED)
      .map((item) => `${item.line}:${item.column} ${item.source ? `${item.source} ` : ''}${item.code !== undefined ? `${item.code}: ` : ''}${item.message.split('\n')[0]}`);
    const more = errors.length > MAX_REPORTED ? `\n… and ${errors.length - MAX_REPORTED} more` : '';
    const name = relative(this.options.rootDir, path) || path;
    return {
      note: `<diagnostics file="${name}">\nThe language server reports ${errors.length === 1 ? 'an error' : `${errors.length} errors`} in this file after the change:\n${shown.join('\n')}${more}\n</diagnostics>`,
      errors: errors.length,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop().catch(() => {})));
    this.clients.clear();
  }
}

/** For `karst doctor` and the opening panel: which servers would run, and from where. */
export function describeServers(servers: LspServerConfig[]): string[] {
  return servers.map((server) => `${server.name} (${Object.keys(server.extensionToLanguage).join(' ')}): ${server.command === process.execPath ? dirname(server.args[0] ?? '') : server.command}`);
}
