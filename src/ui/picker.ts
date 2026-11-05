/** Terminal widgets for choosing from a list and typing a key without showing it. */
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { PickItem } from '../commands/slash.ts';
import { clipToWidth, displayWidth, sanitize, style, tailToWidth } from './render.ts';

/** Items shown at once. The list scrolls to keep the selection in view. */
const ROWS = 10;

type KeyListener = (text: string | undefined, key: Key | undefined) => void;

/** Takes the keyboard for one widget, and gives it back as it was. */
export function captureKeys(onKey: KeyListener): () => void {
  const stdin = process.stdin;
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw === true;
  // Not isPaused(): a stream nothing has read from yet is neither paused nor flowing, and left
  // flowing afterwards it would keep the process from exiting.
  const wasFlowing = stdin.readableFlowing === true;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on('keypress', onKey);
  return () => {
    stdin.off('keypress', onKey);
    stdin.setRawMode?.(wasRaw);
    if (!wasFlowing) stdin.pause();
  };
}

function printable(text: string | undefined, key: Key | undefined): string {
  if (!text || key?.ctrl || key?.meta) return '';
  // Control characters, including the ones a pasted line ends with.
  return text.replace(/[\x00-\x1f\x7f]/g, '');
}

const clip = clipToWidth;

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Writes a block of lines, over the block it drew last time. Returns how many lines it drew. */
function redraw(out: NodeJS.WriteStream, lines: string[], drawn: number): number {
  const back = drawn > 1 ? `\x1b[${drawn - 1}A` : '';
  out.write(`${drawn > 0 ? `\r${back}\x1b[0J` : ''}${lines.join('\n')}`);
  return lines.length;
}

/** Erases the block and leaves the cursor where it started. */
function erase(out: NodeJS.WriteStream, drawn: number): void {
  out.write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ''}\x1b[0J`);
}

export interface ChoiceOption {
  label: string;
  /** A key that picks this option at once, such as `y`. */
  key?: string;
  /** What the option says while a note is being typed for it, such as "No, and tell the model". */
  notePrompt: string;
}

export interface Choice {
  index: number;
  /** What the user typed after pressing Tab, when anything. */
  note?: string;
}

/**
 * Options one per line. ↑↓ move, and Enter, the option's number or its key picks one. Tab opens
 * a line to add a note to the highlighted option, which Enter then sends with it. Esc and Ctrl+C
 * pick `cancelIndex`.
 */
export function chooseWithNote(options: ChoiceOption[], settings: { cancelIndex: number; initial?: number }): Promise<Choice> {
  const out = process.stdout;
  return new Promise((resolve) => {
    let selected = settings.initial ?? 0;
    let noting = false;
    let note = '';
    let drawn = 0;

    const render = (): void => {
      const width = Math.max(20, (out.columns || 80) - 1);
      const lines = options.map((option, i) => {
        const number = `${i + 1}. `;
        if (i !== selected) return `  ${style.dim(number)}${clip(sanitize(option.label), width - 2 - number.length)}`;
        if (!noting) return `${style.cyan('❯')} ${style.cyan(`${number}${clip(sanitize(option.label), width - 2 - number.length)}`)}`;
        const prompt = `${number}${sanitize(option.notePrompt)}: `;
        const room = Math.max(4, width - 3 - displayWidth(prompt));
        return `${style.cyan('❯')} ${style.cyan(prompt)}${tailToWidth(sanitize(note), room)}\x1b[7m \x1b[27m`;
      });
      const hint = noting
        ? '  Enter choose with this note · Esc back'
        : `  ↑↓ move · Enter choose · Tab add a note · Esc ${options[settings.cancelIndex]!.label.toLowerCase()}`;
      lines.push(style.dim(clip(hint, width)));
      drawn = redraw(out, lines, drawn);
    };

    const finish = (index: number, withNote: string | undefined): void => {
      release();
      erase(out, drawn);
      const option = options[index]!;
      const text = withNote ? `${option.notePrompt}: ${withNote}` : option.label;
      out.write(`${style.cyan('→')} ${clip(sanitize(text), Math.max(20, (out.columns || 80) - 3))}\n\x1b[?25h`);
      resolve(withNote ? { index, note: withNote } : { index });
    };

    const release = captureKeys((text, key) => {
      if (key?.ctrl && key.name === 'c') return finish(settings.cancelIndex, undefined);
      if (noting) {
        switch (key?.name) {
          case 'return':
          case 'enter':
            return finish(selected, note.trim() || undefined);
          case 'escape':
          case 'tab':
            noting = false;
            note = '';
            return render();
          case 'backspace':
            note = [...note].slice(0, -1).join('');
            return render();
        }
        if (key?.ctrl && key.name === 'u') {
          note = '';
          return render();
        }
        const typed = printable(text, key);
        if (typed) {
          note += typed;
          render();
        }
        return;
      }
      switch (key?.name) {
        case 'up':
          selected = (selected - 1 + options.length) % options.length;
          return render();
        case 'down':
          selected = (selected + 1) % options.length;
          return render();
        case 'return':
        case 'enter':
          return finish(selected, undefined);
        case 'tab':
          if (key.shift) return;
          noting = true;
          return render();
        case 'escape':
          return finish(settings.cancelIndex, undefined);
      }
      const typed = printable(text, key).toLowerCase();
      if (!typed) return;
      const byNumber = Number(typed) - 1;
      if (Number.isInteger(byNumber) && byNumber >= 0 && byNumber < options.length) return finish(byNumber, undefined);
      const byKey = options.findIndex((option) => option.key === typed);
      if (byKey >= 0) finish(byKey, undefined);
    });
    out.write('\x1b[?25l');
    render();
  });
}

/**
 * A list the user narrows by typing and moves through with the arrow keys. Resolves to the
 * chosen item's value, or null on Esc. With `allowCustom`, the typed text can be chosen too.
 */
export function pickFromList(title: string, items: PickItem[], options: { initial?: string; allowCustom?: boolean } = {}): Promise<string | null> {
  const out = process.stdout;
  return new Promise((resolve) => {
    let filter = '';
    let selected = Math.max(0, items.findIndex((item) => item.value === options.initial));
    let drawn = 0;

    const visibleItems = (): PickItem[] => {
      const q = filter.toLowerCase();
      const matches = q ? items.filter((item) => `${item.label} ${item.value} ${item.detail ?? ''}`.toLowerCase().includes(q)) : items;
      const exact = matches.some((item) => item.value === filter);
      return options.allowCustom && filter && !exact ? [...matches, { value: filter, label: `Use "${filter}"`, detail: 'not in the list' }] : matches;
    };

    const render = (): void => {
      const list = visibleItems();
      selected = Math.min(selected, Math.max(0, list.length - 1));
      const width = Math.max(20, (out.columns || 80) - 1);
      const start = Math.min(Math.max(0, selected - ROWS + 1), Math.max(0, list.length - ROWS));
      const labelWidth = Math.min(32, Math.max(0, ...list.slice(start, start + ROWS).map((item) => displayWidth(sanitize(item.label)))));
      const lines = [style.bold(clip(sanitize(title), width))];
      lines.push(style.dim(clip(filter ? `  Filter: ${sanitize(filter)}` : '  Type to filter', width)));
      if (list.length === 0) lines.push(style.dim('  Nothing matches.'));
      list.slice(start, start + ROWS).forEach((item, i) => {
        const label = padTo(clip(sanitize(item.label), labelWidth), labelWidth);
        const detail = item.detail ? clip(sanitize(item.detail), Math.max(0, width - labelWidth - 6)) : '';
        lines.push(
          start + i === selected
            ? `${style.cyan('❯')} ${style.cyan(style.bold(label))}  ${detail}`.trimEnd()
            : `  ${label}  ${style.dim(detail)}`.trimEnd(),
        );
      });
      const position = list.length > ROWS ? `${selected + 1}/${list.length} · ` : '';
      lines.push(style.dim(clip(`  ${position}↑↓ move · Enter choose · Esc cancel`, width)));
      // Back to the first line drawn, then over everything below it.
      const back = drawn > 1 ? `\x1b[${drawn - 1}A` : '';
      out.write(`${drawn > 0 ? `\r${back}\x1b[0J` : ''}${lines.join('\n')}`);
      drawn = lines.length;
    };

    const finish = (value: string | null, label?: string): void => {
      release();
      out.write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ''}\x1b[0J${style.bold(sanitize(title))} ${value === null ? style.dim('cancelled') : style.cyan(sanitize(label ?? value))}\n\x1b[?25h`);
      resolve(value);
    };

    const release = captureKeys((text, key) => {
      const list = visibleItems();
      switch (key?.name) {
        case 'up':
          selected = list.length ? (selected - 1 + list.length) % list.length : 0;
          return render();
        case 'down':
          selected = list.length ? (selected + 1) % list.length : 0;
          return render();
        case 'pageup':
          selected = Math.max(0, selected - ROWS);
          return render();
        case 'pagedown':
          selected = Math.min(Math.max(0, list.length - 1), selected + ROWS);
          return render();
        case 'return':
        case 'enter': {
          const choice = list[selected];
          if (choice) finish(choice.value, choice.label.startsWith('Use "') ? choice.value : choice.label);
          return;
        }
        case 'escape':
          return finish(null);
        case 'backspace':
          filter = filter.slice(0, -1);
          selected = 0;
          return render();
      }
      if (key?.ctrl && key.name === 'c') return finish(null);
      if (key?.ctrl && key.name === 'u') {
        filter = '';
        selected = 0;
        return render();
      }
      const typed = printable(text, key);
      if (typed) {
        filter += typed;
        selected = 0;
        render();
      }
    });
    out.write('\x1b[?25l');
    render();
  });
}

/** Reads a line without showing it, for API keys. Resolves to null on Esc or Ctrl+C. */
export function readSecret(prompt: string): Promise<string | null> {
  const out = process.stdout;
  return new Promise((resolve) => {
    let value = '';
    out.write(prompt);
    const finish = (result: string | null): void => {
      release();
      out.write(result === null ? ` ${style.dim('cancelled')}\n` : '\n');
      resolve(result);
    };
    const release = captureKeys((text, key) => {
      if (key?.name === 'return' || key?.name === 'enter') return finish(value.trim());
      if (key?.name === 'escape' || (key?.ctrl && key.name === 'c')) return finish(null);
      if (key?.name === 'backspace') {
        if (value) {
          value = value.slice(0, -1);
          out.write('\b \b');
        }
        return;
      }
      if (key?.ctrl && key.name === 'u') {
        out.write('\b \b'.repeat(value.length));
        value = '';
        return;
      }
      const typed = printable(text, key);
      if (typed) {
        value += typed;
        out.write('*'.repeat(typed.length));
      }
    });
  });
}
