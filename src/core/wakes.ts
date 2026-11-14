/**
 * Things that should start a turn without the user typing: background work finishing (its note
 * is already waiting in the conversation) and scheduled prompts coming due. The interactive UI
 * runs them when it is idle. A conversation nobody watches, a subagent or a print-mode run, is
 * woken by `followBackgroundWork` instead.
 */
import type { AgentEvent } from './agent.ts';
import type { BackgroundTask, TaskRegistry } from '../tools/tasks.ts';

/** How many more turns a conversation nobody watches gets for news of its background work. */
const MAX_FOLLOW_UPS = 20;

/** A prompt waiting to run. `run`, when there is one, runs it instead of a plain turn. */
export interface WakePrompt {
  text: string;
  key?: string;
  run?: (signal: AbortSignal) => AsyncIterable<AgentEvent>;
}

export class WakeQueue {
  private prompts: WakePrompt[] = [];
  private notes = false;
  private readonly listeners = new Set<() => void>();
  private settling: NodeJS.Timeout | undefined;

  /**
   * A note for the model is waiting. With `settleMs`, waking waits that long from the first such
   * note, so others that follow, such as a burst of monitor events, start one turn rather than
   * several. A note without it wakes at once, taking those along.
   */
  notify(settleMs = 0): void {
    this.notes = true;
    if (settleMs <= 0) {
      this.emit();
      return;
    }
    if (this.settling) return;
    this.settling = setTimeout(() => {
      this.settling = undefined;
      this.emit();
    }, settleMs);
    this.settling.unref();
  }

  /**
   * A prompt to run as if the user had typed it. A prompt with the same `key` that is still
   * waiting is not added again, so a scheduled job that comes due several times while the session
   * is busy runs once. Returns whether it was added.
   */
  prompt(text: string, key?: string, run?: WakePrompt['run']): boolean {
    if (key !== undefined && this.prompts.some((waiting) => waiting.key === key)) return false;
    this.prompts.push({ text, ...(key === undefined ? {} : { key }), ...(run ? { run } : {}) });
    this.emit();
    return true;
  }

  pending(): boolean {
    return this.notes || this.prompts.length > 0;
  }

  /** Everything waiting, oldest first, and clears it. */
  take(): { prompts: WakePrompt[]; notes: boolean } {
    const taken = { prompts: this.prompts, notes: this.notes };
    this.prompts = [];
    this.notes = false;
    return taken;
  }

  /**
   * Clears what is waiting, except prompts `keep` picks, which still wake the session. For a
   * conversation being left: its notes go, but a run of a job that outlives it stays.
   */
  discard(keep: (prompt: WakePrompt) => boolean): void {
    clearTimeout(this.settling);
    this.settling = undefined;
    this.notes = false;
    this.prompts = this.prompts.filter(keep);
    if (this.prompts.length > 0) this.emit();
  }

  /** Calls `listener` whenever something new is waiting. Returns a function that stops it. */
  onWake(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when something is waiting, or the signal fires. */
  wait(signal?: AbortSignal): Promise<void> {
    if (this.pending() || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        stop();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const stop = this.onWake(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  private emit(): void {
    clearTimeout(this.settling);
    this.settling = undefined;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface FollowOptions {
  /** Starts a turn for the notes waiting in the conversation. Yields nothing when there are none. */
  resume(signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** Adds a note to what the conversation sees in its next turn. */
  note(text: string): void;
  /** The conversation's own background commands and monitors. */
  tasks: TaskRegistry;
  /** Notified when one of them has news for the conversation. */
  wakes: WakeQueue;
  signal: AbortSignal;
}

function stillRunning(tasks: BackgroundTask[]): string {
  const lines = tasks.map((task) => `- task ${task.id}: ${task.description ?? task.command.split('\n')[0]!.slice(0, 80)}`);
  return [
    '<task-notification>',
    'Your turn ended while background work you started is still running:',
    ...lines,
    'You will be woken each time one of them ends or has news. Stop any you no longer need with TaskStop.',
    '</task-notification>',
  ].join('\n');
}

/** Resolves when a note is waiting, a task ends, or the signal fires. */
async function nextChange(tasks: TaskRegistry, wakes: WakeQueue, signal: AbortSignal): Promise<void> {
  const settled = new AbortController();
  const either = AbortSignal.any([signal, settled.signal]);
  try {
    await Promise.race([wakes.wait(either), tasks.waitForChange(either)]);
  } finally {
    // The one that lost stops listening.
    settled.abort();
  }
}

/**
 * Runs `turn`, then keeps the conversation going while its background work runs, the way an
 * interactive session is woken when it is idle. For a subagent or a print-mode run, which would
 * otherwise end without ever seeing how a command it started in the background turned out.
 *
 * The first time a turn ends with work still running, the conversation is told what is running,
 * so it can stop what it no longer needs instead of waiting for it. After that it gets a turn
 * whenever a command ends or a monitor reports, up to a limit. It stops following after a turn
 * that did not end normally, such as an error or an interruption.
 */
export async function* followBackgroundWork(turn: AsyncIterable<AgentEvent>, options: FollowOptions): AsyncGenerator<AgentEvent> {
  const { tasks, wakes, signal } = options;
  let ended: string | undefined;
  let turns = 0;
  async function* watch(events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
      if (event.type === 'turn_end') {
        ended = event.stopReason;
        turns++;
      }
      yield event;
    }
  }

  yield* watch(turn);
  let told = false;
  // A wake whose notes the last turn already saw, at a tool round, starts no turn and is not counted.
  while (!signal.aborted && ended === 'end_turn' && turns <= MAX_FOLLOW_UPS) {
    if (!wakes.pending()) {
      const running = tasks.running();
      if (running.length === 0) return;
      if (told) {
        await nextChange(tasks, wakes, signal);
        continue;
      }
      told = true;
      options.note(stillRunning(running));
      wakes.notify();
    }
    wakes.take();
    yield* watch(options.resume(signal));
  }
}
