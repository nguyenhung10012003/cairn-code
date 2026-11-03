/**
 * Wires one session together: settings, permissions, hooks, provider, tools and transcript.
 * Both the interactive UI and print mode start from here.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { Agent } from './agent.ts';
import type { AgentEvent, AgentWatcher } from './agent.ts';
import { AgentRegistry, forkHistory } from './background-agents.ts';
import type { SubagentHandle } from './background-agents.ts';
import { listField, parseFrontmatter, stringField } from './frontmatter.ts';
import { ConversationWatcher, loadInstructions } from './instructions.ts';
import type { InstructionFile, LoadedInstructions } from './instructions.ts';
import { textOf, userText } from './messages.ts';
import type { Message, Usage } from './messages.ts';
import {
  EXPLORE_PROMPT,
  EXPLORE_WHEN_TO_USE,
  findOutputStyle,
  FORK_WHEN_TO_USE,
  GENERAL_PURPOSE_PROMPT,
  GENERAL_PURPOSE_WHEN_TO_USE,
  modelFacts,
  PLAN_PROMPT,
  PLAN_WHEN_TO_USE,
  planModeReminder,
  SESSION_RENAME_PROMPT,
  SESSION_TITLE_PROMPT,
  SESSION_TITLE_SUFFIX,
  SUBAGENT_NOTES,
} from './prompts.ts';
import type { Effort, JsonSchema, ModelProvider, SystemBlock } from './provider.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import type { PromptAgent } from './system-prompt.ts';
import { WakeQueue } from './wakes.ts';
import { APP_DISPLAY_NAME, appHome, backgroundLogDir, PROJECT_DIR } from '../config/paths.ts';
import { appendLocalAllowRule, loadSettings } from '../config/settings.ts';
import type { HooksConfig, LoadedSettings, SettingSource } from '../config/settings.ts';
import { isTrusted } from '../config/trust.ts';
import { HookRunner } from '../hooks/runner.ts';
import type { HookCommonInput } from '../hooks/runner.ts';
import { loadMcpConfig } from '../mcp/config.ts';
import { McpManager } from '../mcp/manager.ts';
import { PermissionEngine } from '../permissions/engine.ts';
import type { PermissionMode } from '../permissions/engine.ts';
import { canonicalize } from '../permissions/rules.ts';
import { loadPlugins, pluginHooks, pluginMcpServers } from '../plugins/plugins.ts';
import type { Plugin } from '../plugins/plugins.ts';
import { createSandbox } from '../sandbox/sandbox.ts';
import type { Sandbox } from '../sandbox/sandbox.ts';
import { loadSkills, renderSkillListing, skillMatchesPath } from '../skills/skills.ts';
import type { LoadedSkills, SkillSources } from '../skills/skills.ts';
import { skillTool } from '../tools/skill.ts';
import { createProvider, DEFAULT_PROVIDER } from '../providers/index.ts';
import { CheckpointStore } from '../session/checkpoints.ts';
import { listSessions, resolveSessionId, restoreHistory, SessionStore } from '../session/store.ts';
import { createWorktree, finishWorktree, isListedWorktree, removeWorktree, worktreeChanges } from '../session/worktree.ts';
import type { Worktree } from '../session/worktree.ts';
import { CronScheduler } from '../tools/cron.ts';
import { builtinTools, INTERACTIVE_ONLY_TOOLS } from '../tools/index.ts';
import { agentTool } from '../tools/interaction.ts';
import { TaskRegistry } from '../tools/tasks.ts';
import { FileTracker } from '../tools/types.ts';
import type { AgentControl, Prompter, SubagentRequest, Tool, ToolContext, ToolOutput, WebSearchRequest, WorktreeControl } from '../tools/types.ts';

const SUBAGENT_MAX_TURNS = 100;
/** Session-level tools a subagent does not get: it cannot ask the user, plan, schedule or move the session. */
const SUBAGENT_EXCLUDED_TOOLS = new Set([
  'Agent',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'Skill',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterWorktree',
  'ExitWorktree',
  'PushNotification',
]);
/** Tools that run code or reach out, removed by --restricted unless --tools names them. */
const RESTRICTED_TOOLS = new Set(['Bash', 'TaskStop', 'WebFetch', 'Monitor']);
/** Someone who typed within this long is taken to be watching, so a notification would be a duplicate. */
const USER_ACTIVE_MS = 60_000;
/** The tier names the Agent tool takes for `model`. Any other name is a model id, used as given. */
const MODEL_TIERS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const UNATTENDED_BACKGROUND_LIMIT_MS = 10 * 60 * 1000;
const MAX_SUBAGENT_STOP_CONTINUATIONS = 3;

export interface RuntimeOptions {
  cwd: string;
  prompter: Prompter;
  /** Supply a provider directly, as tests do. Otherwise one is created by name. */
  provider?: ModelProvider;
  providerName?: string;
  model?: string;
  effort?: Effort;
  mode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Restricts the built-in tool set by name. */
  tools?: string[];
  settingsArg?: string;
  addDirs?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  resume?: string;
  continueLast?: boolean;
  fork?: boolean;
  sessionId?: string;
  persist?: boolean;
  maxTurns?: number;
  /** Treat the directory as trusted for this run without recording it. */
  trust?: boolean;
  onSubagentEvent?: (description: string, event: AgentEvent) => void;
  /** Paths or JSON strings, from --mcp-config. */
  mcpConfig?: string[];
  strictMcpConfig?: boolean;
  /** Run as this agent, with its prompt, tools and model. */
  agentName?: string;
  /** A path or JSON string defining more agents, from --agents. */
  agentsArg?: string;
  pluginDirs?: string[];
  settingSources?: SettingSource[];
  disableSlashCommands?: boolean;
  /** Skip hooks, installed plugins and discovery of instructions and skills. */
  bare?: boolean;
  /** Turn off every customization, to troubleshoot a broken configuration. */
  safeMode?: boolean;
  /** Remove the tools that run code, and ignore settings files. */
  restricted?: boolean;
  /** Nobody is watching, so background commands get a time limit. */
  unattended?: boolean;
  maxBudgetUsd?: number;
  fallbackModels?: string[];
  outputSchema?: JsonSchema;
  betas?: string[];
  autoCompactTokens?: number;
  name?: string;
  allowBypassMode?: boolean;
  /** Something happened outside any turn, such as an MCP server changing its tools. */
  onNotice?: (text: string) => void;
  /** A slow startup step has begun. */
  onProgress?: (text: string) => void;
  openUrl?: (url: URL) => void | Promise<void>;
  /** Run Agent calls in the background, so the conversation goes on while they work. The CLI turns this on. */
  backgroundAgents?: boolean;
  /** Name new sessions from their first prompt with a small model call. The interactive CLI turns this on. */
  generateTitles?: boolean;
}

export interface SubagentDefinition {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: Effort;
  /** Leave the instruction files out of this agent's system prompt. */
  omitInstructions?: boolean;
}

export interface WorktreeSession {
  path: string;
  branch?: string;
  /** False when the session moved into a worktree that already existed. */
  created: boolean;
}

export interface Runtime {
  agent: Agent;
  engine: PermissionEngine;
  hooks: HookRunner;
  provider: ModelProvider;
  mcp: McpManager;
  context: Omit<ToolContext, 'signal'>;
  settings: LoadedSettings;
  instructions: InstructionFile[];
  warnings: string[];
  projectDir: string;
  trusted: boolean;
  plugins: Plugin[];
  sandbox: Sandbox | null;
  agents: SubagentDefinition[];
  sessionName: string | undefined;
  /** --allow-dangerously-skip-permissions: Shift+Tab may reach bypassPermissions. */
  allowBypassMode: boolean;
  newSession(): void;
  resumeSession(id: string): boolean;
  /** Copies this conversation into a new session and continues there. */
  forkSession(name?: string): void;
  renameSession(name: string): void;
  /** Grants access to a directory, and loads its skills, commands and agents. */
  addDirectory(dir: string): void;
  /** Tells the model what changed in the skill list since it last heard. Returns the changes. */
  refreshSkills(): string[];
  /** Background work finishing and scheduled prompts coming due. The UI starts turns for them. */
  wakes: WakeQueue;
  /** Subagents started in the background. */
  backgroundAgents: AgentControl & { running(): number };
  cron: CronScheduler | null;
  /** The plan file plan mode writes to. */
  planFile(): string;
  /** The worktree the session moved into with EnterWorktree, if it is still there. */
  worktreeSession(): WorktreeSession | undefined;
  exitWorktree(action: 'keep' | 'remove', discardChanges: boolean): Promise<{ content: string; isError?: boolean }>;
  /** Adds text to what the model sees with the next message, such as a command the user ran with `!`. */
  noteForModel(text: string): void;
  /** Asks the model for a short kebab-case name for this conversation. */
  suggestName(signal: AbortSignal): Promise<string | undefined>;
  shutdown(): Promise<void>;
}

/** Explore and Plan are read-only: they may find and reason about code, not change it. */
const READ_ONLY_AGENT_TOOLS = ['Read', 'Glob', 'Grep'];

const BUILTIN_AGENTS: SubagentDefinition[] = [
  { name: 'general-purpose', description: GENERAL_PURPOSE_WHEN_TO_USE, prompt: GENERAL_PURPOSE_PROMPT },
  { name: 'Explore', description: EXPLORE_WHEN_TO_USE, prompt: EXPLORE_PROMPT, tools: READ_ONLY_AGENT_TOOLS, omitInstructions: true },
  { name: 'Plan', description: PLAN_WHEN_TO_USE, prompt: PLAN_PROMPT, tools: READ_ONLY_AGENT_TOOLS, omitInstructions: true },
  { name: 'fork', description: FORK_WHEN_TO_USE, prompt: '' },
];

function readAgentFile(path: string, defaultName: string): SubagentDefinition {
  const { fields, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  const definition: SubagentDefinition = { name: defaultName, description: stringField(fields, 'description') ?? '', prompt: body.trim() };
  const tools = listField(fields, 'tools');
  if (tools.length > 0) definition.tools = tools;
  const disallowed = listField(fields, 'disallowedTools');
  if (disallowed.length > 0) definition.disallowedTools = disallowed;
  const model = stringField(fields, 'model');
  if (model) definition.model = model;
  const effort = stringField(fields, 'effort');
  if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) definition.effort = effort as Effort;
  return definition;
}

function describeAgentTools(definition: SubagentDefinition): string {
  if (definition.tools) return definition.tools.join(', ');
  if (definition.disallowedTools) return `All tools except ${definition.disallowedTools.join(', ')}`;
  return '*';
}

/** Finds an agent type by name. Built-in names also match in any case, so `explore` still works. */
function findAgent(definitions: SubagentDefinition[], name: string): SubagentDefinition | undefined {
  return definitions.find((d) => d.name === name) ?? definitions.find((d) => BUILTIN_AGENTS.includes(d) && d.name.toLowerCase() === name.toLowerCase());
}

const PLAN_WORDS = [
  ['amber', 'brisk', 'calm', 'dapper', 'eager', 'gentle', 'iridescent', 'jolly', 'lucid', 'mellow', 'nimble', 'quiet', 'radiant', 'sunny', 'tidy', 'vivid'],
  ['dancing', 'drifting', 'gliding', 'humming', 'leaping', 'roaming', 'sailing', 'skipping', 'soaring', 'spinning', 'swinging', 'wandering'],
  ['badger', 'comet', 'falcon', 'harbor', 'lantern', 'meadow', 'otter', 'pebble', 'quill', 'river', 'sparrow', 'thistle', 'willow'],
];

function planSlug(): string {
  const bytes = randomBytes(3);
  return PLAN_WORDS.map((words, i) => words[bytes[i]! % words.length]).join('-');
}

function usageDelta(after: Usage, before: Usage): Usage {
  return {
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    cacheReadTokens: after.cacheReadTokens - before.cacheReadTokens,
    cacheWriteTokens: after.cacheWriteTokens - before.cacheWriteTokens,
    webSearches: after.webSearches - before.webSearches,
  };
}

/** Sends a desktop notification without passing the text through a shell. */
function sendDesktopNotification(message: string): boolean {
  if (process.platform === 'darwin') {
    const script = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run'];
    return spawnSync('osascript', [...script, message, APP_DISPLAY_NAME], { stdio: 'ignore', timeout: 5000 }).status === 0;
  }
  if (process.platform === 'linux') return spawnSync('notify-send', [APP_DISPLAY_NAME, message], { stdio: 'ignore', timeout: 5000 }).status === 0;
  return false;
}

function agentFiles(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return agentFiles(path);
    return entry.endsWith('.md') ? [path] : [];
  });
}

export interface AgentSources {
  discover?: boolean;
  addDirs?: string[];
  plugins?: Plugin[];
  /** A path or JSON string, from --agents. */
  inline?: string;
  warnings?: string[];
}

function inlineAgents(arg: string, cwd: string, warnings: string[]): SubagentDefinition[] {
  const trimmed = arg.trim();
  let parsed: Record<string, { description?: string; prompt?: string; tools?: unknown; model?: string }>;
  try {
    parsed = JSON.parse(trimmed.startsWith('{') ? trimmed : readFileSync(resolve(cwd, trimmed), 'utf8')) as typeof parsed;
  } catch (error) {
    warnings.push(`--agents: ${(error as Error).message}`);
    return [];
  }
  return Object.entries(parsed).map(([name, value]) => {
    const tools = listField(value as Record<string, unknown>, 'tools');
    return {
      name,
      description: value.description ?? '',
      prompt: value.prompt ?? '',
      ...(tools.length > 0 ? { tools } : {}),
      ...(value.model ? { model: value.model } : {}),
    };
  });
}

/** Later sources override earlier ones of the same name. A plugin's agents carry its name. */
export function loadAgentDefinitions(projectDir: string, trusted: boolean, sources: AgentSources = {}): SubagentDefinition[] {
  const byName = new Map(BUILTIN_AGENTS.map((agent) => [agent.name, agent]));
  const fromDir = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const path of agentFiles(dir)) {
      const fallback = relative(dir, path).replace(/\.md$/, '').split(sep).join(':');
      const { fields } = parseFrontmatter(readFileSync(path, 'utf8'));
      const definition = readAgentFile(path, stringField(fields, 'name') ?? fallback);
      byName.set(definition.name, definition);
    }
  };
  if (sources.discover !== false) fromDir(join(appHome(), 'agents'));
  if (trusted) {
    if (sources.discover !== false) fromDir(join(projectDir, PROJECT_DIR, 'agents'));
    for (const dir of sources.addDirs ?? []) fromDir(join(dir, PROJECT_DIR, 'agents'));
  }
  for (const plugin of sources.plugins ?? []) {
    for (const given of plugin.agentPaths) {
      const files = statSync(given).isDirectory() ? agentFiles(given) : [given];
      const base = statSync(given).isDirectory() ? given : join(given, '..');
      for (const path of files) {
        const definition = readAgentFile(path, `${plugin.name}:${relative(base, path).replace(/\.md$/, '').split(sep).join(':')}`);
        byName.set(definition.name, definition);
      }
    }
  }
  if (sources.inline) {
    for (const definition of inlineAgents(sources.inline, projectDir, sources.warnings ?? [])) byName.set(definition.name, definition);
  }
  return [...byName.values()];
}

function mergeHookConfigs(...configs: HooksConfig[]): HooksConfig {
  const merged: HooksConfig = {};
  for (const config of configs) {
    for (const [event, groups] of Object.entries(config)) (merged[event] ??= []).push(...groups);
  }
  return merged;
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const projectDir = realpathSync(options.cwd);
  const safe = options.safeMode === true;
  const bare = options.bare === true;
  const restricted = options.restricted === true;
  const trusted = !safe && !restricted && (options.trust === true || isTrusted(projectDir));
  const settingSources = restricted ? [] : options.settingSources;
  const settings = loadSettings({
    cwd: projectDir,
    trusted,
    ...(settingSources ? { sources: settingSources } : {}),
    ...(options.settingsArg === undefined ? {} : { settingsArg: options.settingsArg }),
    ...(options.allowedTools ? { cliAllow: options.allowedTools } : {}),
    ...(options.disallowedTools ? { cliDeny: options.disallowedTools } : {}),
  });
  // Before the provider is created, since this may set what it reads.
  Object.assign(process.env, settings.env);
  const providerName = options.providerName ?? settings.provider ?? DEFAULT_PROVIDER;
  const provider = options.provider ?? createProvider(providerName, settings.providers[providerName]);

  const warnings: string[] = [...settings.warnings];
  const pluginLoad = safe
    ? { plugins: [], warnings: [] }
    : loadPlugins({ includeInstalled: !bare && !restricted, enabled: settings.enabledPlugins, ...(options.pluginDirs ? { flagDirs: options.pluginDirs } : {}) });
  const plugins = pluginLoad.plugins;
  warnings.push(...pluginLoad.warnings);
  const skillAddDirs = [...(options.addDirs ?? [])];
  const agentDefinitions = safe
    ? BUILTIN_AGENTS
    : loadAgentDefinitions(projectDir, trusted, {
        discover: !bare && !restricted,
        addDirs: skillAddDirs,
        plugins,
        warnings,
        ...(options.agentsArg ? { inline: options.agentsArg } : {}),
      });
  const sessionAgent = options.agentName === undefined ? undefined : agentDefinitions.find((candidate) => candidate.name === options.agentName);
  if (options.agentName !== undefined && !sessionAgent) {
    throw new Error(`Unknown agent ${options.agentName}. Available: ${agentDefinitions.map((a) => a.name).join(', ')}`);
  }
  const model = options.model ?? sessionAgent?.model ?? settings.model ?? provider.defaultModel;

  let cwd = projectDir;
  const additionalDirs = [...settings.additionalDirectories, ...(options.addDirs ?? [])];
  const engine = new PermissionEngine({
    mode: options.mode ?? settings.defaultMode,
    rules: settings.rules,
    workingDirs: [projectDir, ...additionalDirs],
    cwd: () => cwd,
  });
  const hookConfig = safe ? {} : mergeHookConfigs(bare ? {} : settings.hooks, ...plugins.map((plugin) => pluginHooks(plugin, projectDir, warnings)));
  for (const type of new Set(HookRunner.unsupported(hookConfig))) warnings.push(`Hooks of type "${type}" are not supported yet, and are skipped.`);
  const hooks = new HookRunner(hookConfig, projectDir);
  const noInstructions: LoadedInstructions = { files: [], conditional: [], warnings: [] };
  const loaded = safe || bare ? noInstructions : loadInstructions(projectDir, trusted);
  warnings.push(...loaded.warnings);
  const providerWarning = provider.configurationWarning?.();
  if (providerWarning) warnings.push(providerWarning);
  if (settings.needsTrust) {
    warnings.push('Project hooks, allow rules and custom agents stay inactive until this directory is trusted. Use /trust or --trust.');
  }

  const persist = options.persist !== false;
  let store: SessionStore;
  let history: Message[] = [];
  let recordedSystem: SystemBlock[] | undefined;
  const resumeId = options.resume !== undefined ? resolveSessionId(projectDir, options.resume) : options.continueLast ? listSessions(projectDir)[0]?.id : undefined;
  if (options.continueLast && resumeId === undefined) {
    warnings.push('No earlier session in this directory, so starting a new one.');
  }
  if (resumeId !== undefined) {
    const restored = restoreHistory(projectDir, resumeId);
    if (!restored) throw new Error(`No session ${resumeId} in ${projectDir}.`);
    history = restored.messages;
    recordedSystem = restored.system;
    if (options.fork) {
      store = persist ? SessionStore.create(projectDir, model, options.sessionId, resumeId) : SessionStore.ephemeral();
      for (const message of history) store.appendMessage(message);
    } else {
      store = SessionStore.open(projectDir, resumeId)!;
      if (restored.repairs) store.appendMessage(restored.repairs);
    }
  } else {
    store = persist ? SessionStore.create(projectDir, model, options.sessionId) : SessionStore.ephemeral();
  }

  let sessionName = options.name;
  if (options.name) store.appendName(options.name);
  else if (resumeId !== undefined) sessionName = listSessions(projectDir).find((session) => session.id === resumeId)?.name;

  const common = (): HookCommonInput => ({ session_id: store.id, transcript_path: store.path, cwd, permission_mode: engine.mode });
  const logDir = backgroundLogDir(store.id);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  // So the model can read a command's output without a prompt for each log.
  engine.addRule(`Read(/${canonicalize(logDir)}/**)`, 'allow', 'session');
  let mainWatcher: ConversationWatcher | undefined;
  const wakes = new WakeQueue();
  /** Tagged by the caller so that it cannot be taken for something the user typed. */
  const notifyMain = (text: string): void => {
    mainWatcher?.note(text);
    wakes.notify();
  };
  const tasks = new TaskRegistry({
    logDir,
    ...(options.unattended ? { defaultLimitMs: UNATTENDED_BACKGROUND_LIMIT_MS } : {}),
    onFinished: (_task, message) => {
      notifyMain(`<task-notification>\n${message}\n</task-notification>`);
      options.onNotice?.(message);
    },
  });

  // A memory directory the model keeps across sessions, and a scratch directory for this one.
  // Kept out of the transcript directory so a session's files stay only its transcript.
  const memoryEnabled = settings.autoMemoryEnabled && persist && !bare && !safe && !restricted;
  const memoryDir = join(appHome(), 'memory', projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
  if (memoryEnabled) {
    mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
    engine.addRule(`Edit(/${canonicalize(memoryDir)}/**)`, 'allow', 'session');
    engine.addRule(`Read(/${canonicalize(memoryDir)}/**)`, 'allow', 'session');
  }
  const memoryIndexPath = join(memoryDir, 'MEMORY.md');
  const memoryIndex = memoryEnabled && existsSync(memoryIndexPath) ? readFileSync(memoryIndexPath, 'utf8') : undefined;
  const scratchpadDir = join(realpathSync(tmpdir()), `cairn-${process.getuid?.() ?? 'user'}`, projectDir.replace(/[^a-zA-Z0-9]/g, '-'), store.id, 'scratchpad');
  mkdirSync(scratchpadDir, { recursive: true, mode: 0o700 });
  engine.addWorkingDir(scratchpadDir);
  engine.addRule(`Edit(/${canonicalize(scratchpadDir)}/**)`, 'allow', 'session');

  // Plan mode writes one file, named once per session.
  const planPath = join(appHome(), 'plans', `${planSlug()}.md`);
  mkdirSync(join(appHome(), 'plans'), { recursive: true, mode: 0o700 });
  engine.planFile = planPath;
  let modeBeforePlan: PermissionMode = 'default';
  let planReminded = false;

  const context: Omit<ToolContext, 'signal'> = {
    cwd: () => cwd,
    setCwd: (dir) => {
      if (dir !== cwd) void hooks.run('CwdChanged', { ...common(), cwd: dir }, { old_cwd: cwd, new_cwd: dir });
      cwd = dir;
    },
    workingDirs: () => engine.workingDirs(),
    files: new FileTracker(),
    prompter: options.prompter,
    todos: { items: [] },
    tasks,
    autoBackground: !bare,
    extraPath: plugins.flatMap((plugin) => (plugin.binDir ? [plugin.binDir] : [])),
    secretEnvVars: provider.credentialEnvVars ?? [],
    isReadDenied: (path) => engine.isPathDenied('Read', path),
    getMode: () => engine.mode,
    setMode: (mode) => {
      engine.mode = mode;
    },
    notify: notifyMain,
    planMode: {
      file: () => planPath,
      enter: () => {
        if (engine.mode !== 'plan') modeBeforePlan = engine.mode;
        engine.mode = 'plan';
      },
      exit: () => {
        engine.mode = modeBeforePlan === 'plan' ? 'default' : modeBeforePlan;
      },
    },
    ...(persist ? { checkpoints: new CheckpointStore(store.id) } : {}),
  };

  const startHook = await hooks.run('SessionStart', common(), { source: resumeId === undefined ? 'startup' : 'resume' });
  warnings.push(...startHook.notices);
  for (const file of loaded.files) void hooks.run('InstructionsLoaded', common(), { file_path: file.path, load_reason: 'session_start' });

  const created = await createSandbox(settings.sandbox, { cwd: projectDir, workingDirs: () => engine.workingDirs() });
  warnings.push(...created.warnings);
  engine.sandbox = created.sandbox;
  if (created.sandbox) context.wrapCommand = created.sandbox.wrap;

  const nestedSkillDirs = new Set<string>();
  const activatedSkills = new Set<string>();
  const skillsEnabled = !safe && options.disableSlashCommands !== true;
  const skillSources = (): SkillSources => ({
    addDirs: skillAddDirs,
    plugins,
    nestedDirs: [...nestedSkillDirs],
    enabled: skillsEnabled,
    discover: !bare && !restricted,
  });
  const currentSkills = (): LoadedSkills => loadSkills(projectDir, trusted, skillSources());
  const loadedSkills = currentSkills();
  warnings.push(...loadedSkills.warnings);
  // Always offered when skills are on, so one written during the session can still be loaded.
  const builtins = [...builtinTools(), ...(skillsEnabled ? [skillTool] : [])];
  const offered = builtins.filter((tool) => {
    if (options.tools && !options.tools.includes(tool.name)) return false;
    if (restricted && RESTRICTED_TOOLS.has(tool.name) && !options.tools) return false;
    if (options.unattended && INTERACTIVE_ONLY_TOOLS.has(tool.name)) return false;
    if (sessionAgent?.disallowedTools?.includes(tool.name)) return false;
    return !sessionAgent?.tools || sessionAgent.tools.includes(tool.name);
  });
  // Web search is a provider server tool, not a listed tool. It can be turned off like one.
  const canSearchWeb = provider.serverTools?.includes('web_search') === true;
  const webSearchAllowed =
    canSearchWeb &&
    (!options.tools || options.tools.includes('WebSearch')) &&
    (!sessionAgent?.tools || sessionAgent.tools.includes('WebSearch')) &&
    !sessionAgent?.disallowedTools?.includes('WebSearch') &&
    !(restricted && !options.tools);
  const skillsAvailable = offered.includes(skillTool) && !engine.isToolRemoved('Skill');
  const listing = skillsAvailable ? renderSkillListing(loadedSkills.skills) : { text: '', omitted: 0 };
  if (listing.omitted > 0) warnings.push(`${listing.omitted} skill description(s) were left out of the system prompt to save space. Their names are still listed.`);

  const pluginServers = Object.assign({}, ...plugins.map((plugin) => pluginMcpServers(plugin, projectDir, warnings))) as Record<string, unknown>;
  const mcpConfig = loadMcpConfig({
    projectDir,
    trusted,
    pluginServers,
    ...(options.mcpConfig ? { configArgs: options.mcpConfig } : {}),
    // --safe-mode leaves out even what the command line names; --bare keeps that and no more.
    ...(options.strictMcpConfig || bare ? { strict: true } : {}),
    ...(safe ? { strict: true, configArgs: [] } : {}),
    ...(provider.credentialEnvVars ? { credentialEnvVars: provider.credentialEnvVars } : {}),
  });
  warnings.push(...mcpConfig.warnings);
  const mcp = new McpManager(mcpConfig.servers, {
    projectDir,
    workingDirs: () => engine.workingDirs(),
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
    ...(options.openUrl ? { openUrl: options.openUrl } : {}),
  });
  if (mcpConfig.servers.length > 0) options.onProgress?.(`Connecting to ${mcpConfig.servers.length} MCP server(s)…`);
  await mcp.connectAll();
  const mcpStates = mcp.states();
  for (const state of mcpStates) {
    if (state.status === 'failed' || state.status === 'needs-auth') warnings.push(`MCP server "${state.configName}": ${state.error ?? state.status}`);
  }

  const connectedServers = mcpStates
    .filter((state) => state.status === 'connected')
    .map((state) => ({ name: state.name, ...(state.instructions ? { instructions: state.instructions } : {}) }));
  const promptOptions = {
    cwd: projectDir,
    model,
    additionalDirectories: additionalDirs,
    instructions: loaded.files,
    ...(connectedServers.length > 0 ? { mcpServers: connectedServers } : {}),
    ...(options.systemPrompt === undefined ? (sessionAgent?.prompt ? { systemPrompt: sessionAgent.prompt } : {}) : { systemPrompt: options.systemPrompt }),
  };
  // Without this the model has no way to learn these names. Offered only when it can start them.
  const agentListing: PromptAgent[] = offered.includes(agentTool) && !engine.isToolRemoved('Agent')
    ? agentDefinitions.map((definition) => ({ name: definition.name, description: definition.description, tools: describeAgentTools(definition) }))
    : [];
  const appended = [options.appendSystemPrompt, ...(recordedSystem ? [] : startHook.additionalContext)]
    .filter(Boolean)
    .join('\n\n');
  const outputStyle = safe ? undefined : findOutputStyle(settings.outputStyle);
  if (settings.outputStyle && settings.outputStyle.toLowerCase() !== 'default' && !outputStyle) warnings.push(`Unknown output style "${settings.outputStyle}". Use /output-style to list them.`);
  const facts = modelFacts(model);
  const attribution = settings.includeCoAuthoredBy === false
    ? { commit: '', pr: '' }
    : {
        commit: settings.attribution?.commit ?? (facts ? `Co-Authored-By: Claude ${facts.name} <noreply@anthropic.com>` : ''),
        pr: settings.attribution?.pr ?? `🤖 Generated with ${APP_DISPLAY_NAME}`,
      };
  const system: SystemBlock[] =
    recordedSystem ??
    buildSystemPrompt({
      ...promptOptions,
      scratchpadDir,
      attribution,
      ...(bare ? { mode: 'bare' as const } : {}),
      unattended: options.unattended === true,
      webSearch: webSearchAllowed && !engine.isToolRemoved('WebSearch'),
      ...(memoryEnabled ? { memory: { dir: memoryDir, ...(memoryIndex ? { index: memoryIndex } : {}) } } : {}),
      ...(outputStyle ? { outputStyle } : {}),
      ...(listing.text ? { skillListing: listing.text } : {}),
      ...(agentListing.length > 0 ? { agents: agentListing } : {}),
      ...(appended ? { appendSystemPrompt: appended } : {}),
    });
  if (resumeId === undefined || options.fork) store.appendSystem(system);
  if (recordedSystem && startHook.additionalContext.length > 0) {
    // The recorded prompt must stay as it was, so new context joins the conversation instead.
    const reminder = userText(`<hook-context>\n${startHook.additionalContext.join('\n\n')}\n</hook-context>`);
    history.push(reminder);
    store.appendMessage(reminder);
  }

  const allTools = (): Tool[] => [...offered, ...mcp.tools()];

  let agent: Agent;
  const newWatcher = (main: boolean): ConversationWatcher => {
    const watcher = new ConversationWatcher({
      projectDir,
      trusted,
      loaded,
      onLoaded: (path, reason) => void hooks.run('InstructionsLoaded', common(), { file_path: path, load_reason: reason }),
      ...(main
        ? {
            onDirectory: (dir: string) => {
              if (trusted && skillsEnabled && existsSync(join(dir, PROJECT_DIR, 'skills'))) nestedSkillDirs.add(dir);
            },
            onFile: (path: string) => {
              for (const skill of currentSkills().skills.values()) {
                if (skill.paths.length > 0 && !activatedSkills.has(skill.name) && skillMatchesPath(skill, projectDir, path)) activatedSkills.add(skill.name);
              }
            },
          }
        : {}),
    });
    return watcher;
  };
  mainWatcher = newWatcher(true);
  const skillListingFor = (): string => (skillsAvailable ? renderSkillListing(currentSkills().skills, activatedSkills).text : '');
  let toldSkills = skillListingFor();
  const refreshSkills = (): string[] => {
    const next = skillListingFor();
    if (next === toldSkills) return [];
    const before = new Set(toldSkills.split('\n'));
    const after = new Set(next.split('\n'));
    const added = [...after].filter((line) => line && !before.has(line));
    const removed = [...before].filter((line) => line && !after.has(line));
    toldSkills = next;
    const parts = [
      ...(added.length > 0 ? [`These skills are now available through the Skill tool:\n${added.join('\n')}`] : []),
      ...(removed.length > 0 ? [`These are no longer available:\n${removed.join('\n')}`] : []),
    ];
    if (parts.length > 0) mainWatcher!.note(`<skills-changed>\n${parts.join('\n')}\n</skills-changed>`);
    return [...added.map((line) => `added   ${line}`), ...removed.map((line) => `removed ${line}`)];
  };

  let lastTypedAt = Date.now();
  let titled = resumeId !== undefined || options.generateTitles !== true;

  /**
   * `opus` and the like name a tier, which each provider maps to one of its models. A tier the
   * provider has no model for keeps the parent's model, as does `inherit`.
   */
  const aliases = provider.modelAliases ?? {};
  const resolveName = (name: string): string => aliases[name] ?? (MODEL_TIERS.has(name) ? agent.model : name);
  const resolveModel = (requested: string | undefined, definition: SubagentDefinition): string => {
    if (requested) return resolveName(requested);
    if (definition.model && definition.model !== 'inherit') return resolveName(definition.model);
    return agent.model;
  };

  // A subagent may message and stop other agents, but not start them.
  const subagentAgents: AgentControl = {
    start: async () => {
      throw new Error('A subagent cannot start other agents. Do the work directly.');
    },
    list: () => registry.list(),
    send: (to, message, from) => registry.send(to, message, from),
    stop: (id) => registry.stop(id),
  };

  const createSubagent = async (request: Omit<SubagentRequest, 'signal'>, id: string, signal?: AbortSignal): Promise<SubagentHandle> => {
    const typeName = request.subagentType ?? 'general-purpose';
    const definition = findAgent(agentDefinitions, typeName);
    if (!definition) {
      throw new Error(`Unknown subagent type ${typeName}. Available: ${agentDefinitions.map((a) => a.name).join(', ')}`);
    }
    const isFork = definition.name === 'fork' && BUILTIN_AGENTS.includes(definition);
    // A command a subagent starts in the background ends with that subagent.
    const subagentTasks = new TaskRegistry({ logDir });
    const subagentWatcher = newWatcher(false);
    let worktree: Worktree | undefined = request.isolation === 'worktree' && !isFork ? createWorktree(projectDir, `agent-${id}`, 'head') : undefined;
    const subagentCwd = worktree?.path;
    const started = await hooks.run('SubagentStart', common(), { agent_type: definition.name }, signal);
    const extra = started.additionalContext.map((text) => `<hook-context>\n${text}\n</hook-context>`);
    const subagentContext: Omit<ToolContext, 'signal'> = {
      ...context,
      ...(subagentCwd ? { cwd: () => subagentCwd } : {}),
      // A subagent's `cd` must not move the main session, and it keeps its own read history.
      setCwd: () => {},
      files: new FileTracker(),
      todos: { items: [] },
      tasks: subagentTasks,
      runSubagent: undefined,
      agentId: id,
      notify: (text) => subagentWatcher.note(text),
      planMode: undefined,
      cron: undefined,
      worktrees: undefined,
      pushNotification: undefined,
      agents: options.backgroundAgents ? subagentAgents : undefined,
    };
    let history: Message[] | undefined;
    let firstPrompt = request.prompt;
    if (isFork) {
      const forked = forkHistory(agent.messages, request.prompt);
      history = forked.history;
      firstPrompt = forked.prompt;
    }
    const subModel = isFork ? agent.model : resolveModel(request.model, definition);
    const effort = isFork ? agent.effort : (request.effort ?? definition.effort ?? agent.effort);
    // A fork keeps the parent's prompt and tools, so it can reuse the parent's cached prefix.
    const tools = isFork
      ? allTools
      : (): Tool[] =>
          allTools().filter(
            (tool) => !SUBAGENT_EXCLUDED_TOOLS.has(tool.name) && (!definition.tools || definition.tools.includes(tool.name)) && !definition.disallowedTools?.includes(tool.name),
          );
    const subSystem = isFork
      ? agent.systemBlocks
      : buildSystemPrompt({
          ...promptOptions,
          ...(subagentCwd ? { cwd: subagentCwd } : {}),
          ...(definition.omitInstructions ? { instructions: [] } : {}),
          model: subModel,
          scratchpadDir,
          unattended: true,
          systemPrompt: [definition.prompt, SUBAGENT_NOTES].filter(Boolean).join('\n\n'),
        });
    const subagent = new Agent({
      provider,
      model: subModel,
      system: subSystem,
      tools,
      engine,
      hooks,
      store: SessionStore.ephemeral(),
      context: subagentContext,
      watcher: subagentWatcher,
      maxTurns: SUBAGENT_MAX_TURNS,
      autoCompact: false,
      // A fork keeps the parent's server tools; a fresh agent gets them unless its definition drops WebSearch.
      ...(webSearchAllowed && (isFork || (!definition.tools || definition.tools.includes('WebSearch')) && !definition.disallowedTools?.includes('WebSearch'))
        ? { serverTools: ['web_search' as const] }
        : {}),
      ...(history ? { history } : {}),
      ...(effort ? { effort } : {}),
    });
    let firstRun = true;
    return {
      type: definition.name,
      note: (text) => subagentWatcher.note(text),
      run: async (text, runSignal) => {
        const usageBefore = { ...subagent.totalUsage };
        const costBefore = subagent.totalCostUsd;
        let nextPrompt = firstRun ? [firstPrompt, ...extra].join('\n\n') : text;
        firstRun = false;
        let finalText = '';
        let failure: string | undefined;
        try {
          for (let continuation = 0; ; continuation++) {
            for await (const event of subagent.run(nextPrompt, runSignal)) {
              options.onSubagentEvent?.(request.description, event);
              if (event.type === 'turn_end') {
                finalText = event.text;
                failure = event.stopReason === 'error' ? event.error : event.stopReason === 'interrupted' ? 'interrupted' : undefined;
              }
            }
            if (failure) break;
            const stopped = await hooks.run('SubagentStop', common(), { agent_type: definition.name, stop_hook_active: continuation > 0 }, runSignal);
            if (!stopped.blocked || continuation >= MAX_SUBAGENT_STOP_CONTINUATIONS) break;
            nextPrompt = `A stop hook asked you to continue: ${stopped.blockReason ?? 'keep working.'}`;
          }
        } finally {
          subagentTasks.stopAll();
          agent.addUsage(usageDelta(subagent.totalUsage, usageBefore), subagent.costIsPartial ? undefined : subagent.totalCostUsd - costBefore);
        }
        return { text: finalText, ...(failure ? { failure } : {}) };
      },
      dispose: () => {
        subagentTasks.stopAll();
        if (!worktree) return undefined;
        const message = finishWorktree(worktree);
        worktree = undefined;
        return message;
      },
    };
  };

  const registry = new AgentRegistry({
    create: (request, id) => createSubagent(request, id),
    notifyMain,
    ...(options.onNotice ? { onNotice: options.onNotice } : {}),
  });
  if (options.backgroundAgents) context.agents = registry;

  context.runSubagent = async (request: SubagentRequest): Promise<string> => {
    const handle = await createSubagent(request, `a${randomBytes(3).toString('hex')}`, request.signal);
    let result: { text: string; failure?: string };
    let cleanup: string | undefined;
    try {
      result = await handle.run(request.prompt, request.signal);
    } finally {
      cleanup = handle.dispose();
    }
    if (result.failure) throw new Error(result.failure);
    return `${result.text || '(The subagent finished without a final message.)'}${cleanup ? `\n\n${cleanup}` : ''}`;
  };

  /** One short request for a small JSON answer, such as a session title. Failures give nothing. */
  const quickJson = async (prompt: string, field: string, signal?: AbortSignal): Promise<string | undefined> => {
    try {
      let reply = '';
      const stream = provider.stream({
        // The provider's small tier, when it has one: a title is not worth the main model.
        model: aliases.haiku ?? agent.model,
        system: [],
        messages: [userText(prompt)],
        tools: [],
        maxTokens: 4_000,
        disableCache: true,
        ...(signal ? { signal } : {}),
      });
      for await (const event of stream) {
        if (event.type === 'message_end') {
          reply = textOf(event.content);
          agent.addUsage(event.usage, event.costUsd);
        }
      }
      const json = /\{[\s\S]*\}/.exec(reply)?.[0];
      const value = json ? (JSON.parse(json) as Record<string, unknown>)[field] : undefined;
      return typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined;
    } catch {
      return undefined;
    }
  };

  const generateTitle = async (): Promise<void> => {
    const first = agent.messages.find((message) => message.role === 'user');
    const text = first ? textOf(first.content).slice(0, 4_000) : '';
    if (!text.trim()) return;
    const title = await quickJson(`${SESSION_TITLE_PROMPT}\n<session>\n${text}\n</session>\n${SESSION_TITLE_SUFFIX}`, 'title');
    if (title) store.appendTitle(title);
  };

  const cron = options.unattended
    ? null
    : new CronScheduler((prompt, job) => {
        options.onNotice?.(`Scheduled job ${job.id} is due.`);
        wakes.prompt(prompt);
      });
  if (cron) context.cron = cron;

  if (!options.unattended) {
    context.pushNotification = async (message) => {
      if (Date.now() - lastTypedAt < USER_ACTIVE_MS) return { sent: false, reason: 'the user is at the terminal, so your output already reaches them.' };
      if (sendDesktopNotification(message)) return { sent: true, reason: 'shown as a desktop notification.' };
      if (process.stdout.isTTY) {
        // OSC 9, which many terminals show as a notification.
        process.stdout.write(`\x1b]9;${message.replace(/[\x00-\x1f\x7f]/g, ' ')}\x07`);
        return { sent: true, reason: 'sent to the terminal as a notification.' };
      }
      return { sent: false, reason: 'no notification service is available on this system.' };
    };
  }

  let worktreeState: { worktree?: Worktree; path: string; created: boolean; originalCwd: string } | undefined;
  const exitWorktree = async (action: 'keep' | 'remove', discard: boolean): Promise<{ content: string; isError?: boolean }> => {
    if (!worktreeState) return { content: 'No worktree session is active, so nothing was changed.' };
    const state = worktreeState;
    if (action === 'remove') {
      if (!state.worktree || !state.created) {
        return { content: `The worktree at ${state.path} was not created by EnterWorktree in this session, so it is not removed. Use action "keep" to return to ${state.originalCwd}.`, isError: true };
      }
      const changes = worktreeChanges(state.worktree);
      if (changes && !discard) {
        return {
          content: `The worktree at ${state.path} has work that removing it would lose:\n${changes}\nConfirm with the user, then call again with discard_changes: true to remove it anyway, or use action "keep".`,
          isError: true,
        };
      }
      context.setCwd(state.originalCwd);
      worktreeState = undefined;
      const removed = removeWorktree(state.worktree);
      return { content: `${removed} Back in ${state.originalCwd}.`, ...(removed.startsWith('Could not') ? { isError: true } : {}) };
    }
    context.setCwd(state.originalCwd);
    worktreeState = undefined;
    return { content: `Kept the worktree at ${state.path}${state.worktree ? ` (branch ${state.worktree.branch})` : ''}. Back in ${state.originalCwd}.` };
  };
  const worktrees: WorktreeControl = {
    enter: async ({ name, path }) => {
      if (path !== undefined) {
        const target = resolve(cwd, path);
        if (!existsSync(target) || !isListedWorktree(projectDir, target)) throw new Error(`${target} is not listed by git worktree list for this repository.`);
        const real = realpathSync(target);
        if (!engine.workingDirs().some((dir) => real === dir || real.startsWith(`${dir}/`))) engine.addWorkingDir(real);
        const originalCwd = worktreeState?.originalCwd ?? cwd;
        context.setCwd(real);
        worktreeState = { path: real, created: false, originalCwd };
        return `Switched the session into the existing worktree at ${real}. ExitWorktree with action "keep" returns to ${originalCwd}.`;
      }
      if (worktreeState) throw new Error(`Already in a worktree session at ${worktreeState.path}. Use ExitWorktree first, or pass path to switch to an existing worktree.`);
      const made = createWorktree(projectDir, name ?? '', settings.worktreeBaseRef ?? 'fresh');
      const originalCwd = cwd;
      context.setCwd(made.path);
      worktreeState = { worktree: made, path: made.path, created: made.created, originalCwd };
      return `${made.created ? 'Created' : 'Entered'} the worktree at ${made.path} on branch ${made.branch}${made.base ? `, from ${made.base}` : ''}. The session now works there; ExitWorktree returns to ${originalCwd}.`;
    },
    exit: exitWorktree,
  };
  context.worktrees = worktrees;

  // Compaction and /clear forget what was said, so plan mode's rules are sent again after them.
  const agentWatcher: AgentWatcher = {
    touched: (paths) => mainWatcher!.touched(paths),
    drain: () => mainWatcher!.drain(),
    reset: () => {
      planReminded = false;
      mainWatcher!.reset();
    },
  };

  agent = new Agent({
    provider,
    model,
    system,
    tools: allTools,
    ...(webSearchAllowed ? { serverTools: ['web_search' as const] } : {}),
    engine,
    hooks,
    store,
    context,
    history,
    ownsTurnState: true,
    autoCompact: settings.autoCompact,
    watcher: agentWatcher,
    onPromptStart: () => {
      lastTypedAt = Date.now();
      void refreshSkills();
      if (!titled) {
        titled = true;
        // After this prompt has joined the conversation.
        setTimeout(() => void generateTitle(), 0);
      }
    },
    modeReminder: () => {
      if (engine.mode !== 'plan') {
        planReminded = false;
        return undefined;
      }
      if (planReminded) return undefined;
      planReminded = true;
      return planModeReminder(planPath, existsSync(planPath));
    },
    ...(outputStyle?.turnReminder ? { turnReminder: () => outputStyle.turnReminder } : {}),
    ...(options.autoCompactTokens === undefined ? {} : { autoCompactTokens: options.autoCompactTokens }),
    ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
    ...(options.fallbackModels ? { fallbackModels: options.fallbackModels } : {}),
    ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    ...(options.betas ? { betas: options.betas } : {}),
    onAlwaysAllow: (rule, shouldPersist) => {
      if (shouldPersist) appendLocalAllowRule(projectDir, rule);
    },
    ...(options.effort ?? settings.effort ? { effort: (options.effort ?? settings.effort)! } : {}),
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  });

  const readableSkillDirs = new Set<string>();
  const hookedSkills = new Set<string>();
  context.skillHost = {
    load: currentSkills,
    registerHooks: (skill) => {
      if (!skill.hooks || hookedSkills.has(skill.name)) return;
      hookedSkills.add(skill.name);
      hooks.add(skill.hooks);
    },
    checkShell: (command) => engine.check('Bash', { kind: 'bash', command }),
    allowRead: (dir) => {
      const canonical = canonicalize(dir);
      if (readableSkillDirs.has(canonical)) return;
      readableSkillDirs.add(canonical);
      engine.addRule(`Read(/${canonical}/**)`, 'allow', 'session');
    },
    sessionId: () => agent.sessionId,
    effort: () => agent.effort ?? 'medium',
    projectDir,
  };

  const switchTo = (next: SessionStore, messages: Message[], nextSystem?: SystemBlock[]): void => {
    store = next;
    agent.reset(next, messages, nextSystem);
    context.files = new FileTracker();
    context.todos.items = [];
    if (persist) context.checkpoints = new CheckpointStore(next.id);
  };

  return {
    agent,
    engine,
    hooks,
    provider,
    mcp,
    context,
    settings,
    instructions: loaded.files,
    warnings,
    projectDir,
    trusted,
    plugins,
    sandbox: created.sandbox,
    agents: agentDefinitions,
    allowBypassMode: options.allowBypassMode === true,
    get sessionName() {
      return sessionName;
    },
    forkSession: (name) => {
      const next = persist ? SessionStore.create(projectDir, agent.model, undefined, store.id) : SessionStore.ephemeral();
      next.appendSystem(agent.systemBlocks);
      const messages = [...agent.messages];
      for (const message of messages) next.appendMessage(message);
      if (name) next.appendName(name);
      sessionName = name;
      switchTo(next, messages);
    },
    renameSession: (name) => {
      store.appendName(name);
      sessionName = name;
    },
    addDirectory: (dir) => {
      engine.addWorkingDir(dir);
      if (!skillAddDirs.includes(dir)) skillAddDirs.push(dir);
    },
    refreshSkills,
    wakes,
    backgroundAgents: registry,
    cron,
    planFile: () => planPath,
    worktreeSession: () =>
      worktreeState ? { path: worktreeState.path, created: worktreeState.created, ...(worktreeState.worktree ? { branch: worktreeState.worktree.branch } : {}) } : undefined,
    exitWorktree,
    noteForModel: (text) => mainWatcher!.note(text),
    suggestName: async (signal) => {
      const transcript = agent.messages
        .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [`${message.role}: ${block.text}`] : [])))
        .join('\n')
        .slice(-1_000);
      if (!transcript.trim()) return undefined;
      const name = await quickJson(`${SESSION_RENAME_PROMPT}\n<conversation>\n${transcript}\n</conversation>`, 'name', signal);
      const kebab = name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return kebab || undefined;
    },
    newSession: () => {
      const next = persist ? SessionStore.create(projectDir, agent.model) : SessionStore.ephemeral();
      next.appendSystem(agent.systemBlocks);
      switchTo(next, []);
    },
    resumeSession: (id) => {
      const restored = restoreHistory(projectDir, id);
      const reopened = SessionStore.open(projectDir, id);
      if (!restored || !reopened) return false;
      if (restored.repairs) reopened.appendMessage(restored.repairs);
      switchTo(reopened, restored.messages, restored.system);
      return true;
    },
    shutdown: async () => {
      registry.stopAll();
      cron?.stopAll();
      tasks.stopAll();
      await created.sandbox?.close();
      await mcp.close();
      await hooks.run('SessionEnd', common());
    },
  };
}
