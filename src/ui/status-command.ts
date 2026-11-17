/**
 * The user's own status line: a command that receives the session's state as JSON on stdin and
 * prints a few lines, shown under the built-in status line. It runs again when something it may
 * show changes, at most once at a time and a few times a second, and its last output stays on
 * screen meanwhile.
 */
import { spawn } from 'node:child_process';
import type { StatusLineSettings } from '../config/settings.ts';

const MIN_GAP_MS = 300;
const TIMEOUT_MS = 5_000;
const MAX_LINES = 3;
const MAX_OUTPUT_CHARS = 10_000;

/** Its colors stay; any other escape sequence or control character, which could move the cursor or retitle the window, goes. */
export function keepColors(text: string): string {
  return text
    .replace(/\x1b\[[0-9;:]*m|\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g, (sequence) => (/^\x1b\[[0-9;:]*m$/.test(sequence) ? sequence : ''))
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
}

export class StatusCommand {
  private readonly settings: StatusLineSettings;
  private readonly input: () => Record<string, unknown>;
  private readonly cwd: () => string;
  private readonly onUpdate: () => void;
  private shown: string[] = [];
  private running = false;
  private again = false;
  private lastRun = 0;
  private delayed: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(settings: StatusLineSettings, options: { input: () => Record<string, unknown>; cwd: () => string; onUpdate: () => void }) {
    this.settings = settings;
    this.input = options.input;
    this.cwd = options.cwd;
    this.onUpdate = options.onUpdate;
  }

  start(): void {
    const seconds = this.settings.refreshInterval;
    if (typeof seconds === 'number' && seconds >= 1) {
      this.interval = setInterval(() => this.refresh(), seconds * 1000);
      this.interval.unref();
    }
    this.refresh();
  }

  /** The lines to show, padded, from the last run that printed anything. */
  lines(): string[] {
    const padding = ' '.repeat(Math.max(0, Math.min(20, Math.floor(this.settings.padding ?? 0))));
    return this.shown.map((line) => `${padding}${line}`);
  }

  /** Something it may show has changed. */
  refresh(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const wait = this.lastRun + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      if (!this.delayed) {
        this.delayed = setTimeout(() => {
          this.delayed = undefined;
          this.refresh();
        }, wait);
        this.delayed.unref();
      }
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    this.lastRun = Date.now();
    const output = await this.execute(JSON.stringify(this.input()));
    this.running = false;
    if (this.stopped) return;
    if (output !== null) {
      const next = output
        .split('\n')
        .map((line) => keepColors(line.replace(/\r$/, '')).trimEnd())
        .filter((line) => line !== '')
        .slice(0, MAX_LINES);
      if (next.join('\n') !== this.shown.join('\n')) {
        this.shown = next;
        this.onUpdate();
      }
    }
    if (this.again) {
      this.again = false;
      this.refresh();
    }
  }

  /** Its stdout, or null when it failed or took too long, which leaves the last output up. */
  private execute(payload: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(process.env.SHELL || '/bin/sh', ['-c', this.settings.command], {
        cwd: this.cwd(),
        env: { ...process.env, COLUMNS: String(process.stdout.columns || 80), LINES: String(process.stdout.rows || 24) },
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: true,
      });
      let stdout = '';
      const timer = setTimeout(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }, TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
      });
      child.stdin.on('error', () => {});
      child.stdin.end(payload);
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? stdout : null);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.delayed);
    clearInterval(this.interval);
  }
}
