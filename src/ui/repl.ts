/**
 * The interactive terminal session. Input stays live while the agent works: a message waits a
 * moment before it is sent, so more can be added to it, and sending one while the agent is busy
 * stops the current work and answers the newest message instead. /queue holds messages until the
 * current work is done.
 */
import { basename } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline';
import { APP_DISPLAY_NAME } from '../config/paths.ts';
import { commandEntries, isCommandLine, parseSlash, runSlashCommand, settleCommand } from '../commands/slash.ts';
import type { CommandIO, CommandResult, TabPage } from '../commands/slash.ts';
import type { Agent, AgentEvent } from '../core/agent.ts';
import { contextTokens } from '../core/messages.ts';
import type { ImageBlock } from '../core/messages.ts';
import type { Runtime } from '../core/runtime.ts';
import type { PermissionMode } from '../permissions/engine.ts';
import type { SkillActivation } from '../skills/skills.ts';
import type { PermissionAnswer, PermissionPrompt, Prompter, UserQuestion } from '../tools/types.ts';
import { AttachedImages, droppedImagePaths, loadImage, markPlaceholders, PastedTexts, PLACEHOLDER_AT_END } from './attachments.ts';
import { readClipboardImage } from './clipboard.ts';
import { Footer } from './footer.ts';
import { chooseWithNote, pickFromList, readSecret } from './picker.ts';
import type { ChoiceOption } from './picker.ts';
import { clipToWidth, displayWidth, MarkdownStream, permissionPreview, sanitize, style, toolResultSummary, toolSummary, wrapToWidth } from './render.ts';
import { showTabs } from './tabs.ts';
import { renderWelcome, welcomeRows } from './welcome.ts';

const stdin = process.stdin;
const stdout = process.stdout;

/** How long a typed message waits before it is sent, so more can be added to it. */
export const SEND_DELAY_MS = 3_000;

/** Commands that leave the running work alone, so they may run alongside it. */
const WHILE_BUSY = new Set([
  'help', 'status', 'cost', 'usage', 'context', 'todos', 'tasks', 'queue', 'copy', 'diff', 'mode', 'effort',
  'permissions', 'agents', 'skills', 'memory', 'hooks', 'btw', 'exit', 'quit',
]);

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Questions that are not the main prompt read a line through a short-lived readline. */
class LineInput {
  read(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: stdin, output: stdout, terminal: true, historySize: 0 });
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve(value);
      };
      rl.on('SIGINT', () => {
        stdout.write('\n');
        finish('');
      });
      rl.on('close', () => finish(null));
      rl.question(prompt, (answer) => finish(answer));
    });
  }
}

/**
 * Lines written straight to the terminal that can be taken back afterwards. Each line is wrapped
 * to fit, so the block's height is known. Once its first row has scrolled into the terminal's
 * scrollback, it can no longer be reached, and it stays.
 */
class ScreenBlock {
  rows = 0;

  write(line: string): void {
    const pieces = wrapToWidth(line, (stdout.columns || 80) - 1);
    stdout.write(`${pieces.join('\n')}\n`);
    this.rows += pieces.length;
  }

  /**
   * Erases the block and the `after` rows written below it since. `tallest` is the most rows the
   * block and what followed it took up at once: past the screen's height, its top scrolled away.
   */
  erase(after: number, tallest: number): boolean {
    if (!stdout.isTTY || tallest > (stdout.rows || 24)) return false;
    stdout.write(`\r\x1b[${this.rows + after}A\x1b[0J`);
    return true;
  }
}

class TerminalPrompter implements Prompter {
  private readonly input: LineInput;
  /**
   * Set by the session: runs a question with the screen to itself, once nothing else has it.
   * Anything printed meanwhile waits until it is answered, so it cannot land inside the prompt.
   */
  around: <T>(work: () => Promise<T>) => Promise<T> = (work) => work();

  constructor(input: LineInput) {
    this.input = input;
  }

  /** Runs one whole question with the footer out of the way. */
  private asking<T>(work: () => Promise<T>): Promise<T> {
    return this.around(work);
  }

  permission(prompt: PermissionPrompt): Promise<PermissionAnswer> {
    return this.asking(async () => {
      const block = new ScreenBlock();
      block.write('');
      block.write(style.yellow(style.bold(`${prompt.toolName} needs your approval`)));
      for (const line of permissionPreview(prompt.toolName, prompt.input)) block.write(line);
      block.write(style.dim(sanitize(prompt.reason)));
      const canAlways = !prompt.forced && prompt.suggestions.length > 0;
      const rules = prompt.suggestions.map((suggestion) => suggestion.rule).join(', ');
      const where = prompt.suggestions.some((suggestion) => suggestion.persist) ? 'saved for this project' : 'for this session';
      const alwaysLabel = `Yes, and don't ask again for ${rules} (${where})`;
      // A rule too long for the option line is shown in full above it.
      if (canAlways && displayWidth(alwaysLabel) > (stdout.columns || 80) - 6) {
        for (const suggestion of prompt.suggestions) {
          block.write(style.dim(`  don't ask again would add: ${sanitize(suggestion.rule)} (${suggestion.persist ? 'saved for this project' : 'this session'})`));
        }
      }
      if (!stdin.isTTY || !stdout.isTTY) return this.typedPermission(canAlways);
      const options: { option: ChoiceOption; answer: PermissionAnswer }[] = [
        { option: { label: 'Yes', key: 'y', notePrompt: 'Yes, and tell the model' }, answer: { behavior: 'allow' } },
        ...(canAlways
          ? [{ option: { label: alwaysLabel, key: 'a', notePrompt: "Yes, don't ask again, and tell the model" }, answer: { behavior: 'allow' as const, always: true } }]
          : []),
        { option: { label: 'No', key: 'n', notePrompt: 'No, and tell the model what to do instead' }, answer: { behavior: 'deny' } },
      ];
      const choice = await chooseWithNote(options.map((entry) => entry.option), { cancelIndex: options.length - 1 });
      const answer = options[choice.index]!.answer;
      if (answer.behavior === 'allow') {
        // The call's line above and its result below say enough, so an approval leaves the
        // prompt off the screen. The picker drew its options and hint below the block, and left
        // one line with the answer.
        // A note goes into the call's result, which shows it. A new rule is shown nowhere else.
        const erased = block.erase(1, block.rows + options.length + 1);
        if (erased && answer.always) {
          stdout.write(`${style.dim(clipToWidth(`  ✓ Approved; won't ask again for ${sanitize(rules)} (${where})`, (stdout.columns || 80) - 1))}\n`);
        }
      }
      return choice.note ? { ...answer, feedback: choice.note } : answer;
    });
  }

  /** Without a terminal to draw options in, the answer is typed. */
  private async typedPermission(canAlways: boolean): Promise<PermissionAnswer> {
    const options = canAlways ? '[y] yes  [a] always  [n] no, or type what to do instead' : '[y] yes  [n] no, or type what to do instead';
    const answer = (await this.input.read(`${options}: `))?.trim() ?? '';
    const lowered = answer.toLowerCase();
    if (lowered === 'y' || lowered === 'yes') return { behavior: 'allow' };
    if (canAlways && (lowered === 'a' || lowered === 'always')) return { behavior: 'allow', always: true };
    if (lowered === '' || lowered === 'n' || lowered === 'no') return { behavior: 'deny' };
    return { behavior: 'deny', feedback: answer };
  }

  questions(questions: UserQuestion[]): Promise<string[] | null> {
    return this.asking(async () => {
      const answers: string[] = [];
      for (const question of questions) {
        stdout.write(`\n${style.bold(sanitize(question.question))}\n`);
        question.options.forEach((option, i) => {
          const description = option.description ? style.dim(` - ${sanitize(option.description)}`) : '';
          stdout.write(`  ${i + 1}. ${sanitize(option.label)}${description}\n`);
        });
        const hint = question.multiSelect ? 'Numbers separated by commas, or your own answer: ' : 'Number, or your own answer: ';
        const raw = (await this.input.read(hint))?.trim() ?? '';
        const picks = raw.split(',').map((part) => Number.parseInt(part.trim(), 10));
        const valid = raw !== '' && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= question.options.length);
        answers.push(valid ? picks.map((n) => question.options[n - 1]!.label).join(', ') : raw);
      }
      return answers;
    });
  }

  approvePlan(plan: string): Promise<boolean> {
    return this.asking(async () => {
      stdout.write(`\n${style.bold('Proposed plan')}\n${sanitize(plan)}\n\n`);
      const answer = (await this.input.read('Approve and start? [y/N]: '))?.trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    });
  }
}

export interface Terminal {
  prompter: TerminalPrompter;
  input: LineInput;
  /** Prints a line for the user, above the input once the session has started. */
  print(text: string): void;
}

export function createTerminalPrompter(): Terminal {
  const input = new LineInput();
  const terminal: Terminal = {
    prompter: new TerminalPrompter(input),
    input,
    print: (text) => stdout.write(text),
  };
  return terminal;
}

/** Rows of thinking shown above the input while it streams. */
const THINKING_ROWS = 5;
/** Enough of the latest thinking to fill those rows, however it wraps. */
const THINKING_TAIL_CHARS = 4_000;

/**
 * The model's thinking, while it arrives: its last few rows above the input, redrawn with the
 * footer. When the thinking ends, the rows go and one line says how long it took, so the
 * conversation keeps the answers and the work, not the reasoning.
 */
class ThinkingView {
  private tail = '';
  private startedAt: number | null = null;
  private readonly changed: () => void;
  private readonly print: (text: string) => void;

  constructor(changed: () => void, print: (text: string) => void) {
    this.changed = changed;
    this.print = print;
  }

  push(text: string): void {
    this.startedAt ??= Date.now();
    this.tail = (this.tail + sanitize(text)).slice(-THINKING_TAIL_CHARS);
    this.changed();
  }

  /** Replaces the rows with a line saying how long the model thought. Does nothing when it was not thinking. */
  finish(): void {
    if (this.startedAt === null) return;
    const ms = Date.now() - this.startedAt;
    this.tail = '';
    this.startedAt = null;
    this.print(`${style.dim(`✻ Thought for ${ms < 1000 ? 'less than a second' : duration(ms)}`)}\n`);
  }

  lines(width: number): string[] {
    if (this.startedAt === null) return [];
    const room = width - 3;
    const rows: string[] = [];
    const lines = this.tail.split('\n');
    for (let i = lines.length - 1; i >= 0 && rows.length < THINKING_ROWS; i--) {
      if (lines[i]!.trim()) rows.unshift(...wrapToWidth(lines[i]!.trimEnd(), room));
    }
    return [style.dim('✻ Thinking…'), ...rows.slice(-THINKING_ROWS).map((row) => style.dim(`  ${row}`))];
  }
}

function renderEvent(event: AgentEvent, runtime: Runtime, md: MarkdownStream, thinking: ThinkingView, print: (text: string) => void): void {
  if (event.type !== 'thinking_delta') thinking.finish();
  switch (event.type) {
    case 'text_delta':
      md.push(event.text);
      break;
    case 'thinking_delta':
      thinking.push(event.text);
      break;
    case 'server_tool':
      md.flush();
      print(`${style.cyan('●')} ${style.bold(sanitize(event.name))}${event.summary ? style.dim(`(${sanitize(event.summary)})`) : ''}\n`);
      break;
    case 'tool_start': {
      md.flush();
      const summary = toolSummary(event.name, event.input, runtime.context.cwd());
      print(`${style.cyan('●')} ${style.bold(event.name)}${summary ? style.dim(`(${summary})`) : ''}\n`);
      break;
    }
    case 'tool_end':
      print(`  ${style.dim('⎿')}  ${toolResultSummary(event.output, event.display, event.isError)}\n`);
      break;
    case 'notice':
      md.flush();
      print(`${event.level === 'warn' ? style.yellow('! ') : ''}${sanitize(event.text)}\n`);
      break;
    case 'compacted':
      md.flush();
      print(`${style.dim('Conversation compacted to free up context.')}\n`);
      break;
    case 'usage':
      break;
    case 'turn_end':
      md.flush();
      if (event.stopReason === 'interrupted') print(`${style.yellow('Interrupted.')}\n`);
      if (event.stopReason === 'error') print(`${style.red(`Error: ${sanitize(event.error ?? 'unknown')}`)}\n`);
      break;
  }
}

/** 950, 12.3k, 4.1M. */
function shortCount(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** 12s, 1m 05s, 74m 40s. */
function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function elapsed(since: number): string {
  return duration(Date.now() - since);
}

/** $0.0042 under a cent, otherwise $0.42 or $17.29. A + marks a lower bound. */
function usd(amount: number, partial: boolean): string {
  return `$${amount > 0 && amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}${partial ? '+' : ''}`;
}

/** What the session has spent so far, to tell what one turn added. */
interface Spent {
  tokens: number;
  costUsd: number;
  /** Responses from a model with no known price. */
  unpriced: number;
}

function spentBy(agent: Agent): Spent {
  const usage = agent.totalUsage;
  return { tokens: contextTokens(usage) + usage.outputTokens, costUsd: agent.totalCostUsd, unpriced: agent.unpricedResponses };
}

/**
 * The line after a turn, such as `Cost: turn $0.42 • session $3.17 | Tokens: turn 48k • session 1.2M | Time: 1m 20s`.
 * Subagents and compaction during the turn count toward it. Null when the turn spent nothing,
 * such as a prompt a hook blocked.
 */
function turnSummary(before: Spent, after: Spent, ms: number): string | null {
  const tokens = after.tokens - before.tokens;
  const cost = Math.max(0, after.costUsd - before.costUsd);
  if (tokens <= 0 && cost === 0) return null;
  const parts: string[] = [];
  // When nothing in the session has a known price, a cost would only be a misleading $0.00.
  if (after.costUsd > 0 || after.unpriced === 0) {
    parts.push(`Cost: turn ${usd(cost, after.unpriced > before.unpriced)} • session ${usd(after.costUsd, after.unpriced > 0)}`);
  }
  parts.push(`Tokens: turn ${shortCount(tokens)} • session ${shortCount(after.tokens)}`);
  parts.push(`Time: ${duration(ms)}`);
  return parts.join(' | ');
}

/** Past this share of the auto-compact point, each turn ends with a suggestion to compact. */
const COMPACT_HINT_FRACTION = 0.75;

/**
 * A suggestion to compact, once the context is close to where it would be compacted anyway, so
 * the user can do it at a moment that suits them and say what to keep. Null below that.
 */
function compactHint(runtime: Runtime): string | null {
  const used = runtime.agent.lastContextTokens;
  const threshold = runtime.agent.autoCompactThreshold;
  if (used === null || used < threshold * COMPACT_HINT_FRACTION) return null;
  const window = runtime.provider.contextWindow(runtime.agent.model);
  const full = `Context is ${Math.round((used / window) * 100)}% full (${shortCount(used)} of ${shortCount(window)} tokens).`;
  const auto = runtime.agent.autoCompacts ? ` Otherwise it is compacted on its own past ${shortCount(Math.round(threshold))}.` : ' Auto-compact is off.';
  return `${full} Consider /compact before you continue.${auto}`;
}

/** `Cairn · my-project`, for the terminal's window or tab. */
function windowTitle(projectDir: string): string {
  return `${APP_DISPLAY_NAME} · ${basename(projectDir) || projectDir}`;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** What the user typed, as it appears in the conversation above the prompt. */
function echo(text: string): string {
  const [first, ...rest] = markPlaceholders(sanitize(text), style.cyan).split('\n');
  return `${style.cyan('>')} ${first}${rest.map((line) => `\n  ${line}`).join('')}\n`;
}

export async function runRepl(runtime: Runtime, terminal: Terminal, initialPrompt?: string): Promise<void> {
  emitKeypressEvents(stdin);
  const { input, prompter } = terminal;
  const promptText = (): string => {
    const mode = runtime.engine.mode;
    return `${mode === 'default' ? '' : style.yellow(`[${mode}] `)}${style.cyan('>')} `;
  };

  if (stdout.isTTY) {
    // The shell's title goes on the terminal's title stack, where it has one, and comes back on exit.
    stdout.write(`\x1b[22;0t\x1b]0;${sanitize(windowTitle(runtime.projectDir))}\x07`);
    process.once('exit', () => stdout.write('\x1b[23;0t'));
  }
  /** The opening panel, worked out again each time it is drawn, since /clear changes the session. */
  const welcome = (): string => `${renderWelcome(welcomeRows(runtime), stdout.columns || 80).join('\n')}\n`;
  stdout.write(welcome());
  for (const warning of runtime.warnings) stdout.write(`${style.yellow('! ')}${sanitize(warning)}\n`);
  if (runtime.engine.mode === 'bypassPermissions') {
    stdout.write(`${style.red('! bypassPermissions: tools run without asking. Use this only in an isolated environment.')}\n`);
  }
  stdout.write('\n');

  /** The work running now: a turn, a compaction, or a command's slow part. */
  let busy: { controller: AbortController; startedAt: number; label: string } | null = null;
  /** A typed message waiting out SEND_DELAY_MS. */
  let pending: { text: string; deadline: number; timer: NodeJS.Timeout } | null = null;
  const queue: string[] = [];
  /** Work runs one piece at a time, in the order it was scheduled. */
  let chain: Promise<void> = Promise.resolve();
  let scheduled = 0;
  let exiting = false;
  let frame = 0;
  let quitHinted = false;
  const attached = new AttachedImages();
  const pasted = new PastedTexts();
  /** Images being read or shrunk, whose placeholders are not on the line yet. */
  let attaching = 0;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExit = resolve));

  const statusLine = (): string => {
    const parts: string[] = [];
    if (pending) {
      const seconds = Math.max(1, Math.ceil((pending.deadline - Date.now()) / 1000));
      parts.push(`Sending in ${seconds}s · Enter sends now · Esc to edit`);
    } else if (busy) {
      parts.push(`${FRAMES[frame % FRAMES.length]} ${busy.label} ${elapsed(busy.startedAt)} · Esc to stop`);
    }
    const agents = runtime.backgroundAgents.running();
    if (agents > 0) parts.push(plural(agents, 'agent'));
    const running = runtime.context.tasks.running();
    const shells = running.filter((task) => task.kind !== 'monitor').length;
    const monitors = running.length - shells;
    if (shells > 0) parts.push(plural(shells, 'shell'));
    if (monitors > 0) parts.push(plural(monitors, 'monitor'));
    if (queue.length > 0) parts.push(`${queue.length} queued`);
    if (attaching > 0) parts.push('Attaching an image…');
    const usage = runtime.agent.totalUsage;
    parts.push(`${shortCount(contextTokens(usage) + usage.outputTokens)} tokens`);
    return parts.join(' · ');
  };

  // One for the session: the footer draws whichever turn is thinking now.
  const thinking = new ThinkingView(
    () => footer.render(),
    (text) => print(text),
  );

  const footer = new Footer({
    prompt: promptText,
    status: statusLine,
    statusRight: () => `${runtime.agent.model} · effort ${runtime.agent.effort ?? 'default'}`,
    above: (width) => {
      const thought = thinking.lines(width);
      if (!pending) return thought;
      const lines = sanitize(pending.text).split('\n');
      const shown = lines.slice(0, 3).map((line, i) => style.dim(clipToWidth(`${i === 0 ? '⏳ ' : '   '}${line}`, width - 1)));
      return [...thought, ...shown, ...(lines.length > 3 ? [style.dim('   …')] : [])];
    },
    commands: () => commandEntries(runtime),
    onSubmit: (text) => submit(text),
    onEscape: () => escape(),
    onInterrupt: () => {
      if (pending || busy) return escape();
      if (!quitHinted) print(style.dim('Press Ctrl+D or type /exit to quit.\n'));
      quitHinted = true;
    },
    onEof: () => void exit(),
    onShiftTab: () => {
      // Riskier modes are never one keypress away: they have to be chosen by name, or allowed at startup.
      const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', ...(runtime.allowBypassMode ? (['bypassPermissions'] as const) : [])];
      const index = modes.indexOf(runtime.engine.mode);
      runtime.engine.mode = modes[(index + 1) % modes.length]!;
    },
    onPasteImage: (quiet) => void pasteImage(quiet),
    onPaste: (text) => {
      const paths = droppedImagePaths(text);
      if (paths) {
        void attachFiles(paths);
        return '';
      }
      // Placed exactly where the text was, with no spaces added, so sending gives back the same message.
      return PastedTexts.isLong(text) ? pasted.add(text) : undefined;
    },
  });
  footer.editor.atomic = PLACEHOLDER_AT_END;
  const print = (text: string): void => footer.print(text);
  terminal.print = print;

  /** Puts placeholders, or paths, on the line at the cursor, with a space on either side of them. */
  const insertAtCursor = (pieces: string[]): void => {
    if (pieces.length === 0) return;
    const editor = footer.editor;
    const before = [...editor.text][editor.cursor - 1];
    editor.insert(`${before === undefined || /\s/.test(before) ? '' : ' '}${pieces.join(' ')} `);
    footer.render();
  };

  /** Reads images one after another. Each gives its placeholder, or null when it could not be read. */
  const attachImages = async (sources: { path: string; label: string }[]): Promise<(string | null)[]> => {
    const placeholders: (string | null)[] = [];
    for (const { path, label } of sources) {
      const loaded = await loadImage(path, label, new AbortController().signal);
      if (!loaded.ok) {
        print(`${style.yellow(`! ${sanitize(loaded.message)}`)}\n`);
        placeholders.push(null);
        continue;
      }
      const placeholder = attached.add(loaded.image);
      if (loaded.shrunk) print(style.dim(`${placeholder} was over the size limit, so it was shrunk to a JPEG and fine detail may be lost.\n`));
      placeholders.push(placeholder);
    }
    return placeholders;
  };

  /** The paste key (Cmd+V on macOS, Ctrl+V elsewhere) or Ctrl+V: the picture on the clipboard. */
  const pasteImage = async (quiet: boolean): Promise<void> => {
    attaching++;
    footer.render();
    try {
      const clip = await readClipboardImage();
      if (!clip.ok) {
        if (!(quiet && clip.empty)) print(style.dim(`${sanitize(clip.message)}\n`));
        return;
      }
      try {
        const [placeholder] = await attachImages([{ path: clip.path, label: 'The clipboard image' }]);
        if (placeholder) insertAtCursor([placeholder]);
      } finally {
        await clip.cleanup();
      }
    } catch (error) {
      print(`${style.red(`Could not paste the image: ${sanitize((error as Error).message)}`)}\n`);
    } finally {
      attaching--;
      footer.render();
    }
  };

  /** Picture files dropped on the terminal, which pastes their paths. A file that fails goes back as its path. */
  const attachFiles = async (paths: string[]): Promise<void> => {
    attaching++;
    footer.render();
    try {
      const placeholders = await attachImages(paths.map((path) => ({ path, label: path })));
      const quoted = (path: string): string => (/[\s'"\\]/.test(path) ? `'${path.replace(/'/g, `'\\''`)}'` : path);
      insertAtCursor(placeholders.map((placeholder, i) => placeholder ?? quoted(paths[i]!)));
    } catch (error) {
      print(`${style.red(`Could not attach the images: ${sanitize((error as Error).message)}`)}\n`);
      footer.editor.insert(paths.join(' '));
    } finally {
      attaching--;
      footer.render();
    }
  };
  // A question asked while /usage has the screen waits until the user goes back, and what is
  // printed while one is open waits for its answer, so an approved prompt can be erased whole.
  prompter.around = (work) => footer.takeover(work);

  const io: CommandIO = {
    choose: async (title, options) => {
      const value = await footer.during(() => pickFromList(title, options.map((label, i) => ({ value: String(i), label }))));
      return value === null ? null : Number(value);
    },
    pick: (title, items, options) => footer.during(() => pickFromList(title, items, options)),
    ask: (question, options) => footer.during(() => (options?.secret ? readSecret(question) : input.read(question))),
    ...(stdin.isTTY && stdout.isTTY
      ? {
          tabs: (title: string, pages: TabPage[], initial: number) =>
            footer.takeover(() =>
              showTabs(title, pages, {
                initial,
                notice: () => (footer.waiting > 0 ? 'A question is waiting for your answer. Press Esc to go back to it.' : undefined),
              }),
            ),
        }
      : {}),
    queue: {
      add: (text) => {
        queue.push(text);
        // Started after the command's own reply is printed.
        setTimeout(afterIdle, 0);
        return queue.length;
      },
      list: () => [...queue],
      clear: () => queue.splice(0).length,
    },
  };

  const schedule = (work: () => Promise<void>): void => {
    scheduled++;
    chain = chain
      .then(async () => {
        scheduled--;
        if (!exiting) await work();
      })
      .catch((error: unknown) => print(`${style.red(sanitize((error as Error).message))}\n`));
  };

  const runBusy = async (label: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const controller = new AbortController();
    busy = { controller, startedAt: Date.now(), label };
    footer.render();
    try {
      await work(controller.signal);
    } catch (error) {
      print(`${style.red(sanitize((error as Error).message))}\n`);
    } finally {
      busy = null;
      footer.render();
      setTimeout(afterIdle, 0);
    }
  };

  const streamEvents = async (events: AsyncIterable<AgentEvent>): Promise<void> => {
    const md = new MarkdownStream(print);
    try {
      for await (const event of events) renderEvent(event, runtime, md, thinking, print);
    } finally {
      // A stream that broke off during thinking still folds it away.
      thinking.finish();
    }
  };
  /** Runs the agent, then sums up what the turn spent and how long it took. */
  const runAgent = (events: (signal: AbortSignal) => AsyncIterable<AgentEvent>): Promise<void> =>
    runBusy('Working', async (signal) => {
      const before = spentBy(runtime.agent);
      const startedAt = Date.now();
      try {
        await streamEvents(events(signal));
      } catch (error) {
        print(`${style.red(sanitize((error as Error).message))}\n`);
      }
      const summary = turnSummary(before, spentBy(runtime.agent), Date.now() - startedAt);
      if (!summary) return;
      print(`\n${style.dim(`▸ ${summary}`)}\n`);
      const hint = compactHint(runtime);
      if (hint) print(`${style.yellow(`! ${hint}`)}\n`);
    });
  const runTurn = (text: string, activation?: SkillActivation, images: ImageBlock[] = []): Promise<void> =>
    runAgent((signal) => runtime.agent.run(text, signal, activation, images.length > 0 ? { images } : {}));
  /**
   * A message the user typed, with its pastes back in full and the images its placeholders name.
   * Only the model gets the full text: the conversation on screen keeps the placeholders.
   */
  const runTyped = (text: string): Promise<void> => runTurn(pasted.expand(text), undefined, attached.in(text));

  /** Starts what is waiting once nothing runs: background work's news first, then the queue. */
  const afterIdle = (): void => {
    if (exiting || busy || scheduled > 0 || pending) return;
    if (runtime.wakes.pending()) {
      const { prompts, notes } = runtime.wakes.take();
      for (const prompt of prompts) schedule(() => runTurn(prompt));
      if (notes) schedule(() => runAgent((signal) => runtime.agent.resumeForNotes(signal)));
      return;
    }
    const next = queue.shift();
    if (next === undefined) return;
    footer.render();
    if (isCommandLine(next, runtime)) {
      print(echo(next));
      schedule(() => runCommand(next));
    } else {
      print(echo(next));
      schedule(() => runTyped(next));
    }
  };
  const stopWaking = runtime.wakes.onWake(() => setTimeout(afterIdle, 0));

  /** Sends a message: whatever is running stops, and the conversation goes on from this one. */
  const send = (text: string): void => {
    print(echo(text));
    busy?.controller.abort();
    schedule(() => runTyped(text));
  };

  const sendPending = (): void => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { text } = pending;
    pending = null;
    send(text);
  };

  /** A typed message waits, and more typed in the meantime joins it. */
  const addPending = (text: string): void => {
    if (pending) clearTimeout(pending.timer);
    const merged = pending ? `${pending.text}\n\n${text}` : text;
    pending = { text: merged, deadline: Date.now() + SEND_DELAY_MS, timer: setTimeout(sendPending, SEND_DELAY_MS) };
    footer.render();
  };

  /** Esc: a waiting message goes back to the line to edit; otherwise running work stops. */
  const escape = (): void => {
    if (pending) {
      clearTimeout(pending.timer);
      const typed = footer.editor.text;
      footer.editor.setText(typed ? `${pending.text}\n${typed}` : pending.text);
      pending = null;
      footer.render();
      return;
    }
    busy?.controller.abort();
  };

  const runCommand = async (text: string): Promise<void> => {
    let result: CommandResult;
    try {
      // A command gets the pastes in full, such as /btw or a skill's arguments. /queue keeps the
      // placeholders, so a queued message shows short when it runs and is expanded then.
      const full = parseSlash(text)?.name === 'queue' ? text : pasted.expand(text);
      result = await runSlashCommand(full, runtime, io);
      if (result.run) {
        const started = result;
        // Deferred work can run injected commands or wait on a browser, so it can be stopped.
        if (busy) result = await settleCommand(started, new AbortController().signal);
        else await runBusy('Working', async (signal) => void (result = await settleCommand(started, signal)));
      }
    } catch (error) {
      print(`${style.red(sanitize((error as Error).message))}\n`);
      return;
    }
    // The screen, then the scrollback (which some terminals fill with what the first wipe
    // removed), then the cursor to the top. The panel says which session this now is.
    if (result.clearScreen) print(`\x1b[2J\x1b[3J\x1b[H${welcome()}\n`);
    else if (result.output) print(`${sanitize(result.output)}\n`);
    if (result.exit) return exit();
    if (result.compact) {
      const focus = result.compact.focus;
      await runBusy('Compacting', async (signal) => {
        try {
          await runtime.agent.compact(focus ?? '', signal);
          print(`${style.dim('Conversation compacted.')}\n`);
        } catch (error) {
          print(`${style.red(`Compaction failed: ${sanitize((error as Error).message)}`)}\n`);
        }
      });
    }
    if (result.prompt) await runTurn(result.prompt, result.activation);
  };

  const command = (text: string): void => {
    const name = parseSlash(text)?.name ?? '';
    if (name === 'exit' || name === 'quit') {
      print(echo(text));
      void exit();
      return;
    }
    if (busy || scheduled > 0) {
      if (!WHILE_BUSY.has(name)) {
        print(style.dim(`/${name} waits for the current work. Press Esc to stop it, or queue it: /queue ${text}\n`));
        return;
      }
      print(echo(text));
      void runCommand(text);
      return;
    }
    print(echo(text));
    schedule(() => runCommand(text));
  };

  const submit = (raw: string): void => {
    quitHinted = false;
    const text = raw.trim();
    if (!text) {
      if (pending) sendPending();
      return;
    }
    const isCommand = isCommandLine(text, runtime);
    if (isCommand && !pending) return command(text);
    if (isCommand) {
      // A command is not part of the waiting message; that message goes first.
      sendPending();
      return command(text);
    }
    addPending(text);
  };

  const exit = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    if (pending) clearTimeout(pending.timer);
    pending = null;
    busy?.controller.abort();
    await chain.catch(() => {});
    resolveExit();
  };

  const ticker = setInterval(() => {
    if (!busy && !pending) return;
    frame++;
    footer.render();
  }, 200);

  footer.start();
  if (initialPrompt) send(initialPrompt);
  else setTimeout(afterIdle, 0);

  await exited;
  clearInterval(ticker);
  stopWaking();
  footer.stop();
  stdin.pause();
}
