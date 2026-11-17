/**
 * The points /rewind can go back to: each message that started a turn, newest last. A turn's
 * checkpoint number is counted from the end, since the history may have been compacted or resumed
 * and only its last turns are still in it.
 */
import { STOP_HOOK_CONTINUE } from '../core/agent.ts';
import { COMPACTED_HISTORY_START } from '../core/compaction.ts';
import type { Message } from '../core/messages.ts';

export interface PromptPoint {
  /** Where the message is in the history; going back to it keeps the messages before it. */
  index: number;
  /** What was typed, without the notes Karst adds to it. */
  text: string;
  /** How many turns, this one included, began at or after it. */
  turnsSince: number;
}

/** A message that began a turn: from the user or a background notice, not a tool result, stop hook or summary. */
function startsTurn(message: Message): boolean {
  if (message.role !== 'user' || message.content.some((block) => block.type === 'tool_result')) return false;
  const first = message.content.find((block) => block.type === 'text');
  if (!first || first.type !== 'text') return message.content.some((block) => block.type === 'image');
  return !first.text.startsWith(STOP_HOOK_CONTINUE) && !first.text.startsWith(COMPACTED_HISTORY_START);
}

function typedText(message: Message): string {
  const texts = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  // Hook context and reminders follow what was typed, in tags of their own.
  const typed = texts.find((text) => !/^<(system-reminder|hook-context)>/.test(text)) ?? texts[0] ?? '';
  return message.content.some((block) => block.type === 'image') && !typed ? '[image]' : typed;
}

export function promptPoints(messages: readonly Message[]): PromptPoint[] {
  const points = messages.flatMap((message, index) => (startsTurn(message) ? [{ index, text: typedText(message) }] : []));
  return points.map((point, i) => ({ ...point, turnsSince: points.length - i }));
}
