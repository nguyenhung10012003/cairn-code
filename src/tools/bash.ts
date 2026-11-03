import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalize, isInside } from '../permissions/rules.ts';
import { killTree } from './tasks.ts';
import type { Tool, ToolContext, ToolOutput } from './types.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_LIMIT = 30_000;
const KILL_GRACE_MS = 2_000;
/** A command can exit while something it backgrounded still holds the output pipe open. */
const PIPE_DRAIN_MS = 200;

export function shell(): string {
  return process.env.SHELL || '/bin/sh';
}

/** Without this, a model-run `env` would copy the API key into the transcript. */
function commandEnvironment(ctx: ToolContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat' };
  for (const name of ctx.secretEnvVars) delete env[name];
  if (ctx.extraPath?.length) env.PATH = [...ctx.extraPath, env.PATH].filter(Boolean).join(delimiter);
  return env;
}

export interface CommandOptions {
  description?: string;
  /** The model asked to run this outside the sandbox, and was approved. */
  unsandboxed: boolean;
}

/** The shell invocation for a command, inside the sandbox when one is on, with credentials removed. */
export function launch(script: string, command: string, options: CommandOptions, ctx: ToolContext): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const plain = { file: shell(), args: ['-c', script] };
  const env = commandEnvironment(ctx);
  if (!ctx.wrapCommand) return { ...plain, env };
  const wrapped = ctx.wrapCommand(plain.file, plain.args, { command, unsandboxed: options.unsandboxed });
  return { file: wrapped.file, args: wrapped.args, env: { ...env, ...wrapped.env } };
}

/** Keeps the start and end of long output, which is where the useful parts usually are. */
class OutputBuffer {
  private head = '';
  private tail = '';
  private dropped = 0;

  append(text: string): void {
    const half = OUTPUT_LIMIT / 2;
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    this.tail += text;
    if (this.tail.length > half) {
      this.dropped += this.tail.length - half;
      this.tail = this.tail.slice(-half);
    }
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n\n[... ${this.dropped} characters of output omitted ...]\n\n${this.tail}`;
  }
}

function startInBackground(command: string, limitMs: number | undefined, options: CommandOptions, ctx: ToolContext): ToolOutput {
  const { file, args, env } = launch(command, command, options, ctx);
  const task = ctx.tasks.start(file, args, {
    command,
    cwd: ctx.cwd(),
    env,
    ...(options.description ? { description: options.description } : {}),
    ...(limitMs === undefined ? {} : { limitMs }),
  });
  if (!task) return { content: 'Failed to start background process.', isError: true };
  return {
    content: `Started in background as task ${task.id}. Output is written to ${task.logPath}, which you can Read. You will be told when it exits. Use TaskStop to stop it.`,
    display: `background task ${task.id}`,
  };
}

function runForeground(command: string, timeoutMs: number, options: CommandOptions, ctx: ToolContext): Promise<ToolOutput> {
  const cwdFile = join(tmpdir(), `cairn-cwd-${randomUUID()}`);
  // The shell exits after each call, so its final directory is carried over by hand.
  const wrapped = `${command}\n__cairn_status=$?; pwd -P > '${cwdFile}' 2>/dev/null; exit $__cairn_status`;

  return new Promise((resolvePromise) => {
    const output = new OutputBuffer();
    const target = launch(wrapped, command, options, ctx);
    const child = spawn(target.file, target.args, {
      cwd: ctx.cwd(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: target.env,
    });
    let timedOut = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      if (child.pid === undefined) return;
      killTree(child.pid, 'SIGTERM');
      forceKill = setTimeout(() => killTree(child.pid!, 'SIGKILL'), KILL_GRACE_MS);
      forceKill.unref();
    };
    const onAbort = (): void => terminate();
    const timer = setTimeout(() => {
      if (shouldMoveToBackground(command, ctx) && child.pid !== undefined) {
        settled = true;
        ctx.signal.removeEventListener('abort', onAbort);
        rmSync(cwdFile, { force: true });
        const task = ctx.tasks.adopt(child, { command, soFar: output.toString(), ...(options.description ? { description: options.description } : {}) });
        resolvePromise({
          content:
            `Command did not complete within its ${Math.round(timeoutMs / 1000)}s timeout and was moved to the background as task ${task.id}. ` +
            `Output is being written to ${task.logPath}. You will be told when it exits.\n` +
            `Session cwd remains ${ctx.cwd()}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
          display: `moved to background: task ${task.id}`,
        });
        return;
      }
      timedOut = true;
      terminate();
    }, timeoutMs);
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk: Buffer) => output.append(decoder.write(chunk)));
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      ctx.signal.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();

      const notes: string[] = [];
      try {
        const finalDir = readFileSync(cwdFile, 'utf8').trim();
        rmSync(cwdFile, { force: true });
        // A failed command leaves the directory where it was.
        if (code === 0 && finalDir && finalDir !== ctx.cwd()) {
          const canonical = canonicalize(finalDir);
          const startDir = ctx.workingDirs()[0];
          if (ctx.workingDirs().some((dir) => isInside(canonical, dir))) {
            ctx.setCwd(finalDir);
          } else if (startDir) {
            ctx.setCwd(startDir);
            notes.push(`Shell cwd was reset to ${startDir}: ${finalDir} is outside the working directories.`);
          }
        }
      } catch {
        // No cwd file: the command called `exit` or was killed. Keep the current directory.
      }

      let body = output.toString().trimEnd();
      if (timedOut) notes.push(`Command timed out after ${timeoutMs} ms.`);
      else if (ctx.signal.aborted) notes.push('Command was interrupted.');
      else if (signal) notes.push(`Command was terminated by ${signal}.`);
      else if (code !== 0) notes.push(`Exit code ${code}.`);
      if (notes.length > 0) body = body ? `${body}\n\n${notes.join('\n')}` : notes.join('\n');
      const isError = timedOut || ctx.signal.aborted || signal !== null || code !== 0;
      resolvePromise({ content: body || '(no output)', isError, ...(code === null ? {} : { exitCode: code }) });
    };

    child.on('error', (error) => {
      output.append(`Failed to start shell: ${error.message}`);
      finish(1, null);
    });
    child.on('close', finish);
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), PIPE_DRAIN_MS).unref();
    });
  });
}

/** A bare `sleep` has nothing to come back for, so it stops at its timeout instead. */
function shouldMoveToBackground(command: string, ctx: ToolContext): boolean {
  return ctx.autoBackground === true && !/^\s*sleep\b/.test(command);
}

/** A leading `sleep` of this many seconds or more is refused in the foreground. */
const MIN_BLOCKED_SLEEP_SECONDS = 2;

function blockedSleep(command: string): boolean {
  // Only a bare `sleep N` as the whole command, not a sleep inside a larger pipeline or script.
  const match = /^\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\s*;?\s*$/.exec(command);
  if (!match) return false;
  const scale = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? ''] ?? 1;
  return Number(match[1]) * scale >= MIN_BLOCKED_SLEEP_SECONDS;
}

export const bashTool: Tool = {
  name: 'Bash',
  description: `Executes a bash command and returns its output.

- \`cd\` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was. Prefer absolute paths — \`cd\` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist.
- IMPORTANT: Avoid using this tool to run \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.
- Command output is displayed to you, not reliably to the user.
- \`timeout\` is in milliseconds: default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS} for a foreground command.
- \`run_in_background\` runs the command detached: it keeps running across turns and re-invokes you when it exits. No \`&\` needed. You will be notified when it exits — do not poll its output file while waiting. Foreground \`sleep\` is blocked; use Monitor with an until-loop to wait on a condition.

### Git
- Interactive flags (\`-i\`, e.g. \`git rebase -i\`, \`git add -i\`) are not supported in this environment.
- Use the \`gh\` CLI for GitHub operations (PRs, issues, API).
- GitHub notifies the owner of any \`@name\` written in a PR, issue, or comment. Write a bare \`@name\` only for a real login you mean to notify. Put roles, placeholders, and code (\`@human\`, \`@reviewer\`, \`@types/node\`) in backticks or drop the \`@\`, even when copied from project files.
- Commit or push only when the user asks. If on the default branch, branch first.
- End git commit messages and PR bodies with the attribution lines given in the system prompt, when one is present.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { description: 'The command to execute', type: 'string' },
      timeout: { description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS} for a foreground command)`, type: 'number' },
      description: {
        description: `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`,
        type: 'string',
      },
      run_in_background: { description: 'Set to true to run this command in the background.', type: 'boolean' },
      dangerouslyDisableSandbox: { description: 'Set this to true to dangerously override sandbox mode and run commands without sandboxing.', type: 'boolean' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: (input) => ({ kind: 'bash', command: input.command as string, ...(input.dangerouslyDisableSandbox === true ? { unsandboxed: true } : {}) }),
  async execute(input, ctx) {
    const command = input.command as string;
    const options: CommandOptions = {
      unsandboxed: input.dangerouslyDisableSandbox === true,
      ...(input.description ? { description: input.description as string } : {}),
    };
    const requested = input.timeout as number | undefined;
    if (input.run_in_background === true) return startInBackground(command, requested, options, ctx);
    if (blockedSleep(command)) {
      return {
        content:
          'Foreground sleep is blocked. To wait for something, run a command that exits when it is ready with run_in_background (you are notified when it exits), or use Monitor with an until-loop.',
        isError: true,
      };
    }
    return runForeground(command, Math.min(Math.max(requested ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS), options, ctx);
  },
};
