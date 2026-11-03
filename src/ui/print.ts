/** Non-interactive mode: one prompt in, one result out, for scripts and pipelines. */
import { parseSlash, resolveExtensionCommand, settleCommand } from '../commands/slash.ts';
import type { AgentEvent } from '../core/agent.ts';
import type { ContentBlock, Message } from '../core/messages.ts';
import type { Runtime } from '../core/runtime.ts';
import type { SkillActivation } from '../skills/skills.ts';
import type { PermissionAnswer, PermissionPrompt, Prompter } from '../tools/types.ts';
import { sanitize } from './render.ts';

export type OutputFormat = 'text' | 'json' | 'stream-json';

/** Nobody is there to answer, so anything that would prompt is refused with a way forward. */
export class NonInteractivePrompter implements Prompter {
  async permission(prompt: PermissionPrompt): Promise<PermissionAnswer> {
    const hint = 'Pre-approve it with --allowedTools or a permissions.allow rule to run it without a prompt.';
    process.stderr.write(`Denied ${prompt.toolName}: ${sanitize(prompt.reason)}. ${hint}\n`);
    return { behavior: 'deny', feedback: 'This session is non-interactive, so nobody could approve the call.' };
  }

  async questions(): Promise<null> {
    return null;
  }

  async approvePlan(): Promise<boolean> {
    return false;
  }
}

/**
 * Lets an MCP tool answer permission prompts, for --permission-prompt-tool. It gets the call as
 * JSON and answers `{"behavior":"allow"}` or `{"behavior":"deny","message":"why"}`. Anything else
 * counts as a refusal.
 */
export class McpToolPrompter extends NonInteractivePrompter {
  private readonly runtime: Runtime;
  private readonly toolName: string;

  constructor(runtime: Runtime, toolName: string) {
    super();
    this.runtime = runtime;
    this.toolName = toolName;
  }

  override async permission(prompt: PermissionPrompt): Promise<PermissionAnswer> {
    const tool = this.runtime.mcp.tools().find((candidate) => candidate.name === this.toolName);
    if (!tool) return { behavior: 'deny', feedback: `The permission tool ${this.toolName} is not available.` };
    try {
      const signal = new AbortController().signal;
      const output = await tool.execute({ tool_name: prompt.toolName, input: prompt.input, reason: prompt.reason }, this.runtime.agent.skillContext(signal));
      const answer = JSON.parse(output.content) as { behavior?: string; message?: string; updatedInput?: Record<string, unknown> };
      if (!output.isError && answer.behavior === 'allow') return { behavior: 'allow', ...(answer.updatedInput ? { updatedInput: answer.updatedInput } : {}) };
      return { behavior: 'deny', feedback: answer.message ?? `${this.toolName} did not approve this call.` };
    } catch (error) {
      return { behavior: 'deny', feedback: `${this.toolName} gave no usable answer: ${(error as Error).message}` };
    }
  }
}

export interface PrintOptions {
  format: OutputFormat;
  /** Read prompts from stdin as JSON lines, one turn per line. */
  streamInput?: boolean;
  includePartialMessages?: boolean;
  replayUserMessages?: boolean;
  includeHookEvents?: boolean;
  /** The final answer should be JSON matching a schema, reported as structured_output. */
  structured?: boolean;
  verbose?: boolean;
}

/** Provider-specific blocks mean nothing to a reader, and attachments would flood the stream. */
function publicBlocks(blocks: ContentBlock[]): unknown[] {
  return blocks.flatMap((block) => {
    if (block.type === 'opaque') return [];
    if (block.type === 'tool_result' && block.attachments) {
      const { attachments, ...rest } = block;
      return [{ ...rest, attachment_count: attachments.length }];
    }
    return [block];
  });
}

function isTypedPrompt(message: Message): boolean {
  return message.role === 'user' && message.content.every((block) => block.type === 'text');
}

async function* readInputLines(): AsyncGenerator<string> {
  let buffered = '';
  for await (const chunk of process.stdin) {
    buffered += (chunk as Buffer).toString('utf8');
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield line;
    }
  }
  if (buffered.trim()) yield buffered.trim();
}

/** `{"type":"user","message":{"role":"user","content":"..."}}`, with text content only. */
export function promptFromInputLine(line: string): string | { error: string } {
  let parsed: { type?: string; message?: { content?: unknown } };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch (error) {
    return { error: `Input line is not JSON: ${(error as Error).message}` };
  }
  if (parsed.type !== 'user') return { error: `Expected a message of type "user", got ${JSON.stringify(parsed.type)}.` };
  const content = parsed.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks = content as { type?: string; text?: string }[];
    if (blocks.every((block) => block.type === 'text' && typeof block.text === 'string')) return blocks.map((block) => block.text).join('\n');
    return { error: 'Only text content is supported in input messages.' };
  }
  return { error: 'The input message has no content.' };
}

const RESULT_SUBTYPES: Record<string, string> = {
  error: 'error_during_execution',
  interrupted: 'error_during_execution',
  refusal: 'error_during_execution',
  max_turns: 'error_max_turns',
  max_budget: 'error_max_budget_usd',
};

export async function runPrint(runtime: Runtime, prompt: string, options: PrintOptions | OutputFormat): Promise<number> {
  const settings: PrintOptions = typeof options === 'string' ? { format: options } : options;
  const { format } = settings;
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (const warning of runtime.warnings) process.stderr.write(`Warning: ${warning}\n`);

  const emit = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const sessionId = (): string => runtime.agent.sessionId;

  if (settings.includeHookEvents && format === 'stream-json') {
    runtime.hooks.onActivity = (activity) => emit({ type: 'system', subtype: 'hook', hook_event: activity.event, handler: activity.handler, exit_code: activity.exitCode, duration_ms: activity.durationMs, session_id: sessionId() });
  }
  if (format === 'stream-json') {
    emit({
      type: 'system',
      subtype: 'init',
      session_id: sessionId(),
      model: runtime.agent.model,
      cwd: runtime.projectDir,
      permission_mode: runtime.engine.mode,
      tools: runtime.agent.toolDefinitions().map((tool) => tool.name),
      mcp_servers: runtime.mcp.states().map((state) => ({ name: state.name, status: state.status })),
      agents: runtime.agents.map((agent) => agent.name),
      skills: [...runtime.context.skillHost!.load().skills.keys()],
      plugins: runtime.plugins.map((plugin) => ({ name: plugin.name, path: plugin.root })),
    });
  }

  let emitted = runtime.agent.messages.length;
  const emitNewMessages = (): void => {
    for (; emitted < runtime.agent.messages.length; emitted++) {
      const message = runtime.agent.messages[emitted]!;
      if (isTypedPrompt(message) && !settings.replayUserMessages) continue;
      emit({ type: message.role, message: { role: message.role, content: publicBlocks(message.content) }, session_id: sessionId() });
    }
  };

  const runTurn = async (input: string): Promise<boolean> => {
    // `cairn -p "/review src/a.ts"` runs the skill. Built-in commands only make sense interactively.
    let text = input;
    let activation: SkillActivation | undefined;
    const slash = input.trimStart().startsWith('/') ? parseSlash(input) : null;
    const extension = slash ? resolveExtensionCommand(slash.name, slash.args, runtime) : null;
    if (extension) {
      const settled = await settleCommand(extension, controller.signal);
      if (settled.prompt === undefined) {
        process.stderr.write(`${sanitize(settled.output ?? 'The command produced nothing to do.')}\n`);
        return false;
      }
      text = settled.prompt;
      activation = settled.activation;
    }

    let last: Extract<AgentEvent, { type: 'turn_end' }> | undefined;
    let turns = 0;
    const started = Date.now();
    for await (const event of runtime.agent.run(text, controller.signal, activation)) {
      if (event.type === 'usage') turns++;
      if (event.type === 'turn_end') last = event;
      if (event.type === 'notice') process.stderr.write(`${sanitize(event.text)}\n`);
      if (settings.verbose && format === 'text' && event.type === 'tool_start') process.stderr.write(`[tool] ${sanitize(event.name)}\n`);
      if (format === 'stream-json') {
        emitNewMessages();
        if (settings.includePartialMessages && (event.type === 'text_delta' || event.type === 'thinking_delta')) {
          emit({ type: 'stream_event', event, session_id: sessionId() });
        }
      }
    }
    if (format === 'stream-json') emitNewMessages();

    const stopReason = last?.stopReason ?? 'error';
    const failed = stopReason in RESULT_SUBTYPES;
    const result = last?.text ?? '';
    let structured: unknown;
    let structureError: string | undefined;
    if (settings.structured && !failed) {
      try {
        structured = JSON.parse(result);
      } catch (error) {
        structureError = `The final answer is not valid JSON: ${(error as Error).message}`;
      }
    }
    const isError = failed || structureError !== undefined;
    const errorText = last?.error ?? structureError;
    const summary = {
      type: 'result',
      subtype: failed ? RESULT_SUBTYPES[stopReason] : structureError ? 'error_during_execution' : 'success',
      is_error: isError,
      stop_reason: stopReason,
      result,
      ...(errorText ? { error: errorText } : {}),
      ...(structured === undefined ? {} : { structured_output: structured }),
      session_id: sessionId(),
      num_turns: turns,
      duration_ms: Date.now() - started,
      usage: runtime.agent.totalUsage,
      // An estimate from list prices, and null when a model's price is not known.
      total_cost_usd: runtime.agent.costIsPartial ? null : runtime.agent.totalCostUsd,
    };
    if (format === 'text') {
      if (errorText) process.stderr.write(`Error: ${sanitize(errorText)}\n`);
      if (result) process.stdout.write(`${result}\n`);
    } else {
      emit(summary);
    }
    return !isError;
  };

  let succeeded = true;
  if (settings.streamInput) {
    for await (const line of readInputLines()) {
      const parsed = promptFromInputLine(line);
      if (typeof parsed !== 'string') {
        process.stderr.write(`${parsed.error}\n`);
        succeeded = false;
        continue;
      }
      succeeded = (await runTurn(parsed)) && succeeded;
      if (controller.signal.aborted) break;
    }
  } else {
    succeeded = await runTurn(prompt);
    // Commands left running in the background get to finish, up to their time limit.
    await runtime.context.tasks.waitForAll(controller.signal);
  }
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  return succeeded ? 0 : 1;
}
