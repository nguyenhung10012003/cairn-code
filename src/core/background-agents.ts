/**
 * Subagents that run in the background. Each keeps its conversation after it finishes, so a
 * later message resumes it with its context intact. Their reports reach the main conversation
 * as notifications.
 */
import { randomBytes } from 'node:crypto';
import type { Message, ToolUseBlock } from './messages.ts';
import { FORK_BOILERPLATE } from './prompts.ts';
import type { AgentControl, AgentSummary, SubagentRequest } from '../tools/types.ts';

/** One subagent, ready to run. Created by the runtime, which knows tools, prompts and models. */
export interface SubagentHandle {
  type: string;
  /** Runs one turn with this prompt, and resolves with its final text or why it failed. */
  run(prompt: string, signal: AbortSignal): Promise<{ text: string; failure?: string }>;
  /** Delivers a note that the agent sees at its next tool round. */
  note(text: string): void;
  /** Stops what it started and cleans up. Returns a line to add to its report, if any. */
  dispose(): string | undefined;
}

interface AgentRecord {
  id: string;
  description: string;
  handle: SubagentHandle;
  status: AgentSummary['status'];
  controller: AbortController;
}

export interface RegistryOptions {
  create(request: Omit<SubagentRequest, 'signal'>, id: string): Promise<SubagentHandle>;
  /** Puts a note into the main conversation and wakes it. */
  notifyMain(text: string): void;
  /** A one-line notice for the person at the terminal. */
  onNotice?(text: string): void;
}

function newAgentId(): string {
  return `a${randomBytes(3).toString('hex')}-${randomBytes(2).toString('hex')}`;
}

function agentMessage(from: string, message: string): string {
  return `<agent-message from="${from}">\n${message}\n</agent-message>`;
}

/**
 * The fork inherits the parent's history. The parent's last message holds the tool calls that
 * started it, which need results before anything else can follow.
 */
export function forkHistory(parent: Message[], directive: string): { history: Message[]; prompt: string } {
  const history = [...parent];
  const last = history.at(-1);
  const uses = last?.role === 'assistant' ? last.content.filter((block): block is ToolUseBlock => block.type === 'tool_use') : [];
  if (uses.length > 0) {
    history.push({
      role: 'user',
      content: uses.map((use) => ({
        type: 'tool_result' as const,
        tool_use_id: use.id,
        content: use.name === 'Agent' ? 'Fork started — that fork is you.' : 'This call runs in the parent, not in this fork.',
      })),
    });
  }
  return { history, prompt: `${FORK_BOILERPLATE}\nYour directive: ${directive}` };
}

export class AgentRegistry implements AgentControl {
  private readonly records = new Map<string, AgentRecord>();
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  async start(request: Omit<SubagentRequest, 'signal'>): Promise<string> {
    const id = newAgentId();
    const handle = await this.options.create(request, id);
    const record: AgentRecord = { id, description: request.description, handle, status: 'running', controller: new AbortController() };
    this.records.set(id, record);
    void this.drive(record, request.prompt);
    return id;
  }

  private async drive(record: AgentRecord, prompt: string): Promise<void> {
    let result: { text: string; failure?: string };
    try {
      result = await record.handle.run(prompt, record.controller.signal);
    } catch (error) {
      result = { text: '', failure: (error as Error).message };
    }
    const cleanup = record.handle.dispose();
    if (record.status === 'stopped') return;
    record.status = result.failure ? 'failed' : 'completed';
    const body = result.failure ? `Error: ${result.failure}${result.text ? `\n\n${result.text}` : ''}` : result.text || '(The agent finished without a final message.)';
    this.options.notifyMain(
      [
        '<task-notification>',
        `<task-id>${record.id}</task-id>`,
        `<status>${record.status}</status>`,
        `<summary>Agent "${record.description}" ${record.status}</summary>`,
        `<result>\n${body}${cleanup ? `\n\n${cleanup}` : ''}\n</result>`,
        '</task-notification>',
      ].join('\n'),
    );
    this.options.onNotice?.(`Agent "${record.description}" (${record.id}) ${record.status}.`);
  }

  private find(to: string): AgentRecord | undefined {
    const byId = this.records.get(to) ?? [...this.records.values()].find((record) => record.id.startsWith(to) && to.length >= 4);
    if (byId) return byId;
    const named = [...this.records.values()].filter((record) => record.description === to);
    // The newest of several with the same description, as with a name taken over by a newer agent.
    return named.at(-1);
  }

  async send(to: string, message: string, from: string): Promise<string> {
    if (to === 'main') {
      if (from === 'main') throw new Error('You are the main conversation. Write to the user directly instead.');
      this.options.notifyMain(agentMessage(from, message));
      return 'Message delivered to the main conversation.';
    }
    const record = this.find(to.replace(/\s*\[[^\]]*\]$/, ''));
    if (!record) {
      const known = [...this.records.values()].map((r) => r.id).join(', ') || 'none';
      throw new Error(`No agent named "${to}". Known agents: ${known}.`);
    }
    if (record.id === from) throw new Error('That is you.');
    if (record.status === 'running') {
      record.handle.note(agentMessage(from, message));
      return `Delivered to ${record.id}. It sees the message at its next tool round.`;
    }
    record.status = 'running';
    record.controller = new AbortController();
    void this.drive(record, agentMessage(from, message));
    return `Agent ${record.id} resumed with your message. You will be notified when it completes.`;
  }

  stop(idOrDescription: string): AgentSummary | undefined {
    const record = this.find(idOrDescription);
    if (!record) return undefined;
    if (record.status === 'running') {
      record.status = 'stopped';
      record.controller.abort();
    }
    return this.summary(record);
  }

  private summary(record: AgentRecord): AgentSummary {
    return { id: record.id, description: record.description, type: record.handle.type, status: record.status };
  }

  list(): AgentSummary[] {
    return [...this.records.values()].map((record) => this.summary(record));
  }

  running(): number {
    return [...this.records.values()].filter((record) => record.status === 'running').length;
  }

  stopAll(): void {
    for (const record of this.records.values()) {
      if (record.status === 'running') {
        record.status = 'stopped';
        record.controller.abort();
      }
    }
  }
}
