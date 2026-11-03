/**
 * Monitor: a long-running script or WebSocket whose output lines arrive in the conversation as
 * notifications while the model keeps working.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { launch } from './bash.ts';
import { killTree } from './tasks.ts';
import type { Tool, ToolContext } from './types.ts';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MIN_TIMEOUT_MS = 1_000;
const BATCH_MS = 200;
/** A monitor sending more notifications than this in a minute is stopped. */
const MAX_EVENTS_PER_MINUTE = 60;
const MAX_EVENT_CHARS = 4_000;
const KILL_GRACE_MS = 2_000;

export const monitorTool: Tool = {
  name: 'Monitor',
  description: `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **Bash with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. You get a single completion notification when it exits.
- **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → Monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → Monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  \`\`\`sh
  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done
  \`\`\`

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use Bash \`run_in_background\` with an \`until\` loop instead (one notification, ends in seconds). Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. \`head\` cannot flush at all — \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via Read) but does not trigger notifications — for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  \`\`\`sh
  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"
  \`\`\`

For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within ${BATCH_MS}ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as Bash. Exit ends the watch (exit code is reported). Every monitor expires after \`timeout_ms\` (default 5 minutes, at most 30 minutes): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use TaskStop to cancel early.
**ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.

  \`\`\`js
  Monitor({
    ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
    description: 'deploy events',
  })
  \`\`\`

Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as bash — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.

Prefer this over \`command: 'websocat wss://…'\` — it avoids the extra process and line-buffering pitfalls. Use bash when you need to transform or filter frames with shell tools before they become events.`,
  inputSchema: {
    type: 'object',
    properties: {
      description: { description: 'Short human-readable description of what you are monitoring (shown in notifications).', type: 'string' },
      timeout_ms: {
        description: `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms. Deadlines above ${MAX_TIMEOUT_MS}ms are capped to ${MAX_TIMEOUT_MS}ms. You are notified at expiry and can re-arm.`,
        default: DEFAULT_TIMEOUT_MS,
        type: 'number',
        minimum: MIN_TIMEOUT_MS,
        maximum: 3_600_000,
      },
      command: { description: 'Shell command or script. Each stdout line is an event; exit ends the watch.', type: 'string' },
      ws: {
        description: 'WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.',
        type: 'object',
        properties: {
          url: { description: 'The WebSocket URL to connect to (ws:// or wss://).', type: 'string' },
          protocols: { description: 'Optional WebSocket subprotocols to request.', type: 'array', items: { description: 'A subprotocol name.', type: 'string' } },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    required: ['description', 'timeout_ms'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: (input) => {
    if (input.command !== undefined) return { kind: 'bash', command: input.command as string };
    const ws = input.ws as { url?: string } | undefined;
    return { kind: 'web', url: ws?.url ?? '' };
  },
  async execute(input, ctx) {
    const description = input.description as string;
    const timeoutMs = Math.min(Math.max(Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const command = input.command as string | undefined;
    const ws = input.ws as { url: string; protocols?: string[] } | undefined;
    if ((command === undefined) === (ws === undefined)) return { content: 'Give exactly one of command or ws.', isError: true };
    if (!ctx.notify) return { content: 'Monitors are not available here.', isError: true };
    return command !== undefined ? startCommand(command, description, timeoutMs, ctx) : startSocket(ws!, description, timeoutMs, ctx);
  },
};

/** Batches events, enforces the rate limit and the deadline, and reports how the watch ended. */
class Watch {
  events = 0;
  private pending: string[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private readonly recent: number[] = [];
  private ended = false;
  private readonly deadline: NodeJS.Timeout;
  private readonly label: string;
  private readonly ctx: ToolContext;
  private readonly kill: () => void;
  private readonly onEnd: (status: 'exited' | 'stopped' | 'timed_out', exitCode?: number | null) => void;

  constructor(
    label: string,
    ctx: ToolContext,
    timeoutMs: number,
    kill: () => void,
    onEnd: (status: 'exited' | 'stopped' | 'timed_out', exitCode?: number | null) => void,
  ) {
    this.label = label;
    this.ctx = ctx;
    this.kill = kill;
    this.onEnd = onEnd;
    this.deadline = setTimeout(() => this.end('timed_out', `expired after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    this.deadline.unref();
  }

  push(line: string): void {
    if (this.ended) return;
    this.pending.push(line.length > MAX_EVENT_CHARS ? `${line.slice(0, MAX_EVENT_CHARS)}… [line truncated]` : line);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), BATCH_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.pending.length === 0 || this.ended) return;
    const lines = this.pending.join('\n');
    this.pending = [];
    const now = Date.now();
    this.recent.push(now);
    while (this.recent.length > 0 && now - this.recent[0]! > 60_000) this.recent.shift();
    this.events++;
    this.ctx.notify!(`<task-notification>\nMonitor event: ${this.label}\n${lines}\n</task-notification>`);
    if (this.recent.length > MAX_EVENTS_PER_MINUTE) {
      this.end('stopped', `was stopped: more than ${MAX_EVENTS_PER_MINUTE} notifications in a minute. Restart it with a tighter filter`);
    }
  }

  /** Ends the watch once, and tells the conversation how. */
  end(status: 'exited' | 'stopped' | 'timed_out', why: string, exitCode?: number | null, quiet = false): void {
    if (this.ended) return;
    this.flush();
    this.ended = true;
    clearTimeout(this.deadline);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (status !== 'exited') this.kill();
    this.onEnd(status, exitCode);
    if (!quiet) this.ctx.notify!(`<task-notification>\nMonitor ${this.label} ${why} (${this.events} event${this.events === 1 ? '' : 's'}).\n</task-notification>`);
  }
}

function startCommand(command: string, description: string, timeoutMs: number, ctx: ToolContext): ReturnType<Tool['execute']> {
  const target = launch(command, command, { unsandboxed: false, description }, ctx);
  let pid: number | undefined;
  let watch: Watch | undefined;
  const task = ctx.tasks.track({ command, description, stop: () => watch?.end('stopped', 'was stopped', undefined, true) });
  const label = `"${description}" (task ${task.id})`;
  const log = createWriteStream(task.logPath, { flags: 'a', mode: 0o600 });
  const child = spawn(target.file, target.args, { cwd: ctx.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: target.env });
  pid = child.pid;
  child.unref();
  watch = new Watch(label, ctx, timeoutMs, () => {
    if (pid === undefined) return;
    killTree(pid, 'SIGTERM');
    setTimeout(() => killTree(pid!, 'SIGKILL'), KILL_GRACE_MS).unref();
  }, (status, code) => ctx.tasks.settle(task.id, status, code));
  const decoder = new StringDecoder('utf8');
  let partial = '';
  child.stdout.on('data', (chunk: Buffer) => {
    log.write(chunk);
    const lines = (partial + decoder.write(chunk)).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) watch!.push(line);
  });
  child.stderr.on('data', (chunk: Buffer) => log.write(chunk));
  for (const stream of [child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.();
  child.on('error', (error) => watch!.end('exited', `could not start: ${error.message}`, 1));
  child.on('close', (code) => {
    if (partial.trim()) watch!.push(partial);
    log.end();
    watch!.end('exited', `ended with exit code ${code}`, code);
  });
  return Promise.resolve({
    content: `Monitor started as task ${task.id}. Each stdout line arrives as a notification; stderr goes to ${task.logPath}. It expires in ${Math.round(timeoutMs / 1000)}s. Use TaskStop to cancel it.`,
    display: `monitor ${task.id}`,
  });
}

function startSocket(spec: { url: string; protocols?: string[] }, description: string, timeoutMs: number, ctx: ToolContext): ReturnType<Tool['execute']> {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return Promise.resolve({ content: `Invalid WebSocket URL: ${spec.url}`, isError: true });
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return Promise.resolve({ content: `Not a WebSocket URL: ${spec.url}`, isError: true });
  let socket: WebSocket | undefined;
  let watch: Watch | undefined;
  const task = ctx.tasks.track({ command: `ws ${url.href}`, description, stop: () => watch?.end('stopped', 'was stopped', undefined, true) });
  const label = `"${description}" (task ${task.id})`;
  try {
    socket = new WebSocket(url.href, spec.protocols ?? []);
  } catch (error) {
    ctx.tasks.settle(task.id, 'exited', 1);
    return Promise.resolve({ content: `Could not open ${url.href}: ${(error as Error).message}`, isError: true });
  }
  watch = new Watch(label, ctx, timeoutMs, () => socket?.close(), (status, code) => ctx.tasks.settle(task.id, status, code));
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    const data = event.data as unknown;
    if (typeof data === 'string') watch!.push(data);
    else watch!.push(`[binary frame, ${(data as ArrayBuffer).byteLength ?? 0} bytes]`);
  });
  socket.addEventListener('error', () => watch!.push(`[socket error on ${url.href}]`));
  socket.addEventListener('close', (event) => watch!.end('exited', `closed with code ${event.code}${event.reason ? ` (${event.reason})` : ''}`, event.code));
  return Promise.resolve({
    content: `Monitor started as task ${task.id} on ${url.href}. Each text frame arrives as a notification. It expires in ${Math.round(timeoutMs / 1000)}s. Use TaskStop to cancel it.`,
    display: `monitor ${task.id}`,
  });
}
