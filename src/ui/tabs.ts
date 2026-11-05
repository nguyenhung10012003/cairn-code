/**
 * Tabs on a screen of their own. They are drawn on the terminal's alternate screen, so the
 * conversation is out of sight while they are open and comes back as it was when they close.
 */
import type { TabPage } from '../commands/slash.ts';
import { captureKeys } from './picker.ts';
import { clipToWidth, displayWidth, sanitize, style } from './render.ts';

const ENTER = '\x1b[?1049h\x1b[?25l';
const LEAVE = '\x1b[?25h\x1b[?1049l';
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
/** The tab bar, the rule under it and a blank line. */
const HEADER_ROWS = 3;

export interface TabViewOptions {
  /** The tab shown first. */
  initial?: number;
  /** A line shown above the key hints while it returns text, such as a prompt that is waiting. Checked a few times a second. */
  notice?: () => string | undefined;
}

/**
 * `←` `→` (or Tab, or a tab's number) switch tabs, `↑` `↓`, PgUp PgDn, Home and End scroll, and
 * Esc, `q` or Ctrl+C close the view. Resolves once it is closed.
 */
export function showTabs(title: string, tabs: TabPage[], options: TabViewOptions = {}): Promise<void> {
  const out = process.stdout;
  return new Promise((resolve) => {
    if (tabs.length === 0) {
      resolve();
      return;
    }
    let current = Math.min(Math.max(0, options.initial ?? 0), tabs.length - 1);
    const pages = new Map<number, string[]>();
    const offsets = tabs.map(() => 0);
    let notice: string | undefined;

    const page = (index: number): string[] => {
      let lines = pages.get(index);
      if (!lines) {
        try {
          lines = tabs[index]!.lines().flatMap((line) => line.split('\n')).map(sanitize);
        } catch (error) {
          lines = [`Could not show this tab: ${sanitize((error as Error).message)}`];
        }
        pages.set(index, lines);
      }
      return lines;
    };

    const geometry = (): { usable: number; height: number; body: number } => {
      const width = Math.max(20, out.columns || 80);
      const height = Math.max(8, out.rows || 24);
      return { usable: width - 1, height, body: height - HEADER_ROWS - (notice ? 2 : 1) };
    };

    const tabBar = (usable: number): string => {
      // The same width selected or not, so the bar does not shift when the selection moves.
      const labels = tabs.map((tab, i) => (i === current ? `[ ${sanitize(tab.title)} ]` : `  ${sanitize(tab.title)}  `));
      if (displayWidth(` ${title}   ${labels.join(' ')}`) <= usable) {
        const shown = labels.map((label, i) => (i === current ? style.cyan(style.bold(label)) : style.dim(label)));
        return ` ${style.bold(sanitize(title))}   ${shown.join(' ')}`;
      }
      // Too narrow for every tab: the current one, and where it is among them.
      return style.cyan(style.bold(clipToWidth(` ‹ ${sanitize(tabs[current]!.title)} › ${current + 1}/${tabs.length}`, usable)));
    };

    const render = (): void => {
      notice = options.notice?.();
      const { usable, body } = geometry();
      const lines = page(current);
      const limit = Math.max(0, lines.length - body);
      const offset = (offsets[current] = Math.min(offsets[current]!, limit));
      const rows = [tabBar(usable), style.dim('─'.repeat(usable)), ''];
      for (let i = 0; i < body; i++) {
        const line = lines[offset + i];
        rows.push(line ? clipToWidth(` ${line}`, usable) : '');
      }
      if (notice) rows.push(style.yellow(clipToWidth(sanitize(notice), usable)));
      const scrolls = lines.length > body;
      const position = scrolls ? `${offset + 1}-${Math.min(lines.length, offset + body)} of ${lines.length} · ` : '';
      rows.push(style.dim(clipToWidth(` ${position}←→ switch tab · ${scrolls ? '↑↓ scroll · ' : ''}Esc back`, usable)));
      // Each row is placed by its number and never reaches the last column, so nothing scrolls.
      out.write(`${SYNC_START}${rows.map((row, i) => `\x1b[${i + 1};1H${row}\x1b[K`).join('')}${SYNC_END}`);
    };

    const switchTo = (index: number): void => {
      current = (index + tabs.length) % tabs.length;
      render();
    };

    const scrollBy = (step: number): void => {
      const limit = Math.max(0, page(current).length - geometry().body);
      offsets[current] = Math.min(limit, Math.max(0, offsets[current]! + step));
      render();
    };

    // However the process ends, the shell gets its own screen back.
    const restore = (): void => void out.write(LEAVE);
    const timer = options.notice
      ? setInterval(() => {
          if (options.notice!() !== notice) render();
        }, 250)
      : undefined;

    const close = (): void => {
      release();
      if (timer) clearInterval(timer);
      out.off('resize', render);
      process.off('exit', restore);
      restore();
      resolve();
    };

    const release = captureKeys((text, key) => {
      switch (key?.name) {
        case 'escape':
          return close();
        case 'left':
          return switchTo(current - 1);
        case 'right':
          return switchTo(current + 1);
        case 'tab':
          return switchTo(current + (key.shift ? -1 : 1));
        case 'up':
          return scrollBy(-1);
        case 'down':
          return scrollBy(1);
        case 'pageup':
          return scrollBy(-Math.max(1, geometry().body - 1));
        case 'pagedown':
          return scrollBy(Math.max(1, geometry().body - 1));
        case 'home':
          return scrollBy(Number.NEGATIVE_INFINITY);
        case 'end':
          return scrollBy(Number.POSITIVE_INFINITY);
      }
      if (key?.ctrl) {
        if (key.name === 'c') close();
        return;
      }
      if (key?.meta || !text) return;
      if (text === 'q') return close();
      const number = Number(text);
      if (Number.isInteger(number) && number >= 1 && number <= tabs.length) switchTo(number - 1);
    });
    process.once('exit', restore);
    out.on('resize', render);
    out.write(ENTER);
    render();
  });
}
