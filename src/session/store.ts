/**
 * Append-only JSONL transcripts, one file per session. Files are private to the user because
 * transcripts routinely contain file contents and command output.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sessionsDir } from '../config/paths.ts';
import { danglingToolResults } from '../core/messages.ts';
import type { Message } from '../core/messages.ts';
import type { SystemBlock } from '../core/provider.ts';

export type SessionRecord =
  | { type: 'meta'; ts: string; sessionId: string; cwd: string; model: string; forkedFrom?: string }
  | { type: 'system'; ts: string; system: SystemBlock[] }
  | { type: 'message'; ts: string; message: Message }
  | { type: 'compaction'; ts: string; summary: string }
  | { type: 'name'; ts: string; name: string }
  | { type: 'title'; ts: string; title: string };

export interface SessionSummary {
  id: string;
  path: string;
  modifiedAt: Date;
  /** The first thing the user typed, for the resume list. */
  preview: string;
  /** Set with --name or /rename. */
  name?: string;
  /** A generated description of what the session is about. */
  title?: string;
}

export class SessionStore {
  readonly id: string;
  readonly path: string | null;

  private constructor(id: string, path: string | null) {
    this.id = id;
    this.path = path;
  }

  /** A store that keeps nothing on disk, for --no-session-persistence and subagents. */
  static ephemeral(): SessionStore {
    return new SessionStore(randomUUID(), null);
  }

  static create(cwd: string, model: string, id: string = randomUUID(), forkedFrom?: string): SessionStore {
    const dir = sessionsDir(cwd);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = new SessionStore(id, join(dir, `${id}.jsonl`));
    const meta: SessionRecord = {
      type: 'meta',
      ts: new Date().toISOString(),
      sessionId: id,
      cwd,
      model,
      ...(forkedFrom === undefined ? {} : { forkedFrom }),
    };
    store.append(meta);
    return store;
  }

  /** Reopens an existing transcript so new messages extend it under the same id. */
  static open(cwd: string, id: string): SessionStore | null {
    const path = join(sessionsDir(cwd), `${id}.jsonl`);
    return existsSync(path) ? new SessionStore(id, path) : null;
  }

  private append(record: SessionRecord): void {
    if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }

  /**
   * Records the system prompt the conversation started with. A resume must send these exact
   * bytes: the environment section would differ if rebuilt, and the API ties thinking blocks to
   * the system prompt they were produced under.
   */
  appendSystem(system: SystemBlock[]): void {
    this.append({ type: 'system', ts: new Date().toISOString(), system });
  }

  appendMessage(message: Message): void {
    this.append({ type: 'message', ts: new Date().toISOString(), message });
  }

  appendName(name: string): void {
    this.append({ type: 'name', ts: new Date().toISOString(), name });
  }

  appendTitle(title: string): void {
    this.append({ type: 'title', ts: new Date().toISOString(), title });
  }

  appendCompaction(summary: string): void {
    this.append({ type: 'compaction', ts: new Date().toISOString(), summary });
  }
}

function parseRecords(path: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SessionRecord);
    } catch {
      // A crash can leave a partial final line. Everything before it is still good.
    }
  }
  return records;
}

export interface RestoredHistory {
  messages: Message[];
  /** Tool results synthesized for calls that never returned. Not yet on disk. */
  repairs: Message | null;
  /** The system prompt recorded for this conversation. */
  system?: SystemBlock[];
}

export function restoreHistory(cwd: string, id: string): RestoredHistory | null {
  const path = join(sessionsDir(cwd), `${id}.jsonl`);
  if (!existsSync(path)) return null;
  let messages: Message[] = [];
  let system: SystemBlock[] | undefined;
  for (const record of parseRecords(path)) {
    if (record.type === 'message') {
      messages.push(record.message);
    } else if (record.type === 'system') {
      system = record.system;
    } else if (record.type === 'compaction') {
      messages = [{ role: 'user', content: [{ type: 'text', text: record.summary }] }];
    }
  }
  const dangling = danglingToolResults(messages);
  const repairs: Message | null = dangling.length > 0 ? { role: 'user', content: dangling } : null;
  if (repairs) messages.push(repairs);
  return { messages, repairs, ...(system ? { system } : {}) };
}

export function listSessions(cwd: string): SessionSummary[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) return [];
  const summaries: SessionSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const path = join(dir, file);
    let preview = '';
    let name: string | undefined;
    let hasMessages = false;
    for (const record of parseRecords(path)) {
      if (record.type === 'name') name = record.name;
      if (record.type !== 'message') continue;
      hasMessages = true;
      if (!preview && record.message.role === 'user') {
        const text = record.message.content.find((b) => b.type === 'text');
        if (text?.type === 'text') preview = text.text.replace(/\s+/g, ' ').slice(0, 80);
      }
    }
    // Opening the app and leaving at once must not hide real work from --continue.
    if (!hasMessages) continue;
    summaries.push({ id: file.replace(/\.jsonl$/, ''), path, modifiedAt: statSync(path).mtime, preview, ...(name ? { name } : {}) });
  }
  return summaries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

/** `--resume` takes an id, or the name given with --name or /rename. The latest match wins. */
export function resolveSessionId(cwd: string, idOrName: string): string {
  return listSessions(cwd).find((session) => session.name === idOrName)?.id ?? idOrName;
}
