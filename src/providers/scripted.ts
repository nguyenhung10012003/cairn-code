/**
 * Plays back a fixed list of model responses and records what it was asked. Used by the tests
 * and for trying the UI without an API. It is not a real model and never pretends to be one.
 */
import { readFileSync } from 'node:fs';
import { emptyUsage } from '../core/messages.ts';
import type { ContentBlock, StopReason, Usage } from '../core/messages.ts';
import { ProviderError } from '../core/provider.ts';
import type { ModelProvider, ProviderRequest, StreamEvent } from '../core/provider.ts';

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

export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  readonly defaultModel = 'scripted';
  /** Plays a scripted turn for a web search, like any other request. */
  readonly serverTools = ['web_search' as const];
  readonly requests: Omit<ProviderRequest, 'signal'>[] = [];
  private readonly turns: ScriptedTurn[];
  private readonly window: number;
  private nextId = 1;

  constructor(turns: ScriptedTurn[], options: { contextWindow?: number } = {}) {
    this.turns = [...turns];
    this.window = options.contextWindow ?? 1_000_000;
  }

  static fromFile(path: string): ScriptedProvider {
    return new ScriptedProvider(JSON.parse(readFileSync(path, 'utf8')) as ScriptedTurn[]);
  }

  contextWindow(): number {
    return this.window;
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const { signal, ...rest } = request;
    this.requests.push(structuredClone(rest));
    const turn = this.turns.shift() ?? { text: '(scripted provider: no responses left)' };

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
}
