/**
 * Session-only scheduled prompts: CronCreate, CronDelete and CronList. Jobs live in memory and
 * fire only while the interactive session is idle.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CronControl, CronJobInfo, Tool } from './types.ts';

const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
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
  timer?: NodeJS.Timeout;
  final?: boolean;
}

export class CronScheduler implements CronControl {
  private readonly jobs = new Map<string, Job>();
  private readonly fire: (prompt: string, job: CronJobInfo) => void;
  private readonly now: () => number;

  /** `fire` receives a job's prompt when it is due. It decides when the prompt actually runs. */
  constructor(fire: (prompt: string, job: CronJobInfo) => void, now: () => number = Date.now) {
    this.fire = fire;
    this.now = now;
  }

  private offsetMs(job: Job, match: Date): number {
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
    return job.nextMatch ? new Date(job.nextMatch.getTime() + this.offsetMs(job, job.nextMatch)) : null;
  }

  private info(job: Job): CronJobInfo {
    return {
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      recurring: job.recurring,
      nextRun: this.runAt(job),
      ...(job.recurring ? { expiresAt: new Date(job.createdAt + RECURRING_LIFETIME_MS) } : {}),
    };
  }

  private arm(job: Job): void {
    clearTimeout(job.timer);
    const at = this.runAt(job);
    if (!at) {
      this.jobs.delete(job.id);
      return;
    }
    // setTimeout cannot wait more than about 24.8 days, so long waits re-arm in steps.
    const delay = Math.max(0, at.getTime() - this.now());
    const step = Math.min(delay, 2 ** 31 - 1);
    job.timer = setTimeout(() => (step < delay ? this.arm(job) : this.trigger(job)), step);
    job.timer.unref();
  }

  private trigger(job: Job): void {
    if (!this.jobs.has(job.id)) return;
    const info = this.info(job);
    if (!job.recurring || job.final) {
      this.jobs.delete(job.id);
    } else {
      job.nextMatch = nextMatch(job.expression, job.nextMatch ?? new Date(this.now()));
      // A recurring job fires one final time once it has lived its seven days.
      if (job.nextMatch && job.nextMatch.getTime() > job.createdAt + RECURRING_LIFETIME_MS) job.final = true;
      this.arm(job);
    }
    this.fire(job.prompt, info);
  }

  create(cron: string, prompt: string, recurring: boolean): CronJobInfo {
    const expression = parseCron(cron);
    const match = nextMatch(expression, new Date(this.now()));
    if (!match) throw new Error(`The expression ${cron} never matches.`);
    const job: Job = { id: randomBytes(4).toString('hex'), cron: cron.trim(), expression, prompt, recurring, createdAt: this.now(), nextMatch: match };
    this.jobs.set(job.id, job);
    this.arm(job);
    return this.info(job);
  }

  delete(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    clearTimeout(job.timer);
    this.jobs.delete(id);
    return true;
  }

  list(): CronJobInfo[] {
    return [...this.jobs.values()].map((job) => this.info(job));
  }

  stopAll(): void {
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    this.jobs.clear();
  }
}

function describeJob(job: CronJobInfo): string {
  const next = job.nextRun ? job.nextRun.toLocaleString() : 'never';
  const kind = job.recurring ? `recurring, expires ${job.expiresAt?.toLocaleString() ?? ''}` : 'one-shot';
  return `${job.id}  ${job.cron}  (${kind})  next run: ${next}\n  prompt: ${job.prompt.replace(/\s+/g, ' ').slice(0, 120)}`;
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

### Session-only

Jobs live only in this session — nothing is written to disk, and the job is gone when the session exits.

### Not for live watching

CronCreate re-runs a prompt at fixed wall-clock intervals. To watch a log file, process, or command output and be notified the moment something changes, use the Monitor tool instead — Monitor streams events as they happen; cron polls on a schedule.

### Runtime behavior

Jobs only fire while the REPL is idle (not mid-query). The scheduler shifts each job by a fixed per-job offset on top of whatever you pick: by default a recurring job runs up to 50% of its period late (max 30 min), and a one-shot job landing on :00 or :30 runs up to 90 s early. The result of this tool and of CronList gives each job's actual next run time: when you tell the user when a job will run, give that time, not the minute in the cron expression. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after 7 days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the 7-day limit when scheduling recurring jobs.

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
      durable: { description: 'Has no effect — durable persistence is not available. All jobs are session-only (in-memory, gone when this session ends).', type: 'boolean' },
    },
    required: ['cron', 'prompt'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (!ctx.cron) return { content: 'Scheduled prompts need an interactive session.', isError: true };
    try {
      const job = ctx.cron.create(input.cron as string, input.prompt as string, input.recurring !== false);
      return { content: `Scheduled job ${job.id}.\n${describeJob(job)}`, display: `job ${job.id}` };
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
  },
};

export const cronDeleteTool: Tool = {
  name: 'CronDelete',
  description: 'Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store.',
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
    if (!ctx.cron?.delete(id)) return { content: `No scheduled job ${id}.`, isError: true };
    return { content: `Cancelled job ${id}.`, display: `cancelled ${id}` };
  },
};

export const cronListTool: Tool = {
  name: 'CronList',
  description: 'List all cron jobs scheduled via CronCreate in this session.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  isReadOnly: () => true,
  access: () => ({ kind: 'none' }),
  async execute(_input, ctx) {
    const jobs = ctx.cron?.list() ?? [];
    if (jobs.length === 0) return { content: 'No scheduled jobs.', display: '0 jobs' };
    return { content: jobs.map(describeJob).join('\n'), display: `${jobs.length} jobs` };
  },
};
