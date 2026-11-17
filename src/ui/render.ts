/** Terminal output helpers. */
import { relative } from 'node:path';
import { style } from './theme.ts';

export { style };

/** Columns a character takes. Over-counting is safe for layout; under-counting would wrap a line. */
export function charWidth(code: number): number {
  if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

/** Terminal columns plain text takes, counting East Asian wide characters and emoji as two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0)!);
  return width;
}

/** Cuts plain text to fit in `width` columns, marking the cut with an ellipsis. */
export function clipToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const w = charWidth(char.codePointAt(0)!);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

/** The end of plain text that fits in `width` columns, so the cursor end of a long input stays visible. */
export function tailToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  const chars = [...text];
  let out = '';
  let used = 1;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = charWidth(chars[i]!.codePointAt(0)!);
    if (used + w > width) break;
    out = chars[i]! + out;
    used += w;
  }
  return `…${out}`;
}

const SGR = /\x1b\[[0-9;]*m/;

/**
 * Splits a line into pieces of at most `width` columns, so each piece takes exactly one terminal
 * row and a block of them can be counted to erase it later. Line breaks split it too, and tabs
 * become spaces to the next stop of 8. Styling around the whole line, as `style` adds it, goes
 * around every piece; styling inside the line is dropped.
 */
export function wrapToWidth(line: string, width: number): string[] {
  const usable = Math.max(1, width);
  const [, open = '', inner = '', close = ''] = new RegExp(`^((?:${SGR.source})*)([\\s\\S]*?)((?:${SGR.source})*)$`).exec(line)!;
  const plain = inner.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const pieces: string[] = [];
  for (const part of plain.split('\n')) {
    let current = '';
    let col = 0;
    for (const char of part) {
      if (char === '\t') {
        let spaces = 8 - (col % 8);
        if (col + spaces > usable) {
          pieces.push(current);
          current = '';
          col = 0;
          spaces = Math.min(8, usable);
        }
        current += ' '.repeat(spaces);
        col += spaces;
        continue;
      }
      const w = charWidth(char.codePointAt(0)!);
      if (col > 0 && col + w > usable) {
        pieces.push(current);
        current = '';
        col = 0;
      }
      current += char;
      col += w;
    }
    pieces.push(current);
  }
  return pieces.map((piece) => (piece ? `${open}${piece}${close}` : ''));
}

/**
 * Removes control characters from anything the model or a tool produced. Printed raw, escape
 * sequences in a file or web page could rewrite the screen, or fake a permission prompt.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Links, bold, strikethrough and italics. Markers inside words, as in snake_case or 2*3*4, are left alone. */
function formatEmphasis(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
      label === url ? style.link(url) : `${style.link(label)} ${style.dim(`(${url})`)}`,
    )
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_m, inner: string) => style.bold(inner))
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, (_m, inner: string) => style.bold(inner))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_m, inner: string) => style.strike(inner))
    .replace(/(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, (_m, inner: string) => style.italic(inner))
    .replace(/(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/g, (_m, inner: string) => style.italic(inner));
}

/** Code spans first, so nothing inside one is read as emphasis. */
function formatInline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => (i % 2 === 1 ? style.code(part.slice(1, -1)) : formatEmphasis(part)))
    .join('');
}

function formatLine(line: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) {
    const text = formatInline(heading[2]!);
    const level = heading[1]!.length;
    return level === 1 ? style.underline(style.heading(text)) : level === 2 ? style.heading(text) : style.bold(text);
  }
  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) return style.border('─'.repeat(Math.min(60, (process.stdout.columns || 80) - 1)));
  const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
  if (task) {
    const done = task[2] !== ' ';
    return `${task[1]}${done ? style.success('☑') : style.dim('☐')} ${done ? style.dim(formatInline(task[3]!)) : formatInline(task[3]!)}`;
  }
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}${style.accent(bullet[1]!.length >= 2 ? '◦' : '•')} ${formatInline(bullet[2]!)}`;
  const ordered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
  if (ordered) return `${ordered[1]}${style.accent(ordered[2]!)} ${formatInline(ordered[3]!)}`;
  const quote = /^(\s*)>\s?(.*)$/.exec(line);
  if (quote) return `${quote[1]}${style.border('│')} ${style.italic(formatInline(quote[2]!))}`;
  // A table: the row of dashes under its header, and the pipes between its cells, step back.
  if (/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(line)) return style.dim(line);
  if (/^\s*\|.*\|\s*$/.test(line)) return line.split('|').map(formatInline).join(style.dim('|'));
  return formatInline(line);
}

/** Styles Markdown a line at a time, while text is still arriving from the model. */
export class MarkdownStream {
  private buffer = '';
  private inFence = false;
  private readonly write: (text: string) => void;

  constructor(write: (text: string) => void) {
    this.write = write;
  }

  push(text: string): void {
    this.buffer += sanitize(text);
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      this.emit(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }

  flush(): void {
    if (this.buffer) this.emit(this.buffer);
    this.buffer = '';
    this.inFence = false;
  }

  private emit(line: string): void {
    if (/^\s*(```|~~~)/.test(line)) {
      this.inFence = !this.inFence;
      this.write(`${style.dim(line)}\n`);
    } else {
      this.write(`${this.inFence ? style.codeBlock(line) : formatLine(line)}\n`);
    }
  }
}

function shortenPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

function oneLine(text: string, max = 120): string {
  const flat = sanitize(text).replace(/\s*\n\s*/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The short argument shown next to a tool name, such as `Read(src/cli.ts)`. */
export function toolSummary(name: string, input: Record<string, unknown>, cwd: string): string {
  const pick = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return oneLine(shortenPath(pick(input.file_path), cwd));
    case 'Bash':
      return oneLine(pick(input.command));
    case 'Glob':
    case 'Grep':
      return oneLine(pick(input.pattern));
    case 'WebFetch':
      return oneLine(pick(input.url));
    case 'Agent':
      return oneLine(pick(input.description));
    case 'Skill':
      return oneLine(pick(input.skill));
    default:
      return name.startsWith('mcp__') ? oneLine(JSON.stringify(input)) : '';
  }
}

const PREVIEW_LINES = 40;

/** What the user reviews before approving a call. Shown in full up to a limit, never hidden. */
export function permissionPreview(name: string, input: Record<string, unknown>): string[] {
  const clip = (text: string, marker: string): string[] => {
    const lines = sanitize(text).split('\n');
    const shown = lines.slice(0, PREVIEW_LINES).map((line) => `  ${marker}${line}`);
    if (lines.length > PREVIEW_LINES) shown.push(style.dim(`  ... ${lines.length - PREVIEW_LINES} more lines`));
    return shown;
  };
  switch (name) {
    case 'Bash':
      return clip(String(input.command ?? ''), '');
    case 'Edit':
      return [
        style.bold(`  ${sanitize(String(input.file_path ?? ''))}`),
        ...clip(String(input.old_string ?? ''), '- ').map(style.error),
        ...clip(String(input.new_string ?? ''), '+ ').map(style.success),
      ];
    case 'Write':
      return [style.bold(`  ${sanitize(String(input.file_path ?? ''))}`), ...clip(String(input.content ?? ''), '+ ').map(style.success)];
    case 'Read':
      return [style.bold(`  ${sanitize(String(input.file_path ?? ''))}`)];
    case 'WebFetch':
      return [style.info(`  ${sanitize(String(input.url ?? ''))}`)];
    default:
      return clip(JSON.stringify(input, null, 2), '');
  }
}

export function toolResultSummary(output: string, display: string | undefined, isError: boolean): string {
  if (isError) {
    const lines = sanitize(output).trim().split('\n');
    const shown = lines.slice(0, 6).join('\n     ');
    return style.error(lines.length > 6 ? `${shown}\n     … ${lines.length - 6} more lines` : shown);
  }
  if (display) return style.dim(sanitize(display));
  const lines = sanitize(output).trimEnd().split('\n');
  const shown = lines.slice(0, 4).map((line) => oneLine(line, 160)).join('\n     ');
  return style.dim(lines.length > 4 ? `${shown}\n     … ${lines.length - 4} more lines` : shown);
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;

  start(label = 'Working… (esc to interrupt)'): void {
    if (this.timer || !process.stdout.isTTY) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      process.stdout.write(`\r\x1b[2K${style.accent(FRAMES[this.frame]!)} ${style.dim(label)}`);
    }, 100);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write('\r\x1b[2K');
  }
}
