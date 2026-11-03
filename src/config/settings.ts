/**
 * Layered settings: user < project < local < --settings. Permission rules from every layer
 * accumulate, and scalars take the last value. Untrusted project layers contribute only their
 * restrictive rules, because hooks, allow rules and provider choice can all be used by a
 * malicious repository to run code or send data elsewhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appHome, localSettingsPath, PROJECT_DIR, projectSettingsPath, userSettingsPath } from './paths.ts';
import { parseRule } from '../permissions/rules.ts';
import { mergeSandboxSettings } from '../sandbox/sandbox.ts';
import type { PermissionRule, RuleBehavior, RuleSource } from '../permissions/rules.ts';
import { PERMISSION_MODES } from '../permissions/engine.ts';
import type { PermissionMode } from '../permissions/engine.ts';
import type { Effort, ProviderConfig } from '../core/provider.ts';
import type { SandboxSettings } from '../sandbox/sandbox.ts';

export interface HookHandler {
  type: string;
  /** For `command`: a shell command, or the program to run when `args` is set. */
  command?: string;
  /** Run without a shell, so each value stays one argument. */
  args?: string[];
  /** For `http`. */
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  if?: string;
  /** Run without waiting, and ignore the answer. */
  async?: boolean;
  /** Treat a crash or timeout as blocking, rather than carrying on. */
  onFailure?: 'continue' | 'block';
  /** Remove after the first success. Honoured for a skill's hooks. */
  once?: boolean;
  /** Set for a plugin's hooks. */
  env?: Record<string, string>;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export type HooksConfig = Record<string, HookGroup[]>;

export interface Settings {
  model?: string;
  provider?: string;
  effort?: Effort;
  autoCompact?: boolean;
  /** Environment variables for this session and what it starts. */
  env?: Record<string, string>;
  /** Installed plugins to turn on or off, by name. Read from user settings only. */
  enabledPlugins?: Record<string, boolean>;
  sandbox?: SandboxSettings;
  /** Per-provider options, such as a base URL, keyed by provider name. */
  providers?: Record<string, ProviderConfig>;
  permissions?: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
    defaultMode?: PermissionMode;
    additionalDirectories?: string[];
  };
  hooks?: HooksConfig;
  /** Concise, Explanatory, Learning or Proactive. Takes effect in a new session. */
  outputStyle?: string;
  /** Lines to end commit messages and pull request descriptions with. An empty string leaves one out. */
  attribution?: { commit?: string; pr?: string };
  /** false leaves both attribution lines out. */
  includeCoAuthoredBy?: boolean;
  /** A memory directory the model keeps across sessions of this project. On by default. */
  autoMemoryEnabled?: boolean;
  worktree?: { baseRef?: 'fresh' | 'head' };
}

export interface LoadOptions {
  cwd: string;
  trusted: boolean;
  /** A path or a JSON string, from --settings. */
  settingsArg?: string;
  cliAllow?: string[];
  cliDeny?: string[];
  /** From --setting-sources. A layer not named here is not read at all. */
  sources?: SettingSource[];
}

export type SettingSource = 'user' | 'project' | 'local';
export const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

export interface LoadedSettings {
  model?: string;
  provider?: string;
  effort?: Effort;
  autoCompact: boolean;
  env: Record<string, string>;
  enabledPlugins: Record<string, boolean>;
  sandbox: SandboxSettings;
  providers: Record<string, ProviderConfig>;
  defaultMode: PermissionMode;
  additionalDirectories: string[];
  rules: PermissionRule[];
  hooks: HooksConfig;
  warnings: string[];
  /** Project config contains parts that stay inert until the directory is trusted. */
  needsTrust: boolean;
  outputStyle?: string;
  attribution?: { commit?: string; pr?: string };
  includeCoAuthoredBy?: boolean;
  autoMemoryEnabled: boolean;
  worktreeBaseRef?: 'fresh' | 'head';
}

function readJson(path: string, warnings: string[]): Settings | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      warnings.push(`${path}: expected a JSON object; ignoring it.`);
      return null;
    }
    return parsed as Settings;
  } catch (error) {
    warnings.push(`${path}: ${(error as Error).message}; ignoring it.`);
    return null;
  }
}

function hasPrivilegedParts(settings: Settings): boolean {
  return (
    (settings.permissions?.allow?.length ?? 0) > 0 ||
    Object.keys(settings.hooks ?? {}).length > 0 ||
    settings.provider !== undefined ||
    settings.sandbox !== undefined ||
    Object.keys(settings.env ?? {}).length > 0 ||
    Object.keys(settings.providers ?? {}).length > 0 ||
    settings.permissions?.defaultMode !== undefined ||
    (settings.permissions?.additionalDirectories?.length ?? 0) > 0
  );
}

export function loadSettings(options: LoadOptions): LoadedSettings {
  const warnings: string[] = [];
  const result: LoadedSettings = {
    autoCompact: true,
    env: {},
    enabledPlugins: {},
    sandbox: {},
    providers: {},
    defaultMode: 'default',
    additionalDirectories: [],
    rules: [],
    hooks: {},
    warnings,
    needsTrust: false,
    autoMemoryEnabled: true,
  };

  const addRules = (texts: unknown, behavior: RuleBehavior, source: RuleSource, anchor: string): void => {
    if (texts === undefined) return;
    if (!Array.isArray(texts)) {
      warnings.push(`permissions.${behavior} must be an array.`);
      return;
    }
    for (const text of texts) {
      const rule = typeof text === 'string' ? parseRule(text, behavior, source, anchor) : null;
      if (rule) result.rules.push(rule);
      else warnings.push(`Ignoring invalid ${behavior} rule: ${JSON.stringify(text)}`);
    }
  };

  const apply = (settings: Settings, source: RuleSource, anchor: string, privileged: boolean): void => {
    addRules(settings.permissions?.deny, 'deny', source, anchor);
    addRules(settings.permissions?.ask, 'ask', source, anchor);
    if (!privileged) return;
    addRules(settings.permissions?.allow, 'allow', source, anchor);
    if (settings.model !== undefined) result.model = settings.model;
    if (settings.provider !== undefined) result.provider = settings.provider;
    if (settings.effort !== undefined) result.effort = settings.effort;
    if (settings.autoCompact !== undefined) result.autoCompact = settings.autoCompact;
    if (typeof settings.outputStyle === 'string') result.outputStyle = settings.outputStyle;
    if (settings.attribution && typeof settings.attribution === 'object') result.attribution = { ...result.attribution, ...settings.attribution };
    if (typeof settings.includeCoAuthoredBy === 'boolean') result.includeCoAuthoredBy = settings.includeCoAuthoredBy;
    if (typeof settings.autoMemoryEnabled === 'boolean') result.autoMemoryEnabled = settings.autoMemoryEnabled;
    if (settings.worktree?.baseRef === 'fresh' || settings.worktree?.baseRef === 'head') result.worktreeBaseRef = settings.worktree.baseRef;
    Object.assign(result.env, settings.env);
    if (settings.sandbox) result.sandbox = mergeSandboxSettings(result.sandbox, settings.sandbox);
    for (const [name, config] of Object.entries(settings.providers ?? {})) {
      result.providers[name] = { ...result.providers[name], ...config };
    }
    const mode = settings.permissions?.defaultMode;
    if (mode !== undefined) {
      if (PERMISSION_MODES.includes(mode)) result.defaultMode = mode;
      else warnings.push(`Ignoring unknown defaultMode: ${String(mode)}`);
    }
    for (const dir of settings.permissions?.additionalDirectories ?? []) {
      result.additionalDirectories.push(resolve(anchor, dir));
    }
    for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
      (result.hooks[event] ??= []).push(...groups);
    }
  };

  const sources = options.sources ?? SETTING_SOURCES;
  const user = sources.includes('user') ? readJson(userSettingsPath(), warnings) : null;
  if (user) {
    apply(user, 'user', appHome(), true);
    Object.assign(result.enabledPlugins, user.enabledPlugins);
  }

  for (const [path, source] of [
    [projectSettingsPath(options.cwd), 'project'],
    [localSettingsPath(options.cwd), 'local'],
  ] as const) {
    if (!sources.includes(source)) continue;
    const project = readJson(path, warnings);
    if (!project) continue;
    if (!options.trusted && hasPrivilegedParts(project)) result.needsTrust = true;
    apply(project, source, options.cwd, options.trusted);
  }
  // Each of these can run commands or shape what the agent does once the directory is trusted.
  const privilegedPaths = [join(options.cwd, '.mcp.json'), ...['agents', 'skills', 'commands'].map((name) => join(options.cwd, PROJECT_DIR, name))];
  if (!options.trusted && privilegedPaths.some((path) => existsSync(path))) result.needsTrust = true;

  if (options.settingsArg !== undefined) {
    const arg = options.settingsArg.trim();
    if (arg.startsWith('{')) {
      try {
        apply(JSON.parse(arg) as Settings, 'flag', options.cwd, true);
      } catch (error) {
        warnings.push(`--settings: ${(error as Error).message}`);
      }
    } else {
      const path = resolve(options.cwd, arg);
      const fromFile = readJson(path, warnings);
      if (fromFile) apply(fromFile, 'flag', dirname(path), true);
      else if (!existsSync(path)) warnings.push(`--settings: ${path} does not exist.`);
    }
  }

  addRules(options.cliDeny, 'deny', 'cli', options.cwd);
  addRules(options.cliAllow, 'allow', 'cli', options.cwd);
  return result;
}

export type SettingsScope = 'user' | 'project' | 'local';

export function settingsPathFor(scope: SettingsScope, cwd: string): string {
  if (scope === 'user') return userSettingsPath();
  return scope === 'project' ? projectSettingsPath(cwd) : localSettingsPath(cwd);
}

/**
 * Changes one settings file and keeps everything else in it. A file that is not valid JSON is
 * left alone, rather than replaced by one that has lost its other settings.
 */
export function updateSettingsFile(path: string, change: (settings: Record<string, unknown>) => void): void {
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${path} is not valid JSON (${(error as Error).message}), so it was not changed. Fix it first.`);
    }
  }
  change(current);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}

/** Saves an approval the user chose to keep. The local file is never meant to be committed. */
export function appendLocalAllowRule(cwd: string, rule: string): void {
  const path = localSettingsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const settings = readJson(path, []) ?? {};
  const permissions = (settings.permissions ??= {});
  const allow = (permissions.allow ??= []);
  if (!allow.includes(rule)) allow.push(rule);
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}
