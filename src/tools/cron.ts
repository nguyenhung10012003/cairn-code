/**
 * Scheduled prompts: CronCreate, CronDelete and CronList, and ScheduleWakeup for a self-paced
 * /loop. Jobs fire only while the interactive session is idle. With a store, they are also saved
 * in the project's workspace folder: a session's own jobs come back when it is resumed, and
 * durable ones run in every later session of the project.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { JobStore } from '../session/scheduled.ts';
import type { CronControl, CronJobInfo, JobOrigin, Tool } from './types.ts';

export const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Scheduled jobs one session can hold at once, so a runaway loop of CronCreate calls stops. */
export const MAX_JOBS = 50;
const MAX_RECURRING_DELAY_MS = 30 * 60 * 1000;
const MAX_ONE_SHOT_EARLY_MS = 90 * 1000;
/** Far enough to find any valid expression, including Feb 29. */
const SEARCH_LIMIT_MINUTES = 8 * 366 * 24 * 60;

interface CronField {
  values: Set<number>;
  /** True when the field was `*` (or `*` with a step), which matters for day matching. */
  any: boolean;
}

export interface CronExpression {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(text: string, min: number, max: number, name: string): CronField {
  const values = new Set<number>();
  let any = false;
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${name}: ${part}`);
    let start: number;
    let end: number;
    if (range === '*') {
      start = min;
      end = max;
      if (stepText === undefined) any = true;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-').map(Number);
      start = a!;
      end = b!;
    } else {
      start = Number(range);
      end = stepText === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid ${name}: ${part} (allowed ${min}-${max})`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, any };
}

export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`A cron expression has 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}.`);
  const dayOfWeek = parseField(fields[4]!, 0, 7, 'day of week');
  // 7 is Sunday, like 0.
  if (dayOfWeek.values.delete(7)) dayOfWeek.values.add(0);
  return {
    minute: parseField(fields[0]!, 0, 59, 'minute'),
    hour: parseField(fields[1]!, 0, 23, 'hour'),
    dayOfMonth: parseField(fields[2]!, 1, 31, 'day of month'),
    month: parseField(fields[3]!, 1, 12, 'month'),
    dayOfWeek,
  };
}

function matches(cron: CronExpression, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes()) || !cron.hour.values.has(date.getHours()) || !cron.month.values.has(date.getMonth() + 1)) return false;
  const dom = cron.dayOfMonth.values.has(date.getDate());
  const dow = cron.dayOfWeek.values.has(date.getDay());
  // Standard cron: when both day fields are restricted, either one may match.
  if (!cron.dayOfMonth.any && !cron.dayOfWeek.any) return dom || dow;
  return dom && dow;
}

/** The first matching minute strictly after `after`, in local time. */
export function nextMatch(cron: CronExpression, after: Date): Date | null {
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++) {
    if (matches(cron, candidate)) return candidate;
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

/** A fixed fraction per job, so jobs created at the same moment do not all fire at once. */
function jitterFraction(id: string): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0) / 0xffffffff;
}

interface Job {
  id: string;
  cron: string;
  expression: CronExpression;
  prompt: string;
  recurring: boolean;
  createdAt: number;
  /** The scheduled match, before the job's offset is applied. */
  nextMatch: Date | null;
  /** When `nextMatch` runs, worked out once per match: finding the match after it can take a while. */
  due?: { match: number; at: Date };
  timer?: NodeJS.Timeout;
  final?: boolean;
  durable: boolean;
  sessionId: string;
  origin: JobOrigin;
  loopDefault: boolean;
}

export interface SchedulerOptions {
  /** The session new jobs belong to. */
  session?: () => string;
  /** Where jobs are kept for later. Without one, they last as long as the process. */
  store?: JobStore;
  now?: () => number;
  /** The longest a timer waits before it checks the clock again. */
  stepMs?: number;
}

const CLOCK_CHECK_MS = 30_000;

export interface CreateOptions {
  durable?: boolean;
  origin?: JobOrigin;
  loopDefault?: boolean;
}

/** A self-paced loop's next iteration is not saved: such a loop is not brought back. */
const isSaved = (job: Job): boolean => job.origin !== 'wakeup';

export class CronScheduler implements CronControl {
  private readonly jobs = new Map<string, Job>();
  private readonly fire: (prompt: string, job: CronJobInfo) => void;
  private readonly now: () => number;
  private readonly session: () => string;
  private readonly store: JobStore | undefined;
  private readonly stepMs: number;

  /** `fire` receives a job's prompt when it is due. It decides when the prompt actually runs. */
  constructor(fire: (prompt: string, job: CronJobInfo) => void, options: SchedulerOptions = {}) {
    this.fire = fire;
    this.now = options.now ?? Date.now;
    this.session = options.session ?? (() => '');
    this.store = options.store;
    this.stepMs = options.stepMs ?? CLOCK_CHECK_MS;
  }

  get persistent(): boolean {
    return this.store !== undefined;
  }

  /** Why saved jobs cannot be changed right now, such as an unreadable file. */
  storageProblem(): string | undefined {
    return this.store?.problem();
  }

  private save(job: Job): void {
    if (!this.store || !isSaved(job)) return;
    this.store.save({
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      recurring: job.recurring,
      createdAt: job.createdAt,
      sessionId: job.sessionId,
      durable: job.durable,
      ...(job.origin === 'loop' ? { loop: true } : {}),
      ...(job.loopDefault ? { loopDefault: true } : {}),
      ...(!job.recurring && job.nextMatch ? { runAt: job.nextMatch.getTime() } : {}),
    });
  }

  private offsetMs(job: Job, match: Date): number {
    // Its time comes from now plus a delay, so it is not on a round minute many sessions share.
    if (job.origin === 'wakeup') return 0;
    const fraction = jitterFraction(job.id);
    if (job.recurring) {
      const following = nextMatch(job.expression, match);
      const period = following ? following.getTime() - match.getTime() : 0;
      return Math.floor(fraction * Math.min(period * 0.5, MAX_RECURRING_DELAY_MS));
    }
    const minute = match.getMinutes();
    return minute === 0 || minute === 30 ? -Math.floor(fraction * MAX_ONE_SHOT_EARLY_MS) : 0;
  }

  private runAt(job: Job): Date | null {
    if (!job.nextMatch) return null;
    const match = job.nextMatch.getTime();
    if (job.due?.match !== match) job.due = { match, at: new Date(match + this.offsetMs(job, job.nextMatch)) };
    return job.due.at;
  }

  private info(job: Job): CronJobInfo {
    return {
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      recurring: job.recurring,
      nextRun: this.runAt(job),
      durable: job.durable,
      origin: job.origin,
      ...(job.loopDefault ? { loopDefault: true } : {}),
      ...(job.recurring ? { expiresAt: new Date(job.createdAt + RECURRING_LIFETIME_MS) } : {}),
    };
  }

  /** Takes a job out of this process only. What is saved stays saved. */
  private unload(job: Job): void {
    clearTimeout(job.timer);
    this.jobs.delete(job.id);
  }

  private arm(job: Job): void {
    clearTimeout(job.timer);
    const at = this.runAt(job);
    if (!at) {
      this.unload(job);
      if (this.store && isSaved(job)) this.store.remove(job.id);
      return;
    }
    // A timer counts time the process runs, which can stop while the machine sleeps, and a due
    // time is on the wall clock. So a long wait is taken in short steps, each checking the clock
    // again, and a job is at most one step late after the machine wakes.
    const delay = Math.max(0, at.getTime() - this.now());
    const step = Math.min(delay, this.stepMs);
    job.timer = setTimeout(() => (step < delay ? this.arm(job) : this.trigger(job)), step);
    job.timer.unref();
  }

  private trigger(job: Job): void {
    if (!this.jobs.has(job.id)) return;
    const saved = this.store !== undefined && isSaved(job);
    // Cancelled in another session since this one loaded it.
    if (saved && !this.store!.has(job.id)) {
      this.unload(job);
      return;
    }
    const info = this.info(job);
    // Another session of the project may have the same job loaded. Only one of them runs it.
    const mine = !saved || !job.nextMatch || this.store!.claim(job.id, job.nextMatch.getTime());
    if (!job.recurring || job.final) {
      this.unload(job);
      if (saved) this.store!.remove(job.id);
    } else {
      // From now, not from the match that just ran: matches missed while the machine slept or the
      // process was stopped are not run one after another to catch up.
      job.nextMatch = nextMatch(job.expression, new Date(Math.max(job.nextMatch?.getTime() ?? 0, this.now())));
      // A recurring job fires one final time once it has lived its seven days.
      if (job.nextMatch && job.nextMatch.getTime() > job.createdAt + RECURRING_LIFETIME_MS) job.final = true;
      this.arm(job);
    }
    if (mine) this.fire(job.prompt, info);
  }

  create(cron: string, prompt: string, recurring: boolean, options: CreateOptions = {}): CronJobInfo {
    // A self-paced loop's next iteration replaces the one before, so it never adds up.
    if (options.origin !== 'wakeup' && this.count() >= MAX_JOBS) {
      throw new Error(`This session already has ${MAX_JOBS} scheduled jobs, the most it can hold. Cancel one with CronDelete first.`);
    }
    const expression = parseCron(cron);
    const match = nextMatch(expression, new Date(this.now()));
    if (!match) throw new Error(`The expression ${cron} never matches.`);
    const job: Job = {
      id: randomBytes(4).toString('hex'),
      cron: cron.trim(),
      expression,
      prompt,
      recurring,
      createdAt: this.now(),
      nextMatch: match,
      durable: options.durable === true,
      sessionId: this.session(),
      origin: options.origin ?? 'tool',
      loopDefault: options.loopDefault === true,
    };
    this.jobs.set(job.id, job);
    this.save(job);
    this.arm(job);
    return this.info(job);
  }

  /** A one-shot job for the minute `at` starts, which must be in the future. */
  createAt(at: Date, prompt: string, origin: JobOrigin): CronJobInfo {
    return this.create(`${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`, prompt, false, { origin });
  }

  /**
   * Loads saved jobs that belong here: durable ones, and those of `sessionId` when it is being
   * resumed. A one-shot job whose time passed, and a recurring job past its seven days, are
   * dropped for good. A recurring job does not make up for runs it missed.
   */
  restore(sessionId: string): CronJobInfo[] {
    if (!this.store) return [];
    const now = this.now();
    const restored: CronJobInfo[] = [];
    for (const stored of this.store.load()) {
      if (this.jobs.has(stored.id)) continue;
      let expression: CronExpression;
      try {
        expression = parseCron(stored.cron);
      } catch {
        this.store.remove(stored.id);
        continue;
      }
      const expired = stored.recurring ? now > stored.createdAt + RECURRING_LIFETIME_MS : stored.runAt === undefined || stored.runAt <= now;
      if (expired) {
        this.store.remove(stored.id);
        continue;
      }
      if (!stored.durable && stored.sessionId !== sessionId) continue;
      const match = stored.recurring ? nextMatch(expression, new Date(now)) : new Date(stored.runAt!);
      const job: Job = {
        id: stored.id,
        cron: stored.cron,
        expression,
        prompt: stored.prompt,
        recurring: stored.recurring,
        createdAt: stored.createdAt,
        nextMatch: match,
        durable: stored.durable,
        sessionId: stored.sessionId,
        origin: stored.loop ? 'loop' : 'tool',
        loopDefault: stored.loopDefault === true,
      };
      if (job.recurring && match && match.getTime() > job.createdAt + RECURRING_LIFETIME_MS) job.final = true;
      this.jobs.set(job.id, job);
      this.arm(job);
      restored.push(this.info(job));
    }
    return restored;
  }

  /**
   * Stops the jobs that belong to the conversation being left, keeping them saved so they come
   * back when it is resumed. Durable jobs belong to the project, and go on. Returns what stopped.
   */
  forgetSession(): CronJobInfo[] {
    const forgotten = [...this.jobs.values()].filter((job) => !job.durable);
    for (const job of forgotten) this.unload(job);
    return forgotten.map((job) => this.info(job));
  }

  /** The conversation goes on in a copy with a new session id, which its jobs now belong to. */
  adopt(sessionId: string): void {
    for (const job of this.jobs.values()) {
      if (job.durable || job.sessionId === sessionId) continue;
      job.sessionId = sessionId;
      this.save(job);
    }
  }

  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) {
      // A durable job another session made after this one started is not loaded here. An
      // unreadable file says nothing about whether it is there, and cannot be changed anyway.
      if (!this.store?.has(id) || this.store.problem() !== undefined) return false;
      this.store.remove(id);
      return true;
    }
    this.unload(job);
    if (this.store && isSaved(job)) this.store.remove(id);
    return true;
  }

  list(): CronJobInfo[] {
    return [...this.jobs.values()].map((job) => this.info(job));
  }

  has(id: string): boolean {
    return this.jobs.has(id);
  }

  /** Jobs held, other than a self-paced loop's next iteration. Cheap enough for every redraw, unlike list. */
  count(): number {
    let held = 0;
    for (const job of this.jobs.values()) if (job.origin !== 'wakeup') held++;
    return held;
  }

  /** Stops every timer, at the end of the process. What is saved stays saved. */
  stopAll(): void {
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    this.jobs.clear();
  }
}

function describeJob(job: CronJobInfo): string {
  const next = job.nextRun ? job.nextRun.toLocaleString() : 'never';
  const kind = [
    job.recurring ? `recurring, expires ${job.expiresAt?.toLocaleString() ?? ''}` : 'one-shot',
    ...(job.durable ? ['durable'] : []),
    ...(job.origin === 'loop' ? ['started by /loop'] : job.origin === 'wakeup' ? ['next iteration of the self-paced /loop'] : []),
  ].join(', ');
  const prompt = job.loopDefault ? 'the /loop default prompt' : job.prompt.replace(/\s+/g, ' ').slice(0, 120);
  return `${job.id}  ${job.cron}  (${kind})  next run: ${next}\n  prompt: ${prompt}`;
}

export const cronCreateTool: Tool = {
  name: 'CronCreate',
  description: `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

### One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

### Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

### Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

### Saved for later

Jobs are saved in the project's workspace folder, unless the session saves nothing. They fire only while a session runs. When this session is resumed (\`--resume\` or \`--continue\`), its jobs come back, except a one-shot job whose time passed meanwhile; a recurring job does not make up for the runs it missed. Starting a new conversation (\`/clear\`) stops this session's jobs until it is resumed.

\`durable: true\` makes a job belong to the project instead: it also runs in later sessions of this project, once per due time even with several sessions open, and \`/clear\` leaves it running. Use it only when the user asks for the job to outlive this session. Creating a durable job asks the user for approval.

### Not for live watching

CronCreate re-runs a prompt at fixed wall-clock intervals. To watch a log file, process, or command output and be notified the moment something changes, use the Monitor tool instead — Monitor streams events as they happen; cron polls on a schedule.

### Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). A job that comes due again while the REPL is still busy fires once when it is idle, not once per missed time. The scheduler shifts each job by a fixed per-job offset on top of whatever you pick: by default a recurring job runs up to 50% of its period late (max 30 min), and a one-shot job landing on :00 or :30 runs up to 90 s early. The result of this tool and of CronList gives each job's actual next run time: when you tell the user when a job will run, give that time, not the minute in the cron expression. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after 7 days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the 7-day limit when scheduling recurring jobs. A session holds at most ${MAX_JOBS} jobs at once.

Returns a job ID you can pass to CronDelete.`,
  inputSchema: {
    type: 'object',
    properties: {
      cron: {
        description: 'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
        type: 'string',
      },
      prompt: { description: 'The prompt to enqueue at each fire time.', type: 'string' },
      recurring: {
        description:
          'true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.',
        type: 'boolean',
      },
      durable: {
        description:
          'true = the job belongs to the project: it also runs in later sessions of this project. false (default) = it belongs to this session, and comes back only when this session is resumed.',
        type: 'boolean',
      },
    },
    required: ['cron', 'prompt'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  // A durable job runs its prompt in every later session of the project, so text the model read
  // in a file or on a web page could otherwise plant itself there. It needs the user's approval,
  // or the rule CronCreate(durable). A job for this session alone does not.
  access: (input) => (input.durable === true ? { kind: 'confirm', specifier: 'durable' } : { kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.cron) return { content: 'Scheduled prompts need an interactive session.', isError: true };
    try {
      const durable = input.durable === true;
      const job = ctx.cron.create(input.cron as string, input.prompt as string, input.recurring !== false, { durable });
      const problem = ctx.cron.storageProblem();
      const note = problem
        ? `\nIt runs in this session but was not saved for later: ${problem}`
        : durable && !ctx.cron.persistent
          ? '\nThis session saves nothing, so the job lasts only as long as it does.'
          : '';
      return { content: `Scheduled job ${job.id}.\n${describeJob(job)}${note}`, display: `job ${job.id}` };
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
  },
};

export const cronDeleteTool: Tool = {
  name: 'CronDelete',
  description: 'Cancel a cron job previously scheduled with CronCreate or /loop, including a durable one, and remove it from the saved jobs. Cancelling the next iteration of a self-paced /loop ends that loop.',
  inputSchema: {
    type: 'object',
    properties: { id: { description: 'Job ID returned by CronCreate.', type: 'string' } },
    required: ['id'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    const id = input.id as string;
    if (!ctx.cron?.delete(id)) {
      const problem = ctx.cron?.storageProblem();
      return { content: problem ? `No scheduled job ${id} in this session. ${problem}` : `No scheduled job ${id}.`, isError: true };
    }
    const problem = ctx.cron.storageProblem();
    const note = problem ? ` It no longer runs in this session, but stays in the saved jobs: ${problem}` : '';
    return { content: `Cancelled job ${id}.${note}`, display: `cancelled ${id}` };
  },
};

export const cronListTool: Tool = {
  name: 'CronList',
  description: 'List the cron jobs this session runs: those scheduled with CronCreate or /loop, durable ones from earlier sessions of this project, and the next iteration of a self-paced /loop.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(_input, ctx) {
    const jobs = ctx.cron?.list() ?? [];
    if (jobs.length === 0) return { content: 'No scheduled jobs.', display: '0 jobs' };
    return { content: jobs.map(describeJob).join('\n'), display: `${jobs.length} jobs` };
  },
};

export const scheduleWakeupTool: Tool = {
  name: 'ScheduleWakeup',
  description: `Schedule the next iteration of a self-paced /loop, or end the loop. Only for a loop the user started with /loop and no interval; each iteration's prompt says when one is running. Outside such a loop, use CronCreate.

At the end of each iteration, write a line on what you found, then call this once:
- \`delaySeconds\`: how long to wait, from 60 to 3600. Choose from what you saw: a minute or two while something is about to change (a build finishing, a deploy rolling out), longer while nothing is pending. Each iteration rereads the conversation, and after 5 idle minutes the prompt cache has expired, so frequent checks on something quiet cost more than they look.
- \`reason\`: one short line on why, shown to the user, such as "CI still running, 3 of 7 jobs done".
- \`stop: true\`, with nothing else, when the task is done, cannot make progress, or the user asked to stop.

When an event will say when to look again (a log line, a CI result, a file changing), start a Monitor for it as well: its events wake you as they happen, and \`delaySeconds\` is only the fallback. Stop that Monitor with TaskStop when you stop the loop.

The next iteration shows in CronList as a one-shot job. An iteration that ends without calling this tool gets one more about 20 minutes later, and if that one does not call it either, the loop ends. A loop also ends after 7 days.`,
  inputSchema: {
    type: 'object',
    properties: {
      delaySeconds: { description: 'Seconds until the next iteration, from 60 to 3600. Rounded up to the next whole minute.', type: 'number' },
      reason: { description: 'Why this delay, in one short line the user sees.', type: 'string' },
      stop: { description: 'true to end the loop. Give no other fields with it.', type: 'boolean' },
      prompt: { description: 'Ignored: every iteration runs the prompt the user gave /loop.', type: 'string' },
    },
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.loop) return { content: 'Loops need an interactive session.', isError: true };
    return ctx.loop.schedule({
      ...(typeof input.delaySeconds === 'number' ? { delaySeconds: input.delaySeconds } : {}),
      ...(typeof input.reason === 'string' ? { reason: input.reason } : {}),
      ...(input.stop === true ? { stop: true } : {}),
    });
  },
};
