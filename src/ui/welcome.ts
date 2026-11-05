/**
 * The panel at the top of an interactive session: the model, where it runs, the session, the
 * permission mode and what was loaded, with a few keys to know. Drawn at the start, and again
 * after /clear.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { relative } from 'node:path';
import { APP_DISPLAY_NAME, VERSION } from '../config/paths.ts';
import type { InstructionFile } from '../core/instructions.ts';
import type { Runtime } from '../core/runtime.ts';
import { clipToWidth, displayWidth, sanitize, style, tailToWidth, wrapToWidth } from './render.ts';

export interface WelcomeRow {
  label: string;
  value: string;
  /** Cut from the start when it does not fit, as for a path, whose end says the most. */
  fromStart?: boolean;
}

const TIPS = ['/help for commands', '/usage for costs', 'Shift+Tab to change mode', 'Ctrl+V to paste an image', '/clear to start over'];
/** Below this, the panel is plain lines rather than a box. */
const MIN_BOX_WIDTH = 44;
const MAX_INNER_WIDTH = 96;
const MAX_INSTRUCTION_FILES = 3;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function shortPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** 200k, 1M. */
function windowSize(tokens: number): string {
  return tokens >= 1_000_000 ? `${Number((tokens / 1_000_000).toFixed(1))}M` : `${Math.round(tokens / 1_000)}k`;
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/** The branch, or the commit when none is checked out. Null outside a repository. */
function gitHead(cwd: string): string | null {
  // symbolic-ref also answers in a repository with no commits yet.
  const branch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch) return branch;
  const commit = git(cwd, ['rev-parse', '--short', 'HEAD']);
  return commit ? `detached at ${commit}` : null;
}

/** Instruction files by the shortest name that tells them apart: relative inside the directory, ~/ outside it. */
function instructionNames(files: InstructionFile[], cwd: string): string[] {
  const names = files.map((file) => {
    const inside = relative(cwd, file.path);
    return inside && !inside.startsWith('..') ? inside : shortPath(file.path);
  });
  if (names.length <= MAX_INSTRUCTION_FILES) return names;
  return [...names.slice(0, MAX_INSTRUCTION_FILES), `${names.length - MAX_INSTRUCTION_FILES} more instruction files`];
}

export function welcomeRows(runtime: Runtime): WelcomeRow[] {
  const cwd = runtime.context.cwd();
  const head = gitHead(cwd);
  const trust = runtime.trusted ? ['trusted'] : runtime.settings.needsTrust ? ['not trusted, so its settings are off (/trust)'] : [];
  const messages = runtime.agent.messages.length;
  const servers = runtime.mcp.states();
  const connected = servers.filter((state) => state.status === 'connected').length;
  const skills = runtime.context.skillHost?.load().skills.size ?? 0;
  const loaded = [
    ...instructionNames(runtime.instructions, cwd),
    ...(servers.length > 0 ? [`${plural(servers.length, 'MCP server')}${connected < servers.length ? ` (${connected} connected)` : ''}`] : []),
    ...(skills > 0 ? [plural(skills, 'skill')] : []),
    ...(runtime.plugins.length > 0 ? [plural(runtime.plugins.length, 'plugin')] : []),
  ];
  const rows: WelcomeRow[] = [
    {
      label: 'Model',
      value: [runtime.agent.model, runtime.providerName, `effort ${runtime.agent.effort ?? 'default'}`, `${windowSize(runtime.provider.contextWindow(runtime.agent.model))} context`].join(' · '),
    },
    { label: 'Directory', value: [shortPath(cwd), ...(head ? [`git ${head}`] : []), ...trust].join(' · '), fromStart: true },
    {
      label: 'Session',
      value: [messages > 0 ? `resumed, ${plural(messages, 'message')}` : 'new', runtime.agent.sessionId, ...(runtime.sessionName ? [`"${runtime.sessionName}"`] : [])].join(' · '),
    },
    { label: 'Permissions', value: [runtime.engine.mode, runtime.sandbox ? 'sandbox on' : 'sandbox off'].join(' · ') },
    { label: 'Loaded', value: loaded.length > 0 ? loaded.join(' · ') : 'no instruction files, MCP servers, skills or plugins' },
  ];
  return rows.map((row) => ({ ...row, value: sanitize(row.value) }));
}

/**
 * A row's value as lines of at most `room` columns. A path is cut from its start, so the branch
 * after it stays. Anything else breaks between its ` · ` parts, and splits a part only when that
 * part alone is too long.
 */
function valueLines(row: WelcomeRow, room: number): string[] {
  if (displayWidth(row.value) <= room) return [row.value];
  if (row.fromStart) return [tailToWidth(row.value, room)];
  const lines: string[] = [];
  let current = '';
  for (const part of row.value.split(' · ')) {
    const joined = current ? `${current} · ${part}` : part;
    if (displayWidth(joined) <= room) {
      current = joined;
      continue;
    }
    if (current) lines.push(current);
    const pieces = wrapToWidth(part, room);
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  if (current) lines.push(current);
  return lines;
}

/** As many tips as fit in `room` columns. */
function tipsLine(room: number): string {
  let line = '';
  for (const tip of TIPS) {
    const next = line ? `${line} · ${tip}` : tip;
    if (displayWidth(next) > room) break;
    line = next;
  }
  return line;
}

/** The panel as lines no wider than `width` columns. */
export function renderWelcome(rows: WelcomeRow[], width: number): string[] {
  const title = `✻ ${APP_DISPLAY_NAME} v${VERSION}`;
  const usable = width - 1;
  const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
  if (usable < MIN_BOX_WIDTH) {
    // Too narrow for a box: a row on one line when it fits, else its value on the lines after.
    return [
      style.bold(style.cyan(clipToWidth(title, usable))),
      ...rows.flatMap((row) => {
        const label = `${row.label}: `;
        if (displayWidth(label) + displayWidth(row.value) <= usable) return [`${style.dim(label)}${row.value}`];
        return [style.dim(row.label), ...valueLines(row, usable - 2).map((line) => `  ${line}`)];
      }),
      style.dim(tipsLine(usable)),
    ];
  }
  const natural = Math.max(
    displayWidth(title) + 2,
    displayWidth(TIPS.join(' · ')),
    ...rows.map((row) => labelWidth + 2 + displayWidth(row.value)),
  );
  // Two columns of border and two of padding on each side.
  const inner = Math.min(natural, usable - 6, MAX_INNER_WIDTH);
  const boxed = (content: string, contentWidth: number): string =>
    `${style.dim('│')}  ${content}${' '.repeat(Math.max(0, inner - contentWidth))}  ${style.dim('│')}`;
  const lines = [
    `${style.dim('╭─ ')}${style.bold(style.cyan(title))}${style.dim(` ${'─'.repeat(Math.max(1, inner + 1 - displayWidth(title)))}╮`)}`,
    boxed('', 0),
  ];
  const room = inner - labelWidth - 2;
  for (const row of rows) {
    valueLines(row, room).forEach((piece, i) => {
      const label = i === 0 ? style.dim(row.label.padEnd(labelWidth)) : ' '.repeat(labelWidth);
      lines.push(boxed(`${label}  ${piece}`, labelWidth + 2 + displayWidth(piece)));
    });
  }
  const tips = tipsLine(inner);
  lines.push(boxed('', 0), boxed(style.dim(tips), displayWidth(tips)), style.dim(`╰${'─'.repeat(inner + 4)}╯`));
  return lines;
}
