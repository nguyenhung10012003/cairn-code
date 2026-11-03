/** The list of slash commands shown under the prompt while one is being typed. */
import type { CommandEntry } from '../commands/slash.ts';
import { sanitize, style } from './render.ts';

/** Commands shown at once. The list scrolls to keep the selection in view. */
export const MENU_ROWS = 8;
const MAX_NAME_WIDTH = 28;

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Description words starting with the query, from three letters on, so `/undo` finds /rewind. */
function describedBy(description: string, q: string): boolean {
  return q.length >= 3 && description.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(q));
}

/**
 * Commands matching what follows the slash, best first: the exact name, names that start with
 * it, names that contain it, names with its letters in order, then words in descriptions.
 */
export function filterCommands(entries: CommandEntry[], query: string): CommandEntry[] {
  const q = query.toLowerCase();
  const ranked: { entry: CommandEntry; rank: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    let rank: number;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    // Starting on the same letter makes `/cmp` mean /compact rather than /autocompact.
    else if (isSubsequence(q, name)) rank = name[0] === q[0] ? 3 : 4;
    else if (describedBy(entry.description, q)) rank = 5;
    else continue;
    ranked.push({ entry, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name));
  return ranked.map(({ entry }) => entry);
}

/** Columns a character takes. Over-counting is safe here; under-counting would wrap a line. */
function charWidth(code: number): number {
  if ((code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0)!);
  return width;
}

/** Cuts text to fit in `width` columns, marking the cut with an ellipsis. */
function clip(text: string, width: number): string {
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

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * One line per visible command, each shorter than the terminal is wide: a wrapped line would
 * throw off the cursor movement that puts the cursor back on the prompt.
 */
export function renderMenu(items: CommandEntry[], selected: number, columns: number): string[] {
  const start = Math.min(Math.max(0, selected - MENU_ROWS + 1), Math.max(0, items.length - MENU_ROWS));
  const visible = items.slice(start, start + MENU_ROWS);
  const labels = visible.map((entry) => sanitize(`/${entry.name}${entry.hint ? ` ${entry.hint}` : ''}`));
  const usable = Math.max(10, columns - 1);
  const nameWidth = Math.min(MAX_NAME_WIDTH, usable - 2, Math.max(...labels.map(displayWidth)));
  const descriptionWidth = usable - 2 - nameWidth - 2;
  const lines = visible.map((entry, i) => {
    const name = pad(clip(labels[i]!, nameWidth), nameWidth);
    const description = clip(sanitize(entry.description).replace(/\s+/g, ' ').trim(), descriptionWidth);
    if (start + i === selected) return `${style.cyan('❯')} ${style.cyan(style.bold(name))}  ${description}`.trimEnd();
    return `  ${name}  ${style.dim(description)}`.trimEnd();
  });
  if (items.length > MENU_ROWS) lines.push(style.dim(`  ${selected + 1}/${items.length}`));
  return lines;
}

/** The parts of a readline Interface the menu uses. */
export interface MenuLine {
  readonly line: string;
  readonly cursor: number;
  getCursorPos(): { rows: number; cols: number };
  write(data: string): void;
  write(data: null, key: { name: string; ctrl?: boolean }): void;
}

export interface MenuKey {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Shows matching commands under a prompt line that starts with a slash. The line stays a
 * normal readline line: the menu only takes the keys it uses while it is showing.
 */
export class CommandMenu {
  private readonly rl: MenuLine;
  private readonly entries: () => CommandEntry[];
  private readonly write: (text: string) => void;
  private readonly columns: () => number;
  private items: CommandEntry[] = [];
  private selected = 0;
  private query: string | null = null;
  /** Lines drawn under the prompt, so they can be erased. */
  private drawn = 0;
  /** The line the user closed the menu on with Esc. It stays closed until the line changes. */
  private dismissed: string | null = null;

  constructor(options: { rl: MenuLine; entries: () => CommandEntry[]; write: (text: string) => void; columns: () => number }) {
    this.rl = options.rl;
    this.entries = options.entries;
    this.write = options.write;
    this.columns = options.columns;
  }

  get visible(): boolean {
    return this.query !== null;
  }

  /** Called before readline sees a key. True when the menu used it, so readline must not. */
  handle(key: MenuKey | undefined): boolean {
    if (!this.visible || !key) return false;
    // The key decoder marks a lone Esc as meta, so check for Esc before ruling out modifiers.
    if (key.name === 'escape') {
      this.dismissed = this.rl.line;
      this.close();
      return true;
    }
    if (key.ctrl || key.meta) return false;
    switch (key.name) {
      case 'up':
        this.move(-1);
        return true;
      case 'down':
        this.move(1);
        return true;
      case 'tab':
        if (key.shift) return false;
        this.complete();
        return true;
      case 'return':
      case 'enter':
        this.submit();
        return true;
      default:
        return false;
    }
  }

  /** Called after readline has handled a key: opens, filters or closes the menu to match the line. */
  update(key: MenuKey | undefined): void {
    // Recalling history never opens the menu, so the arrows keep walking through history.
    if (key?.name === 'up' || key?.name === 'down') {
      this.close();
      return;
    }
    const line = this.rl.line;
    if (line !== this.dismissed) this.dismissed = null;
    if (!/^\/\S*$/.test(line) || this.rl.cursor !== line.length || this.dismissed !== null) {
      this.close();
      return;
    }
    const query = line.slice(1);
    if (query !== this.query) {
      this.items = filterCommands(this.entries(), query);
      this.selected = 0;
    }
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.query = query;
    this.draw();
  }

  /** Erases the menu and leaves the cursor where it was. */
  close(): void {
    this.query = null;
    if (this.drawn === 0) return;
    const { cols } = this.rl.getCursorPos();
    // The menu's rows are there to move into, so this does not scroll the screen.
    this.write(`\n\x1b[0J\x1b[1A\x1b[${cols + 1}G`);
    this.drawn = 0;
  }

  private move(by: number): void {
    this.selected = (this.selected + by + this.items.length) % this.items.length;
    this.draw();
  }

  private draw(): void {
    const { rows, cols } = this.rl.getCursorPos();
    // A wrapped line would put the menu over part of the input. Command names are short.
    if (rows > 0) {
      this.close();
      return;
    }
    const lines = renderMenu(this.items, this.selected, this.columns());
    // Relative moves, because writing below the last screen row scrolls it.
    this.write(`\n\x1b[0J${lines.join('\n')}\x1b[${lines.length}A\x1b[${cols + 1}G`);
    this.drawn = lines.length;
  }

  private replaceLine(text: string): void {
    this.rl.write(null, { ctrl: true, name: 'e' });
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(text);
  }

  /** Tab: puts the selected command on the line, ready for its arguments. */
  private complete(): void {
    const choice = this.items[this.selected];
    this.close();
    if (choice) this.replaceLine(`/${choice.name} `);
  }

  /** Enter: runs the selected command. */
  private submit(): void {
    const choice = this.items[this.selected];
    this.close();
    if (choice && this.rl.line !== `/${choice.name}`) this.replaceLine(`/${choice.name}`);
    this.rl.write(null, { name: 'return' });
  }
}
