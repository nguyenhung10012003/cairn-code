/**
 * Hooks. A command hook receives JSON on stdin and answers through its exit code and stdout:
 * exit 0 may print a JSON decision, exit 2 blocks, and anything else is a non-blocking error
 * unless `onFailure` says to block. An http hook gets the same JSON as a POST body.
 */
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import type { HookGroup, HookHandler, HooksConfig } from '../config/settings.ts';
import { debug } from '../core/debug.ts';
import { matchBashPattern, parseRule } from '../permissions/rules.ts';

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'PermissionRequest'
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged'
  | 'StopFailure'
  | 'Stop';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'InstructionsLoaded',
  'CwdChanged', 'FileChanged', 'StopFailure', 'Stop',
];

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_CAPTURED_CHARS = 1_000_000;
const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set(['SessionStart', 'UserPromptSubmit']);
const SUPPORTED_TYPES = new Set(['command', 'http', 'prompt']);
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 30;
/** Where a model's yes or no means something. Elsewhere a prompt hook is skipped. */
const PROMPT_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'UserPromptSubmit', 'Stop', 'SubagentStop']);

/** Sends one prompt to a model and returns its text. Set by the runtime once it has a provider. */
export type HookEvaluator = (request: { system: string; prompt: string; model?: string; signal: AbortSignal }) => Promise<string>;

const PROMPT_HOOK_SYSTEM = `You check one condition for a hook in a coding agent. You receive the hook's instructions and the event's input as JSON. Decide only from what you are given.

Answer with one JSON object and nothing else:
- {"ok": true} when the action may go ahead, or the condition holds;
- {"ok": false, "reason": "..."} when it may not, with a reason the agent can act on;
- add "impossible": true to an "ok": false answer when the condition can never be met, so the agent should stop trying.`;

export interface HookResult {
  /** Stops the action. On Stop, tells the agent to keep going instead. */
  blocked: boolean;
  blockReason?: string;
  permission?: 'allow' | 'deny' | 'ask';
  permissionReason?: string;
  updatedInput?: Record<string, unknown>;
  updatedOutput?: string;
  /** A PermissionRequest hook answering in the user's place. */
  requestDecision?: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string };
  additionalContext: string[];
  notices: string[];
  /** From SessionStart, CwdChanged or FileChanged: the files FileChanged watches, besides those its matchers name. */
  watchPaths?: string[];
}

/** Reported as each hook runs, for --include-hook-events. */
export interface HookActivity {
  event: HookEvent;
  handler: string;
  exitCode: number | null;
  durationMs: number;
}

export interface HookCommonInput {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  permission_mode: string;
}

function emptyResult(): HookResult {
  return { blocked: false, additionalContext: [], notices: [] };
}

/** A FileChanged matcher is a list of file names, compared whole, as it also says which files to watch. */
function fileNames(matcher: string | undefined): string[] {
  return (matcher ?? '').split('|').map((name) => name.trim()).filter((name) => name !== '' && name !== '*');
}

function matcherMatches(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_|,\s-]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map((part) => part.trim()).includes(target);
  }
  // Unanchored, so `^Notebook` matches NotebookEdit.
  try {
    return new RegExp(matcher).test(target);
  } catch {
    return false;
  }
}

/** The `if` field uses permission rule syntax, for example `Bash(rm *)`. */
function ifConditionMatches(condition: string | undefined, toolName: string, input: Record<string, unknown> | undefined): boolean {
  if (condition === undefined) return true;
  const rule = parseRule(condition, 'deny', 'cli', '/');
  if (!rule || rule.tool !== toolName) return false;
  if (rule.specifier === undefined) return true;
  const subject = input?.command ?? input?.file_path ?? input?.url;
  return typeof subject === 'string' && matchBashPattern(rule.specifier, subject);
}

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(handler: HookHandler, payload: string, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    // With `args` nothing goes through a shell, so a value cannot be re-parsed as syntax.
    const [file, args] = handler.args ? [handler.command!, handler.args] : [process.env.SHELL || '/bin/sh', ['-c', handler.command!]];
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env, ...handler.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, (handler.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURED_CHARS) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURED_CHARS) stderr += d.toString();
    });
    // A hook that ignores its stdin closes the pipe early, which is not an error.
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
    const done = (code: number | null): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on('error', (error) => {
      stderr += error.message;
      done(1);
    });
    child.on('close', done);
  });
}

/** `$NAME` in a header is filled in only for variables the hook lists in `allowedEnvVars`. */
function expandHeaders(handler: HookHandler): Record<string, string> {
  const allowed = new Set(handler.allowedEnvVars ?? []);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(handler.headers ?? {})) {
    headers[name] = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, variable: string) => (allowed.has(variable) ? (process.env[variable] ?? '') : match));
  }
  return headers;
}

async function runHttp(handler: HookHandler, payload: string, signal?: AbortSignal): Promise<CommandOutcome> {
  const timeout = AbortSignal.timeout((handler.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
  try {
    const response = await fetch(handler.url!, {
      method: 'POST',
      headers: expandHeaders(handler),
      body: payload,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = (await response.text()).slice(0, MAX_CAPTURED_CHARS);
    return response.ok ? { code: 0, stdout: text, stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: `HTTP ${response.status}`, timedOut: false };
  } catch (error) {
    return { code: 1, stdout: '', stderr: (error as Error).message, timedOut: timeout.aborted };
  }
}

/** The hook's prompt with its input in place of `$ARGUMENTS`, or after it. `\$` stays a plain `$`. */
export function fillPrompt(prompt: string, payload: string): string {
  let used = false;
  const filled = prompt.replace(/\\\$|\$ARGUMENTS/g, (match) => {
    if (match !== '$ARGUMENTS') return '$';
    used = true;
    return payload;
  });
  return used ? filled : `${filled}\n\n${payload}`;
}

/**
 * Asks a model, and answers as a command hook would: `ok: false` is exit code 2 with the reason,
 * so it blocks the action, or on Stop keeps the agent going. On Stop and SubagentStop,
 * `impossible: true` lets it stop after all, as there is nothing left to try.
 */
async function runPrompt(handler: HookHandler, event: HookEvent, payload: string, evaluator: HookEvaluator | undefined, signal?: AbortSignal): Promise<CommandOutcome> {
  if (!evaluator) return { code: 1, stdout: '', stderr: 'no model is available to run it', timedOut: false };
  if (typeof handler.prompt !== 'string' || handler.prompt.trim() === '') return { code: 1, stdout: '', stderr: 'it has no prompt', timedOut: false };
  const timeout = AbortSignal.timeout((handler.timeout ?? DEFAULT_PROMPT_TIMEOUT_SECONDS) * 1000);
  let reply: string;
  try {
    reply = await evaluator({
      system: PROMPT_HOOK_SYSTEM,
      prompt: fillPrompt(handler.prompt, payload),
      ...(handler.model ? { model: handler.model } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    return { code: 1, stdout: '', stderr: (error as Error).message, timedOut: timeout.aborted };
  }
  let answer: { ok?: unknown; reason?: unknown; impossible?: unknown };
  try {
    answer = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '') as typeof answer;
  } catch {
    return { code: 1, stdout: '', stderr: 'the model did not answer with JSON', timedOut: false };
  }
  if (answer.ok === true) return { code: 0, stdout: '', stderr: '', timedOut: false };
  if (answer.ok !== false) return { code: 1, stdout: '', stderr: 'the model answered without "ok"', timedOut: false };
  if (answer.impossible === true && (event === 'Stop' || event === 'SubagentStop')) return { code: 0, stdout: '', stderr: '', timedOut: false };
  const reason = typeof answer.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : 'A prompt hook said no.';
  return { code: 2, stdout: '', stderr: reason, timedOut: false };
}

function describeHandler(handler: HookHandler): string {
  if (handler.type === 'prompt') {
    const text = (handler.prompt ?? '').replace(/\s+/g, ' ').trim();
    return `prompt: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
  }
  return handler.type === 'http' ? handler.url! : [handler.command, ...(handler.args ?? [])].join(' ');
}

interface HookJson {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    updatedToolOutput?: string;
    additionalContext?: string;
    decision?: { behavior?: string; updatedInput?: Record<string, unknown>; message?: string };
    watchPaths?: unknown;
  };
  watchPaths?: unknown;
}

function pathList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.startsWith('/')) : undefined;
}

function applyJson(json: HookJson, result: HookResult): void {
  if (json.systemMessage) result.notices.push(json.systemMessage);
  const watchPaths = pathList(json.hookSpecificOutput?.watchPaths) ?? pathList(json.watchPaths);
  if (watchPaths) result.watchPaths = watchPaths;
  if (json.decision === 'block' || json.continue === false) {
    result.blocked = true;
    result.blockReason = json.reason ?? json.stopReason ?? 'Blocked by a hook.';
  }
  const specific = json.hookSpecificOutput;
  if (!specific) return;
  const answer = specific.decision;
  if (answer?.behavior === 'deny' || (answer?.behavior === 'allow' && result.requestDecision?.behavior !== 'deny')) {
    result.requestDecision = {
      behavior: answer.behavior,
      ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}),
      ...(answer.message ? { message: answer.message } : {}),
    };
  }
  const decision = specific.permissionDecision;
  if (decision === 'deny') {
    // Across several hooks, the most restrictive answer wins.
    result.permission = 'deny';
    result.permissionReason = specific.permissionDecisionReason ?? 'Denied by a hook.';
  } else if (decision === 'ask' && result.permission !== 'deny') {
    result.permission = 'ask';
    if (specific.permissionDecisionReason) result.permissionReason = specific.permissionDecisionReason;
  } else if (decision === 'allow' && result.permission === undefined) {
    result.permission = 'allow';
  }
  if (specific.updatedInput) result.updatedInput = specific.updatedInput;
  if (typeof specific.updatedToolOutput === 'string') result.updatedOutput = specific.updatedToolOutput;
  if (specific.additionalContext) result.additionalContext.push(specific.additionalContext.slice(0, MAX_CONTEXT_CHARS));
}

export class HookRunner {
  private readonly config: HooksConfig;
  private readonly projectDir: string;
  /** Hooks added while running, by a skill. A `once` hook is dropped after its first success. */
  private readonly added: HooksConfig = {};
  onActivity?: (activity: HookActivity) => void;
  /** Runs `prompt` hooks. Without it, they fail as hooks that could not start. */
  evaluator?: HookEvaluator;

  constructor(config: HooksConfig, projectDir: string) {
    this.config = config;
    this.projectDir = projectDir;
  }

  /** Every configured hook, for /hooks. */
  list(): { event: string; matcher?: string; handler: string }[] {
    return Object.entries(this.groups()).flatMap(([event, groups]) =>
      groups.flatMap((group) => (group.hooks ?? []).map((handler) => ({ event, ...(group.matcher ? { matcher: group.matcher } : {}), handler: describeHandler(handler) }))),
    );
  }

  private groups(): HooksConfig {
    const merged: HooksConfig = {};
    for (const source of [this.config, this.added]) {
      for (const [event, groups] of Object.entries(source)) (merged[event] ??= []).push(...groups);
    }
    return merged;
  }

  add(config: HooksConfig): void {
    for (const [event, groups] of Object.entries(config)) (this.added[event] ??= []).push(...groups);
  }

  /** The hook handlers named by a config that this version cannot run. */
  static unsupported(config: HooksConfig): string[] {
    return Object.values(config).flatMap((groups: HookGroup[]) =>
      groups.flatMap((group) => (group.hooks ?? []).filter((handler) => !SUPPORTED_TYPES.has(handler.type)).map((handler) => handler.type)),
    );
  }

  /** Whether any hook is set for `event`. */
  has(event: HookEvent): boolean {
    return (this.groups()[event] ?? []).some((group) => (group.hooks ?? []).length > 0);
  }

  /** The file names FileChanged matchers list, which are watched in the working directory. */
  watchedNames(): string[] {
    return [...new Set((this.groups().FileChanged ?? []).flatMap((group) => fileNames(group.matcher)))];
  }

  /** The events a config gives `prompt` hooks that never run there. */
  static misplacedPrompts(config: HooksConfig): string[] {
    return Object.entries(config)
      .filter(([event, groups]) => !PROMPT_EVENTS.has(event) && groups.some((group) => (group.hooks ?? []).some((handler) => handler.type === 'prompt')))
      .map(([event]) => event);
  }

  private forget(handler: HookHandler): void {
    for (const groups of Object.values(this.added)) {
      for (const group of groups) group.hooks = group.hooks.filter((candidate) => candidate !== handler);
    }
  }

  private execute(handler: HookHandler, event: HookEvent, payload: string, cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<CommandOutcome> {
    if (handler.type === 'prompt') return runPrompt(handler, event, payload, this.evaluator, signal);
    return handler.type === 'http' ? runHttp(handler, payload, signal) : runCommand(handler, payload, cwd, env, signal);
  }

  async run(
    event: HookEvent,
    common: HookCommonInput,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<HookResult> {
    const result = emptyResult();
    const toolName = extra.tool_name as string | undefined;
    const input = extra.tool_input as Record<string, unknown> | undefined;
    const target = toolName ?? ['source', 'trigger', 'notification_type', 'agent_type', 'load_reason'].map((key) => extra[key] as string | undefined).find(Boolean) ?? '';
    const changed = event === 'FileChanged' ? basename(String(extra.file_path ?? '')) : undefined;
    const handlers = (this.groups()[event] ?? [])
      .filter((group) => (changed === undefined ? matcherMatches(group.matcher, target) : fileNames(group.matcher).length === 0 || fileNames(group.matcher).includes(changed)))
      .flatMap((group) => group.hooks ?? [])
      .filter((handler) => SUPPORTED_TYPES.has(handler.type) && (handler.type !== 'prompt' || PROMPT_EVENTS.has(event)) && ifConditionMatches(handler.if, toolName ?? '', input));
    if (handlers.length === 0) return result;

    const payload = JSON.stringify({ ...common, hook_event_name: event, ...extra });
    const env = { KARST_PROJECT_DIR: this.projectDir };
    const waited = handlers.filter((handler) => {
      // A prompt hook is only there for its answer, so it is always waited for.
      if (!handler.async || handler.type === 'prompt') return true;
      // Nothing can be decided from an async hook, so its answer is not awaited or read.
      void this.execute(handler, event, payload, common.cwd, env);
      return false;
    });
    const outcomes = await Promise.all(
      waited.map(async (handler) => {
        const started = Date.now();
        const outcome = await this.execute(handler, event, payload, common.cwd, env, signal);
        debug('hooks', `${event}: ${describeHandler(handler)} -> ${outcome.timedOut ? 'timed out' : `exit ${outcome.code}`}`);
        this.onActivity?.({ event, handler: describeHandler(handler), exitCode: outcome.code, durationMs: Date.now() - started });
        return outcome;
      }),
    );

    outcomes.forEach((outcome, i) => {
      const handler = waited[i]!;
      const label = describeHandler(handler);
      const failed = outcome.timedOut || (outcome.code !== 0 && outcome.code !== 2);
      if (failed && handler.onFailure === 'block') {
        result.blocked = true;
        result.blockReason = outcome.stderr.trim() || `A required hook failed: ${label}`;
      } else if (outcome.timedOut) {
        result.notices.push(`Hook timed out: ${label}`);
      } else if (outcome.code === 2) {
        result.blocked = true;
        result.blockReason = outcome.stderr.trim() || `Blocked by hook: ${label}`;
      } else if (outcome.code !== 0) {
        result.notices.push(`Hook failed (exit ${outcome.code}): ${label}${outcome.stderr ? `: ${outcome.stderr.trim()}` : ''}`);
      } else {
        if (handler.once) this.forget(handler);
        const stdout = outcome.stdout.trim();
        if (stdout.startsWith('{')) {
          try {
            applyJson(JSON.parse(stdout) as HookJson, result);
            return;
          } catch {
            result.notices.push(`Hook printed invalid JSON: ${label}`);
          }
        }
        if (stdout && CONTEXT_EVENTS.has(event)) result.additionalContext.push(stdout.slice(0, MAX_CONTEXT_CHARS));
      }
    });
    return result;
  }
}
