/**
 * Usage reports, read from the `usage` records that transcripts keep. Transcripts written before
 * those records existed have none, so what they spent is not counted.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appHome, sessionsDir } from '../config/paths.ts';
import { addUsage, contextTokens, emptyUsage } from '../core/messages.ts';
import type { Usage } from '../core/messages.ts';

export interface UsageEntry {
  at: Date;
  provider: string;
  model: string;
  usage: Usage;
  /** Null when the model had no known price. */
  costUsd: number | null;
}

export interface SessionUsage {
  id: string;
  /** The directory the session ran in. */
  project: string;
  name?: string;
  title?: string;
  entries: UsageEntry[];
}

export interface UsageTotals {
  usage: Usage;
  costUsd: number;
  /** Some of it ran on a model with no known price, so `costUsd` is a lower bound. */
  costIsPartial: boolean;
}

export type UsageReportKind = 'daily' | 'projects' | 'sessions';

export interface UsageRow {
  /** The day as YYYY-MM-DD, the project directory, or the session id. */
  key: string;
  sessionCount: number;
  firstAt: Date;
  lastAt: Date;
  totals: UsageTotals;
  /** For a row per session. */
  session?: SessionUsage;
}

/**
 * Only lines that start like these are parsed: records are written with `type` first, and the
 * message records, which hold file contents and command output, are by far the largest.
 */
const WANTED = ['{"type":"usage"', '{"type":"meta"', '{"type":"name"', '{"type":"title"'];

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageOf(value: unknown): Usage {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    inputTokens: tokens(raw.inputTokens),
    outputTokens: tokens(raw.outputTokens),
    cacheReadTokens: tokens(raw.cacheReadTokens),
    cacheWriteTokens: tokens(raw.cacheWriteTokens),
    webSearches: tokens(raw.webSearches),
  };
}

/** Null when the file cannot be read. A line that does not parse, such as one cut off by a crash, is skipped. */
export function readSessionUsage(path: string, fallbackProject = ''): SessionUsage | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const session: SessionUsage = { id: basename(path, '.jsonl'), project: fallbackProject, entries: [] };
  for (const line of text.split('\n')) {
    if (!WANTED.some((prefix) => line.startsWith(prefix))) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === 'meta' && typeof record.cwd === 'string') {
      session.project = record.cwd;
    } else if (record.type === 'name' && typeof record.name === 'string') {
      session.name = record.name;
    } else if (record.type === 'title' && typeof record.title === 'string') {
      session.title = record.title;
    } else if (record.type === 'usage') {
      const at = new Date(typeof record.ts === 'string' ? record.ts : Number.NaN);
      if (Number.isNaN(at.getTime())) continue;
      session.entries.push({
        at,
        provider: typeof record.provider === 'string' ? record.provider : '',
        model: typeof record.model === 'string' ? record.model : '',
        usage: usageOf(record.usage),
        costUsd: typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) ? record.costUsd : null,
      });
    }
  }
  return session;
}

function projectDirs(): string[] {
  const root = join(appHome(), 'projects');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

/** Every saved session that recorded usage, in one project or in all of them. */
export function loadUsage(project?: string): SessionUsage[] {
  const dirs = project === undefined ? projectDirs() : [sessionsDir(project)];
  const sessions: SessionUsage[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const session = readSessionUsage(join(dir, file), project ?? basename(dir));
      if (session && session.entries.length > 0) sessions.push(session);
    }
  }
  return sessions;
}

/** YYYY-MM-DD in local time. */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** True for a real date written as YYYY-MM-DD. */
export function isDay(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && localDay(new Date(`${text}T00:00:00`)) === text;
}

/** Keeps the entries from `since` to `until`, both days included, and the sessions that still have any. */
export function withinDays(sessions: SessionUsage[], since?: string, until?: string): SessionUsage[] {
  if (since === undefined && until === undefined) return sessions;
  return sessions.flatMap((session) => {
    const entries = session.entries.filter((entry) => {
      const day = localDay(entry.at);
      return (since === undefined || day >= since) && (until === undefined || day <= until);
    });
    return entries.length > 0 ? [{ ...session, entries }] : [];
  });
}

export function totalsOf(entries: UsageEntry[]): UsageTotals {
  let usage = emptyUsage();
  let costUsd = 0;
  let costIsPartial = false;
  for (const entry of entries) {
    usage = addUsage(usage, entry.usage);
    if (entry.costUsd === null) costIsPartial = true;
    else costUsd += entry.costUsd;
  }
  return { usage, costUsd, costIsPartial };
}

/** Input, output and cache tokens together, as the status line counts them. */
export function totalTokens(usage: Usage): number {
  return contextTokens(usage) + usage.outputTokens;
}

/**
 * One row per day, oldest first; per project, most spent first; or per session, most recently
 * used last.
 */
export function groupUsage(sessions: SessionUsage[], by: UsageReportKind): UsageRow[] {
  interface Group {
    entries: UsageEntry[];
    sessionIds: Set<string>;
    first: number;
    last: number;
    session?: SessionUsage;
  }
  const groups = new Map<string, Group>();
  for (const session of sessions) {
    for (const entry of session.entries) {
      const key = by === 'daily' ? localDay(entry.at) : by === 'projects' ? session.project : session.id;
      const time = entry.at.getTime();
      let group = groups.get(key);
      if (!group) {
        group = { entries: [], sessionIds: new Set(), first: time, last: time, ...(by === 'sessions' ? { session } : {}) };
        groups.set(key, group);
      }
      group.entries.push(entry);
      group.sessionIds.add(session.id);
      group.first = Math.min(group.first, time);
      group.last = Math.max(group.last, time);
    }
  }
  const rows = [...groups].map(([key, group]): UsageRow => ({
    key,
    sessionCount: group.sessionIds.size,
    firstAt: new Date(group.first),
    lastAt: new Date(group.last),
    totals: totalsOf(group.entries),
    ...(group.session ? { session: group.session } : {}),
  }));
  if (by === 'daily') return rows.sort((a, b) => a.key.localeCompare(b.key));
  if (by === 'projects') return rows.sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.lastAt.getTime() - a.lastAt.getTime());
  return rows.sort((a, b) => a.lastAt.getTime() - b.lastAt.getTime());
}

/** What a transcript has recorded over every run of it, or null when it has recorded nothing. */
export function sessionTotals(path: string | null): UsageTotals | null {
  if (!path) return null;
  const session = readSessionUsage(path);
  return session && session.entries.length > 0 ? totalsOf(session.entries) : null;
}
