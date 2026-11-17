/** Scheduled prompts kept in the workspace folder, /loop, ScheduleWakeup, CronList and CronDelete. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'bun:test';
import { runSlashCommand } from '../src/commands/slash.ts';
import { workspaceScheduledPath } from '../src/config/paths.ts';
import { DEFAULT_LOOP_PROMPT, defaultLoopPrompt, intervalToCron, parseLoop } from '../src/core/loop.ts';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { ScriptedTurn } from '../src/providers/scripted.ts';
import { WorkspaceJobStore } from '../src/session/scheduled.ts';
import { cronDeleteTool, cronListTool, CronScheduler, nextMatch, parseCron, scheduleWakeupTool } from '../src/tools/cron.ts';
import type { Prompter } from '../src/tools/types.ts';

const prompter: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };
const noChoice = { choose: async () => null };

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

let home: string;
let project: string;
beforeEach(() => {
  home = tempDir('karst-schedule-home-');
  project = tempDir('karst-schedule-project-');
  process.env.KARST_HOME = home;
});

/** A pinned one-shot expression for the minute `at` starts. */
const pinned = (at: Date): string => `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
/** A whole minute a few minutes from now, never :00 or :30, whose one-shot jobs run early. */
function comingMinute(): Date {
  const at = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 3 * 60_000);
  if (at.getMinutes() % 30 === 0) at.setMinutes(at.getMinutes() + 1);
  return at;
}

describe('scheduled jobs saved in the workspace folder', () => {
  it('come back when their session is resumed, and not in another session', () => {
    const store = new WorkspaceJobStore(project);
    const first = new CronScheduler(() => {}, { session: () => 'session-a', store });
    const recurring = first.create('7 9 * * *', 'morning check', true);
    const once = first.create(pinned(comingMinute()), 'remind me', false);
    first.stopAll();
    assert.equal(statSync(workspaceScheduledPath(project)).mode & 0o777, 0o600);

    const other = new CronScheduler(() => {}, { session: () => 'session-b', store });
    assert.deepEqual(other.restore('session-b'), []);
    const resumed = new CronScheduler(() => {}, { session: () => 'session-a', store });
    assert.deepEqual(resumed.restore('session-a').map((job) => job.id).sort(), [recurring.id, once.id].sort());
    other.stopAll();
    resumed.stopAll();
  });

  it('drop a one-shot job whose time passed and a recurring job past its seven days', () => {
    const store = new WorkspaceJobStore(project);
    const base = { recurring: false, sessionId: 'session-a', durable: false, cron: '7 9 1 1 *', prompt: 'old' };
    store.save({ ...base, id: '0000000a', createdAt: Date.now() - 60_000, runAt: Date.now() - 1_000 });
    store.save({ ...base, id: '0000000b', recurring: true, cron: '7 9 * * *', createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 });
    const scheduler = new CronScheduler(() => {}, { session: () => 'session-a', store });
    assert.deepEqual(scheduler.restore('session-a'), []);
    assert.deepEqual(store.load(), []);
  });

  it('let only the first session to claim a run of a job have it', () => {
    const first = new WorkspaceJobStore(project);
    const second = new WorkspaceJobStore(project);
    assert.equal(first.claim('0000000c', 1_000), true);
    assert.equal(second.claim('0000000c', 1_000), false);
    assert.equal(second.claim('0000000c', 61_000), true, 'the next run is a new claim');
    assert.equal(first.claim('0000000c', 1_000), true, 'older claims are cleared, so the folder does not grow');
  });

  it('run a durable job in every session of the project, and a one-shot one only once', async () => {
    const at = comingMinute();
    const now = (): number => at.getTime() - 50;
    let fired = 0;
    const first = new CronScheduler(() => fired++, { session: () => 'session-a', store: new WorkspaceJobStore(project), now });
    const job = first.create(pinned(at), 'project check', false, { durable: true });
    // A second process, with its own view of the same file.
    const second = new CronScheduler(() => fired++, { session: () => 'session-b', store: new WorkspaceJobStore(project), now });
    assert.deepEqual(second.restore('session-b').map((restored) => restored.id), [job.id]);
    await Bun.sleep(300);
    assert.equal(fired, 1);
    assert.deepEqual(new WorkspaceJobStore(project).load(), [], 'a one-shot job is gone once it ran');
  });

  it('run a recurring durable job once per due time, however many sessions have it', async () => {
    let clock = new Date(2026, 10, 12, 14, 17, 10).getTime();
    let fired = 0;
    const options = { now: () => clock, stepMs: 20 };
    const first = new CronScheduler(() => fired++, { ...options, session: () => 'session-a', store: new WorkspaceJobStore(project) });
    const job = first.create('* * * * *', 'every minute', true, { durable: true });
    const second = new CronScheduler(() => fired++, { ...options, session: () => 'session-b', store: new WorkspaceJobStore(project) });
    second.restore('session-b');
    // Both come to the same run of it.
    clock = job.nextRun!.getTime() - 10;
    await Bun.sleep(200);
    assert.equal(fired, 1);
    first.stopAll();
    second.stopAll();
  });

  it('do not run here once another session cancelled them', async () => {
    const at = comingMinute();
    const now = (): number => at.getTime() - 100;
    let fired = 0;
    const first = new CronScheduler(() => fired++, { session: () => 'session-a', store: new WorkspaceJobStore(project), now: () => Date.now() });
    const job = first.create(pinned(at), 'project check', false, { durable: true });
    const second = new CronScheduler(() => fired++, { session: () => 'session-b', store: new WorkspaceJobStore(project), now });
    second.restore('session-b');
    assert.equal(first.delete(job.id), true);
    await Bun.sleep(300);
    assert.equal(fired, 0);
    assert.deepEqual(second.list(), []);
    first.stopAll();
  });

  it('hold at most 50 in one session, not counting the next iteration of a self-paced loop', () => {
    const scheduler = new CronScheduler(() => {});
    for (let i = 0; i < 50; i++) scheduler.create('7 9 * * *', `job ${i}`, true);
    assert.throws(() => scheduler.create('7 9 * * *', 'one more', true), /already has 50 scheduled jobs/);
    scheduler.createAt(comingMinute(), 'next iteration', 'wakeup');
    assert.equal(scheduler.list().length, 51);
    scheduler.stopAll();
  });

  it('run once soon after the machine wakes, without catching up on the runs it slept through', async () => {
    let clock = new Date(2026, 10, 12, 14, 17, 10).getTime();
    let fired = 0;
    const scheduler = new CronScheduler(() => fired++, { now: () => clock, stepMs: 20 });
    scheduler.create('*/5 * * * *', 'check', true);
    // An hour of sleep: the process's timers stand still while the wall clock moves on.
    clock += 60 * 60_000;
    await Bun.sleep(200);
    assert.equal(fired, 1);
    assert.ok(scheduler.list()[0]!.nextRun!.getTime() > clock, 'the next run comes after the wake');
    scheduler.stopAll();
  });

  it('leave a file they cannot read as it is, and treat its jobs as still there', () => {
    const store = new WorkspaceJobStore(project);
    let fired = 0;
    const scheduler = new CronScheduler(() => fired++, { session: () => 'session-a', store });
    scheduler.create('7 9 * * *', 'one', true);
    const kept = scheduler.create('8 9 * * *', 'two', true);
    // Half edited by hand.
    const broken = readFileSync(workspaceScheduledPath(project), 'utf8').slice(0, -5);
    writeFileSync(workspaceScheduledPath(project), broken);

    scheduler.create('9 9 * * *', 'three', true);
    assert.equal(readFileSync(workspaceScheduledPath(project), 'utf8'), broken, 'nothing was written over it');
    assert.match(scheduler.storageProblem()!, /Could not read the scheduled jobs/);
    assert.equal(store.has(kept.id), true, 'a job is not taken for cancelled because the file cannot be read');
    assert.equal(scheduler.delete('0000dead'), false);
    for (let i = 0; i < 5; i++) store.load();
    assert.equal(store.warnings.length, 1);

    writeFileSync(workspaceScheduledPath(project), JSON.stringify({ jobs: [{ id: 'not-a-job' }] }));
    scheduler.create('10 9 * * *', 'four', true);
    assert.equal(scheduler.storageProblem(), undefined);
    const entries = (JSON.parse(readFileSync(workspaceScheduledPath(project), 'utf8')) as { jobs: { id: string }[] }).jobs;
    assert.deepEqual(entries.map((entry) => entry.id).slice(0, 1), ['not-a-job'], 'an entry this version does not understand is kept');
    scheduler.stopAll();
    assert.equal(fired, 0);
  });

  it('keep every job when several sessions save at the same moment', async () => {
    const sessions = 4;
    const perSession = 25;
    const script = join(project, 'save-jobs.ts');
    writeFileSync(
      script,
      `import { WorkspaceJobStore } from ${JSON.stringify(join(import.meta.dir, '../src/session/scheduled.ts'))};
const [project, session, count, startAt] = process.argv.slice(2);
const store = new WorkspaceJobStore(project);
// All of them start together, so their reads and writes overlap.
while (Date.now() < Number(startAt)) {}
for (let i = 0; i < Number(count); i++) {
  const id = Number(session).toString(16).padStart(2, '0') + i.toString(16).padStart(6, '0');
  if (!store.save({ id, cron: '7 9 * * *', prompt: 'p', recurring: true, createdAt: Date.now(), sessionId: 's' + session, durable: true })) process.exit(2);
}
`,
    );
    const startAt = Date.now() + 1_500;
    const exits = await Promise.all(
      Array.from({ length: sessions }, (_, session) => {
        const child = spawn(process.execPath, [script, project, String(session), String(perSession), String(startAt)], {
          env: { ...process.env, KARST_HOME: home },
          stdio: 'inherit',
        });
        return new Promise<number | null>((resolve) => child.on('exit', resolve));
      }),
    );
    assert.deepEqual(exits, Array(sessions).fill(0));
    assert.equal(new WorkspaceJobStore(project).load().length, sessions * perSession, 'no session lost another one\'s job');
    assert.equal(existsSync(`${workspaceScheduledPath(project)}.lock`), false, 'the lock is released');
  });
  it('take over a lock left by a session that died holding it', () => {
    const store = new WorkspaceJobStore(project);
    const lock = `${workspaceScheduledPath(project)}.lock`;
    mkdirSync(join(lock, '..'), { recursive: true });
    writeFileSync(lock, '12345 left-behind');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    const started = Date.now();
    assert.equal(store.save({ id: '0000beef', cron: '7 9 * * *', prompt: 'p', recurring: true, createdAt: Date.now(), sessionId: 's', durable: false }), true);
    assert.ok(Date.now() - started < 1_000, 'an old lock is not waited for');
    assert.deepEqual(store.load().map((job) => job.id), ['0000beef']);
    assert.equal(existsSync(lock), false);
  });
  it('work out a job\'s run time once per match, however often they are listed', () => {
    const scheduler = new CronScheduler(() => {});
    // Leap days: finding the match after the next one searches years of minutes.
    scheduler.create('0 0 29 2 *', 'leap day', true);
    scheduler.list();
    const started = performance.now();
    for (let i = 0; i < 50; i++) scheduler.list();
    assert.ok(performance.now() - started < 500, `${Math.round(performance.now() - started)}ms`);
    scheduler.stopAll();
  });

  it('need approval for a durable job, which a rule for durable jobs alone can give', async () => {
    const prompts: string[][] = [];
    const call = (durable: boolean): ScriptedTurn => ({ toolCalls: [{ name: 'CronCreate', input: { cron: '7 9 * * *', prompt: durable ? 'project job' : 'session job', durable } }] });
    const runtime = await createRuntime({
      cwd: project,
      provider: new ScriptedProvider([call(false), { text: 'ok' }, call(true), { text: 'ok' }]),
      persist: false,
      prompter: { ...prompter, permission: async (prompt) => (prompts.push(prompt.suggestions.map((suggestion) => suggestion.rule)), { behavior: 'deny' }) },
    });
    for (const text of ['one', 'two']) {
      for await (const _event of runtime.agent.run(text, new AbortController().signal)) {
        // Run it to the end.
      }
    }
    assert.deepEqual(prompts, [['CronCreate(durable)']], 'only the durable job asked');
    assert.deepEqual(runtime.cron!.list().map((job) => job.prompt), ['session job']);
    const durable = (): string => runtime.engine.check('CronCreate', { kind: 'confirm', specifier: 'durable' }).behavior;
    runtime.engine.mode = 'dontAsk';
    assert.equal(durable(), 'deny');
    runtime.engine.mode = 'default';
    runtime.engine.addRule('CronCreate(durable)', 'allow', 'session');
    assert.equal(durable(), 'allow');
    await runtime.shutdown();
  });

  it('follow the conversation: /clear keeps durable jobs and stops its own, which /resume and --resume bring back', async () => {
    const runtime = await createRuntime({ cwd: project, provider: new ScriptedProvider([{ text: 'hi' }]), prompter });
    for await (const _event of runtime.agent.run('hello', new AbortController().signal)) {
      // A conversation to resume later.
    }
    const id = runtime.agent.sessionId;
    runtime.cron!.create('7 9 * * *', 'session job', true);
    runtime.cron!.create('8 9 * * *', 'project job', true, { durable: true });

    const cleared = await runSlashCommand('/clear', runtime, noChoice);
    assert.equal(cleared.notice, 'Stopped what the previous conversation left running: 1 scheduled job. Its scheduled jobs come back if you resume it.');
    assert.deepEqual(runtime.cron!.list().map((job) => job.prompt), ['project job']);

    const later = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), prompter });
    assert.ok(later.warnings.some((warning) => /project job/.test(warning) && !/session job/.test(warning)), later.warnings.join('\n'));
    const resumedAtStart = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), prompter, resume: id });
    assert.ok(resumedAtStart.warnings.some((warning) => /session job/.test(warning)), resumedAtStart.warnings.join('\n'));

    const resumed = runtime.resumeSession(id);
    assert.match(resumed!.restored!, /session job/);
    assert.deepEqual(runtime.cron!.list().map((job) => job.prompt).sort(), ['project job', 'session job']);
    for (const each of [runtime, later, resumedAtStart]) await each.shutdown();
  });

  it('keep a durable job\'s run that is waiting for the session on /clear, and drop the rest', async () => {
    const runtime = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), prompter });
    const own = runtime.cron!.create('7 9 * * *', 'session job', true);
    const shared = runtime.cron!.create('8 9 * * *', 'project job', true, { durable: true });
    // Both came due while the session was busy.
    runtime.wakes.prompt('session job', `cron:${own.id}`);
    runtime.wakes.prompt('project job', `cron:${shared.id}`);
    runtime.noteForModel('news from the old conversation');
    runtime.wakes.notify();
    let woken = 0;
    runtime.wakes.onWake(() => woken++);
    await runSlashCommand('/clear', runtime, noChoice);
    const waiting = runtime.wakes.take();
    assert.deepEqual(waiting.prompts.map((prompt) => prompt.text), ['project job']);
    assert.equal(waiting.notes, false);
    assert.equal(woken, 1, 'the run left waiting still wakes the session');
    await runtime.shutdown();
  });
});

describe('/loop', () => {
  const at = new Date(2026, 10, 12, 14, 17);

  it('reads an interval before the prompt, after it, or alone', () => {
    assert.deepEqual(parseLoop('5m check the deploy', at), { prompt: 'check the deploy', every: { cron: '2-59/5 * * * *', describe: 'every 5 minutes' } });
    assert.deepEqual(parseLoop('check the deploy every 2 hours', at), { prompt: 'check the deploy', every: { cron: '17 */2 * * *', describe: 'every 2 hours' } });
    assert.deepEqual(parseLoop('look at CI every hour', at).every, { cron: '17 * * * *', describe: 'every hour' });
    assert.deepEqual(parseLoop('15m', at), { prompt: null, every: { cron: '2-59/15 * * * *', describe: 'every 15 minutes' } });
    assert.deepEqual(parseLoop('1d', at).every, { cron: '17 14 * * *', describe: 'every day' });
    assert.deepEqual(parseLoop('check the deploy', at), { prompt: 'check the deploy' });
    assert.deepEqual(parseLoop('', at), { prompt: null });
    assert.deepEqual(parseLoop('3 days ago the build broke, find out why', at), { prompt: '3 days ago the build broke, find out why' });
    assert.throws(() => parseLoop('0m check', at), /more than zero/);
    assert.throws(() => parseLoop('check every 0 minutes', at), /more than zero/);
  });

  it('rounds an interval to one a schedule can keep, and says so', () => {
    assert.match(intervalToCron(7, 'm', at).note!, /7 minutes .* every 6 minutes/);
    assert.equal(intervalToCron(7, 'm', at).cron, '5-59/6 * * * *');
    assert.equal(intervalToCron(90, 'm', at).cron, '17 */2 * * *');
    assert.equal(intervalToCron(30, 's', at).cron, '* * * * *');
    assert.match(intervalToCron(30, 's', at).note!, /seconds are rounded up/);
    assert.deepEqual(intervalToCron(7, 'd', at), { cron: '17 14 * * 4', describe: 'every week' });
  });

  it('first runs on its schedule a whole interval after the run it starts with', () => {
    const intervals: [number, 'm' | 'h' | 'd'][] = [[2, 'm'], [5, 'm'], [20, 'm'], [30, 'm'], [1, 'h'], [3, 'h'], [6, 'h'], [1, 'd'], [3, 'd'], [7, 'd']];
    for (const start of [new Date(2026, 10, 12, 14, 17), new Date(2026, 10, 3, 23, 59), new Date(2026, 10, 1, 0, 0)]) {
      for (const [amount, unit] of intervals) {
        const every = intervalToCron(amount, unit, start);
        const gap = (nextMatch(parseCron(every.cron), start)!.getTime() - start.getTime()) / 60_000;
        const expected = amount * { m: 1, h: 60, d: 1440 }[unit];
        assert.equal(gap, expected, `${amount}${unit} from ${start.toString()}: ${every.cron}`);
      }
    }
  });

  it('takes its default prompt from loop.md, the project\'s only when trusted', () => {
    assert.deepEqual(defaultLoopPrompt(project, false), { text: DEFAULT_LOOP_PROMPT, source: 'built-in' });
    writeFileSync(join(home, 'loop.md'), 'Mine.\n');
    mkdirSync(join(project, '.karst'), { recursive: true });
    writeFileSync(join(project, '.karst', 'loop.md'), `Project. ${'x'.repeat(30_000)}`);
    assert.equal(defaultLoopPrompt(project, false).text, 'Mine.');
    const fromProject = defaultLoopPrompt(project, true);
    assert.equal(fromProject.source, join(project, '.karst', 'loop.md'));
    assert.equal(Buffer.byteLength(fromProject.text), 25_000);
  });

  it('runs a skill it names with the Skill tool, when the model may run that skill', async () => {
    const skill = (name: string, front: string): void => {
      mkdirSync(join(home, 'skills', name), { recursive: true });
      writeFileSync(join(home, 'skills', name, 'SKILL.md'), `---\ndescription: ${name}\n${front}---\nDo ${name}.\n`);
    };
    skill('review-pr', '');
    skill('deploy', 'disable-model-invocation: true\n');
    const provider = new ScriptedProvider([]);
    const runtime = await createRuntime({ cwd: project, provider, persist: false, prompter });
    const firstRun = async (line: string): Promise<string> => {
      await runSlashCommand(line, runtime, noChoice);
      return runtime.wakes.take().prompts[0]!.text;
    };
    assert.match(await firstRun('/loop 5m /review-pr 12'), /^\/review-pr 12\n[\s\S]*Run it now with the Skill tool: skill "review-pr", args "12"/);
    assert.equal(await firstRun('/loop 5m /deploy prod'), '/deploy prod', 'only the user may run it, so it stays text');
    assert.equal(await firstRun('/loop 5m /clear'), '/clear', 'a built-in command stays text');
    await runSlashCommand('/loop stop', runtime, noChoice);

    await runSlashCommand('/loop /review-pr 12', runtime, noChoice);
    const iteration = runtime.wakes.take().prompts[0]!;
    for await (const _event of iteration.run!(new AbortController().signal)) {
      // Run the self-paced iteration.
    }
    assert.match(JSON.stringify(provider.requests.at(-1)!.messages.at(-1)), /loop-iteration[\s\S]*Run it now with the Skill tool: skill \\"review-pr\\"/);
    await runtime.shutdown();
  });

  it('with an interval, schedules a recurring job and runs it once now, until /loop stop', async () => {
    const runtime = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), persist: false, prompter });
    const started = await runSlashCommand('/loop 5m check the deploy', runtime, noChoice);
    assert.match(started.output!, /every 5 minutes \(\S+ \* \* \* \*\).*It also runs once now/s);
    assert.match((await runSlashCommand('/loop 0m check', runtime, noChoice)).output!, /more than zero/);
    const [job] = runtime.cron!.list();
    assert.equal(job!.origin, 'loop');
    assert.deepEqual(runtime.wakes.take().prompts, [{ text: 'check the deploy', key: `cron:${job!.id}` }]);

    await runSlashCommand('/loop 10m', runtime, noChoice);
    assert.equal(runtime.cron!.list()[1]!.loopDefault, true);
    assert.equal(runtime.wakes.take().prompts[0]!.text, DEFAULT_LOOP_PROMPT);

    assert.equal((await runSlashCommand('/loop stop', runtime, noChoice)).output, 'Stopped 2 scheduled loops.');
    assert.deepEqual(runtime.cron!.list(), []);
    assert.equal((await runSlashCommand('/loop stop', runtime, noChoice)).output, 'No loop is running.');
    await runtime.shutdown();
  });
});

describe('a self-paced loop', () => {
  let notices: string[];
  const start = async (script: ScriptedTurn[]): Promise<{ runtime: Runtime; provider: ScriptedProvider }> => {
    notices = [];
    const provider = new ScriptedProvider(script);
    const runtime = await createRuntime({ cwd: project, provider, persist: false, prompter, onNotice: (text) => notices.push(text) });
    return { runtime, provider };
  };
  /** Runs what is waiting to wake the session, as the terminal does when it is idle. */
  const runWaiting = async (runtime: Runtime, signal = new AbortController().signal): Promise<void> => {
    for (const prompt of runtime.wakes.take().prompts) {
      assert.ok(prompt.run, 'an iteration runs through the loop');
      for await (const _event of prompt.run(signal)) {
        // Run it to the end.
      }
    }
  };
  const wakeupId = (runtime: Runtime): string => runtime.cron!.list().find((job) => job.origin === 'wakeup')!.id;

  it('runs an iteration, waits as long as the model asks, and ends on stop: true', async () => {
    const { runtime, provider } = await start([
      { toolCalls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 120, reason: 'the build is still running' } }] },
      { text: 'Build at 40%.' },
      { toolCalls: [{ name: 'ScheduleWakeup', input: { stop: true } }] },
      { text: 'Build passed.' },
    ]);
    assert.match((await runSlashCommand('/loop check the build', runtime, noChoice)).output!, /Started a self-paced loop/);
    const before = Date.now();
    await runWaiting(runtime);
    assert.match(JSON.stringify(provider.requests[0]!.messages.at(-1)), /<loop-iteration number=\\"1\\">[\s\S]*check the build/);
    const next = runtime.loops!.waitingUntil()!;
    assert.ok(next.getTime() >= before + 120_000 && next.getTime() < before + 181_000, next.toString());
    assert.equal(next.getSeconds(), 0);
    assert.match(notices.at(-1)!, /^Loop: next iteration at .*, the build is still running$/);

    runtime.loops!.due(wakeupId(runtime));
    await runWaiting(runtime);
    assert.match(JSON.stringify(provider.requests[2]!.messages.at(-1)), /number=\\"2\\"/);
    assert.equal(runtime.loops!.waitingUntil(), undefined);
    assert.deepEqual(runtime.cron!.list(), []);
    assert.match(notices.at(-1)!, /The loop is finished/);
    await runtime.shutdown();
  });

  it('gives an iteration that schedules nothing one more, about 20 minutes later, then ends', async () => {
    const { runtime } = await start([{ text: 'Looked.' }, { text: 'Looked again.' }]);
    await runSlashCommand('/loop', runtime, noChoice);
    const before = Date.now();
    await runWaiting(runtime);
    const next = runtime.loops!.waitingUntil()!;
    assert.ok(next.getTime() >= before + 20 * 60_000 && next.getTime() < before + 21 * 60_000 + 1_000);
    assert.match(notices.at(-1)!, /did not schedule the next one, so one more runs at/);

    runtime.loops!.due(wakeupId(runtime));
    await runWaiting(runtime);
    assert.equal(runtime.loops!.waitingUntil(), undefined);
    assert.match(notices.at(-1)!, /two iterations in a row/);
    await runtime.shutdown();
  });

  it('stops on Esc while it waits, when its iteration is interrupted, and on /clear', async () => {
    const { runtime } = await start([{ toolCalls: [{ name: 'ScheduleWakeup', input: { delaySeconds: 300, reason: 'quiet' } }] }, { text: 'ok' }]);
    await runSlashCommand('/loop watch it', runtime, noChoice);
    await runWaiting(runtime);
    assert.equal(runtime.loops!.cancelWaiting(), true);
    assert.deepEqual(runtime.cron!.list(), []);
    assert.equal(runtime.loops!.cancelWaiting(), false);

    await runSlashCommand('/loop watch it', runtime, noChoice);
    const controller = new AbortController();
    controller.abort();
    await runWaiting(runtime, controller.signal);
    assert.match(notices.at(-1)!, /interrupted/);
    assert.equal(runtime.loops!.stop(), false);

    await runSlashCommand('/loop watch it', runtime, noChoice);
    assert.match((await runSlashCommand('/clear', runtime, noChoice)).notice!, /1 self-paced loop/);
    assert.equal(runtime.wakes.pending(), false);
    await runtime.shutdown();
  });

  it('ScheduleWakeup refuses outside a loop, and keeps the delay between 1 minute and 1 hour', async () => {
    const { runtime } = await start([]);
    const call = (input: Record<string, unknown>) => scheduleWakeupTool.execute(input, { ...runtime.context, signal: new AbortController().signal });
    const outside = await call({ delaySeconds: 60, reason: 'x' });
    assert.equal(outside.isError, true);
    assert.match(outside.content as string, /No self-paced \/loop is running/);

    await runSlashCommand('/loop watch it', runtime, noChoice);
    assert.match((await call({ delaySeconds: 5, reason: 'x' })).content as string, /so it is 60/);
    assert.match((await call({ reason: 'x' })).content as string, /Give delaySeconds/);
    assert.equal(runtime.cron!.list().filter((job) => job.origin === 'wakeup').length, 1, 'a new wakeup replaces the one before');
    await runtime.shutdown();
  });
});

describe('CronList and CronDelete', () => {
  it('list the jobs this session runs, and cancel one by its id', async () => {
    const runtime = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), persist: false, prompter });
    const ctx = { ...runtime.context, signal: new AbortController().signal };
    assert.deepEqual(await cronListTool.execute({}, ctx), { content: 'No scheduled jobs.', display: '0 jobs' });

    const kept = runtime.cron!.create('7 9 * * *', 'morning check', true);
    const cancelled = runtime.cron!.create(pinned(comingMinute()), 'remind me\nabout the deploy', false);
    const listed = await cronListTool.execute({}, ctx);
    assert.equal(listed.display, '2 jobs');
    assert.match(listed.content, new RegExp(`^${kept.id}  7 9 \\* \\* \\*  \\(recurring, expires .+\\)  next run: .+\\n  prompt: morning check$`, 'm'));
    assert.match(listed.content, new RegExp(`^${cancelled.id}  .+  \\(one-shot\\)  next run: .+\\n  prompt: remind me about the deploy$`, 'm'));

    assert.deepEqual(await cronDeleteTool.execute({ id: cancelled.id }, ctx), { content: `Cancelled job ${cancelled.id}.`, display: `cancelled ${cancelled.id}` });
    assert.deepEqual(runtime.cron!.list().map((job) => job.id), [kept.id]);
    assert.deepEqual(await cronDeleteTool.execute({ id: cancelled.id }, ctx), { content: `No scheduled job ${cancelled.id}.`, isError: true });
    await runtime.shutdown();
  });

  it('take a durable job out of the saved jobs, so later sessions do not run it', async () => {
    const runtime = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), prompter });
    const ctx = { ...runtime.context, signal: new AbortController().signal };
    const job = runtime.cron!.create('7 9 * * *', 'project check', true, { durable: true });
    assert.deepEqual(new WorkspaceJobStore(project).load().map((saved) => saved.id), [job.id]);
    assert.match((await cronListTool.execute({}, ctx)).content, new RegExp(`^${job.id}  .+, durable\\)`));

    assert.equal((await cronDeleteTool.execute({ id: job.id }, ctx)).content, `Cancelled job ${job.id}.`);
    assert.deepEqual(new WorkspaceJobStore(project).load(), []);
    const later = new CronScheduler(() => {}, { session: () => 'a-later-session', store: new WorkspaceJobStore(project) });
    assert.deepEqual(later.restore('a-later-session'), []);
    later.stopAll();
    await runtime.shutdown();
  });
});

it('keeps nothing on disk for a session that saves nothing', async () => {
  const runtime = await createRuntime({ cwd: project, provider: new ScriptedProvider([]), persist: false, prompter });
  runtime.cron!.create('7 9 * * *', 'x', true, { durable: true });
  assert.equal(runtime.cron!.persistent, false);
  assert.equal(existsSync(workspaceScheduledPath(project)), false);
  await runtime.shutdown();
});
