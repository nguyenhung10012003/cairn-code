/**
 * Watches the files that FileChanged hooks name, and reports each change once things settle.
 * A directory is watched rather than the file, so a file that is created, or replaced by an
 * editor writing a new copy and renaming it, is still seen.
 */
import { existsSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

export type FileEvent = 'change' | 'add' | 'unlink';

/** Editors write a file in several steps; one report follows the last of them. */
const SETTLE_MS = 100;

export class FileWatcher {
  private readonly onChange: (path: string, event: FileEvent) => void;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  /** Whether each watched file existed when last seen, to tell a creation from a change. */
  private readonly present = new Map<string, boolean>();
  private paths = new Set<string>();

  constructor(onChange: (path: string, event: FileEvent) => void) {
    this.onChange = onChange;
  }

  /** Watches exactly these absolute paths from now on. */
  setPaths(paths: Iterable<string>): void {
    this.paths = new Set(paths);
    const dirs = new Set([...this.paths].map((path) => dirname(path)));
    for (const [dir, watcher] of this.watchers) {
      if (dirs.has(dir)) continue;
      watcher.close();
      this.watchers.delete(dir);
    }
    for (const path of this.paths) if (!this.present.has(path)) this.present.set(path, existsSync(path));
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        // Not persistent: watching files must not keep a finished session running.
        const watcher = watch(dir, { persistent: false }, (_type, name) => {
          if (name !== null) this.touched(`${dir}/${basename(name.toString())}`);
        });
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // A directory that does not exist yet cannot be watched; nothing in it is reported.
      }
    }
  }

  private touched(path: string): void {
    if (!this.paths.has(path)) return;
    clearTimeout(this.pending.get(path));
    this.pending.set(
      path,
      setTimeout(() => {
        this.pending.delete(path);
        const was = this.present.get(path) ?? false;
        const is = existsSync(path);
        this.present.set(path, is);
        if (!was && !is) return;
        this.onChange(path, !is ? 'unlink' : was ? 'change' : 'add');
      }, SETTLE_MS).unref(),
    );
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
