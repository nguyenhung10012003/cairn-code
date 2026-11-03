/**
 * Plugins bundle skills, commands, agents, hooks, MCP servers and executables. A plugin comes
 * from --plugin-dir or from `cairn plugin install`, both of them a person's explicit choice, so
 * unlike a repository's own files it does not wait for workspace trust.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { appHome, userSettingsPath } from '../config/paths.ts';
import type { HookGroup, HooksConfig } from '../config/settings.ts';

const MANIFEST_DIRS = ['.cairn-plugin', '.claude-plugin'];
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  skills?: string | string[];
  commands?: string | string[];
  agents?: string | string[];
  hooks?: unknown;
  mcpServers?: unknown;
  defaultEnabled?: boolean;
}

export interface Plugin {
  name: string;
  root: string;
  dataDir: string;
  version?: string;
  description?: string;
  source: 'flag' | 'installed';
  /** Directories holding `<name>/SKILL.md` folders, or one folder holding SKILL.md itself. */
  skillDirs: string[];
  commandPaths: string[];
  agentPaths: string[];
  hooksFiles: string[];
  inlineHooks: HooksConfig[];
  mcpFiles: string[];
  inlineMcp: Record<string, unknown>[];
  binDir?: string;
}

export interface PluginReport {
  plugin: Plugin | null;
  errors: string[];
  warnings: string[];
}

export function installedPluginsDir(): string {
  return join(appHome(), 'plugins');
}

function pluginDataDir(name: string): string {
  return join(appHome(), 'plugin-data', name.replace(/[^a-zA-Z0-9_-]/g, '-'));
}

function asList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A component path must start with `./`, stay inside the plugin, and exist. */
function componentPath(root: string, given: string, label: string, errors: string[], allowRoot = false): string | null {
  if (allowRoot && given === '.') return root;
  if (!given.startsWith('./')) {
    errors.push(`${label} path must start with ./: ${given}`);
    return null;
  }
  const path = resolve(root, given);
  if (given.split('/').includes('..') || isAbsolute(given) || !(path === root || path.startsWith(`${root}${sep}`))) {
    errors.push(`${label} path escapes the plugin directory: ${given}`);
    return null;
  }
  if (!existsSync(path)) {
    errors.push(`${label} path not found: ${given}`);
    return null;
  }
  return path;
}

export function readPlugin(rootGiven: string, source: Plugin['source']): PluginReport {
  const root = resolve(rootGiven);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isDirectory(root)) return { plugin: null, errors: [`Not a directory: ${root}`], warnings };

  let manifest: PluginManifest = {};
  const manifestPath = MANIFEST_DIRS.map((dir) => join(root, dir, 'plugin.json')).find((path) => existsSync(path));
  if (manifestPath) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected a JSON object');
      manifest = parsed as PluginManifest;
    } catch (error) {
      return { plugin: null, errors: [`${manifestPath}: ${(error as Error).message}`], warnings };
    }
    if (manifest.name === undefined) errors.push('plugin.json needs a name.');
  }
  const name = manifest.name ?? basename(root);
  if (!NAME_PATTERN.test(name)) errors.push(`Invalid plugin name: ${JSON.stringify(name)}. Use letters, digits, dots, dashes and underscores.`);
  if (manifestPath && manifest.version === undefined) warnings.push('plugin.json has no version.');
  if (manifestPath && manifest.description === undefined) warnings.push('plugin.json has no description.');
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'CAIRN.md'))) warnings.push('An instruction file at the plugin root is not loaded. Put instructions in a skill.');

  const paths = (value: unknown, label: string, allowRoot = false): string[] =>
    asList(value).flatMap((given) => componentPath(root, given, label, errors, allowRoot) ?? []);

  // `skills` adds to the default folder. `commands` and `agents` replace theirs.
  const skillDirs = [...(isDirectory(join(root, 'skills')) ? [join(root, 'skills')] : []), ...paths(manifest.skills, 'skills', true)];
  if (skillDirs.length === 0 && existsSync(join(root, 'SKILL.md'))) skillDirs.push(root);
  const commandPaths = manifest.commands === undefined ? (isDirectory(join(root, 'commands')) ? [join(root, 'commands')] : []) : paths(manifest.commands, 'commands');
  const agentPaths = manifest.agents === undefined ? (isDirectory(join(root, 'agents')) ? [join(root, 'agents')] : []) : paths(manifest.agents, 'agents');
  if (manifest.commands !== undefined && isDirectory(join(root, 'commands'))) warnings.push('The default commands/ folder is ignored because the manifest sets "commands".');
  if (manifest.agents !== undefined && isDirectory(join(root, 'agents'))) warnings.push('The default agents/ folder is ignored because the manifest sets "agents".');

  const hooksFiles = existsSync(join(root, 'hooks', 'hooks.json')) ? [join(root, 'hooks', 'hooks.json')] : [];
  const inlineHooks: HooksConfig[] = [];
  for (const entry of Array.isArray(manifest.hooks) ? manifest.hooks : manifest.hooks === undefined ? [] : [manifest.hooks]) {
    if (typeof entry === 'string') {
      const path = componentPath(root, entry, 'hooks', errors);
      if (path) hooksFiles.push(path);
    } else if (typeof entry === 'object' && entry !== null) {
      inlineHooks.push(entry as HooksConfig);
    } else {
      errors.push('hooks must be a path or an object.');
    }
  }

  const mcpFiles = existsSync(join(root, '.mcp.json')) ? [join(root, '.mcp.json')] : [];
  const inlineMcp: Record<string, unknown>[] = [];
  for (const entry of Array.isArray(manifest.mcpServers) ? manifest.mcpServers : manifest.mcpServers === undefined ? [] : [manifest.mcpServers]) {
    if (typeof entry === 'string') {
      if (/\.(mcpb|dxt)$/.test(entry)) {
        errors.push(`MCP bundles are not supported yet: ${entry}`);
        continue;
      }
      const path = componentPath(root, entry, 'mcpServers', errors);
      if (path) mcpFiles.push(path);
    } else if (typeof entry === 'object' && entry !== null) {
      inlineMcp.push(entry as Record<string, unknown>);
    } else {
      errors.push('mcpServers must be a path or an object.');
    }
  }

  if (errors.length > 0) return { plugin: null, errors, warnings };
  return {
    plugin: {
      name,
      root,
      dataDir: pluginDataDir(name),
      source,
      skillDirs,
      commandPaths,
      agentPaths,
      hooksFiles,
      inlineHooks,
      mcpFiles,
      inlineMcp,
      ...(manifest.version ? { version: manifest.version } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(isDirectory(join(root, 'bin')) ? { binDir: join(root, 'bin') } : {}),
    },
    errors,
    warnings,
  };
}

export interface LoadedPlugins {
  plugins: Plugin[];
  warnings: string[];
}

/** A plugin from --plugin-dir replaces an installed one of the same name for this run. */
export function loadPlugins(options: { flagDirs?: string[]; enabled?: Record<string, boolean>; includeInstalled: boolean }): LoadedPlugins {
  const byName = new Map<string, Plugin>();
  const warnings: string[] = [];
  const add = (root: string, source: Plugin['source']): void => {
    const report = readPlugin(root, source);
    if (!report.plugin) {
      warnings.push(`Plugin at ${root} did not load: ${report.errors.join(' ')}`);
      return;
    }
    if (source === 'installed' && options.enabled?.[report.plugin.name] === false) return;
    byName.set(report.plugin.name, report.plugin);
  };
  if (options.includeInstalled && isDirectory(installedPluginsDir())) {
    for (const entry of readdirSync(installedPluginsDir()).sort()) {
      const root = join(installedPluginsDir(), entry);
      if (isDirectory(root)) add(root, 'installed');
    }
  }
  for (const dir of options.flagDirs ?? []) add(dir, 'flag');
  return { plugins: [...byName.values()], warnings };
}

/** Substitutes the plugin's paths in anything it declares. Scripts built for Claude Code use the other spelling. */
export function expandPluginVars(text: string, plugin: Plugin, projectDir: string): string {
  return text
    .replace(/\$\{(?:CAIRN|CLAUDE)_PLUGIN_ROOT\}/g, plugin.root)
    .replace(/\$\{(?:CAIRN|CLAUDE)_PLUGIN_DATA\}/g, () => {
      mkdirSync(plugin.dataDir, { recursive: true });
      return plugin.dataDir;
    })
    .replace(/\$\{(?:CAIRN|CLAUDE)_PROJECT_DIR\}/g, projectDir);
}

function expandDeep<T>(value: T, plugin: Plugin, projectDir: string): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) => (typeof item === 'string' ? expandPluginVars(item, plugin, projectDir) : item)) as T;
}

/** A hooks file wraps the event map in `hooks`. An inline object in the manifest is the map itself. */
export function pluginHooks(plugin: Plugin, projectDir: string, warnings: string[]): HooksConfig {
  const merged: HooksConfig = {};
  const env = {
    CAIRN_PLUGIN_ROOT: plugin.root,
    CAIRN_PLUGIN_DATA: plugin.dataDir,
    CLAUDE_PLUGIN_ROOT: plugin.root,
    CLAUDE_PLUGIN_DATA: plugin.dataDir,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  const addAll = (config: HooksConfig): void => {
    for (const [event, groups] of Object.entries(config)) {
      const scoped = expandDeep(groups, plugin, projectDir).map((group: HookGroup) => ({
        ...group,
        hooks: (group.hooks ?? []).map((handler) => ({ ...handler, env: { ...handler.env, ...env } })),
      }));
      (merged[event] ??= []).push(...scoped);
    }
  };
  for (const path of plugin.hooksFiles) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: HooksConfig };
      if (!parsed.hooks) warnings.push(`${path}: a hooks file needs a top-level "hooks" key.`);
      else addAll(parsed.hooks);
    } catch (error) {
      warnings.push(`${path}: ${(error as Error).message}`);
    }
  }
  for (const config of plugin.inlineHooks) addAll(config);
  return merged;
}

/** Each server gets a name that says where it came from, so it cannot pose as one of yours. */
export function pluginMcpServers(plugin: Plugin, projectDir: string, warnings: string[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const addAll = (servers: Record<string, unknown>): void => {
    for (const [name, config] of Object.entries(servers)) merged[`plugin_${plugin.name}_${name}`] = expandDeep(config, plugin, projectDir);
  };
  for (const path of plugin.mcpFiles) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> };
      addAll(parsed.mcpServers ?? (parsed as Record<string, unknown>));
    } catch (error) {
      warnings.push(`${path}: ${(error as Error).message}`);
    }
  }
  for (const servers of plugin.inlineMcp) addAll(servers);
  return merged;
}

function setEnabled(name: string, enabled: boolean): void {
  const path = userSettingsPath();
  let settings: { enabledPlugins?: Record<string, boolean> } = {};
  if (existsSync(path)) settings = JSON.parse(readFileSync(path, 'utf8')) as typeof settings;
  (settings.enabledPlugins ??= {})[name] = enabled;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function enabledMap(): Record<string, boolean> {
  try {
    return (JSON.parse(readFileSync(userSettingsPath(), 'utf8')) as { enabledPlugins?: Record<string, boolean> }).enabledPlugins ?? {};
  } catch {
    return {};
  }
}

const USAGE = `Usage: cairn plugin <command>

  validate <path> [--strict]      Check a plugin without loading it
  install <path>                  Copy a local plugin into ~/.cairn/plugins
  uninstall <name> [--keep-data]  Remove an installed plugin
  list                            Show installed plugins
  enable <name>                   Turn an installed plugin on
  disable <name>                  Turn an installed plugin off
`;

export function runPluginCommand(args: string[]): number {
  const [command, target] = args;
  const print = (text: string): void => void process.stdout.write(`${text}\n`);
  const fail = (text: string): number => {
    process.stderr.write(`${text}\n`);
    return 1;
  };
  switch (command) {
    case 'validate': {
      if (!target) return fail(USAGE);
      const report = readPlugin(target, 'flag');
      for (const error of report.errors) print(`error: ${error}`);
      for (const warning of report.warnings) print(`warning: ${warning}`);
      if (report.errors.length > 0) {
        print('Validation failed');
        return 1;
      }
      if (report.warnings.length > 0) {
        print('Validation passed with warnings');
        return args.includes('--strict') ? 1 : 0;
      }
      print('Validation passed');
      return 0;
    }
    case 'install': {
      if (!target) return fail(USAGE);
      const report = readPlugin(target, 'installed');
      if (!report.plugin) return fail(`Cannot install: ${report.errors.join(' ')}`);
      const destination = join(installedPluginsDir(), report.plugin.name);
      if (resolve(destination) === report.plugin.root) return fail(`${report.plugin.name} is already installed from there.`);
      mkdirSync(installedPluginsDir(), { recursive: true });
      rmSync(destination, { recursive: true, force: true });
      cpSync(report.plugin.root, destination, { recursive: true, verbatimSymlinks: true });
      setEnabled(report.plugin.name, true);
      for (const warning of report.warnings) print(`warning: ${warning}`);
      print(`Installed ${report.plugin.name}${report.plugin.version ? ` ${report.plugin.version}` : ''}. It can run commands through its hooks and MCP servers.`);
      return 0;
    }
    case 'uninstall': {
      if (!target) return fail(USAGE);
      const destination = join(installedPluginsDir(), target);
      // A name, not a path: `../..` here would delete something else entirely.
      if (!NAME_PATTERN.test(target) || !isDirectory(destination)) return fail(`No installed plugin named ${target}.`);
      rmSync(destination, { recursive: true, force: true });
      if (!args.includes('--keep-data')) rmSync(pluginDataDir(target), { recursive: true, force: true });
      print(`Uninstalled ${target}.`);
      return 0;
    }
    case 'list': {
      const loaded = loadPlugins({ includeInstalled: true });
      const enabled = enabledMap();
      const names = isDirectory(installedPluginsDir()) ? readdirSync(installedPluginsDir()).sort() : [];
      if (names.length === 0) print('No plugins installed.');
      for (const name of names) {
        const plugin = loaded.plugins.find((candidate) => basename(candidate.root) === name);
        print(`${name}${plugin?.version ? ` ${plugin.version}` : ''}  ${enabled[name] === false ? 'disabled' : 'enabled'}${plugin?.description ? `  ${plugin.description}` : ''}`);
      }
      for (const warning of loaded.warnings) print(`warning: ${warning}`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      if (!target) return fail(USAGE);
      if (!isDirectory(join(installedPluginsDir(), target))) return fail(`No installed plugin named ${target}.`);
      setEnabled(target, command === 'enable');
      print(`${command === 'enable' ? 'Enabled' : 'Disabled'} ${target}.`);
      return 0;
    }
    default:
      process.stdout.write(USAGE);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 1;
  }
}
