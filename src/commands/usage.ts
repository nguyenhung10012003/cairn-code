/** `cairn usage` and `/usage <report>`: saved tokens and estimated cost, per day, project or session. */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP_NAME } from '../config/paths.ts';
import { groupUsage, isDay, loadUsage, localDay, totalsOf, totalTokens, withinDays } from '../session/usage.ts';
import type { UsageReportKind, UsageRow, UsageTotals } from '../session/usage.ts';
import { sanitize } from '../ui/render.ts';

export const USAGE_HELP = `Usage: ${APP_NAME} usage [daily|projects|sessions] [options]

Tokens and estimated cost from saved sessions: per day (the default), per project, or per session.

Options:
  --project <path>   Only sessions that ran in this directory, such as --project .
  --since <date>     From this day on, as YYYY-MM-DD in local time
  --until <date>     Up to and including this day
  --json             Print JSON instead of a table

TOKENS counts input, output and cache tokens together. Costs are estimates at list prices;
your actual bill is what the provider's console shows. Sessions run with
--no-session-persistence are not saved, so they are not counted.
`;

const REPORTS: Record<string, UsageReportKind> = {
  daily: 'daily',
  day: 'daily',
  projects: 'projects',
  project: 'projects',
  sessions: 'sessions',
  session: 'sessions',
};

export interface UsageQuery {
  kind: UsageReportKind;
  project?: string;
  since?: string;
  until?: string;
  json: boolean;
}

/** Throws with a message for the user when the arguments make no sense. */
export function parseUsageArgs(argv: string[], cwd: string): UsageQuery {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (positionals.length > 1) throw new Error(`Expected one report, not "${positionals.join(' ')}".`);
  const name = positionals[0] ?? 'daily';
  const kind = REPORTS[name];
  if (!kind) throw new Error(`Unknown report "${name}". Choose daily, projects or sessions.`);
  for (const [flag, value] of [['--since', values.since], ['--until', values.until]] as const) {
    if (value !== undefined && !isDay(value)) throw new Error(`${flag} takes a date as YYYY-MM-DD, not "${value}".`);
  }
  if (values.since && values.until && values.since > values.until) throw new Error('--since is after --until.');
  let project: string | undefined;
  if (values.project !== undefined) {
    const path = resolve(cwd, values.project);
    // Sessions are filed under the real path, as the app saw it when they ran.
    project = existsSync(path) ? realpathSync(path) : path;
  }
  return {
    kind,
    json: values.json === true,
    ...(project === undefined ? {} : { project }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(values.until === undefined ? {} : { until: values.until }),
  };
}

/** 950, 12.3k, 4.1M, 2.5B. */
function shortCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${(count / 1_000_000_000).toFixed(1)}B`;
}

function money(totals: UsageTotals): string {
  return `$${totals.costUsd.toFixed(2)}${totals.costIsPartial ? '+' : ''}`;
}

function minute(date: Date): string {
  return `${localDay(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function shortPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function oneLine(text: string, max: number): string {
  const flat = sanitize(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface Column {
  title: string;
  right?: boolean;
}

/** Two spaces between columns. The last column is not padded, so long names do not add trailing space. */
function renderTable(columns: Column[], rows: string[][]): string[] {
  const widths = columns.map((column, i) => Math.max(column.title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]): string =>
    `  ${cells.map((cell, i) => (columns[i]!.right ? cell.padStart(widths[i]!) : i === cells.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')}`.trimEnd();
  return [line(columns.map((column) => column.title)), ...rows.map(line)];
}

const SPLIT: Column[] = [
  { title: 'INPUT', right: true },
  { title: 'OUTPUT', right: true },
  { title: 'CACHE READ', right: true },
  { title: 'CACHE WRITE', right: true },
  { title: 'COST', right: true },
];

function splitCells(totals: UsageTotals): string[] {
  const { usage } = totals;
  return [shortCount(usage.inputTokens), shortCount(usage.outputTokens), shortCount(usage.cacheReadTokens), shortCount(usage.cacheWriteTokens), money(totals)];
}

function table(kind: UsageReportKind, rows: UsageRow[], total: UsageTotals, sessionCount: number): string[] {
  if (kind === 'daily') {
    return renderTable(
      [{ title: 'DATE' }, { title: 'SESSIONS', right: true }, ...SPLIT],
      [
        ...rows.map((row) => [row.key, String(row.sessionCount), ...splitCells(row.totals)]),
        ['Total', String(sessionCount), ...splitCells(total)],
      ],
    );
  }
  if (kind === 'projects') {
    return renderTable(
      [{ title: 'LAST USED' }, { title: 'SESSIONS', right: true }, ...SPLIT, { title: 'PROJECT' }],
      [
        ...rows.map((row) => [localDay(row.lastAt), String(row.sessionCount), ...splitCells(row.totals), sanitize(shortPath(row.key))]),
        ['Total', String(sessionCount), ...splitCells(total), ''],
      ],
    );
  }
  return renderTable(
    [{ title: 'LAST USED' }, { title: 'SESSION' }, { title: 'TOKENS', right: true }, { title: 'COST', right: true }, { title: 'PROJECT' }, { title: 'NAME' }],
    [
      ...rows.map((row) => [
        minute(row.lastAt),
        row.key.slice(0, 8),
        shortCount(totalTokens(row.totals.usage)),
        money(row.totals),
        sanitize(shortPath(row.session?.project ?? '')),
        oneLine(row.session?.name ?? row.session?.title ?? '', 60),
      ]),
      ['Total', '', shortCount(totalTokens(total.usage)), money(total), '', ''],
    ],
  );
}

function spending(totals: UsageTotals): Record<string, unknown> {
  return { usage: totals.usage, total_tokens: totalTokens(totals.usage), cost_usd: totals.costUsd, cost_is_partial: totals.costIsPartial };
}

function jsonRow(kind: UsageReportKind, row: UsageRow): Record<string, unknown> {
  if (kind === 'daily') return { date: row.key, sessions: row.sessionCount, ...spending(row.totals) };
  const times = { first_used: row.firstAt.toISOString(), last_used: row.lastAt.toISOString() };
  if (kind === 'projects') return { project: row.key, sessions: row.sessionCount, ...times, ...spending(row.totals) };
  const session = row.session;
  return {
    session_id: row.key,
    project: session?.project ?? '',
    ...(session?.name ? { name: session.name } : {}),
    ...(session?.title ? { title: session.title } : {}),
    ...times,
    ...spending(row.totals),
  };
}

const HEADINGS: Record<UsageReportKind, string> = { daily: 'Per day', projects: 'Per project', sessions: 'Per session' };

export function usageReport(query: UsageQuery): string {
  const sessions = withinDays(loadUsage(query.project), query.since, query.until);
  const rows = groupUsage(sessions, query.kind);
  const total = totalsOf(sessions.flatMap((session) => session.entries));
  if (query.json) {
    return JSON.stringify(
      {
        report: query.kind,
        ...(query.project === undefined ? {} : { project: query.project }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.until === undefined ? {} : { until: query.until }),
        rows: rows.map((row) => jsonRow(query.kind, row)),
        total: { sessions: sessions.length, ...spending(total) },
      },
      null,
      2,
    );
  }
  const where = query.project === undefined ? '' : ` in ${sanitize(shortPath(query.project))}`;
  const when = [query.since ? ` from ${query.since}` : '', query.until ? ` to ${query.until}` : ''].join('');
  if (rows.length === 0) return `No usage recorded${where}${when}.`;
  const everywhere = query.project === undefined && query.kind !== 'projects' ? ', all projects' : '';
  const lines = [`${HEADINGS[query.kind]}${everywhere}${where}${when}:`, '', ...table(query.kind, rows, total, sessions.length), ''];
  if (total.costIsPartial) lines.push('+ Some of it ran on a model with no known price, so the cost is a lower bound.');
  lines.push('Costs are estimates at list prices.');
  return lines.join('\n');
}

export function runUsageCommand(argv: string[], cwd: string): number {
  if (argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE_HELP);
    return 0;
  }
  let query: UsageQuery;
  try {
    query = parseUsageArgs(argv, cwd);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE_HELP}`);
    return 2;
  }
  process.stdout.write(`${usageReport(query)}\n`);
  return 0;
}
