/** Terminal widgets for choosing from a list and typing a key without showing it. */
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { PickItem } from '../commands/slash.ts';
import { sanitize, style } from './render.ts';

/** Items shown at once. The list scrolls to keep the selection in view. */
const ROWS = 10;

type KeyListener = (text: string | undefined, key: Key | undefined) => void;

/** Takes the keyboard for one widget, and gives it back as it was. */
function captureKeys(onKey: KeyListener): () => void {
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

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
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
      const labelWidth = Math.min(32, Math.max(0, ...list.slice(start, start + ROWS).map((item) => sanitize(item.label).length)));
      const lines = [style.bold(clip(sanitize(title), width))];
      lines.push(style.dim(clip(filter ? `  Filter: ${sanitize(filter)}` : '  Type to filter', width)));
      if (list.length === 0) lines.push(style.dim('  Nothing matches.'));
      list.slice(start, start + ROWS).forEach((item, i) => {
        const label = clip(sanitize(item.label), labelWidth).padEnd(labelWidth);
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
