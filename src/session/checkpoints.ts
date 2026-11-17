/**
 * File snapshots taken before the agent changes a file, so a turn can be undone. Only changes
 * through Edit and Write are covered: what a shell command does to files is not tracked.
 */
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileHistoryDir } from '../config/paths.ts';

interface SnapshotEntry {
  turn: number;
  path: string;
  /** Backup file name, or null when the file did not exist before this turn. */
  backup: string | null;
}

export interface RewindResult {
  restored: string[];
  removed: string[];
  skipped: string[];
}

export class CheckpointStore {
  private readonly dir: string;
  private readonly manifest: string;
  private readonly entries: SnapshotEntry[] = [];
  private turn = 0;

  constructor(sessionId: string) {
    this.dir = fileHistoryDir(sessionId);
    this.manifest = join(this.dir, 'manifest.jsonl');
    if (existsSync(this.manifest)) {
      for (const line of readFileSync(this.manifest, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SnapshotEntry | { start: number };
          if ('start' in entry) {
            this.turn = Math.max(this.turn, entry.start);
            continue;
          }
          this.entries.push(entry);
          this.turn = Math.max(this.turn, entry.turn);
        } catch {
          // A partial final line from a crash; earlier snapshots remain usable.
        }
      }
    }
  }

  /**
   * Called for each user prompt. Snapshots are grouped by the turn that made them. Each start is
   * written down, so a resumed session still counts its turns from the end, as /rewind does.
   */
  beginTurn(): number {
    this.turn += 1;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.manifest, `${JSON.stringify({ start: this.turn })}\n`, { mode: 0o600 });
    } catch {
      // Without the line, a resumed session counts fewer turns; the snapshots are still right.
    }
    return this.turn;
  }

  /** The number of the turn running now, or the last one. */
  get currentTurn(): number {
    return this.turn;
  }

  async snapshot(path: string): Promise<void> {
    if (this.entries.some((e) => e.turn === this.turn && e.path === path)) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let backup: string | null = null;
    try {
      const info = await lstat(path);
      if (info.isFile()) {
        backup = `${this.turn}-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;
        await copyFile(path, join(this.dir, backup));
      } else {
        // Symlinks and hard-to-restore types are left alone rather than restored wrongly.
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const entry: SnapshotEntry = { turn: this.turn, path, backup };
    this.entries.push(entry);
    appendFileSync(this.manifest, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Turns that changed files, newest first. */
  turnsWithChanges(): number[] {
    return [...new Set(this.entries.map((e) => e.turn))].sort((a, b) => b - a);
  }

  /** Undoes the last `count` turns that changed files. */
  rewind(count = 1): Promise<RewindResult> {
    return this.undo(new Set(this.turnsWithChanges().slice(0, count)));
  }

  /** Undoes turn `first` and every turn after it, putting files back as they were before it began. */
  rewindFrom(first: number): Promise<RewindResult> {
    return this.undo(new Set(this.turnsWithChanges().filter((turn) => turn >= first)));
  }

  private async undo(targets: Set<number>): Promise<RewindResult> {
    const result: RewindResult = { restored: [], removed: [], skipped: [] };
    if (targets.size === 0) return result;

    // The earliest snapshot of a path is its state before all the turns being undone.
    const earliest = new Map<string, SnapshotEntry>();
    for (const entry of this.entries) {
      if (targets.has(entry.turn) && !earliest.has(entry.path)) earliest.set(entry.path, entry);
    }
    for (const [path, entry] of earliest) {
      if (await isSymlink(path)) {
        result.skipped.push(path);
      } else if (entry.backup === null) {
        await rm(path, { force: true });
        result.removed.push(path);
      } else {
        await mkdir(dirname(path), { recursive: true });
        await copyFile(join(this.dir, entry.backup), path);
        result.restored.push(path);
      }
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (targets.has(this.entries[i]!.turn)) this.entries.splice(i, 1);
    }
    return result;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}
