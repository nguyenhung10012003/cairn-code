/**
 * The bottom of the interactive screen: messages waiting to be sent, the line being typed, the
 * command menu, and a status line. Everything else is printed above it, so typing goes on while
 * the agent writes. The footer follows the output down the screen, which keeps the scrollback
 * intact, and sits on the last rows once the screen has filled.
 */
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { CommandEntry } from '../commands/slash.ts';
import { CommandMenu } from './command-menu.ts';
import type { MenuHost } from './command-menu.ts';
import { LineEditor } from './editor.ts';
import { charWidth, clipToWidth, displayWidth, sanitize, style } from './render.ts';

const stdin = process.stdin;
const stdout = process.stdout;

/** Drawn as one update where the terminal supports it, so the footer does not flicker. */
const SYNC_START = '\x1b[?2026h\x1b[?25l';
const SYNC_END = '\x1b[?25h\x1b[?2026l';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';

export interface FooterOptions {
  prompt: () => string;
  /** The status line, plain text that fits in `width` columns. */
  status: (width: number) => string;
  /** Lines shown above the prompt, such as a message waiting to be sent. */
  above: (width: number) => string[];
  commands: () => CommandEntry[];
  /** A line was sent with Enter. */
  onSubmit: (text: string) => void;
  /** Esc, when the command menu did not take it. */
  onEscape: () => void;
  /** Ctrl+C on an empty line. */
  onInterrupt: () => void;
  /** Ctrl+D on an empty line. */
  onEof: () => void;
  onShiftTab: () => void;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

function printable(text: string | undefined, key: Key | undefined): string {
  if (!text || key?.ctrl || key?.meta) return '';
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export class Footer {
  readonly editor = new LineEditor();
  private readonly menu: CommandMenu;
  private readonly options: FooterOptions;
  private active = false;
  private suspended = false;
  /** The footer is on screen, with the cursor this many rows below its first line. */
  private drawn = false;
  private cursorRow = 0;
  private pasting = false;
  private readonly host: MenuHost;

  constructor(options: FooterOptions) {
    this.options = options;
    this.menu = new CommandMenu(options.commands);
    const editor = this.editor;
    this.host = {
      get text() {
        return editor.text;
      },
      get cursorAtEnd() {
        return editor.cursor === [...editor.text].length;
      },
      replace: (text) => editor.setText(text),
      submit: () => this.submit(),
    };
  }

  start(): void {
    if (this.active) return;
    emitKeypressEvents(stdin);
    // However the process ends, the shell gets its terminal back with paste mode off and a cursor.
    process.once('exit', () => {
      if (stdout.isTTY) stdout.write(`${PASTE_OFF}\x1b[?25h`);
    });
    this.active = true;
    this.attach();
    stdout.on('resize', this.onResize);
    this.render();
  }

  /** Erases the footer and gives the terminal back as it was. */
  stop(): void {
    if (!this.active) return;
    this.erase();
    if (!this.suspended) this.detach();
    stdout.off('resize', this.onResize);
    this.active = false;
    this.suspended = false;
    stdin.setRawMode?.(false);
  }

  /** Hands the keyboard and the bottom of the screen to something else, such as a prompt. */
  suspend(): void {
    if (!this.active || this.suspended) return;
    this.erase();
    this.detach();
    this.suspended = true;
  }

  resume(): void {
    if (!this.active || !this.suspended) return;
    this.suspended = false;
    this.attach();
    this.render();
  }

  /** Runs `work` with the footer out of the way. */
  async during<T>(work: () => Promise<T>): Promise<T> {
    const was = this.suspended;
    this.suspend();
    try {
      return await work();
    } finally {
      if (!was) this.resume();
    }
  }

  /** Prints above the footer. `text` should end with a newline. */
  print(text: string): void {
    if (!this.active || this.suspended) {
      stdout.write(text);
      return;
    }
    stdout.write(`${SYNC_START}${this.eraseSequence()}${text.endsWith('\n') ? text : `${text}\n`}`);
    this.drawn = false;
    this.render(true);
  }

  render(inSync = false): void {
    if (!this.active || this.suspended) return;
    const width = Math.max(20, stdout.columns || 80);
    const usable = width - 1;
    const above = this.options.above(width).map((line) => clipLine(line, usable));
    const { rows, row, col } = this.layout(usable);
    const menu = this.menu.lines(width);
    const status = style.dim(clipToWidth(sanitize(this.options.status(usable)), usable));
    const lines = [...above, ...rows, ...menu, status];
    const cursorRow = above.length + row;
    const up = lines.length - 1 - cursorRow;
    let out = inSync ? '' : SYNC_START;
    out += this.drawn ? this.eraseSequence() : '\r\x1b[0J';
    out += lines.join('\n');
    if (up > 0) out += `\x1b[${up}A`;
    out += `\r${col > 0 ? `\x1b[${col}C` : ''}${SYNC_END}`;
    stdout.write(out);
    this.drawn = true;
    this.cursorRow = cursorRow;
  }

  private eraseSequence(): string {
    if (!this.drawn) return '';
    return `\r${this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : ''}\x1b[0J`;
  }

  private erase(): void {
    if (!this.drawn) return;
    stdout.write(this.eraseSequence());
    this.drawn = false;
  }

  /** The prompt and the text as screen rows no wider than `usable`, and where the cursor is. */
  private layout(usable: number): { rows: string[]; row: number; col: number } {
    const prompt = this.options.prompt();
    const continuation = style.dim('… ');
    const rows: string[] = [];
    let current = prompt;
    let col = displayWidth(stripAnsi(prompt));
    let cursor = { row: 0, col };
    const text = [...this.editor.text];
    for (let i = 0; i <= text.length; i++) {
      const char = text[i];
      const shown = char === '\t' ? '  ' : char;
      const width = char === undefined || char === '\n' ? 0 : char === '\t' ? 2 : charWidth(char.codePointAt(0)!);
      if (char !== undefined && char !== '\n' && col + width > usable) {
        rows.push(current);
        current = '';
        col = 0;
      }
      if (i === this.editor.cursor) cursor = { row: rows.length, col };
      if (char === undefined) break;
      if (char === '\n') {
        rows.push(current);
        current = continuation;
        col = 2;
        continue;
      }
      current += shown;
      col += width;
    }
    rows.push(current);
    return { rows, ...cursor };
  }

  private attach(): void {
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('keypress', this.onKey);
    stdout.write(PASTE_ON);
  }

  private detach(): void {
    stdin.off('keypress', this.onKey);
    stdout.write(PASTE_OFF);
    this.pasting = false;
  }

  private readonly onResize = (): void => this.render();

  private submit(): void {
    const text = this.editor.text;
    // A line ending in a backslash goes on to another line, as it did before.
    if (text.endsWith('\\') && this.editor.cursor === [...text].length) {
      this.editor.setText(`${text.slice(0, -1)}\n`);
      return;
    }
    this.menu.close();
    const sent = this.editor.take();
    this.render();
    this.options.onSubmit(sent);
  }

  private readonly onKey = (text: string | undefined, key: Key | undefined): void => {
    if (key?.name === 'paste-start') {
      this.pasting = true;
      return;
    }
    if (key?.name === 'paste-end') {
      this.pasting = false;
      this.menu.update(key, this.host);
      this.render();
      return;
    }
    if (this.pasting) {
      // Pasted line breaks stay in the message instead of sending it.
      if (key?.name === 'return' || key?.name === 'enter') this.editor.insert('\n');
      else if (key?.name === 'tab') this.editor.insert('\t');
      else {
        const typed = printable(text, key);
        if (typed) this.editor.insert(typed);
      }
      return;
    }
    if (this.menu.handle(key, this.host)) {
      this.render();
      return;
    }
    const editor = this.editor;
    const name = key?.name;
    if (key?.ctrl) {
      switch (name) {
        case 'c':
          if (editor.text) editor.setText('');
          else this.options.onInterrupt();
          break;
        case 'd':
          if (!editor.text) {
            this.options.onEof();
            return;
          }
          editor.deleteForward();
          break;
        case 'a':
          editor.home();
          break;
        case 'e':
          editor.end();
          break;
        case 'b':
          editor.left();
          break;
        case 'f':
          editor.right();
          break;
        case 'u':
          editor.deleteToStart();
          break;
        case 'k':
          editor.deleteToEnd();
          break;
        case 'w':
          editor.deleteWordBack();
          break;
        case 'p':
          editor.historyBack();
          break;
        case 'n':
          editor.historyForward();
          break;
        case 'left':
          editor.wordLeft();
          break;
        case 'right':
          editor.wordRight();
          break;
        default:
          return;
      }
    } else {
      switch (name) {
        case 'return':
        case 'enter':
          if (key?.meta) editor.insert('\n');
          else {
            this.submit();
            return;
          }
          break;
        case 'escape':
          this.options.onEscape();
          this.render();
          return;
        case 'tab':
          if (key?.shift) {
            this.options.onShiftTab();
            break;
          }
          return;
        case 'backspace':
          if (key?.meta) editor.deleteWordBack();
          else editor.backspace();
          break;
        case 'delete':
          editor.deleteForward();
          break;
        case 'left':
          if (key?.meta) editor.wordLeft();
          else editor.left();
          break;
        case 'right':
          if (key?.meta) editor.wordRight();
          else editor.right();
          break;
        case 'home':
          editor.home();
          break;
        case 'end':
          editor.end();
          break;
        case 'up':
          editor.historyBack();
          break;
        case 'down':
          editor.historyForward();
          break;
        default: {
          if (key?.meta && name === 'b') editor.wordLeft();
          else if (key?.meta && name === 'f') editor.wordRight();
          else {
            const typed = printable(text, key);
            if (!typed) return;
            editor.insert(typed);
          }
        }
      }
    }
    this.menu.update(key, this.host);
    this.render();
  };
}

function clipLine(line: string, usable: number): string {
  return displayWidth(stripAnsi(line)) <= usable ? line : clipToWidth(stripAnsi(line), usable);
}
