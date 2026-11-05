/**
 * Provider-neutral conversation model. Everything above the provider layer speaks
 * these types, so swapping API backends never touches the agent loop or the tools.
 */

export interface TextBlock {
  type: 'text';
  text: string;
  /** Provider fields that must be replayed unchanged, such as citations. */
  extra?: Record<string, unknown>;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** Something a tool shows the model that is not text: a picture or a PDF, base64-encoded. */
export interface Attachment {
  kind: 'image' | 'document';
  mediaType: string;
  data: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  attachments?: Attachment[];
}

/**
 * A provider-specific block (a thinking block, for example) that the agent does not
 * interpret but must replay unchanged on later requests.
 */
export interface OpaqueBlock {
  type: 'opaque';
  provider: string;
  data: unknown;
}

/** A picture the user attached to a message, base64-encoded. Only user messages carry these. */
export interface ImageBlock {
  type: 'image';
  mediaType: string;
  data: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | OpaqueBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other';

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
}

export function addUsage(total: Usage, delta: Usage): Usage {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheReadTokens: total.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + delta.cacheWriteTokens,
    webSearches: total.webSearches + delta.webSearches,
  };
}

/** Tokens the model actually had to read for a request, cached or not. */
export function contextTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/**
 * Tool_use blocks with no matching tool_result make a history the API rejects. This can
 * happen after a crash, so it runs on every resume. Results are appended, never edited in.
 */
export function danglingToolResults(messages: Message[]): ToolResultBlock[] {
  const resolved = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') resolved.add(block.tool_use_id);
    }
  }
  const dangling: ToolResultBlock[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && !resolved.has(block.id)) {
        dangling.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Tool call was interrupted before it returned a result.',
          is_error: true,
        });
      }
    }
  }
  return dangling;
}
