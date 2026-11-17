/**
 * Vim keys for the prompt, with `"editorMode": "vim"`. It starts in insert mode, where keys type
 * as usual; Esc goes to normal mode, where they move and edit. Ctrl keys, arrows and Shift+Tab
 * work as they do without vim, and Esc in normal mode does what Esc does without it, such as
 * stopping the agent. Enter sends the message in either mode.
 *
 * Normal mode has counts, h l 0 ^ $ w b e W B E f F t T ; , gg G j k, the operators d c y with
 * those motions and doubled for the line, x X D C S s r ~ J p P i a I A o O, and u to undo.
 */
import type { Key } from 'node:readline';
import type { LineEditor } from './editor.ts';

export type VimOutcome = 'handled' | 'submit' | 'pass';
type Mode = 'insert' | 'normal';
type Operator = 'd' | 'c' | 'y';
type Find = { kind: 'f' | 'F' | 't' | 'T'; char: string };

/** 0 for blanks, 1 for word characters, 2 for other punctuation, as vim tells words apart. */
function classOf(char: string | undefined, bigWord: boolean): number {
  if (char === undefined || /\s/.test(char)) return 0;
  if (bigWord) return 1;
  return /[\p{L}\p{N}_]/u.test(char) ? 1 : 2;
}

interface Motion {
  to: number;
  /** The character at `to` is part of what an operator takes, as for e, f, t and $. */
  inclusive: boolean;
  /** It moves between lines, so an operator takes whole lines. */
  linewise?: boolean;
}

export class VimMode {
  mode: Mode = 'insert';
  private count = '';
  private operator: { name: Operator; count: number } | null = null;
  /** A key that needs the next one: f F t T and r a character, g another g. */
  private awaiting: 'f' | 'F' | 't' | 'T' | 'r' | 'g' | null = null;
  private lastFind: Find | null = null;
  private register: { text: string; linewise: boolean } = { text: '', linewise: false };
  private readonly undo: { text: string; cursor: number }[] = [];
  /** Text and cursor as insert mode started, so the insert can be undone as one change. */
  private insertStart: { text: string; cursor: number } | null = null;

  /** After a message is sent, the next one starts in insert mode. */
  reset(): void {
    this.mode = 'insert';
    this.clearPending();
    this.insertStart = null;
  }

  handle(text: string | undefined, key: Key | undefined, editor: LineEditor): VimOutcome {
    const name = key?.name;
    // Esc first: a terminal may report it with meta set.
    if (name === 'escape') {
      if (this.mode === 'insert') {
        this.toNormal(editor);
        return 'handled';
      }
      if (this.operator || this.awaiting || this.count) {
        this.clearPending();
        return 'handled';
      }
      return 'pass';
    }
    // Alt+Enter still starts a new line, and in insert mode Enter is the footer's to handle.
    if ((name === 'return' || name === 'enter') && !key?.meta) return this.mode === 'normal' ? 'submit' : 'pass';
    if (key?.ctrl || key?.meta || this.mode === 'insert') return 'pass';
    if (['up', 'down', 'left', 'right', 'home', 'end', 'tab', 'delete'].includes(name ?? '')) return 'pass';
    if (name === 'backspace') {
      editor.cursor = Math.max(this.lineStart(editor, editor.cursor), editor.cursor - 1);
      return 'handled';
    }
    const char = text && [...text].length === 1 ? text : undefined;
    if (char !== undefined) this.normalKey(char, editor);
    return 'handled';
  }

  private clearPending(): void {
    this.count = '';
    this.operator = null;
    this.awaiting = null;
  }

  private toNormal(editor: LineEditor): void {
    if (this.insertStart && this.insertStart.text !== editor.text) this.pushUndo(this.insertStart);
    this.insertStart = null;
    this.mode = 'normal';
    // As in vim, the cursor steps back onto the last character typed.
    if (editor.cursor > this.lineStart(editor, editor.cursor)) editor.cursor--;
  }

  private toInsert(editor: LineEditor, snapshot = { text: editor.text, cursor: editor.cursor }): void {
    this.mode = 'insert';
    this.insertStart = snapshot;
  }

  private pushUndo(state: { text: string; cursor: number }): void {
    this.undo.push(state);
    if (this.undo.length > 100) this.undo.shift();
  }

  private lineStart(editor: LineEditor, at: number): number {
    const chars = [...editor.text];
    let i = at;
    while (i > 0 && chars[i - 1] !== '\n') i--;
    return i;
  }

  private lineEnd(editor: LineEditor, at: number): number {
    const chars = [...editor.text];
    let i = at;
    while (i < chars.length && chars[i] !== '\n') i++;
    return i;
  }

  /** Normal mode keeps the cursor on a character, not past the end of the line. */
  private clamp(editor: LineEditor): void {
    const start = this.lineStart(editor, editor.cursor);
    const end = this.lineEnd(editor, editor.cursor);
    editor.cursor = Math.max(start, Math.min(editor.cursor, end - 1 < start ? start : end - 1));
  }

  private normalKey(char: string, editor: LineEditor): void {
    if (this.awaiting) return this.finishAwaited(char, editor);
    if (/[1-9]/.test(char) || (char === '0' && this.count !== '')) {
      this.count += char;
      return;
    }
    const count = Math.max(1, Number(this.count || '1')) * (this.operator?.count ?? 1);
    this.count = '';
    if (this.operator) return this.operatorKey(char, count, editor);
    switch (char) {
      case 'd':
      case 'c':
      case 'y':
        this.operator = { name: char, count };
        return;
      case 'f':
      case 'F':
      case 't':
      case 'T':
      case 'r':
      case 'g':
        this.awaiting = char;
        this.count = count > 1 ? String(count) : '';
        return;
      case 'i':
        return this.toInsert(editor);
      case 'a':
        editor.cursor = Math.min(this.lineEnd(editor, editor.cursor), editor.cursor + 1);
        return this.toInsert(editor);
      case 'I':
        editor.cursor = this.firstNonBlank(editor);
        return this.toInsert(editor);
      case 'A':
        editor.cursor = this.lineEnd(editor, editor.cursor);
        return this.toInsert(editor);
      case 'o':
      case 'O': {
        const snapshot = { text: editor.text, cursor: editor.cursor };
        editor.cursor = char === 'o' ? this.lineEnd(editor, editor.cursor) : this.lineStart(editor, editor.cursor);
        editor.insert('\n');
        if (char === 'O') editor.cursor--;
        return this.toInsert(editor, snapshot);
      }
      case 'x':
      case 'X': {
        const start = this.lineStart(editor, editor.cursor);
        const end = this.lineEnd(editor, editor.cursor);
        const from = char === 'x' ? editor.cursor : Math.max(start, editor.cursor - count);
        const to = char === 'x' ? Math.min(end, editor.cursor + count) : editor.cursor;
        if (from < to) this.change(editor, from, to, false, 'd');
        return;
      }
      case 'D':
        return this.change(editor, editor.cursor, this.lineEnd(editor, editor.cursor), false, 'd');
      case 'C':
        return this.change(editor, editor.cursor, this.lineEnd(editor, editor.cursor), false, 'c');
      case 's':
        return this.change(editor, editor.cursor, Math.min(this.lineEnd(editor, editor.cursor), editor.cursor + count), false, 'c');
      case 'S':
        return this.lines(editor, count, 'c');
      case '~': {
        const chars = [...editor.text];
        const end = Math.min(this.lineEnd(editor, editor.cursor), editor.cursor + count);
        if (editor.cursor >= end) return;
        this.pushUndo({ text: editor.text, cursor: editor.cursor });
        for (let i = editor.cursor; i < end; i++) {
          const c = chars[i]!;
          chars[i] = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
        }
        editor.set(chars.join(''), end);
        return this.clamp(editor);
      }
      case 'J': {
        const end = this.lineEnd(editor, editor.cursor);
        const chars = [...editor.text];
        if (end >= chars.length) return;
        this.pushUndo({ text: editor.text, cursor: editor.cursor });
        let next = end + 1;
        while (next < chars.length && (chars[next] === ' ' || chars[next] === '\t')) next++;
        chars.splice(end, next - end, ' ');
        editor.set(chars.join(''), end);
        return;
      }
      case 'p':
      case 'P':
        return this.put(editor, char === 'p', count);
      case 'u': {
        const previous = this.undo.pop();
        if (!previous) return;
        editor.set(previous.text, previous.cursor);
        return this.clamp(editor);
      }
      case 'j':
      case 'k': {
        const moved = this.verticalMotion(editor, char === 'j' ? count : -count);
        if (moved === null) {
          // On the first or last line, j and k go through the messages sent before, as Down and Up do.
          if (char === 'k') editor.historyBack();
          else editor.historyForward();
          editor.cursor = this.lineStart(editor, editor.cursor);
        } else editor.cursor = moved.to;
        return this.clamp(editor);
      }
      default: {
        const motion = this.motion(char, count, editor);
        if (!motion) return;
        editor.cursor = motion.to;
        this.clamp(editor);
      }
    }
  }

  private finishAwaited(char: string, editor: LineEditor): void {
    const awaited = this.awaiting!;
    this.awaiting = null;
    const count = Math.max(1, Number(this.count || '1'));
    this.count = '';
    if (awaited === 'r') {
      const end = this.lineEnd(editor, editor.cursor);
      if (editor.cursor + count > end) return;
      this.pushUndo({ text: editor.text, cursor: editor.cursor });
      const chars = [...editor.text];
      for (let i = 0; i < count; i++) chars[editor.cursor + i] = char;
      editor.set(chars.join(''), editor.cursor + count - 1);
      return;
    }
    const motion = awaited === 'g' ? (char === 'g' ? { to: 0, inclusive: false, linewise: true } : null) : this.find({ kind: awaited, char }, count, editor);
    if (awaited !== 'g' && motion) this.lastFind = { kind: awaited, char };
    if (!motion) {
      this.operator = null;
      return;
    }
    if (this.operator) return this.applyOperator(motion, editor);
    editor.cursor = motion.to;
    this.clamp(editor);
  }

  private operatorKey(char: string, count: number, editor: LineEditor): void {
    const operator = this.operator!;
    if (char === operator.name) {
      this.operator = null;
      return this.lines(editor, count, operator.name);
    }
    if (char === 'f' || char === 'F' || char === 't' || char === 'T' || char === 'g') {
      this.awaiting = char;
      this.count = count > 1 ? String(count) : '';
      this.operator = { name: operator.name, count: 1 };
      return;
    }
    // cw changes to the end of the word, not up to the next one, as in vim.
    const motion = this.motion(operator.name === 'c' && (char === 'w' || char === 'W') ? (char === 'w' ? 'e' : 'E') : char, count, editor, operator.name === 'c');
    if (!motion) {
      this.operator = null;
      return;
    }
    this.applyOperator(motion, editor);
  }

  private applyOperator(motion: Motion, editor: LineEditor): void {
    const operator = this.operator!;
    this.operator = null;
    if (motion.linewise) {
      const from = this.lineStart(editor, Math.min(editor.cursor, motion.to));
      const to = this.lineEnd(editor, Math.max(editor.cursor, motion.to));
      return this.changeLines(editor, from, to, operator.name);
    }
    const from = Math.min(editor.cursor, motion.to);
    const to = Math.max(editor.cursor, motion.to) + (motion.inclusive ? 1 : 0);
    this.change(editor, from, Math.min(to, [...editor.text].length), false, operator.name);
  }

  /** dd, cc, yy and S: whole lines, from the cursor's down. */
  private lines(editor: LineEditor, count: number, operator: Operator): void {
    const from = this.lineStart(editor, editor.cursor);
    let to = this.lineEnd(editor, editor.cursor);
    for (let i = 1; i < count && to < [...editor.text].length; i++) to = this.lineEnd(editor, to + 1);
    this.changeLines(editor, from, to, operator);
  }

  /** `from` to `to` are the start of a line and the end of a line, without its line break. */
  private changeLines(editor: LineEditor, from: number, to: number, operator: Operator): void {
    const chars = [...editor.text];
    this.register = { text: chars.slice(from, to).join(''), linewise: true };
    if (operator === 'y') return;
    this.pushUndo({ text: editor.text, cursor: editor.cursor });
    if (operator === 'c') {
      // The lines are emptied, and typing starts where they were.
      chars.splice(from, to - from);
      editor.set(chars.join(''), from);
      this.mode = 'insert';
      this.insertStart = null;
      return;
    }
    // With the line break before or after, so no empty line is left.
    const removeFrom = to < chars.length ? from : Math.max(0, from - 1);
    const removeTo = to < chars.length ? to + 1 : to;
    chars.splice(removeFrom, removeTo - removeFrom);
    editor.set(chars.join(''), Math.min(removeFrom, chars.length));
    editor.cursor = this.lineStart(editor, editor.cursor);
    this.clamp(editor);
  }

  private change(editor: LineEditor, from: number, to: number, linewise: boolean, operator: Operator): void {
    const chars = [...editor.text];
    this.register = { text: chars.slice(from, to).join(''), linewise };
    if (operator === 'y') {
      editor.cursor = from;
      return;
    }
    this.pushUndo({ text: editor.text, cursor: editor.cursor });
    chars.splice(from, to - from);
    editor.set(chars.join(''), from);
    if (operator === 'c') {
      this.mode = 'insert';
      this.insertStart = null;
    } else this.clamp(editor);
  }

  private put(editor: LineEditor, after: boolean, count: number): void {
    const { text, linewise } = this.register;
    if (text === '') return;
    this.pushUndo({ text: editor.text, cursor: editor.cursor });
    const chars = [...editor.text];
    const repeated = Array.from({ length: count }, () => text).join(linewise ? '\n' : '');
    if (linewise) {
      const at = after ? this.lineEnd(editor, editor.cursor) : this.lineStart(editor, editor.cursor);
      const inserted = after ? `\n${repeated}` : `${repeated}\n`;
      chars.splice(at, 0, ...inserted);
      editor.set(chars.join(''), after ? at + 1 : at);
      return;
    }
    const at = after && chars.length > 0 ? Math.min(this.lineEnd(editor, editor.cursor), editor.cursor + 1) : editor.cursor;
    chars.splice(at, 0, ...repeated);
    editor.set(chars.join(''), at + [...repeated].length - 1);
    this.clamp(editor);
  }

  private firstNonBlank(editor: LineEditor): number {
    const chars = [...editor.text];
    let i = this.lineStart(editor, editor.cursor);
    const end = this.lineEnd(editor, editor.cursor);
    while (i < end && /\s/.test(chars[i]!)) i++;
    return i;
  }

  private verticalMotion(editor: LineEditor, lines: number): Motion | null {
    const chars = [...editor.text];
    const column = editor.cursor - this.lineStart(editor, editor.cursor);
    let start = this.lineStart(editor, editor.cursor);
    for (let i = 0; i < Math.abs(lines); i++) {
      if (lines > 0) {
        const end = this.lineEnd(editor, start);
        if (end >= chars.length) return i === 0 ? null : { to: start + Math.min(column, this.lineEnd(editor, start) - start), inclusive: false, linewise: true };
        start = end + 1;
      } else {
        if (start === 0) return i === 0 ? null : { to: start + Math.min(column, this.lineEnd(editor, start) - start), inclusive: false, linewise: true };
        start = this.lineStart(editor, start - 1);
      }
    }
    return { to: start + Math.min(column, this.lineEnd(editor, start) - start), inclusive: false, linewise: true };
  }

  private motion(char: string, count: number, editor: LineEditor, forChange = false): Motion | null {
    const chars = [...editor.text];
    const at = editor.cursor;
    const start = this.lineStart(editor, at);
    const end = this.lineEnd(editor, at);
    switch (char) {
      case 'h':
        return { to: Math.max(start, at - count), inclusive: false };
      case 'l':
      case ' ':
        return { to: Math.min(end, at + count), inclusive: false };
      case '0':
        return { to: start, inclusive: false };
      case '^':
        return { to: this.firstNonBlank(editor), inclusive: false };
      case '$':
        return { to: Math.max(start, end - 1), inclusive: true };
      case 'G':
        return { to: this.lineStart(editor, chars.length), inclusive: false, linewise: true };
      case 'j':
      case 'k':
        return this.verticalMotion(editor, char === 'j' ? count : -count);
      case 'w':
      case 'W': {
        let i = at;
        for (let n = 0; n < count && i < chars.length; n++) {
          const big = char === 'W';
          const kind = classOf(chars[i], big);
          while (i < chars.length && kind !== 0 && classOf(chars[i], big) === kind) i++;
          while (i < chars.length && classOf(chars[i], big) === 0) i++;
        }
        return { to: i, inclusive: false };
      }
      case 'e':
      case 'E': {
        const big = char === 'E';
        let i = at;
        for (let n = 0; n < count; n++) {
          // cw on the last character of a word changes just that character.
          if (!(forChange && n === 0 && classOf(chars[i], big) !== 0 && classOf(chars[i + 1], big) !== classOf(chars[i], big))) i++;
          else break;
          while (i < chars.length && classOf(chars[i], big) === 0) i++;
          const kind = classOf(chars[i], big);
          while (i + 1 < chars.length && classOf(chars[i + 1], big) === kind) i++;
        }
        return { to: Math.min(i, chars.length - 1), inclusive: true };
      }
      case 'b':
      case 'B': {
        const big = char === 'B';
        let i = at;
        for (let n = 0; n < count && i > 0; n++) {
          i--;
          while (i > 0 && classOf(chars[i], big) === 0) i--;
          const kind = classOf(chars[i], big);
          while (i > 0 && classOf(chars[i - 1], big) === kind) i--;
        }
        return { to: i, inclusive: false };
      }
      case ';':
      case ',': {
        if (!this.lastFind) return null;
        const reversed = { f: 'F', F: 'f', t: 'T', T: 't' } as const;
        return this.find(char === ';' ? this.lastFind : { kind: reversed[this.lastFind.kind], char: this.lastFind.char }, count, editor, true);
      }
      default:
        return null;
    }
  }

  /** f and t find a character forward on the line, F and T backward; t and T stop next to it. */
  private find(find: Find, count: number, editor: LineEditor, repeat = false): Motion | null {
    const chars = [...editor.text];
    const start = this.lineStart(editor, editor.cursor);
    const end = this.lineEnd(editor, editor.cursor);
    const forward = find.kind === 'f' || find.kind === 't';
    const till = find.kind === 't' || find.kind === 'T';
    let i = editor.cursor;
    for (let n = 0; n < count; n++) {
      // Repeating t or T would find the same character again, right next to the cursor.
      let next = forward ? i + 1 + (repeat && till && n === 0 ? 1 : 0) : i - 1 - (repeat && till && n === 0 ? 1 : 0);
      while (next >= start && next < end && chars[next] !== find.char) next += forward ? 1 : -1;
      if (next < start || next >= end) return null;
      i = next;
    }
    const to = till ? i + (forward ? -1 : 1) : i;
    return { to, inclusive: forward };
  }
}
