import { createHash } from 'node:crypto';
import type { Attachment } from '../core/messages.ts';
import type { Effort, JsonSchema } from '../core/provider.ts';
import type { AccessRequest, Decision, PermissionMode, RuleSuggestion } from '../permissions/engine.ts';
import type { CheckpointStore } from '../session/checkpoints.ts';
import type { LoadedSkills, Skill, SkillActivation } from '../skills/skills.ts';
import type { CommandWrapper } from '../sandbox/sandbox.ts';
import type { TaskRegistry } from './tasks.ts';

export interface ToolOutput {
  /** What the model sees. */
  content: string;
  isError?: boolean;
  /** Shorter text for the terminal, when the model's copy would be noisy. */
  display?: string;
  /** A command's exit status, for tools that run one. */
  exitCode?: number;
  /** Pictures or documents for the model to see alongside `content`. */
  attachments?: Attachment[];
  /** Raises the usual cap on how much of `content` reaches the model, for a read the model asked to be large. */
  maxChars?: number;
}

export interface PermissionPrompt {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  suggestions: RuleSuggestion[];
  forced: boolean;
}

export type PermissionAnswer =
  | { behavior: 'allow'; always?: boolean; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; feedback?: string };

export interface UserQuestion {
  question: string;
  /** A short label shown as a chip, at most 12 characters. */
  header?: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect?: boolean;
}

/** How tools and the permission flow reach the person at the keyboard. */
export interface Prompter {
  permission(prompt: PermissionPrompt): Promise<PermissionAnswer>;
  /** Returns one answer per question, or null when nobody can answer. */
  questions(questions: UserQuestion[]): Promise<string[] | null>;
  approvePlan(plan: string): Promise<boolean>;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SubagentRequest {
  description: string;
  prompt: string;
  subagentType?: string;
  model?: string;
  effort?: Effort;
  /** `worktree` gives the subagent its own git worktree. */
  isolation?: 'worktree';
  signal: AbortSignal;
}

export interface AgentSummary {
  id: string;
  description: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
}

/** Subagents that run in the background, so the conversation can go on while they work. */
export interface AgentControl {
  /** Starts one and returns its id. Its report arrives later as a notification. */
  start(request: Omit<SubagentRequest, 'signal'>): Promise<string>;
  list(): AgentSummary[];
  /** Delivers a message to a running agent, or resumes a finished one with it. */
  send(to: string, message: string, from: string): Promise<string>;
  stop(idOrDescription: string): AgentSummary | undefined;
}

export interface CronJobInfo {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  nextRun: Date | null;
  expiresAt?: Date;
}

export interface CronControl {
  create(cron: string, prompt: string, recurring: boolean): CronJobInfo;
  delete(id: string): boolean;
  list(): CronJobInfo[];
}

export interface WorktreeControl {
  enter(options: { name?: string; path?: string }): Promise<string>;
  exit(action: 'keep' | 'remove', discardChanges: boolean): Promise<{ content: string; isError?: boolean }>;
}

export interface WebSearchRequest {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  mode: 'standard' | 'extended';
  signal: AbortSignal;
}

/** What invoking a skill needs from the session, whichever agent or command starts it. */
export interface SkillHost {
  load(): LoadedSkills;
  checkShell(command: string): Decision;
  /** A skill's supporting files live outside the project when it is a personal skill. */
  allowRead(dir: string): void;
  /** Registers a skill's `hooks`, which stay active for the rest of the session. */
  registerHooks(skill: Skill): void;
  sessionId(): string;
  effort(): string;
  projectDir: string;
}

/**
 * Remembers what the model has read, so an edit is refused if it never saw the file or the
 * file changed since. Each agent has its own tracker: a subagent's edit must not let the
 * parent write over content the parent has not seen.
 */
export class FileTracker {
  private readonly seen = new Map<string, string>();

  record(path: string, content: string | Buffer): void {
    this.seen.set(path, hashContent(content));
  }

  status(path: string, current: string | Buffer): 'current' | 'unread' | 'stale' {
    const known = this.seen.get(path);
    if (known === undefined) return 'unread';
    return known === hashContent(current) ? 'current' : 'stale';
  }
}

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface ToolContext {
  cwd(): string;
  setCwd(dir: string): void;
  workingDirs(): string[];
  signal: AbortSignal;
  files: FileTracker;
  checkpoints?: CheckpointStore;
  prompter: Prompter;
  todos: { items: TodoItem[] };
  tasks: TaskRegistry;
  /** Move a foreground command to the background at its timeout, rather than stopping it. */
  autoBackground?: boolean;
  /** Directories of enabled plugins' `bin/`, put on PATH for the commands the model runs. */
  extraPath?: string[];
  /** Encloses a shell command in the OS sandbox, when one is on. */
  wrapCommand?: CommandWrapper;
  /** Environment variables that hold credentials. Commands the model runs must not see them. */
  secretEnvVars: string[];
  isReadDenied(path: string): boolean;
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  runSubagent?(request: SubagentRequest): Promise<string>;
  /** Present for the agent that may start background subagents and message them. */
  agents?: AgentControl;
  /** This agent's id, when it is a subagent, so its messages can say who sent them. */
  agentId?: string;
  /** Puts a note into this agent's conversation, such as a monitor event, and wakes it if idle. */
  notify?(text: string): void;
  /** The plan file for this session, and the way into and out of plan mode. */
  planMode?: { file(): string; enter(): void; exit(): void };
  cron?: CronControl;
  worktrees?: WorktreeControl;
  /** Shows a desktop notification. Returns what happened, such as that it was not needed. */
  pushNotification?(message: string): Promise<{ sent: boolean; reason: string }>;
  webSearch?(request: WebSearchRequest): Promise<ToolOutput>;
  skillHost?: SkillHost;
  activateSkill?(activation: SkillActivation): void;
  /** Returns true when this exact text was already loaded into the conversation. */
  noteSkillLoaded?(name: string, text: string): boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Keep the definition out of context until the model searches for it, if the API supports that. */
  deferred?: boolean;
  /** Safe to run alongside other read-only calls, and allowed in plan mode. */
  isReadOnly(input: Record<string, unknown>): boolean;
  access(input: Record<string, unknown>, ctx: ToolContext): AccessRequest;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

function typeMatches(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Validates model-produced input against the subset of JSON Schema our tools use. A streamed
 * tool call can be cut off or malformed, so this always runs before a tool sees its input.
 * Returns an error message, or null when the input is valid.
 */
export function validateInput(schema: JsonSchema, value: unknown, path = 'input'): string | null {
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    return `${path} must be of type ${String(schema.type)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(', ')}`;
  }
  if (schema.const !== undefined && value !== schema.const) return `${path} must be ${JSON.stringify(schema.const)}`;
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path} must be at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${path} must be at most ${schema.maxLength} characters`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} must have at least ${schema.minItems} items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} must have at most ${schema.maxItems} items`;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (record[key] === undefined) return `${path}.${key} is required`;
    }
    const properties = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        const error = validateInput(propertySchema, item, `${path}.${key}`);
        if (error) return error;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not a recognized parameter`;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (const [i, item] of value.entries()) {
      const error = validateInput(schema.items as JsonSchema, item, `${path}[${i}]`);
      if (error) return error;
    }
  }
  return null;
}
