/**
 * Watches the files that FileChanged hooks name, and reports each change once things settle.
 * Each file is polled with `watchFile` rather than watched with `fs.watch`: Bun's `fs.watch` on
 * Linux reports nothing for a file whose name starts with a dot, such as `.envrc`, and polling
 * also sees a file that is created, or replaced by an editor writing a copy and renaming it.
 */
import { statSync, unwatchFile, watchFile } from 'node:fs';

export type FileEvent = 'change' | 'add' | 'unlink';

const POLL_MS = 250;
/** Editors write a file in several steps; one report follows the last of them. */
const SETTLE_MS = 100;

/** What tells one version of a file from another, or null when it is not there. */
function signature(path: string): string | null {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return null;
  }
}

export class FileWatcher {
  private readonly onChange: (path: string, event: FileEvent) => void;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** How each watched file was when last reported, to tell a creation from a change, and a change from nothing. */
  private readonly seen = new Map<string, string | null>();
  private paths = new Set<string>();

  constructor(onChange: (path: string, event: FileEvent) => void) {
    this.onChange = onChange;
  }

  /** Watches exactly these absolute paths from now on. */
  setPaths(paths: Iterable<string>): void {
    const next = new Set(paths);
    for (const path of this.paths) {
      if (next.has(path)) continue;
      unwatchFile(path);
      clearTimeout(this.pending.get(path));
      this.pending.delete(path);
      this.seen.delete(path);
    }
    for (const path of next) {
      if (this.paths.has(path)) continue;
      this.seen.set(path, signature(path));
      // Not persistent: watching files must not keep a finished session running.
      watchFile(path, { interval: POLL_MS, persistent: false }, () => this.touched(path));
    }
    this.paths = next;
  }

  private touched(path: string): void {
    if (!this.paths.has(path)) return;
    clearTimeout(this.pending.get(path));
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        const was = this.seen.get(path) ?? null;
        const is = signature(path);
        if (was === is) return;
        this.seen.set(path, is);
        this.onChange(path, is === null ? 'unlink' : was === null ? 'add' : 'change');
      }, SETTLE_MS).unref(),
    );
  }

  close(): void {
    for (const path of this.paths) unwatchFile(path);
    this.paths.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
