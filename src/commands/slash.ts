/** Built-in slash commands, then skills and MCP prompts by name. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { APP_DISPLAY_NAME, INSTRUCTION_FILE, localSettingsPath, userSettingsPath } from '../config/paths.ts';
import { markTrusted } from '../config/trust.ts';
import { renderTranscript } from '../core/compaction.ts';
import { textOf } from '../core/messages.ts';
import type { Effort } from '../core/provider.ts';
import type { Runtime } from '../core/runtime.ts';
import type { McpServerState } from '../mcp/manager.ts';
import { PERMISSION_MODES } from '../permissions/engine.ts';
import type { PermissionMode } from '../permissions/engine.ts';
import { listSessions } from '../session/store.ts';
import { sessionTotals, totalTokens } from '../session/usage.ts';
import { splitArguments } from '../skills/skills.ts';
import type { Skill, SkillActivation } from '../skills/skills.ts';
import { prepareSkill, SkillError } from '../tools/skill.ts';
import { modelCommand, providerCommand } from './provider.ts';
import { parseUsageArgs, usageReport, usageSessions } from './usage.ts';
import type { UsageQuery } from './usage.ts';

export interface CommandResult {
  /** Text to print. */
  output?: string;
  /** Text to send to the model as the next prompt. */
  prompt?: string;
  /** What a skill changes for the turn that `prompt` starts. */
  activation?: SkillActivation;
  exit?: boolean;
  /** Wipe the terminal, screen and scrollback, as for a fresh start. The interactive session then draws its opening panel again. */
  clearScreen?: boolean;
  /** Run a compaction, which needs the UI's streaming and interrupt handling. */
  compact?: { focus?: string };
  /** Slow work the user may want to interrupt. The UI runs it, and it leads to another result. */
  run?: (signal: AbortSignal) => Promise<CommandResult>;
}

export interface PickItem {
  value: string;
  label: string;
  detail?: string;
}

/** One tab of a tabbed view. */
export interface TabPage {
  title: string;
  /** Plain text lines, worked out the first time the tab is shown. */
  lines(): string[];
}

export interface CommandIO {
  /** Asks the user to pick from a list. Returns the chosen index, or null. */
  choose(title: string, options: string[]): Promise<number | null>;
  /**
   * A list the user narrows by typing. Returns the chosen value, or null. With `allowCustom`,
   * what was typed can be returned too. Absent where nobody is there to choose.
   */
  pick?(title: string, items: PickItem[], options?: { initial?: string; allowCustom?: boolean }): Promise<string | null>;
  /** One line of text, or null. With `secret`, what is typed is not shown. Absent where nobody is there to answer. */
  ask?(question: string, options?: { secret?: boolean }): Promise<string | null>;
  /**
   * Shows tabs on a screen of their own, starting on `initial`, until the user closes them.
   * Absent where there is no terminal to draw on.
   */
  tabs?(title: string, pages: TabPage[], initial: number): Promise<void>;
  /** Messages to run once the current work is done. Only the interactive session has one. */
  queue?: {
    /** Returns the message's place in the queue. */
    add(text: string): number;
    list(): string[];
    /** Returns how many were removed. */
    clear(): number;
  };
}

interface BuiltinCommand {
  description: string;
  run(args: string, runtime: Runtime, io: CommandIO): Promise<CommandResult> | CommandResult;
}

const INIT_PROMPT = `Look through this repository and write a concise ${INSTRUCTION_FILE} in its root for future coding sessions. Cover the commands to build, test and lint, how to run one test, the architecture that is not obvious from a single file, and conventions a newcomer would get wrong. Leave out anything easily discovered by listing files and generic advice. If the file already exists, improve it rather than replacing it.`;

function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

function skillsOf(runtime: Runtime): Map<string, Skill> {
  return runtime.context.skillHost!.load().skills;
}

function describeServer(state: McpServerState): string {
  const parts = [`${state.toolCount} tools`];
  if (state.promptCount > 0) parts.push(`${state.promptCount} prompts`);
  if (state.hasResources) parts.push('resources');
  const summaries: Record<McpServerState['status'], string> = {
    connected: `connected, ${parts.join(', ')}`,
    failed: `failed: ${state.error ?? 'unknown error'}`,
    'needs-auth': `needs sign-in: /mcp login ${state.name}`,
    disabled: 'disabled',
    connecting: 'connecting',
  };
  const changed = state.toolsChanged ? ' (tools changed: /mcp reconnect to load them)' : '';
  return `  ${state.name.padEnd(16)} ${state.type.padEnd(6)} ${state.scope.padEnd(8)} ${summaries[state.status]}${changed}`;
}

/**
 * What this session has spent while the app has been running, and, when the transcript holds a
 * different total, that total over every run.
 */
function sessionSpending(runtime: Runtime): { spent: string[]; saved?: string } {
  const { totalUsage: usage, totalCostUsd, costIsPartial } = runtime.agent;
  const cost = `$${totalCostUsd.toFixed(4)}`;
  const spent = [
    `Input:        ${formatTokens(usage.inputTokens)}`,
    `Output:       ${formatTokens(usage.outputTokens)}`,
    `Cache read:   ${formatTokens(usage.cacheReadTokens)}`,
    `Cache write:  ${formatTokens(usage.cacheWriteTokens)}`,
    ...(usage.webSearches > 0 ? [`Web searches: ${formatTokens(usage.webSearches)}`] : []),
    costIsPartial
      ? `Estimated:    at least ${cost} (some models have no known price)`
      : `Estimated:    ${cost} at list prices. Your actual bill is what the Console shows.`,
  ];
  // After a resume the transcript holds earlier runs too; after /clear, less than this run.
  const saved = sessionTotals(runtime.agent.transcriptPath);
  if (saved === null || (totalTokens(saved.usage) === totalTokens(usage) && Math.abs(saved.costUsd - totalCostUsd) <= 1e-9)) return { spent };
  return {
    spent,
    saved: `Saved for this session over every run: ${formatTokens(totalTokens(saved.usage))} tokens, ${saved.costIsPartial ? 'at least ' : ''}$${saved.costUsd.toFixed(4)}.`,
  };
}

const USAGE_TABS: { title: string; kind?: UsageQuery['kind'] }[] = [
  { title: 'This session' },
  { title: 'Daily', kind: 'daily' },
  { title: 'Projects', kind: 'projects' },
  { title: 'Sessions', kind: 'sessions' },
];

/** `200k` or `1m`. Undefined when it is out of range or not a number. */
export function parseTokenCount(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.trim());
  if (!match) return undefined;
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  const tokens = Number(match[1]) * scale;
  return tokens >= 100_000 && tokens <= 1_000_000 ? tokens : undefined;
}

const BUILTINS: Record<string, BuiltinCommand> = {
  help: {
    description: 'Show this list',
    run: (_args, runtime) => {
      const lines = Object.entries(BUILTINS).map(([name, command]) => `  /${name.padEnd(12)} ${command.description}`);
      const skills = [...skillsOf(runtime).values()].filter((skill) => skill.userInvocable);
      if (skills.length > 0) {
        lines.push('', 'Skills:');
        for (const skill of skills) {
          const label = `/${skill.name}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`;
          lines.push(`  ${label.padEnd(13)} ${skill.description}`);
        }
      }
      const prompts = runtime.mcp.prompts();
      if (prompts.length > 0) {
        lines.push('', 'MCP prompts:');
        for (const { command, prompt } of prompts) lines.push(`  /${command}  ${prompt.description ?? ''}`.trimEnd());
      }
      lines.push(
        '',
        'Keys: Esc or Ctrl+C interrupts a running turn. Shift+Tab cycles the permission mode. End a line with \\ to continue it.',
        'Typing / lists commands as you type: Up and Down choose, Enter runs, Tab completes, Esc closes the list.',
        'In a permission prompt: Up and Down choose, Enter confirms, Tab adds a note to the answer, Esc says no.',
        'In /usage: Left and Right switch tabs, Up and Down scroll, Esc goes back to the conversation.',
        'Ctrl+V pastes an image from the clipboard as [Image #1], and an image file dropped on the terminal is attached the same way. Delete the placeholder to leave the image out.',
        'A message waits 3 seconds before it is sent: type more to add to it, Enter on an empty line to send it now, Esc to edit it.',
        'Sending a message while the agent works stops that work and answers the new message. /queue <message> waits its turn instead.',
      );
      return { output: lines.join('\n') };
    },
  },
  clear: {
    description: 'Start a new conversation, on a clear screen',
    run: (_args, runtime) => {
      runtime.newSession();
      return { output: `Started a new session: ${runtime.agent.sessionId}`, clearScreen: true };
    },
  },
  compact: {
    description: 'Summarize the conversation to free up context. Optional: what to focus on',
    run: (args, runtime) => {
      if (runtime.agent.messages.length === 0) return { output: 'Nothing to compact yet.' };
      return { compact: args ? { focus: args } : {} };
    },
  },
  trust: {
    description: "Trust this directory's hooks, allow rules, MCP servers, skills and agents. Takes effect on the next start",
    run: (_args, runtime) => {
      markTrusted(runtime.projectDir);
      return { output: `Trusted ${runtime.projectDir}. Restart to apply its settings.` };
    },
  },
  context: {
    description: 'Show how full the context window is',
    run: (_args, runtime) => {
      const window = runtime.provider.contextWindow(runtime.agent.model);
      const used = runtime.agent.lastContextTokens;
      if (used === null) return { output: `No measurement yet. Context window: ${formatTokens(window)} tokens.` };
      return { output: `${formatTokens(used)} of ${formatTokens(window)} tokens (${((used / window) * 100).toFixed(1)}%).` };
    },
  },
  cost: {
    description: 'Show token usage and estimated cost for this session',
    run: (_args, runtime) => {
      const { spent, saved } = sessionSpending(runtime);
      const reports = saved ? ['', saved, 'Reports: /usage daily, /usage projects, /usage sessions.'] : [];
      return { output: [...spent, ...reports].join('\n') };
    },
  },
  model: {
    description: 'Choose the model, from a list or by name. Kept for new sessions',
    run: (args, runtime, io) => modelCommand(args, runtime, io),
  },
  queue: {
    description: 'Run a message after the current work is done. Also: /queue to list, /queue clear',
    run: (args, _runtime, io) => {
      if (!io.queue) return { output: 'There is a queue only in an interactive session.' };
      if (!args) {
        const items = io.queue.list();
        if (items.length === 0) return { output: 'The queue is empty. Add to it with /queue <message>.' };
        return { output: items.map((item, i) => `  ${i + 1}. ${item.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n') };
      }
      if (args === 'clear') return { output: `Removed ${io.queue.clear()} queued message(s).` };
      const place = io.queue.add(args);
      return { output: `Queued as #${place}. It runs when the current work is done.` };
    },
  },
  provider: {
    description: 'Switch provider, or: /provider add, /provider key <name>, /provider remove <name>, /provider list',
    run: (args, runtime, io) => providerCommand(args, runtime, io),
  },
  effort: {
    description: 'Show or change the effort level: low, medium, high, xhigh, max',
    run: (args, runtime) => {
      if (args) {
        if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(args)) return { output: `Unknown effort level: ${args}` };
        runtime.agent.effort = args as Effort;
      }
      return { output: `Effort: ${runtime.agent.effort ?? 'provider default'}` };
    },
  },
  mode: {
    description: `Show or change the permission mode: ${PERMISSION_MODES.join(', ')}`,
    run: (args, runtime) => {
      if (args) {
        if (!PERMISSION_MODES.includes(args as PermissionMode)) return { output: `Unknown mode: ${args}` };
        runtime.engine.mode = args as PermissionMode;
      }
      return { output: `Permission mode: ${runtime.engine.mode}` };
    },
  },
  permissions: {
    description: 'List the permission rules in effect',
    run: (_args, runtime) => {
      const rules = runtime.engine.listRules();
      const lines = [`Mode: ${runtime.engine.mode}`, `Working directories: ${runtime.engine.workingDirs().join(', ')}`];
      if (rules.length === 0) lines.push('No rules.');
      for (const rule of rules) lines.push(`  ${rule.behavior.padEnd(5)} ${rule.text}  (${rule.source})`);
      return { output: lines.join('\n') };
    },
  },
  'add-dir': {
    description: 'Allow access to another directory for this session',
    run: (args, runtime) => {
      if (!args) return { output: 'Usage: /add-dir <path>' };
      const dir = resolve(runtime.context.cwd(), args);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return { output: `Not a directory: ${dir}` };
      runtime.addDirectory(dir);
      return { output: `Added ${dir}` };
    },
  },
  rewind: {
    description: 'Undo file changes from the last turn, or the last N turns. Shell command effects are not undone',
    run: async (args, runtime) => {
      const checkpoints = runtime.context.checkpoints;
      if (!checkpoints) return { output: 'File history is off in this session.' };
      const count = args ? Number.parseInt(args, 10) : 1;
      if (!Number.isInteger(count) || count < 1) return { output: 'Usage: /rewind [number of turns]' };
      const result = await checkpoints.rewind(count);
      const lines = [
        ...result.restored.map((path) => `restored  ${path}`),
        ...result.removed.map((path) => `removed   ${path}`),
        ...result.skipped.map((path) => `skipped   ${path} (symlink)`),
      ];
      if (lines.length === 0) return { output: 'No file changes to undo.' };
      return {
        output: `${lines.join('\n')}\nThe conversation is unchanged, so tell the model if it should know about this.`,
      };
    },
  },
  resume: {
    description: 'Switch to an earlier session from this directory',
    run: async (args, runtime, io) => {
      let id = args;
      if (!id) {
        const sessions = listSessions(runtime.projectDir).filter((s) => s.id !== runtime.agent.sessionId).slice(0, 20);
        if (sessions.length === 0) return { output: 'No other sessions in this directory.' };
        const choice = await io.choose(
          'Sessions:',
          sessions.map((s) => `${s.modifiedAt.toISOString().slice(0, 16).replace('T', ' ')}  ${s.preview || '(empty)'}`),
        );
        if (choice === null) return {};
        id = sessions[choice]!.id;
      }
      return { output: runtime.resumeSession(id) ? `Resumed ${id}.` : `No session ${id}.` };
    },
  },
  status: {
    description: 'Show session details',
    run: (_args, runtime) => ({
      output: [
        `${APP_DISPLAY_NAME} session ${runtime.agent.sessionId}`,
        `Provider: ${runtime.providerName}`,
        `Model: ${runtime.agent.model}`,
        `Permission mode: ${runtime.engine.mode}`,
        `Directory: ${runtime.context.cwd()}${runtime.trusted ? ' (trusted)' : ''}`,
        `Instruction files: ${runtime.instructions.map((file) => file.path).join(', ') || 'none'}`,
        `Transcript: ${runtime.agent.transcriptPath ?? 'not saved'}`,
      ].join('\n'),
    }),
  },
  todos: {
    description: 'Show the task checklist',
    run: (_args, runtime) => {
      const items = runtime.context.todos.items;
      if (items.length === 0) return { output: 'The checklist is empty.' };
      const marks = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
      return { output: items.map((item) => `${marks[item.status]} ${item.content}`).join('\n') };
    },
  },
  skills: {
    description: 'List skills, and who can use each',
    run: (_args, runtime) => {
      const { skills, warnings } = runtime.context.skillHost!.load();
      if (skills.size === 0 && warnings.length === 0) {
        return { output: 'No skills. Add one at .cairn/skills/<name>/SKILL.md or ~/.cairn/skills/<name>/SKILL.md.' };
      }
      const lines = [...skills.values()].map((skill) => {
        const who = skill.disableModelInvocation ? 'only you' : skill.userInvocable ? 'you and the model' : 'only the model';
        const shadowed = BUILTINS[skill.name] ? ' (shadowed by a built-in command)' : '';
        return `  ${skill.name.padEnd(20)} ${skill.source.padEnd(8)} ${who}${shadowed}\n    ${skill.description}`;
      });
      return { output: [...lines, ...warnings.map((warning) => `! ${warning}`)].join('\n') };
    },
  },
  mcp: {
    description: 'Show MCP servers. Also: /mcp reconnect <name|all>, /mcp login <name>, /mcp logout <name>',
    run: (args, runtime) => {
      const [action, target] = args.split(/\s+/);
      if (!action) {
        const states = runtime.mcp.states();
        if (states.length === 0) return { output: 'No MCP servers. Add one with `cairn mcp add`.' };
        return { output: states.map(describeServer).join('\n') };
      }
      const names = runtime.mcp.states().map((state) => state.name);
      if (action === 'reconnect') {
        const targets = target === 'all' ? names : target ? [target] : [];
        if (targets.length === 0) return { output: 'Usage: /mcp reconnect <name|all>' };
        return {
          run: async () => {
            const lines: string[] = [];
            for (const name of targets) lines.push(describeServer(await runtime.mcp.reconnect(name)));
            return { output: lines.join('\n') };
          },
        };
      }
      if (action === 'login') {
        if (!target) return { output: 'Usage: /mcp login <name>' };
        return { run: async (signal) => ({ output: describeServer(await runtime.mcp.login(target, signal)) }) };
      }
      if (action === 'logout') {
        if (!target) return { output: 'Usage: /mcp logout <name>' };
        return { output: runtime.mcp.logout(target) ? `Signed out of ${target}.` : `No stored sign-in for ${target}.` };
      }
      return { output: `Unknown /mcp action: ${action}` };
    },
  },
  agents: {
    description: 'List the agents the model can hand work to',
    run: (_args, runtime) => ({ output: runtime.agents.map((agent) => `  ${agent.name.padEnd(24)} ${agent.description}`).join('\n') }),
  },
  autocompact: {
    description: 'Show or set when to compact automatically: auto, or a number of tokens such as 200k',
    run: (args, runtime) => {
      if (args) {
        const tokens = args === 'auto' ? null : parseTokenCount(args);
        if (tokens === undefined) return { output: 'Usage: /autocompact [auto|<tokens>], for example 200k or 1m. Between 100k and 1m.' };
        if (tokens === null) delete runtime.agent.autoCompactTokens;
        else runtime.agent.autoCompactTokens = tokens;
      }
      return { output: `Auto-compact at ${formatTokens(Math.round(runtime.agent.autoCompactThreshold))} tokens.` };
    },
  },
  branch: {
    description: 'Copy this conversation into a new session and continue there. Optional: a name',
    run: (args, runtime) => {
      const from = runtime.agent.sessionId;
      runtime.forkSession(args || undefined);
      return { output: `Now in ${runtime.agent.sessionId}, branched from ${from}.` };
    },
  },
  btw: {
    description: 'Ask a side question about this conversation, without adding to it',
    run: (args, runtime) => {
      if (!args) return { output: 'Usage: /btw <question>' };
      return {
        run: async (signal) => {
          const question = `Answer this side question briefly. It is an aside: do not continue the work.\n\n<conversation>\n${renderTranscript(runtime.agent.messages)}\n</conversation>\n\nQuestion: ${args}`;
          let reply: string | undefined;
          const stream = runtime.provider.stream({
            model: runtime.agent.model,
            system: [],
            messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
            tools: [],
            maxTokens: 4_000,
            disableCache: true,
            signal,
          });
          for await (const event of stream) {
            if (event.type === 'message_end') {
              reply = textOf(event.content);
              runtime.agent.addUsage(event.usage, event.costUsd, runtime.agent.model);
            }
          }
          return { output: reply || 'No answer came back.' };
        },
      };
    },
  },
  cd: {
    description: 'Move the session to another directory inside the working directories',
    run: (args, runtime) => {
      if (!args) return { output: 'Usage: /cd <path>' };
      const dir = resolve(runtime.context.cwd(), args);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return { output: `Not a directory: ${dir}` };
      if (!runtime.engine.workingDirs().some((root) => dir === root || dir.startsWith(`${root}/`))) {
        return { output: `${dir} is outside the working directories. Use /add-dir first.` };
      }
      runtime.context.setCwd(dir);
      return { output: `Now in ${dir}` };
    },
  },
  config: {
    description: 'Show settings, or save some: model=, effort=, autoCompact=',
    run: (args, runtime) => {
      if (!args) {
        const { settings } = runtime;
        return {
          output: [
            `model: ${runtime.agent.model}`,
            `effort: ${runtime.agent.effort ?? 'provider default'}`,
            `autoCompact: ${settings.autoCompact}`,
            `defaultMode: ${settings.defaultMode}`,
            `User settings: ${userSettingsPath()}`,
            `Local settings: ${localSettingsPath(runtime.projectDir)}`,
          ].join('\n'),
        };
      }
      const updates: Record<string, unknown> = {};
      for (const pair of args.split(/\s+/)) {
        const [key, value] = pair.split('=');
        if (key === 'model' && value) {
          updates.model = value;
          runtime.agent.model = value;
        } else if (key === 'effort' && value && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
          updates.effort = value;
          runtime.agent.effort = value as Effort;
        } else if (key === 'autoCompact' && (value === 'true' || value === 'false')) {
          updates.autoCompact = value === 'true';
        } else {
          return { output: `Cannot set ${pair}. Use model=, effort= or autoCompact=.` };
        }
      }
      const path = userSettingsPath();
      const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...current, ...updates }, null, 2)}\n`, { mode: 0o600 });
      return { output: `Saved to ${path}.` };
    },
  },
  copy: {
    description: 'Copy the latest reply to the clipboard',
    run: (_args, runtime) => {
      const last = [...runtime.agent.messages].reverse().find((message) => message.role === 'assistant' && textOf(message.content));
      if (!last) return { output: 'There is no reply to copy yet.' };
      const tool = process.platform === 'darwin' ? ['pbcopy'] : ['xclip', '-selection', 'clipboard'];
      const result = spawnSync(tool[0]!, tool.slice(1), { input: textOf(last.content), stdio: ['pipe', 'ignore', 'ignore'] });
      return { output: result.status === 0 ? 'Copied.' : `Could not run ${tool[0]}.` };
    },
  },
  diff: {
    description: 'Show uncommitted changes in this repository',
    run: (_args, runtime) => {
      const result = spawnSync('git', ['diff', 'HEAD', '--stat', '--patch'], { cwd: runtime.context.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      if (result.status !== 0) return { output: result.stderr.trim() || 'Not a git repository.' };
      return { output: result.stdout.trim() || 'No uncommitted changes.' };
    },
  },
  export: {
    description: 'Save this conversation as text. Optional: a file name',
    run: (args, runtime) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const path = resolve(runtime.context.cwd(), args || `conversation-${stamp}.txt`);
      if (existsSync(path)) return { output: `${path} already exists. Name another file.` };
      writeFileSync(path, `${renderTranscript(runtime.agent.messages)}\n`);
      return { output: `Saved to ${path}.` };
    },
  },
  hooks: {
    description: 'List the hooks in effect',
    run: (_args, runtime) => {
      const hooks = runtime.hooks.list();
      if (hooks.length === 0) return { output: 'No hooks.' };
      return { output: hooks.map((hook) => `  ${hook.event.padEnd(20)} ${(hook.matcher ?? '*').padEnd(16)} ${hook.handler}`).join('\n') };
    },
  },
  memory: {
    description: 'List the instruction files loaded for this session',
    run: (_args, runtime) => {
      if (runtime.instructions.length === 0) return { output: `No instruction files. Add a ${INSTRUCTION_FILE}, or run /init.` };
      return { output: runtime.instructions.map((file) => `  ${file.scope.padEnd(8)} ${file.path}`).join('\n') };
    },
  },
  plan: {
    description: 'Switch to plan mode. Optional: what to plan',
    run: (args, runtime) => {
      if (runtime.engine.mode === 'bypassPermissions') return { output: 'Plan mode is not available while permission checks are off.' };
      runtime.engine.mode = 'plan';
      return args ? { output: 'Plan mode is on.', prompt: args } : { output: 'Plan mode is on.' };
    },
  },
  plugin: {
    description: 'List loaded plugins. Manage them with `cairn plugin`',
    run: (_args, runtime) => {
      if (runtime.plugins.length === 0) return { output: 'No plugins loaded. Use --plugin-dir, or `cairn plugin install <path>`.' };
      return { output: runtime.plugins.map((plugin) => `  ${plugin.name}${plugin.version ? ` ${plugin.version}` : ''}  (${plugin.source})  ${plugin.root}`).join('\n') };
    },
  },
  'reload-skills': {
    description: 'Look again for skills, and tell the model what changed',
    run: (_args, runtime) => {
      const changes = runtime.refreshSkills();
      return { output: changes.length > 0 ? changes.join('\n') : 'No changes.' };
    },
  },
  rename: {
    description: 'Name this session, so --resume can find it',
    run: (args, runtime) => {
      if (!args) return { output: `Session name: ${runtime.sessionName ?? 'none'}` };
      runtime.renameSession(args);
      return { output: `Named this session ${args}.` };
    },
  },
  sandbox: {
    description: 'Show the sandbox. Also: /sandbox on, /sandbox off, which take effect on the next start',
    run: (args, runtime) => {
      if (args === 'on' || args === 'off') {
        const path = localSettingsPath(runtime.projectDir);
        const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { sandbox?: Record<string, unknown> }) : {};
        current.sandbox = { ...current.sandbox, enabled: args === 'on' };
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
        return { output: `Sandbox ${args} in ${path}. Restart to apply it.` };
      }
      if (args) return { output: 'Usage: /sandbox [on|off]' };
      return { output: runtime.sandbox ? runtime.sandbox.describe().join('\n') : 'Sandbox: off. Shell commands run under the permission rules only.' };
    },
  },
  tasks: {
    description: 'List background commands. Also: /tasks stop <id>',
    run: (args, runtime) => {
      const [action, id] = args.split(/\s+/);
      const tasks = runtime.context.tasks;
      if (action === 'stop') {
        if (!id) return { output: 'Usage: /tasks stop <id>' };
        const stopped = tasks.stop(id);
        return { output: stopped ? `Stopped ${id}.` : `No task ${id}.` };
      }
      const all = tasks.list();
      if (all.length === 0) return { output: 'No background commands.' };
      return { output: all.map((task) => `  ${task.id}  ${task.status.padEnd(9)} ${task.description ?? task.command.split('\n')[0]!.slice(0, 60)}\n    ${task.logPath}`).join('\n') };
    },
  },
  usage: {
    description: 'Tokens and estimated cost in tabs: this session, daily, projects, sessions',
    run: async (args, runtime, io) => {
      let query: UsageQuery | undefined;
      if (args.trim()) {
        try {
          query = parseUsageArgs(splitArguments(args), runtime.context.cwd());
        } catch (error) {
          return { output: `${(error as Error).message}\nUsage: /usage [daily|projects|sessions] [--project <path>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]` };
        }
      }
      // Without a screen to draw tabs on, and for --json, the text is printed as before.
      if (!io.tabs || query?.json) return query ? { output: usageReport(query) } : BUILTINS.cost!.run(args, runtime, io);
      const filters = query ?? { kind: 'daily' as const, json: false };
      let sessions: ReturnType<typeof usageSessions> | undefined;
      const pages: TabPage[] = USAGE_TABS.map(({ title, kind }) => ({
        title,
        lines: () => {
          if (!kind) {
            const { spent, saved } = sessionSpending(runtime);
            return saved ? [...spent, '', saved] : spent;
          }
          sessions ??= usageSessions(filters);
          return usageReport({ ...filters, kind }, sessions).split('\n');
        },
      }));
      await io.tabs('Usage', pages, query ? USAGE_TABS.findIndex((tab) => tab.kind === query.kind) : 0);
      return {};
    },
  },
  init: {
    description: `Write a ${INSTRUCTION_FILE} for this project`,
    run: () => ({ prompt: INIT_PROMPT }),
  },
  exit: { description: 'Quit', run: () => ({ exit: true }) },
};

/** A command the user can type, for completion and the command menu. */
export interface CommandEntry {
  /** Without the slash. */
  name: string;
  description: string;
  /** What goes after the name, such as `<file>`. */
  hint?: string;
}

/** Built-in commands, then skills, then MCP prompts. A built-in hides a skill of the same name, as when running one. */
export function commandEntries(runtime: Runtime): CommandEntry[] {
  const entries: CommandEntry[] = Object.entries(BUILTINS).map(([name, command]) => ({ name, description: command.description }));
  for (const skill of skillsOf(runtime).values()) {
    if (skill.userInvocable) entries.push({ name: skill.name, description: skill.description, ...(skill.argumentHint ? { hint: skill.argumentHint } : {}) });
  }
  for (const { command, server, prompt } of runtime.mcp.prompts()) {
    entries.push({ name: command, description: prompt.description ?? `Prompt from the ${server} MCP server` });
  }
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entry.name) && seen.add(entry.name));
}

export function commandNames(runtime: Runtime): string[] {
  return commandEntries(runtime).map((entry) => `/${entry.name}`);
}

function skillCommand(skill: Skill, args: string, runtime: Runtime): CommandResult {
  return {
    run: async (signal) => {
      const ctx = runtime.agent.skillContext(signal);
      try {
        const prepared = await prepareSkill(skill, args, ctx);
        if (skill.fork) {
          const report = await ctx.runSubagent!({
            description: `skill ${skill.name}`,
            prompt: prepared.text,
            signal,
            ...(skill.agent ? { subagentType: skill.agent } : {}),
            ...(skill.model ? { model: skill.model } : {}),
            ...(skill.effort ? { effort: skill.effort } : {}),
          });
          return { prompt: `The skill "${skill.name}" ran in a subagent and reported:\n\n${report}` };
        }
        ctx.noteSkillLoaded?.(skill.name, prepared.text);
        return { prompt: prepared.text, activation: prepared.activation };
      } catch (error) {
        if (error instanceof SkillError) return { output: error.message };
        throw error;
      }
    },
  };
}

/** A skill or MCP prompt named by a `/name args` line. Print mode uses only these. */
export function resolveExtensionCommand(name: string, args: string, runtime: Runtime): CommandResult | null {
  const skill = skillsOf(runtime).get(name);
  if (skill?.userInvocable) return skillCommand(skill, args, runtime);
  const prompt = runtime.mcp.prompts().find(({ command }) => command === name);
  if (prompt) {
    return {
      run: async (signal) => {
        try {
          return { prompt: await runtime.mcp.renderPrompt(prompt.server, prompt.prompt, splitArguments(args), signal) };
        } catch (error) {
          return { output: `MCP prompt failed: ${(error as Error).message}` };
        }
      },
    };
  }
  return null;
}

export function parseSlash(line: string): { name: string; args: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(line.trim());
  return match ? { name: match[1]!, args: match[2]!.trim() } : null;
}

export async function runSlashCommand(line: string, runtime: Runtime, io: CommandIO): Promise<CommandResult> {
  const parsed = parseSlash(line);
  if (!parsed) return { output: 'Type /help to list commands.' };
  const { name, args } = parsed;
  if (name === 'quit') return { exit: true };
  const builtin = BUILTINS[name];
  if (builtin) return builtin.run(args, runtime, io);
  return resolveExtensionCommand(name, args, runtime) ?? { output: `Unknown command: /${name}. Type /help to list commands.` };
}

/** Runs any deferred work, leaving a result with nothing further to do. */
export async function settleCommand(result: CommandResult, signal: AbortSignal): Promise<CommandResult> {
  let current = result;
  while (current.run) current = await current.run(signal);
  return current;
}
