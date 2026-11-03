/**
 * Replays model responses from a script and records what it was asked. It is not a real model
 * and never pretends to be one.
 *
 * A script is either a list of responses, played in order to every request (the tests use this),
 * or a set of rules matched against what the user typed, for trying Cairn by hand.
 */
import { readFileSync } from 'node:fs';
import { SUMMARIZER_SYSTEM } from '../core/compaction.ts';
import { emptyUsage, textOf } from '../core/messages.ts';
import type { ContentBlock, Message, StopReason, Usage } from '../core/messages.ts';
import { ProviderError } from '../core/provider.ts';
import type { ModelProvider, ProviderRequest, StreamEvent } from '../core/provider.ts';
import demoScript from './mock-demo.json' with { type: 'json' };

export interface ScriptedTurn {
  thinking?: string;
  serverTool?: { name: string; summary?: string };
  text?: string;
  toolCalls?: { name: string; input: Record<string, unknown>; id?: string }[];
  stopReason?: StopReason;
  stopDetail?: string;
  usage?: Partial<Usage>;
  costUsd?: number;
  servedBy?: string;
  notices?: string[];
  /** Throw this message instead of responding. */
  error?: string;
  /** The HTTP status that error stands for. */
  errorStatus?: number;
  /** Wait before responding, so tests can interrupt mid-request. */
  delayMs?: number;
}

/** Answers a prompt that matches it. */
export interface MockRule {
  /** Matches a prompt containing this text, ignoring case. */
  match?: string;
  /** Matches a prompt this regular expression finds, ignoring case. Its groups fill {{1}}, {{2}} and so on. */
  regex?: string;
  /** One response per request: the first answers the prompt, each later one the previous step's tool results. */
  steps: ScriptedTurn[];
}

export interface MockScript {
  rules: MockRule[];
  /** The response when no rule matches. */
  fallback?: ScriptedTurn;
}

const MAX_RESULT_CHARS = 2_000;

interface CompiledRule {
  test: (prompt: string) => string[] | null;
  steps: ScriptedTurn[];
}

/** Checks a script's shape, so a mistake shows up at startup rather than as a strange reply. */
function compileRules(script: MockScript): CompiledRule[] {
  if (!Array.isArray(script.rules)) throw new Error('a rules script needs a "rules" list');
  return script.rules.map((rule, i) => {
    const where = `rule ${i + 1}`;
    if (!Array.isArray(rule.steps) || rule.steps.length === 0) throw new Error(`${where} needs a non-empty "steps" list`);
    if (typeof rule.regex === 'string') {
      let pattern: RegExp;
      try {
        pattern = new RegExp(rule.regex, 'i');
      } catch (error) {
        throw new Error(`${where} has an invalid regex: ${(error as Error).message}`);
      }
      return { test: (prompt) => pattern.exec(prompt), steps: rule.steps };
    }
    if (typeof rule.match === 'string') {
      const needle = rule.match.toLowerCase();
      return { test: (prompt) => (prompt.toLowerCase().includes(needle) ? [prompt] : null), steps: rule.steps };
    }
    throw new Error(`${where} needs "match" or "regex"`);
  });
}

/** Replaces {{name}} in every string of a step. Unknown names stay as written. */
function fill<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => vars[name] ?? whole) as T;
  if (Array.isArray(value)) return value.map((item) => fill(item, vars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)])) as T;
  }
  return value;
}

const isPrompt = (message: Message): boolean => message.role === 'user' && !message.content.some((block) => block.type === 'tool_result');

export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly defaultModel = 'scripted';
  /** Plays a scripted turn for a web search, like any other request. */
  readonly serverTools = ['web_search' as const];
  readonly requests: Omit<ProviderRequest, 'signal'>[] = [];
  private readonly turns: ScriptedTurn[];
  private readonly rules: CompiledRule[] | null;
  private readonly fallback: ScriptedTurn;
  private readonly warning: string | undefined;
  private readonly window: number;
  private nextId = 1;

  constructor(script: ScriptedTurn[] | MockScript, options: { contextWindow?: number; warning?: string } = {}) {
    if (Array.isArray(script)) {
      this.turns = [...script];
      this.rules = null;
      this.fallback = { text: '(scripted provider: no responses left)' };
    } else {
      this.turns = [];
      this.rules = compileRules(script);
      this.fallback = script.fallback ?? { text: '(mock) No rule matches "{{prompt}}".' };
    }
    this.window = options.contextWindow ?? 1_000_000;
    this.warning = options.warning;
  }

  static fromFile(path: string): ScriptedProvider {
    return new ScriptedProvider(JSON.parse(readFileSync(path, 'utf8')) as ScriptedTurn[] | MockScript);
  }

  /** The rules in mock-demo.json, for when no script is given. */
  static demo(): ScriptedProvider {
    return new ScriptedProvider(demoScript as MockScript, {
      warning: 'Replies come from the built-in mock script, not a model. Type "help" to see what it does, or set CAIRN_SCRIPT to use your own.',
    });
  }

  contextWindow(): number {
    return this.window;
  }

  configurationWarning(): string | undefined {
    return this.warning;
  }

  async listModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const { signal, ...rest } = request;
    this.requests.push(structuredClone(rest));
    const turn = this.rules ? this.ruleTurn(request) : (this.turns.shift() ?? this.fallback);

    if (turn.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, turn.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new ProviderError('aborted'));
        }, { once: true });
      });
    }
    if (turn.error) throw new ProviderError(turn.error, turn.errorStatus === undefined ? {} : { status: turn.errorStatus });

    const content: ContentBlock[] = [];
    if (turn.thinking) yield { type: 'thinking_delta', text: turn.thinking };
    if (turn.serverTool) yield { type: 'server_tool', ...turn.serverTool };
    if (turn.text) {
      for (const piece of turn.text.match(/\S+\s*|\s+/g) ?? []) yield { type: 'text_delta', text: piece };
      content.push({ type: 'text', text: turn.text });
    }
    for (const call of turn.toolCalls ?? []) {
      const id = call.id ?? `toolu_${this.nextId++}`;
      yield { type: 'tool_use_start', id, name: call.name };
      content.push({ type: 'tool_use', id, name: call.name, input: call.input });
    }
    const stopReason = turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn');
    const event: StreamEvent = {
      type: 'message_end',
      content,
      stopReason,
      usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5, ...turn.usage },
      ...(turn.stopDetail ? { stopDetail: turn.stopDetail } : {}),
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      ...(turn.servedBy ? { servedBy: turn.servedBy } : {}),
      ...(turn.notices ? { notices: turn.notices } : {}),
    };
    yield event;
  }

  /**
   * Works out the reply from the conversation alone, so the main agent and its subagents can
   * share one provider: the prompt is the latest user message without tool results, and the
   * step is how many replies have followed it.
   */
  private ruleTurn(request: ProviderRequest): ScriptedTurn {
    // Requests Cairn makes for itself, which no rule is written for.
    if (request.system[0]?.text === SUMMARIZER_SYSTEM) {
      return { text: `<summary>(mock) A summary of ${request.messages.length} message(s) would go here.</summary>` };
    }
    if (request.system.length === 0) {
      // Session titles and /rename ask for one JSON field; one reply serves both.
      const asked = textOf(request.messages.at(-1)?.content ?? []);
      if (asked.includes('Return JSON')) return { text: '{"title": "Mock session", "name": "mock-session"}' };
      return { text: '(mock) The answer to a side question would go here.' };
    }

    const messages = request.messages;
    let start = messages.length - 1;
    while (start > 0 && !isPrompt(messages[start]!)) start--;
    const promptBlock = messages[start]?.content.find((block) => block.type === 'text');
    const prompt = promptBlock?.type === 'text' ? promptBlock.text.trim() : '';
    const step = messages.slice(start + 1).filter((message) => message.role === 'assistant').length;
    const last = messages.at(-1);
    const result = start === messages.length - 1 || !last
      ? ''
      : last.content.flatMap((block) => (block.type === 'tool_result' ? [block.content] : [])).join('\n').slice(0, MAX_RESULT_CHARS);

    for (const rule of this.rules!) {
      const groups = rule.test(prompt);
      if (!groups) continue;
      const vars: Record<string, string> = { prompt, result };
      groups.forEach((group, i) => {
        if (i > 0) vars[String(i)] = group ?? '';
      });
      const turn = rule.steps[step];
      return turn ? fill(turn, vars) : { text: '(mock) This rule has no more steps.' };
    }
    return step === 0 ? fill(this.fallback, { prompt, result }) : { text: '(mock) No rule matched, so there is nothing more to do.' };
  }
}
