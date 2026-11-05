/** Terminal output helpers. */
import { relative } from 'node:path';

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

function paint(code: string): (text: string) => string {
  return (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const style = {
  dim: paint('2'),
  bold: paint('1'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
};

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

function formatLine(line: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return style.bold(heading[2]!);
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_m, text: string) => style.bold(text))
    .replace(/`([^`]+)`/g, (_m, text: string) => style.cyan(text));
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
      this.write(`${this.inFence ? style.cyan(line) : formatLine(line)}\n`);
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
        `  ${sanitize(String(input.file_path ?? ''))}`,
        ...clip(String(input.old_string ?? ''), '- ').map(style.red),
        ...clip(String(input.new_string ?? ''), '+ ').map(style.green),
      ];
    case 'Write':
      return [`  ${sanitize(String(input.file_path ?? ''))}`, ...clip(String(input.content ?? ''), '+ ').map(style.green)];
    case 'Read':
      return [`  ${sanitize(String(input.file_path ?? ''))}`];
    case 'WebFetch':
      return [`  ${sanitize(String(input.url ?? ''))}`];
    default:
      return clip(JSON.stringify(input, null, 2), '');
  }
}

export function toolResultSummary(output: string, display: string | undefined, isError: boolean): string {
  if (isError) {
    const lines = sanitize(output).trim().split('\n');
    const shown = lines.slice(0, 6).join('\n     ');
    return style.red(lines.length > 6 ? `${shown}\n     … ${lines.length - 6} more lines` : shown);
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
      process.stdout.write(`\r\x1b[2K${style.dim(`${FRAMES[this.frame]} ${label}`)}`);
    }, 100);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write('\r\x1b[2K');
  }
}
