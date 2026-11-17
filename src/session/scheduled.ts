/**
 * Scheduled prompts saved in the project's workspace folder, so they outlive the process: a
 * session's own jobs come back when it is resumed, and durable jobs run in any later session of
 * the project. Several sessions may share the file, so every change reads it again first while
 * holding a lock file, and a run is claimed with a file that only one of them can create.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceScheduledPath, workspaceScheduledRunsDir } from '../config/paths.ts';

/**
 * A change holds the lock for well under a millisecond, so a lock this old was left by a session
 * that died holding it, and is taken over.
 */
const LOCK_STALE_MS = 2_000;
const LOCK_RETRY_MS = 5;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Waits without returning to the event loop, as the changes it guards are synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export interface StoredJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  /** Milliseconds since the epoch. Recurring jobs expire seven days after this. */
  createdAt: number;
  /** The session that made it, which gets it back when resumed. */
  sessionId: string;
  /** Runs in every session of the project, not only the one that made it. */
  durable: boolean;
  /** Made by /loop, which can stop it. */
  loop?: boolean;
  /** Runs the /loop default prompt as it reads at the time, rather than `prompt`. */
  loopDefault?: boolean;
  /** For a one-shot job: the minute it is due. One whose time passed is not brought back. */
  runAt?: number;
}

export interface JobStore {
  load(): StoredJob[];
  /** Returns false when the job could not be saved, as when the file cannot be read. */
  save(job: StoredJob): boolean;
  remove(id: string): void;
  /** Also true when the file cannot be read, so a job is not taken for cancelled because of that. */
  has(id: string): boolean;
  /** True for the first session to claim this run of the job, false for any other. */
  claim(id: string, at: number): boolean;
  /** Why the file cannot be used right now, if it cannot. */
  problem(): string | undefined;
}

function isStoredJob(value: unknown): value is StoredJob {
  const job = value as Partial<StoredJob> | null;
  return (
    typeof job === 'object' &&
    job !== null &&
    typeof job.id === 'string' &&
    /^[0-9a-f]{8}$/.test(job.id) &&
    typeof job.cron === 'string' &&
    typeof job.prompt === 'string' &&
    typeof job.recurring === 'boolean' &&
    typeof job.createdAt === 'number' &&
    typeof job.sessionId === 'string' &&
    typeof job.durable === 'boolean'
  );
}

export class WorkspaceJobStore implements JobStore {
  private readonly path: string;
  private readonly lockPath: string;
  private readonly runsDir: string;
  private unreadable: string | undefined;

  constructor(projectDir: string) {
    this.path = workspaceScheduledPath(projectDir);
    this.lockPath = `${this.path}.lock`;
    this.runsDir = workspaceScheduledRunsDir(projectDir);
  }

  /**
   * Runs `change` holding the lock file, so that another session cannot read the file between
   * this one reading and writing it, and have one of the two changes lost.
   */
  private locked<T>(change: () => T): T {
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const token = `${process.pid} ${randomUUID()}`;
    for (;;) {
      try {
        writeFileSync(this.lockPath, token, { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      let age: number;
      try {
        age = Date.now() - statSync(this.lockPath).mtimeMs;
      } catch {
        continue; // Released meanwhile.
      }
      if (age > LOCK_STALE_MS) rmSync(this.lockPath, { force: true });
      else sleepSync(LOCK_RETRY_MS);
    }
    try {
      return change();
    } finally {
      // Only this session's own lock: if another session took this one over as stale, the lock
      // there now is theirs.
      try {
        if (readFileSync(this.lockPath, 'utf8') === token) rmSync(this.lockPath, { force: true });
      } catch {
        // Already gone.
      }
    }
  }

  /** Problems with the file, for the session to show. One at most, however often it is read. */
  get warnings(): string[] {
    return this.unreadable ? [this.unreadable] : [];
  }

  problem(): string | undefined {
    return this.unreadable;
  }

  /**
   * Every entry in the file, including ones this version does not understand, which are kept
   * when it is written. Null when the file exists but cannot be read as a list of jobs: then
   * nothing is written to it, so a file half edited by hand is not replaced by a near-empty one.
   */
  private read(): unknown[] | null {
    if (!existsSync(this.path)) {
      this.unreadable = undefined;
      return [];
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { jobs?: unknown };
      if (!Array.isArray(parsed.jobs)) throw new Error('it has no "jobs" list');
      this.unreadable = undefined;
      return parsed.jobs;
    } catch (error) {
      this.unreadable = `Could not read the scheduled jobs in ${this.path}: ${(error as Error).message}. Jobs are not saved, and none are removed, until it is fixed or deleted.`;
      return null;
    }
  }

  load(): StoredJob[] {
    return (this.read() ?? []).filter(isStoredJob);
  }

  /** Written whole to a temporary file and renamed, so a reader never sees half of it. */
  private write(entries: unknown[]): void {
    mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ jobs: entries }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private static isJob(entry: unknown, id: string): boolean {
    return isStoredJob(entry) && entry.id === id;
  }

  save(job: StoredJob): boolean {
    return this.locked(() => {
      const entries = this.read();
      if (!entries) return false;
      this.write([...entries.filter((entry) => !WorkspaceJobStore.isJob(entry, job.id)), job]);
      return true;
    });
  }

  remove(id: string): void {
    // With no file there is nothing to take out, and no folder to make for a lock.
    if (!existsSync(this.path)) this.read();
    else {
      this.locked(() => {
        const entries = this.read();
        if (!entries) return;
        if (entries.some((entry) => WorkspaceJobStore.isJob(entry, id))) this.write(entries.filter((entry) => !WorkspaceJobStore.isJob(entry, id)));
      });
    }
    this.dropClaims(id);
  }

  has(id: string): boolean {
    const entries = this.read();
    return entries === null || entries.some((entry) => WorkspaceJobStore.isJob(entry, id));
  }

  claim(id: string, at: number): boolean {
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    try {
      // `wx` fails if the file exists, and only one process can create it.
      closeSync(openSync(join(this.runsDir, `${id}-${at}`), 'wx', 0o600));
    } catch {
      return false;
    }
    this.dropClaims(id, at);
    return true;
  }

  /** Claims for earlier runs are no longer needed once a later one is claimed. */
  private dropClaims(id: string, keep?: number): void {
    let names: string[];
    try {
      names = readdirSync(this.runsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(`${id}-`) && name !== `${id}-${keep}`) rmSync(join(this.runsDir, name), { force: true });
    }
  }
}
