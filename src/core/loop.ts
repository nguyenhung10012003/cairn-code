/**
 * /loop: a prompt that runs again and again while the session is open. With an interval it is a
 * recurring cron job. Without one it is self-paced: after each iteration the model picks when
 * the next runs, with ScheduleWakeup, and this module keeps that going. Either way the prompt is
 * the user's, or the default one: `loop.md` if there is one, otherwise a built-in prompt.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, PROJECT_DIR } from '../config/paths.ts';
import { RECURRING_LIFETIME_MS } from '../tools/cron.ts';
import type { CronScheduler } from '../tools/cron.ts';
import type { LoopControl, ToolOutput } from '../tools/types.ts';
import type { AgentEvent } from './agent.ts';
import type { WakeQueue } from './wakes.ts';

export const LOOP_FILE = 'loop.md';
const MAX_LOOP_FILE_BYTES = 25_000;
const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 3_600;
/** When an iteration does not say when the next should run. */
const FALLBACK_DELAY_SECONDS = 20 * 60;
const DEFAULT_PROMPT_LABEL = 'the /loop default prompt';

export const DEFAULT_LOOP_PROMPT = `Look after this project between turns. Go through these in order and work on the first one that needs something. If none does, say so in one line.

1. Unfinished work: if this conversation left a task undone, carry on with it.
2. The pull request for the current branch, if it has one (\`gh pr view\`): address new review comments, look into failed checks, and resolve conflicts with the base branch. Commit and push only fixes for that pull request's own comments and checks.
3. Upkeep, when nothing above is pending: make one small improvement in code this conversation worked on, such as fixing a bug you can demonstrate or removing something unused. Keep it small enough to review at a glance.

Never merge, force-push, or delete branches or files. End with a short note on what you did or found.`;

/** The default prompt: `.karst/loop.md` in a trusted project, then `~/.karst/loop.md`, then the built-in one. Read again for each run. */
export function defaultLoopPrompt(projectDir: string, trusted: boolean): { text: string; source: string } {
  const candidates = [...(trusted ? [join(projectDir, PROJECT_DIR, LOOP_FILE)] : []), join(appHome(), LOOP_FILE)];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    const text = bytes.subarray(0, MAX_LOOP_FILE_BYTES).toString('utf8').trim();
    if (text) return { text, source: path };
  }
  return { text: DEFAULT_LOOP_PROMPT, source: 'built-in' };
}

export interface LoopInterval {
  cron: string;
  /** Such as "every 5 minutes". */
  describe: string;
  /** Said when the interval asked for could not be kept exactly. */
  note?: string;
}

export interface LoopRequest {
  /** Null for the default prompt. */
  prompt: string | null;
  /** Absent for a self-paced loop. */
  every?: LoopInterval;
}

const UNITS: Record<string, 's' | 'm' | 'h' | 'd'> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
};

/** Steps a cron expression can repeat on evenly, in minutes: parts of an hour, parts of a day, then days. */
const STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880, 4320, 5760, 7200, 8640, 10080];

function plural(count: number, unit: string): string {
  return count === 1 ? unit : `${Number.isInteger(count) ? count : count.toFixed(1)} ${unit}s`;
}

function describeMinutes(minutes: number): string {
  if (minutes < 60) return plural(minutes, 'minute');
  if (minutes < 1440) return plural(minutes / 60, 'hour');
  return plural(minutes / 1440, 'day');
}

const WEEK_MINUTES = 7 * 1440;

/** A step through a cron field that passes through `value`, as `*` with a step passes through its lowest value. */
function stepThrough(value: number, step: number, min: number, max: number): string {
  const start = min + ((value - min) % step);
  return start === min ? `*/${step}` : `${start}-${max}/${step}`;
}

/**
 * The nearest even cron step to an interval, counted from `now`: /loop runs the prompt once now,
 * so the first scheduled run comes a whole interval later, not at the next round :00.
 */
export function intervalToCron(amount: number, unit: 's' | 'm' | 'h' | 'd', now: Date): LoopInterval {
  if (!(amount > 0)) throw new Error('A loop interval must be more than zero, such as 5m or 2h.');
  const scale = { s: 1 / 60, m: 1, h: 60, d: 1440 }[unit];
  const asked = Math.max(1, Math.ceil(amount * scale));
  // Ties go to the longer step, which costs less.
  const minutes = STEPS.reduce((best, step) => (Math.abs(step - asked) <= Math.abs(best - asked) ? step : best), STEPS[0]!);
  const minute = now.getMinutes();
  const hour = now.getHours();
  // Every step below a day divides an hour or a day evenly, so the gaps stay equal across the boundary.
  const cron =
    minutes === 1 ? '* * * * *'
    : minutes < 60 ? `${stepThrough(minute, minutes, 0, 59)} * * * *`
    : minutes === 60 ? `${minute} * * * *`
    : minutes < 1440 ? `${minute} ${stepThrough(hour, minutes / 60, 0, 23)} * * *`
    : minutes === 1440 ? `${minute} ${hour} * * *`
    : minutes === WEEK_MINUTES ? `${minute} ${hour} * * ${now.getDay()}`
    : `${minute} ${hour} ${stepThrough(now.getDate(), minutes / 1440, 1, 31)} * *`;
  const describe = minutes === WEEK_MINUTES ? 'every week' : `every ${describeMinutes(minutes)}`;
  const notes: string[] = [];
  if (unit === 's' && amount % 60 !== 0) notes.push('Schedules have whole minutes, so seconds are rounded up.');
  if (minutes !== asked) notes.push(`${describeMinutes(asked)} does not divide evenly into a schedule, so this runs ${describe}.`);
  if (minutes > 1440 && minutes !== WEEK_MINUTES) notes.push('A day-of-month step restarts each month, so the gap at a month\'s end can be shorter.');
  return { cron, describe, ...(notes.length > 0 ? { note: notes.join(' ') } : {}) };
}

/**
 * `5m check the deploy`, `check the deploy every 2 hours`, `15m` (the default prompt on a
 * schedule), `check the deploy` (self-paced), or nothing (the default prompt, self-paced).
 */
export function parseLoop(args: string, now: Date): LoopRequest {
  const text = args.trim();
  // Only a bare token such as `30m` leads, so a prompt that starts with "3 days ago..." stays a prompt.
  const leading = /^(\d+)([smhd])(?:\s+([\s\S]*))?$/i.exec(text);
  if (leading) {
    const rest = leading[3]?.trim();
    return { prompt: rest || null, every: intervalToCron(Number(leading[1]), UNITS[leading[2]!.toLowerCase()]!, now) };
  }
  const trailing = /^([\s\S]*?)[\s,]*\bevery\s+(?:(\d+)\s*)?([a-z]+)\.?$/i.exec(text);
  if (trailing && UNITS[trailing[3]!.toLowerCase()]) {
    const rest = trailing[1]!.trim();
    return { prompt: rest || null, every: intervalToCron(trailing[2] ? Number(trailing[2]) : 1, UNITS[trailing[3]!.toLowerCase()]!, now) };
  }
  return { prompt: text || null };
}

export interface LoopHost {
  cron: CronScheduler;
  wakes: WakeQueue;
  /** A turn for one iteration, as if the user had typed `prompt`. */
  turn(prompt: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** The default prompt as it reads now. */
  defaultPrompt(): string;
  /** A user's prompt as it should run, such as one naming a skill. */
  prepare?(prompt: string): string;
  /** A line for the person at the terminal. */
  notice(text: string): void;
  now?: () => number;
}

interface SelfPaced {
  /** Null for the default prompt. */
  prompt: string | null;
  startedAt: number;
  iterations: number;
  /** The one-shot job that runs the next iteration. */
  wakeup?: string;
  next?: { at: Date; reason: string };
  /** An iteration is waiting for the session to be idle. */
  queued: boolean;
  /** ScheduleWakeup was called during the current iteration. */
  rescheduled: boolean;
  /** ScheduleWakeup asked to stop during the current iteration. */
  stopping: boolean;
  /** The pending wakeup is the one given to an iteration that did not ask for one. */
  fallback: boolean;
}

function clock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The loops of one interactive session. Only one self-paced loop runs at a time. */
export class LoopController implements LoopControl {
  private readonly host: LoopHost;
  private loop: SelfPaced | undefined;
  private iterating = false;

  constructor(host: LoopHost) {
    this.host = host;
  }

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  private prepare(prompt: string): string {
    return this.host.prepare?.(prompt) ?? prompt;
  }

  /** A loop on a schedule, as a recurring cron job. Its first run is now. */
  startFixed(every: LoopInterval, prompt: string | null): string {
    const job = this.host.cron.create(every.cron, prompt ?? DEFAULT_PROMPT_LABEL, true, { origin: 'loop', loopDefault: prompt === null });
    // The same key as the job's own runs, so one coming due before this starts is not a second run.
    this.host.wakes.prompt(prompt === null ? this.host.defaultPrompt() : this.prepare(prompt), `cron:${job.id}`);
    return [
      `Scheduled job ${job.id}: ${prompt === null ? 'the default prompt ' : ''}${every.describe} (${every.cron}), next run at ${job.nextRun ? clock(job.nextRun) : 'never'}. It also runs once now.`,
      ...(every.note ? [every.note] : []),
      'It stops after 7 days, or with /loop stop.',
    ].join('\n');
  }

  /** A self-paced loop. Its first iteration runs now. */
  start(prompt: string | null): string {
    const replaced = this.stop();
    this.loop = { prompt, startedAt: this.now(), iterations: 0, queued: false, rescheduled: false, stopping: false, fallback: false };
    this.enqueue(this.loop);
    return [
      ...(replaced ? ['Replaced the self-paced loop that was running.'] : []),
      `Started a self-paced loop${prompt === null ? ' with the default prompt' : ''}. The first iteration runs now. After each one the model picks when the next runs, from 1 minute to 1 hour.`,
      'Esc while it waits stops it, as does /loop stop.',
    ].join('\n');
  }

  private enqueue(loop: SelfPaced): void {
    loop.queued = true;
    this.host.wakes.prompt('/loop iteration', 'loop', (signal) => this.iterate(signal));
  }

  /** A self-paced loop's wakeup job came due. */
  due(jobId: string): void {
    if (!this.loop || this.loop.wakeup !== jobId) return;
    // Already gone when the scheduler ran it, but not when the wakeup is brought forward.
    this.host.cron.delete(jobId);
    this.loop.wakeup = undefined;
    this.enqueue(this.loop);
  }

  private iterationPrompt(loop: SelfPaced): string {
    return [
      `<loop-iteration number="${loop.iterations}">`,
      'This is one iteration of a self-paced /loop the user started. Do the task below now. Then write a line on what you found, and call ScheduleWakeup: delaySeconds and a reason, chosen from what you saw, or stop: true when the task is done or cannot make progress.',
      '',
      loop.prompt === null ? this.host.defaultPrompt() : this.prepare(loop.prompt),
      '</loop-iteration>',
    ].join('\n');
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const loop = this.loop;
    // Stopped, or replaced by another loop with its own iteration waiting, since this was queued.
    if (!loop || !loop.queued) return;
    loop.queued = false;
    loop.iterations++;
    loop.rescheduled = false;
    let ended: string | undefined;
    this.iterating = true;
    try {
      for await (const event of this.host.turn(this.iterationPrompt(loop), signal)) {
        if (event.type === 'turn_end') ended = event.stopReason;
        yield event;
      }
    } finally {
      this.iterating = false;
    }
    // Replaced or stopped while it ran.
    if (this.loop !== loop) return;
    if (loop.stopping) {
      this.end();
      this.host.notice('The loop is finished. /loop starts it again.');
    } else if (loop.rescheduled) {
      this.host.notice(`Loop: next iteration at ${clock(loop.next!.at)}, ${loop.next!.reason}`);
    } else if (ended === 'interrupted' || signal.aborted) {
      this.end();
      this.host.notice('The loop stopped, because its iteration was interrupted. /loop starts it again.');
    } else if (loop.fallback) {
      this.end();
      this.host.notice('The loop ended: two iterations in a row did not schedule the next one.');
    } else {
      loop.fallback = true;
      const at = this.wake(loop, FALLBACK_DELAY_SECONDS, 'the last iteration did not schedule one');
      this.host.notice(
        at
          ? `Loop: the iteration did not schedule the next one, so one more runs at ${clock(at)}. If that one does not either, the loop ends.`
          : 'The loop has run for 7 days, its limit, so it ends here.',
      );
    }
  }

  /** Sets the pending wakeup. Returns undefined, and ends the loop, past its seven days. */
  private wake(loop: SelfPaced, seconds: number, reason: string): Date | undefined {
    if (loop.wakeup) this.host.cron.delete(loop.wakeup);
    loop.wakeup = undefined;
    // On a whole minute, as cron jobs are, and never sooner than asked.
    const at = new Date(Math.ceil((this.now() + seconds * 1000) / 60_000) * 60_000);
    if (at.getTime() > loop.startedAt + RECURRING_LIFETIME_MS) {
      this.end();
      return undefined;
    }
    loop.wakeup = this.host.cron.createAt(at, this.iterationLabel(loop), 'wakeup').id;
    loop.next = { at, reason };
    return at;
  }

  private iterationLabel(loop: SelfPaced): string {
    return loop.prompt ?? DEFAULT_PROMPT_LABEL;
  }

  schedule(request: { delaySeconds?: number; reason?: string; stop?: boolean }): ToolOutput {
    const loop = this.active();
    if (!loop) {
      return { content: 'No self-paced /loop is running, so there is nothing to schedule. For a reminder, use CronCreate with recurring: false.', isError: true };
    }
    if (request.stop) {
      if (this.iterating) loop.stopping = true;
      else {
        this.end();
        this.host.notice('The loop is finished. /loop starts it again.');
      }
      return { content: 'The loop ends after this turn. The user can start it again with /loop.', display: 'loop finished' };
    }
    const asked = request.delaySeconds;
    if (asked === undefined || !Number.isFinite(asked)) {
      return { content: 'Give delaySeconds, from 60 to 3600, and a reason; or stop: true to end the loop.', isError: true };
    }
    const seconds = Math.min(Math.max(Math.round(asked), MIN_DELAY_SECONDS), MAX_DELAY_SECONDS);
    const reason = (request.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'no reason given';
    const at = this.wake(loop, seconds, reason);
    if (!at) {
      this.host.notice('The loop has run for 7 days, its limit, so it ends here.');
      return { content: 'The loop has run for 7 days, its limit, so it has ended. Tell the user; /loop starts a new one.' };
    }
    loop.rescheduled = true;
    loop.fallback = false;
    // Within an iteration, the line comes once the iteration ends.
    if (!this.iterating) this.host.notice(`Loop: next iteration at ${clock(at)}, ${reason}`);
    const clamped = seconds === asked ? '' : ` delaySeconds must be from ${MIN_DELAY_SECONDS} to ${MAX_DELAY_SECONDS}, so it is ${seconds}.`;
    return { content: `The next iteration runs at ${clock(at)}.${clamped} End your turn now.`, display: `next iteration at ${clock(at)}` };
  }

  /** The self-paced loop, unless its wakeup was cancelled some other way, such as with CronDelete. */
  private active(): SelfPaced | undefined {
    const loop = this.loop;
    if (!loop) return undefined;
    if (this.iterating || loop.queued) return loop;
    // Asked on every redraw of the status line, so it must stay cheap.
    if (loop.wakeup !== undefined && this.host.cron.has(loop.wakeup)) return loop;
    this.loop = undefined;
    return undefined;
  }

  /** When the self-paced loop's next iteration is due, if it is waiting for one. */
  waitingUntil(): Date | undefined {
    const loop = this.active();
    return loop && !this.iterating && !loop.queued && loop.wakeup ? loop.next?.at : undefined;
  }

  /** Esc or Ctrl+C while nothing runs: stops a self-paced loop that is waiting. */
  cancelWaiting(): boolean {
    if (!this.waitingUntil()) return false;
    this.end();
    return true;
  }

  /** Stops the self-paced loop. Returns whether there was one. */
  stop(): boolean {
    const had = this.active() !== undefined;
    this.end();
    return had;
  }

  /** /loop stop: the self-paced loop, and the scheduled loops /loop started. */
  stopAll(): string {
    const selfPaced = this.stop();
    const jobs = this.host.cron.list().filter((job) => job.origin === 'loop');
    for (const job of jobs) this.host.cron.delete(job.id);
    const parts = [...(selfPaced ? ['the self-paced loop'] : []), ...(jobs.length === 0 ? [] : [jobs.length === 1 ? 'a scheduled loop' : `${jobs.length} scheduled loops`])];
    return parts.length > 0 ? `Stopped ${parts.join(' and ')}.` : 'No loop is running.';
  }

  private end(): void {
    const loop = this.loop;
    this.loop = undefined;
    if (loop?.wakeup) this.host.cron.delete(loop.wakeup);
  }
}
