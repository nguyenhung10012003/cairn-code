/** The list of slash commands shown under the prompt while one is being typed. */
import type { CommandEntry } from '../commands/slash.ts';
import { clipToWidth as clip, displayWidth, sanitize, style } from './render.ts';

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

export interface MenuKey {
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** What the menu needs from the line being typed. */
export interface MenuHost {
  readonly text: string;
  readonly cursorAtEnd: boolean;
  /** Replaces the whole line, with the cursor at its end. */
  replace(text: string): void;
  /** Sends the line, as Enter would. */
  submit(): void;
}

/**
 * Matching commands, listed under a prompt line that starts with a slash. It only takes the
 * keys it uses while it is showing; the footer draws the lines it returns.
 */
export class CommandMenu {
  private readonly entries: () => CommandEntry[];
  private items: CommandEntry[] = [];
  private selected = 0;
  private query: string | null = null;
  /** The line the user closed the menu on with Esc. It stays closed until the line changes. */
  private dismissed: string | null = null;

  constructor(entries: () => CommandEntry[]) {
    this.entries = entries;
  }

  get visible(): boolean {
    return this.query !== null;
  }

  /** Called before the line sees a key. True when the menu used it. */
  handle(key: MenuKey | undefined, host: MenuHost): boolean {
    if (!this.visible || !key) return false;
    // The key decoder marks a lone Esc as meta, so check for Esc before ruling out modifiers.
    if (key.name === 'escape') {
      this.dismissed = host.text;
      this.close();
      return true;
    }
    if (key.ctrl || key.meta) return false;
    const choice = this.items[this.selected];
    switch (key.name) {
      case 'up':
        this.move(-1);
        return true;
      case 'down':
        this.move(1);
        return true;
      case 'tab':
        if (key.shift) return false;
        this.close();
        if (choice) host.replace(`/${choice.name} `);
        return true;
      case 'return':
      case 'enter':
        this.close();
        if (choice) host.replace(`/${choice.name}`);
        host.submit();
        return true;
      default:
        return false;
    }
  }

  /** Called after the line has changed: opens, filters or closes the menu to match it. */
  update(key: MenuKey | undefined, host: MenuHost): void {
    // Recalling history never opens the menu, so the arrows keep walking through history.
    if (key?.name === 'up' || key?.name === 'down') {
      this.close();
      return;
    }
    const line = host.text;
    if (line !== this.dismissed) this.dismissed = null;
    if (!/^\/\S*$/.test(line) || !host.cursorAtEnd || this.dismissed !== null) {
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
  }

  close(): void {
    this.query = null;
  }

  /** What to draw under the line, or nothing while closed. */
  lines(columns: number): string[] {
    return this.visible ? renderMenu(this.items, this.selected, columns) : [];
  }

  private move(by: number): void {
    this.selected = (this.selected + by + this.items.length) % this.items.length;
  }
}
