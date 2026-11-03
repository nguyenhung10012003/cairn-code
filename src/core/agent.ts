/**
 * The agent loop: send the conversation to the model, run whatever tools it asks for, feed the
 * results back, and repeat until it stops. History is append-only, and each batch of tool
 * results goes back in one user message.
 */
import { compactedHistory, summarizeConversation } from './compaction.ts';
import { debug } from './debug.ts';
import { addUsage, contextTokens, emptyUsage, textOf } from './messages.ts';
import type { ContentBlock, Message, StopReason, ToolResultBlock, ToolUseBlock, Usage } from './messages.ts';
import type { Effort, JsonSchema, ModelProvider, ServerTool, StreamEvent, SystemBlock, ToolDefinition } from './provider.ts';
import type { HookCommonInput, HookRunner } from '../hooks/runner.ts';
import type { PermissionEngine } from '../permissions/engine.ts';
import { validateInput } from '../tools/types.ts';
import type { Tool, ToolContext, ToolOutput } from '../tools/types.ts';
import type { SessionStore } from '../session/store.ts';
import type { SkillActivation } from '../skills/skills.ts';

/** Room for thinking as well as the reply, since thinking counts toward this limit. */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const AUTO_COMPACT_FRACTION = 0.8;
const MAX_FAILED_COMPACTIONS = 3;
const MAX_TOOL_RESULT_CHARS = 100_000;
const MAX_STOP_HOOK_CONTINUATIONS = 5;
const MAX_KEPT_CHARS_PER_SKILL = 20_000;
const MAX_KEPT_SKILL_CHARS = 100_000;
/** These tools act on the one file they name. Search tools name a whole directory. */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);
/** Overloaded, or the model is unavailable. Worth another model; anything else would fail there too. */
const FALLBACK_STATUSES = new Set([404, 503, 529]);

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'server_tool'; name: string; summary?: string }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; id: string; name: string; output: string; display?: string; isError: boolean; durationMs: number }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'compacted'; automatic: boolean }
  | { type: 'usage'; turn: Usage; total: Usage }
  | { type: 'turn_end'; stopReason: StopReason | 'interrupted' | 'error' | 'max_turns' | 'max_budget'; text: string; error?: string };

/** What the agent reports as it works, and what it collects to add to the conversation. */
export interface AgentWatcher {
  touched(paths: string[]): void;
  drain(): string[];
  reset(): void;
}

export interface AgentOptions {
  provider: ModelProvider;
  model: string;
  system: SystemBlock[];
  /** A function, because reconnecting an MCP server can change the set between turns. */
  tools: () => Tool[];
  serverTools?: ServerTool[];
  engine: PermissionEngine;
  hooks: HookRunner;
  store: SessionStore;
  context: Omit<ToolContext, 'signal'>;
  /** Approvals the user chose to keep are handed here to persist. */
  onAlwaysAllow?: (rule: string, persist: boolean) => void;
  history?: Message[];
  effort?: Effort;
  maxTurns?: number;
  maxOutputTokens?: number;
  autoCompact?: boolean;
  /** Compact above this many tokens, rather than at a fraction of the model's window. */
  autoCompactTokens?: number;
  /** The main agent ends a skill's turn-long grants. A subagent shares them and must not. */
  ownsTurnState?: boolean;
  watcher?: AgentWatcher;
  /** Before a prompt joins the conversation, so anything new can go along with it. */
  onPromptStart?: () => void;
  /** Text to send with the next user message because of the session's state, such as plan mode. */
  modeReminder?: () => string | undefined;
  /** Sent with every prompt the user types, such as an output style's reminder. */
  turnReminder?: () => string | undefined;
  /** Stop when the estimated spend for this session reaches this. */
  maxBudgetUsd?: number;
  /** Tried in order when the model is overloaded or unavailable. The next prompt tries it again. */
  fallbackModels?: string[];
  /** Ask for a final answer that matches this JSON Schema. */
  outputSchema?: JsonSchema;
  betas?: string[];
}

export class Agent {
  messages: Message[];
  model: string;
  effort: Effort | undefined;
  totalUsage: Usage = emptyUsage();
  totalCostUsd = 0;
  /** True when some response ran on a model with no known price, so the total is a lower bound. */
  costIsPartial = false;
  /** Tokens the most recent request occupied. Null right after compaction. */
  lastContextTokens: number | null = null;
  autoCompactTokens: number | undefined;

  private readonly options: AgentOptions;
  private store: SessionStore;
  /** Frozen for a conversation: changing it would invalidate the cache and earlier thinking. */
  private system: SystemBlock[];
  private failedCompactions = 0;
  private lastServedBy: string | undefined;
  /** Set by a skill, for the rest of the turn. */
  private turnModel: string | undefined;
  private turnEffort: Effort | undefined;
  /** What each invoked skill last rendered to. Kept through compaction, and for repeat calls. */
  private readonly loadedSkills = new Map<string, string>();

  constructor(options: AgentOptions) {
    this.options = options;
    this.store = options.store;
    this.system = options.system;
    this.messages = options.history ? [...options.history] : [];
    this.model = options.model;
    this.effort = options.effort;
    this.autoCompactTokens = options.autoCompactTokens;
  }

  get systemBlocks(): SystemBlock[] {
    return this.system;
  }

  get provider(): ModelProvider {
    return this.options.provider;
  }

  /**
   * Sends the rest of the conversation to another provider and model. The history is neutral,
   * so it carries over; blocks only the old provider understands stay in it but are not sent.
   */
  switchProvider(provider: ModelProvider, model: string): void {
    this.options.provider = provider;
    this.model = model;
    this.lastServedBy = undefined;
    // lastContextTokens stays: the history is as long as it was, and a model with a smaller
    // window should compact it before the first request rather than fail on it.
  }

  get sessionId(): string {
    return this.store.id;
  }

  get transcriptPath(): string | null {
    return this.store.path;
  }

  /** Swaps in another conversation, for /clear and /resume. */
  reset(store: SessionStore, history: Message[] = [], system?: SystemBlock[]): void {
    this.store = store;
    this.messages = [...history];
    if (system) this.system = system;
    this.lastContextTokens = null;
    this.failedCompactions = 0;
    this.lastServedBy = undefined;
    this.loadedSkills.clear();
    this.options.watcher?.reset();
  }

  /** What became relevant since the last message, as text to send with the next one. */
  private reminders(): ContentBlock[] {
    const texts = this.options.watcher?.drain() ?? [];
    const mode = this.options.modeReminder?.();
    if (mode) texts.push(mode);
    return texts.map((text) => ({ type: 'text', text }));
  }

  /** The tokens above which a conversation is compacted. */
  get autoCompactThreshold(): number {
    return this.autoCompactTokens ?? this.options.provider.contextWindow(this.model) * AUTO_COMPACT_FRACTION;
  }

  activate(activation: SkillActivation): void {
    this.options.engine.addTurnRules(activation.allowedTools, activation.disallowedTools);
    if (activation.model) this.turnModel = activation.model;
    if (activation.effort) this.turnEffort = activation.effort;
  }

  noteSkillLoaded(name: string, text: string): boolean {
    const repeat = this.loadedSkills.get(name) === text;
    this.loadedSkills.set(name, text);
    return repeat;
  }

  /** The context a tool or command needs in order to invoke a skill for this agent. */
  skillContext(signal: AbortSignal): ToolContext {
    return {
      ...this.options.context,
      signal,
      activateSkill: (activation) => this.activate(activation),
      noteSkillLoaded: (name, text) => this.noteSkillLoaded(name, text),
    };
  }

  private append(message: Message): void {
    this.messages.push(message);
    this.store.appendMessage(message);
  }

  private hookCommon(): HookCommonInput {
    return {
      session_id: this.store.id,
      transcript_path: this.store.path,
      cwd: this.options.context.cwd(),
      permission_mode: this.options.engine.mode,
    };
  }

  /** Tool definitions are fixed once built, in a stable order, to keep the cache prefix valid. */
  toolDefinitions(): ToolDefinition[] {
    return this.availableTools().map(({ name, description, inputSchema, deferred }) => ({
      name,
      description,
      inputSchema,
      ...(deferred ? { deferred } : {}),
    }));
  }

  private availableTools(): Tool[] {
    return this.options.tools().filter((tool) => !this.options.engine.isToolRemoved(tool.name));
  }

  /** Runs on the provider's side, so it cannot be prompted per call, only removed by a deny rule. */
  private availableServerTools(): ServerTool[] {
    return (this.options.serverTools ?? []).filter((tool) => {
      return !(tool === 'web_search' && this.options.engine.isToolRemoved('WebSearch'));
    });
  }

  async compact(focus?: string, signal?: AbortSignal): Promise<void> {
    const trigger = focus === undefined ? 'auto' : 'manual';
    const pre = await this.options.hooks.run('PreCompact', this.hookCommon(), { trigger }, signal);
    if (pre.blocked) throw new Error(pre.blockReason ?? 'A hook blocked compaction.');
    const result = await summarizeConversation({
      provider: this.options.provider,
      model: this.model,
      messages: this.messages,
      ...(focus === undefined ? {} : { focus }),
      ...(signal ? { signal } : {}),
    });
    this.addUsage(result.usage, result.costUsd);
    this.messages = compactedHistory(result.summary, this.skillsToKeep());
    this.store.appendCompaction(textOf(this.messages[0]!.content));
    this.lastContextTokens = null;
    this.options.watcher?.reset();
    await this.options.hooks.run('PostCompact', this.hookCommon(), { trigger, compact_summary: result.summary }, signal);
  }

  /**
   * A skill's instructions would otherwise vanish in the summary while the model still believes
   * they are loaded. The most recently used go first, within a budget. A dropped skill is
   * forgotten, so calling it again loads it again rather than reporting "already loaded".
   */
  private skillsToKeep(): string[] {
    const kept: string[] = [];
    let budget = MAX_KEPT_SKILL_CHARS;
    for (const [name, text] of [...this.loadedSkills].reverse()) {
      const clipped = text.slice(0, MAX_KEPT_CHARS_PER_SKILL);
      if (clipped.length > budget || clipped.length < text.length) {
        this.loadedSkills.delete(name);
        if (clipped.length > budget) continue;
      }
      kept.push(`Skill "${name}" was loaded earlier and still applies:\n\n${clipped}`);
      budget -= clipped.length;
    }
    return kept;
  }

  /** Also used to add in what subagents spent. */
  addUsage(usage: Usage, costUsd: number | undefined): void {
    this.totalUsage = addUsage(this.totalUsage, usage);
    if (costUsd === undefined) this.costIsPartial = true;
    else this.totalCostUsd += costUsd;
  }

  private shouldAutoCompact(): boolean {
    if (this.options.autoCompact === false || this.lastContextTokens === null) return false;
    if (this.failedCompactions >= MAX_FAILED_COMPACTIONS) return false;
    return this.lastContextTokens > this.autoCompactThreshold;
  }

  /**
   * Starts a turn for notes that arrived while the conversation was idle, such as background
   * work finishing. Does nothing when no note is waiting.
   */
  async *resumeForNotes(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const notes = this.options.watcher?.drain() ?? [];
    if (notes.length === 0) return;
    yield* this.run('', signal, undefined, notes);
  }

  async *run(prompt: string, signal: AbortSignal, activation?: SkillActivation, notes?: string[]): AsyncGenerator<AgentEvent> {
    if (this.options.ownsTurnState) {
      this.options.engine.clearTurnRules();
      this.turnModel = undefined;
      this.turnEffort = undefined;
    }
    if (activation) this.activate(activation);
    const content: ContentBlock[] = [];
    if (notes) {
      // Not typed by anyone, so there is no prompt for UserPromptSubmit hooks to judge.
      this.options.context.checkpoints?.beginTurn();
      content.push(...notes.map((text): ContentBlock => ({ type: 'text', text })), ...this.reminders());
    } else {
      const submit = await this.options.hooks.run('UserPromptSubmit', this.hookCommon(), { prompt }, signal);
      for (const notice of submit.notices) yield { type: 'notice', level: 'warn', text: notice };
      if (submit.blocked) {
        yield { type: 'notice', level: 'warn', text: submit.blockReason ?? 'Prompt blocked by a hook.' };
        yield { type: 'turn_end', stopReason: 'other', text: '' };
        return;
      }
      this.options.context.checkpoints?.beginTurn();
      this.options.onPromptStart?.();

      content.push({ type: 'text', text: prompt });
      for (const context of submit.additionalContext) {
        content.push({ type: 'text', text: `<hook-context>\n${context}\n</hook-context>` });
      }
      content.push(...this.reminders());
      const turnReminder = this.options.turnReminder?.();
      if (turnReminder) content.push({ type: 'text', text: `<system-reminder>\n${turnReminder}\n</system-reminder>` });
    }
    this.append({ role: 'user', content });

    const fallbacks = this.options.fallbackModels ?? [];
    let fallbackIndex = -1;
    const maxTurns = this.options.maxTurns ?? Number.POSITIVE_INFINITY;
    let lastText = '';
    let stopHookContinuations = 0;

    for (let turn = 0; ; turn++) {
      if (turn >= maxTurns) {
        yield { type: 'notice', level: 'warn', text: `Stopped after reaching the limit of ${maxTurns} turns.` };
        yield { type: 'turn_end', stopReason: 'max_turns', text: lastText };
        return;
      }
      if (signal.aborted) {
        yield { type: 'turn_end', stopReason: 'interrupted', text: lastText };
        return;
      }
      if (this.shouldAutoCompact()) {
        try {
          await this.compact(undefined, signal);
          yield { type: 'compacted', automatic: true };
          this.failedCompactions = 0;
        } catch (error) {
          this.failedCompactions++;
          yield { type: 'notice', level: 'warn', text: `Auto-compaction failed: ${(error as Error).message}` };
        }
      }

      let ended: Extract<StreamEvent, { type: 'message_end' }> | undefined;
      let partialText = '';
      try {
        const serverTools = this.availableServerTools();
        const effort = this.turnEffort ?? this.effort;
        debug('api', `request: ${fallbacks[fallbackIndex] ?? this.turnModel ?? this.model}, ${this.messages.length} messages`);
        const stream = this.options.provider.stream({
          model: fallbacks[fallbackIndex] ?? this.turnModel ?? this.model,
          system: this.system,
          messages: this.messages,
          tools: this.toolDefinitions(),
          maxTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          signal,
          ...(serverTools.length > 0 ? { serverTools } : {}),
          ...(effort ? { effort } : {}),
          ...(this.options.outputSchema ? { outputSchema: this.options.outputSchema } : {}),
          ...(this.options.betas ? { betas: this.options.betas } : {}),
        });
        for await (const event of stream) {
          if (event.type === 'text_delta') {
            partialText += event.text;
            yield { type: 'text_delta', text: event.text };
          } else if (event.type === 'thinking_delta') {
            yield { type: 'thinking_delta', text: event.text };
          } else if (event.type === 'server_tool') {
            yield { type: 'server_tool', name: event.name, ...(event.summary ? { summary: event.summary } : {}) };
          } else if (event.type === 'message_end') {
            ended = event;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          this.keepPartialText(partialText);
          yield { type: 'turn_end', stopReason: 'interrupted', text: partialText };
          return;
        }
        const status = (error as { status?: number }).status;
        if (!partialText && status !== undefined && FALLBACK_STATUSES.has(status) && fallbackIndex + 1 < fallbacks.length) {
          fallbackIndex++;
          yield { type: 'notice', level: 'warn', text: `The model was not available (HTTP ${status}), so trying ${fallbacks[fallbackIndex]}.` };
          turn--;
          continue;
        }
        const message = (error as Error).message;
        await this.options.hooks.run('StopFailure', this.hookCommon(), { error: message }, undefined);
        yield { type: 'turn_end', stopReason: 'error', text: lastText, error: message };
        return;
      }
      if (!ended) {
        if (signal.aborted) {
          this.keepPartialText(partialText);
          yield { type: 'turn_end', stopReason: 'interrupted', text: partialText };
          return;
        }
        yield { type: 'turn_end', stopReason: 'error', text: lastText, error: 'The model stream ended without a final message.' };
        return;
      }

      this.addUsage(ended.usage, ended.costUsd);
      this.lastContextTokens = contextTokens(ended.usage);
      yield { type: 'usage', turn: ended.usage, total: this.totalUsage };
      for (const notice of ended.notices ?? []) yield { type: 'notice', level: 'warn', text: notice };
      if (ended.servedBy !== this.lastServedBy) {
        this.lastServedBy = ended.servedBy;
        if (ended.servedBy) {
          yield { type: 'notice', level: 'info', text: `${this.turnModel ?? this.model} declined, so ${ended.servedBy} answered instead.` };
        }
      }

      if (ended.stopReason === 'refusal') {
        // Partial output from a refusal is not an answer. Nothing from it goes in the history,
        // and an empty assistant message would make the next request fail.
        yield {
          type: 'notice',
          level: 'warn',
          text: `The model declined this request${ended.stopDetail ? `: ${ended.stopDetail}` : '.'} Rephrase it, or use /clear if the conversation keeps being declined.`,
        };
        yield { type: 'turn_end', stopReason: 'refusal', text: lastText };
        return;
      }

      if (ended.content.length > 0) this.append({ role: 'assistant', content: ended.content });
      const text = textOf(ended.content);
      if (text) lastText = text;
      const toolUses = ended.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

      if (this.options.maxBudgetUsd !== undefined && this.totalCostUsd >= this.options.maxBudgetUsd) {
        this.closeOpenToolUses(toolUses, 'This call did not run: the session reached its spending limit.');
        yield { type: 'notice', level: 'warn', text: `Stopped at the spending limit of $${this.options.maxBudgetUsd}.` };
        yield { type: 'turn_end', stopReason: 'max_budget', text: lastText };
        return;
      }

      if (ended.stopReason === 'pause') continue;

      if (ended.stopReason === 'max_tokens') {
        // A tool call cut off here may have valid-looking but incomplete input. Never run it.
        if (toolUses.length > 0) {
          this.closeOpenToolUses(toolUses, 'This call was cut off by the output limit and did not run. Retry with a smaller step.');
          continue;
        }
        yield { type: 'notice', level: 'warn', text: 'The response was cut off by the output token limit.' };
        yield { type: 'turn_end', stopReason: 'max_tokens', text: lastText };
        return;
      }

      if (toolUses.length > 0) {
        const results: ToolResultBlock[] = [];
        for await (const event of this.executeTools(toolUses, signal, results)) yield event;
        const batch = await this.options.hooks.run('PostToolBatch', this.hookCommon(), { tool_names: toolUses.map((use) => use.name) }, signal);
        for (const notice of batch.notices) yield { type: 'notice', level: 'warn', text: notice };
        this.append({ role: 'user', content: [...results, ...this.reminders()] });
        if (batch.blocked) {
          yield { type: 'notice', level: 'warn', text: batch.blockReason ?? 'A hook stopped the turn.' };
          yield { type: 'turn_end', stopReason: 'other', text: lastText };
          return;
        }
        continue;
      }

      const stop = await this.options.hooks.run(
        'Stop',
        this.hookCommon(),
        { stop_hook_active: stopHookContinuations > 0 },
        signal,
      );
      for (const notice of stop.notices) yield { type: 'notice', level: 'warn', text: notice };
      if (stop.blocked && stopHookContinuations < MAX_STOP_HOOK_CONTINUATIONS) {
        stopHookContinuations++;
        this.append({
          role: 'user',
          content: [{ type: 'text', text: `A stop hook asked you to continue: ${stop.blockReason ?? 'keep working.'}` }],
        });
        continue;
      }
      yield { type: 'turn_end', stopReason: ended.stopReason, text: lastText };
      return;
    }
  }

  /** Keeps what the user already saw. Tool calls and thinking from a broken stream are dropped. */
  private keepPartialText(text: string): void {
    if (text) this.append({ role: 'assistant', content: [{ type: 'text', text }] });
  }

  private closeOpenToolUses(toolUses: ToolUseBlock[], message: string): void {
    if (toolUses.length === 0) return;
    this.append({
      role: 'user',
      content: toolUses.map((use) => ({ type: 'tool_result', tool_use_id: use.id, content: message, is_error: true })),
    });
  }

  /**
   * Runs one batch of tool calls. Consecutive read-only calls run together, others run alone,
   * and `results` always ends up with one entry per call in the original order.
   */
  private async *executeTools(toolUses: ToolUseBlock[], signal: AbortSignal, results: ToolResultBlock[]): AsyncGenerator<AgentEvent> {
    const toolContext = this.skillContext(signal);
    const available = new Map(this.availableTools().map((tool) => [tool.name, tool]));

    let i = 0;
    while (i < toolUses.length) {
      if (signal.aborted) {
        for (const use of toolUses.slice(i)) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Interrupted by the user before this call ran.', is_error: true });
        }
        return;
      }
      const first = toolUses[i]!;
      const firstTool = available.get(first.name);
      const concurrent = firstTool !== undefined && validateInput(firstTool.inputSchema, first.input) === null && firstTool.isReadOnly(first.input);
      const batch: ToolUseBlock[] = [first];
      if (concurrent) {
        while (i + batch.length < toolUses.length) {
          const next = toolUses[i + batch.length]!;
          const tool = available.get(next.name);
          if (!tool || validateInput(tool.inputSchema, next.input) !== null || !tool.isReadOnly(next.input)) break;
          batch.push(next);
        }
      }
      i += batch.length;

      // Permission prompts are asked one at a time, before anything in the batch starts.
      const prepared = [];
      for (const use of batch) {
        yield { type: 'tool_start', id: use.id, name: use.name, input: use.input };
        const outcome = await this.prepareCall(use, available.get(use.name), toolContext);
        for (const notice of outcome.notices) yield { type: 'notice', level: 'warn', text: notice };
        prepared.push({ use, ...outcome });
      }

      const startedAt = Date.now();
      const outputs = await Promise.all(
        prepared.map(async (call) => {
          if (call.rejection !== undefined) return { content: call.rejection, isError: true, durationMs: 0 };
          const result = await this.runCall(call.use, call.tool!, call.input!, toolContext);
          // The note goes with this call's result, so the model reads it next to what it asked about.
          const content = call.note ? `${result.content}\n\nThe user approved this call and added: ${call.note}` : result.content;
          return { ...result, content, durationMs: Date.now() - startedAt };
        }),
      );

      for (const [index, call] of prepared.entries()) {
        const output = outputs[index]!;
        const block: ToolResultBlock = { type: 'tool_result', tool_use_id: call.use.id, content: output.content };
        if (output.isError) block.is_error = true;
        if ('attachments' in output && output.attachments) block.attachments = output.attachments;
        results.push(block);
        yield {
          type: 'tool_end',
          id: call.use.id,
          name: call.use.name,
          output: output.content,
          isError: output.isError ?? false,
          durationMs: output.durationMs,
          ...('display' in output && output.display ? { display: output.display } : {}),
        };
      }
    }
  }

  private async prepareCall(
    use: ToolUseBlock,
    tool: Tool | undefined,
    ctx: ToolContext,
  ): Promise<{ tool?: Tool; input?: Record<string, unknown>; rejection?: string; note?: string; notices: string[] }> {
    const notices: string[] = [];
    if (!tool) return { rejection: `No such tool: ${use.name}`, notices };

    const invalid = validateInput(tool.inputSchema, use.input);
    if (invalid) return { rejection: `Invalid input for ${use.name}: ${invalid}`, notices };

    const hook = await this.options.hooks.run(
      'PreToolUse',
      this.hookCommon(),
      { tool_name: use.name, tool_input: use.input, tool_use_id: use.id },
      ctx.signal,
    );
    notices.push(...hook.notices);
    if (hook.blocked) return { rejection: hook.blockReason ?? 'Blocked by a hook.', notices };
    if (hook.permission === 'deny') return { rejection: hook.permissionReason ?? 'Denied by a hook.', notices };

    // A hook may rewrite the input, which must then pass the same checks as the model's own.
    const input = hook.updatedInput ?? use.input;
    if (hook.updatedInput) {
      const invalidUpdate = validateInput(tool.inputSchema, input);
      if (invalidUpdate) return { rejection: `A hook produced invalid input: ${invalidUpdate}`, notices };
    }

    const verdict = hook.permission === 'allow' || hook.permission === 'ask' ? hook.permission : undefined;
    const decision = this.options.engine.check(use.name, tool.access(input, ctx), verdict);
    if (decision.behavior === 'deny') return { rejection: `Permission denied: ${decision.reason}`, notices };
    if (decision.behavior === 'ask') {
      const request = await this.options.hooks.run(
        'PermissionRequest',
        this.hookCommon(),
        { tool_name: use.name, tool_input: input, tool_use_id: use.id, reason: decision.reason },
        ctx.signal,
      );
      notices.push(...request.notices);
      const answered = request.requestDecision;
      if (answered?.behavior === 'deny') return { rejection: answered.message ?? 'A hook declined this call.', notices };
      // A forced prompt protects something an allow rule may not reach, so a hook cannot skip it.
      if (answered?.behavior === 'allow' && !decision.forced) {
        const replacement = answered.updatedInput ?? input;
        const invalidReplacement = validateInput(tool.inputSchema, replacement);
        if (invalidReplacement) return { rejection: `A hook produced invalid input: ${invalidReplacement}`, notices };
        return { tool, input: replacement, notices };
      }
      await this.options.hooks.run('Notification', this.hookCommon(), { notification_type: 'permission_prompt', message: decision.reason }, ctx.signal);
      const answer = await ctx.prompter.permission({
        toolName: use.name,
        input,
        reason: decision.reason,
        suggestions: decision.suggestions ?? [],
        forced: decision.forced ?? false,
      });
      if (answer.behavior === 'deny') {
        const feedback = answer.feedback ? ` The user said: ${answer.feedback}` : '';
        return { rejection: `The user declined this call.${feedback}`, notices };
      }
      const note = answer.feedback?.trim() ? { note: answer.feedback.trim() } : {};
      if (answer.updatedInput) {
        const invalidAnswer = validateInput(tool.inputSchema, answer.updatedInput);
        if (invalidAnswer) return { rejection: `The approval changed the input to something invalid: ${invalidAnswer}`, notices };
        return { tool, input: answer.updatedInput, notices, ...note };
      }
      if (answer.always && !decision.forced) {
        for (const suggestion of decision.suggestions ?? []) {
          this.options.engine.addRule(suggestion.rule, 'allow', suggestion.persist ? 'local' : 'session');
          this.options.onAlwaysAllow?.(suggestion.rule, suggestion.persist);
        }
      }
      return { tool, input, notices, ...note };
    }
    return { tool, input, notices };
  }

  private async runCall(
    use: ToolUseBlock,
    tool: Tool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutput> {
    // An abort listener never fires for a signal that has already aborted, so check first.
    if (ctx.signal.aborted) return { content: 'Interrupted by the user before this call ran.', isError: true };
    let output: ToolOutput;
    try {
      output = await tool.execute(input, ctx);
    } catch (error) {
      output = { content: `${use.name} failed: ${(error as Error).message}`, isError: true };
    }
    if (!output.isError && FILE_TOOLS.has(use.name)) {
      const access = tool.access(input, ctx);
      if (access.kind === 'read' || access.kind === 'edit') this.options.watcher?.touched(access.paths);
    }
    const cap = Math.max(MAX_TOOL_RESULT_CHARS, output.maxChars ?? 0);
    if (output.content.length > cap) {
      const omitted = output.content.length - cap;
      output = { ...output, content: `${output.content.slice(0, cap)}\n\n[Output truncated: ${omitted} more characters.]` };
    }

    const event = output.isError ? 'PostToolUseFailure' : 'PostToolUse';
    const post = await this.options.hooks.run(
      event,
      this.hookCommon(),
      { tool_name: use.name, tool_input: input, tool_use_id: use.id, tool_response: output.content },
      ctx.signal,
    );
    let content = post.updatedOutput ?? output.content;
    if (post.blocked && post.blockReason) content += `\n\nA hook reported: ${post.blockReason}`;
    for (const context of post.additionalContext) content += `\n\n<hook-context>\n${context}\n</hook-context>`;
    return { ...output, content };
  }
}
