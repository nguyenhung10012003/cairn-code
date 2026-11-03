/** The interactive terminal session. */
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline';
import type { Key } from 'node:readline';
import { APP_DISPLAY_NAME, VERSION } from '../config/paths.ts';
import { commandEntries, runSlashCommand, settleCommand } from '../commands/slash.ts';
import type { CommandEntry, CommandIO, CommandResult } from '../commands/slash.ts';
import { CommandMenu } from './command-menu.ts';
import { chooseWithNote, pickFromList, readSecret } from './picker.ts';
import type { ChoiceOption } from './picker.ts';
import type { SkillActivation } from '../skills/skills.ts';
import type { AgentEvent } from '../core/agent.ts';
import type { Runtime } from '../core/runtime.ts';
import type { PermissionMode } from '../permissions/engine.ts';
import type { PermissionAnswer, PermissionPrompt, Prompter, UserQuestion } from '../tools/types.ts';
import { displayWidth, MarkdownStream, permissionPreview, sanitize, Spinner, style, toolResultSummary, toolSummary } from './render.ts';

const stdin = process.stdin;
const stdout = process.stdout;

type KeyListener = (text: string | undefined, key: Key | undefined) => void;

/** Everything that reads a line from the keyboard goes through one short-lived readline. */
class LineInput {
  private history: string[] = [];
  private commands: () => CommandEntry[] = () => [];
  onShiftTab: (() => void) | undefined;

  setCommands(provider: () => CommandEntry[]): void {
    this.commands = provider;
  }

  /** `commands` shows the command menu while the line starts with a slash. */
  read(prompt: string, options: { history?: boolean; commands?: boolean; signal?: AbortSignal } = {}): Promise<string | null> {
    return new Promise((resolve) => {
      const before = stdin.listeners('keypress');
      const rl = createInterface({
        input: stdin,
        output: stdout,
        terminal: true,
        historySize: options.history ? 500 : 0,
        history: options.history ? this.history : [],
        removeHistoryDuplicates: true,
        completer: (line: string): [string[], string] => {
          if (!line.startsWith('/')) return [[], line];
          return [this.commands().map((entry) => `/${entry.name}`).filter((name) => name.startsWith(line)), line];
        },
      });
      // Readline reads keys through a keypress listener of its own. Calling it from here lets
      // the command menu see each key first and keep the ones it uses away from readline.
      const readlineKeys = stdin.listeners('keypress').filter((listener) => !before.includes(listener)) as KeyListener[];
      for (const listener of readlineKeys) stdin.off('keypress', listener);
      const menu = options.commands && stdout.isTTY
        ? new CommandMenu({ rl, entries: this.commands, write: (text) => stdout.write(text), columns: () => stdout.columns || 80 })
        : null;
      if (options.history) rl.on('history', (updated: string[]) => (this.history = updated));
      let settled = false;
      // A wake (background work finishing, a scheduled prompt) closes the prompt so it can be handled.
      const onWakeAbort = (): void => finish(null);
      options.signal?.addEventListener('abort', onWakeAbort, { once: true });
      const onKey: KeyListener = (text, key) => {
        if (key?.name === 'tab' && key.shift) {
          // Not passed on: readline takes it for Tab and would complete the line.
          if (!this.onShiftTab) return;
          this.onShiftTab();
          rl.setPrompt(promptProvider());
          rl.prompt(true);
          menu?.update(key);
          return;
        }
        if (menu?.handle(key)) return;
        for (const listener of readlineKeys) listener.call(stdin, text, key);
        if (!settled) menu?.update(key);
      };
      const promptProvider = (): string => (options.history ? this.currentPrompt() : prompt);
      stdin.on('keypress', onKey);
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        menu?.close();
        stdin.off('keypress', onKey);
        options.signal?.removeEventListener('abort', onWakeAbort);
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

  currentPrompt: () => string = () => '> ';
}

class TerminalPrompter implements Prompter {
  private readonly input: LineInput;
  /** Set by the turn runner: stops the spinner and key watcher while a question is open. */
  beforePrompt: () => void = () => {};
  afterPrompt: () => void = () => {};

  constructor(input: LineInput) {
    this.input = input;
  }

  private async ask(text: string): Promise<string | null> {
    this.beforePrompt();
    try {
      return await this.input.read(text);
    } finally {
      this.afterPrompt();
    }
  }

  async permission(prompt: PermissionPrompt): Promise<PermissionAnswer> {
    this.beforePrompt();
    stdout.write(`\n${style.yellow(style.bold(`${prompt.toolName} needs your approval`))}\n`);
    for (const line of permissionPreview(prompt.toolName, prompt.input)) stdout.write(`${line}\n`);
    stdout.write(`${style.dim(sanitize(prompt.reason))}\n`);
    const canAlways = !prompt.forced && prompt.suggestions.length > 0;
    const rules = prompt.suggestions.map((suggestion) => suggestion.rule).join(', ');
    const where = prompt.suggestions.some((suggestion) => suggestion.persist) ? 'saved for this project' : 'for this session';
    const alwaysLabel = `Yes, and don't ask again for ${rules} (${where})`;
    // A rule too long for the option line is shown in full above it.
    if (canAlways && displayWidth(alwaysLabel) > (stdout.columns || 80) - 6) {
      for (const suggestion of prompt.suggestions) {
        stdout.write(style.dim(`  don't ask again would add: ${sanitize(suggestion.rule)} (${suggestion.persist ? 'saved for this project' : 'this session'})\n`));
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
    try {
      const choice = await chooseWithNote(options.map((entry) => entry.option), { cancelIndex: options.length - 1 });
      const answer = options[choice.index]!.answer;
      return choice.note ? { ...answer, feedback: choice.note } : answer;
    } finally {
      this.afterPrompt();
    }
  }

  /** Without a terminal to draw options in, the answer is typed. */
  private async typedPermission(canAlways: boolean): Promise<PermissionAnswer> {
    const options = canAlways ? '[y] yes  [a] always  [n] no, or type what to do instead' : '[y] yes  [n] no, or type what to do instead';
    const answer = (await this.ask(`${options}: `))?.trim() ?? '';
    const lowered = answer.toLowerCase();
    if (lowered === 'y' || lowered === 'yes') return { behavior: 'allow' };
    if (canAlways && (lowered === 'a' || lowered === 'always')) return { behavior: 'allow', always: true };
    if (lowered === '' || lowered === 'n' || lowered === 'no') return { behavior: 'deny' };
    return { behavior: 'deny', feedback: answer };
  }

  async questions(questions: UserQuestion[]): Promise<string[] | null> {
    this.beforePrompt();
    const answers: string[] = [];
    for (const question of questions) {
      stdout.write(`\n${style.bold(sanitize(question.question))}\n`);
      question.options.forEach((option, i) => {
        const description = option.description ? style.dim(` - ${sanitize(option.description)}`) : '';
        stdout.write(`  ${i + 1}. ${sanitize(option.label)}${description}\n`);
      });
      const hint = question.multiSelect ? 'Numbers separated by commas, or your own answer: ' : 'Number, or your own answer: ';
      const raw = (await this.ask(hint))?.trim() ?? '';
      const picks = raw.split(',').map((part) => Number.parseInt(part.trim(), 10));
      const valid = raw !== '' && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= question.options.length);
      answers.push(valid ? picks.map((n) => question.options[n - 1]!.label).join(', ') : raw);
    }
    return answers;
  }

  async approvePlan(plan: string): Promise<boolean> {
    this.beforePrompt();
    stdout.write(`\n${style.bold('Proposed plan')}\n${sanitize(plan)}\n\n`);
    const answer = (await this.ask('Approve and start? [y/N]: '))?.trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }
}

export function createTerminalPrompter(): { prompter: TerminalPrompter; input: LineInput } {
  const input = new LineInput();
  return { prompter: new TerminalPrompter(input), input };
}

function renderEvent(event: AgentEvent, runtime: Runtime, md: MarkdownStream, thinking: MarkdownStream, spinner: Spinner): void {
  if (event.type !== 'thinking_delta') thinking.flush();
  switch (event.type) {
    case 'text_delta':
      spinner.stop();
      md.push(event.text);
      break;
    case 'thinking_delta':
      spinner.stop();
      thinking.push(event.text);
      break;
    case 'server_tool':
      md.flush();
      spinner.stop();
      stdout.write(`${style.cyan('●')} ${style.bold(sanitize(event.name))}${event.summary ? style.dim(`(${sanitize(event.summary)})`) : ''}\n`);
      spinner.start();
      break;
    case 'tool_start': {
      md.flush();
      spinner.stop();
      const summary = toolSummary(event.name, event.input, runtime.context.cwd());
      stdout.write(`${style.cyan('●')} ${style.bold(event.name)}${summary ? style.dim(`(${summary})`) : ''}\n`);
      spinner.start();
      break;
    }
    case 'tool_end':
      spinner.stop();
      stdout.write(`  ${style.dim('⎿')}  ${toolResultSummary(event.output, event.display, event.isError)}\n`);
      spinner.start();
      break;
    case 'notice':
      md.flush();
      spinner.stop();
      stdout.write(`${event.level === 'warn' ? style.yellow('! ') : ''}${sanitize(event.text)}\n`);
      break;
    case 'compacted':
      md.flush();
      spinner.stop();
      stdout.write(`${style.dim('Conversation compacted to free up context.')}\n`);
      break;
    case 'usage':
      break;
    case 'turn_end':
      md.flush();
      spinner.stop();
      if (event.stopReason === 'interrupted') stdout.write(`${style.yellow('Interrupted.')}\n`);
      if (event.stopReason === 'error') stdout.write(`${style.red(`Error: ${sanitize(event.error ?? 'unknown')}`)}\n`);
      break;
  }
}

/** Watches for Esc and Ctrl+C while the agent runs. Other keys are ignored. */
function watchInterrupt(onInterrupt: () => void): { pause: () => void; resume: () => void; stop: () => void } {
  const onKey = (_text: string | undefined, key: Key | undefined): void => {
    if (key?.name === 'escape' || (key?.ctrl && key.name === 'c')) onInterrupt();
  };
  const resume = (): void => {
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('keypress', onKey);
  };
  const pause = (): void => {
    stdin.off('keypress', onKey);
  };
  resume();
  return {
    pause,
    resume,
    stop: () => {
      pause();
      stdin.setRawMode?.(false);
      stdin.pause();
    },
  };
}

export async function runRepl(
  runtime: Runtime,
  terminal: { prompter: TerminalPrompter; input: LineInput },
  initialPrompt?: string,
): Promise<void> {
  emitKeypressEvents(stdin);
  const { input, prompter } = terminal;
  input.setCommands(() => commandEntries(runtime));
  const promptText = (): string => {
    const mode = runtime.engine.mode;
    return `${mode === 'default' ? '' : style.yellow(`[${mode}] `)}${style.cyan('>')} `;
  };
  input.currentPrompt = promptText;
  input.onShiftTab = () => {
    // Riskier modes are never one keypress away: they have to be chosen by name, or allowed at startup.
    const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', ...(runtime.allowBypassMode ? (['bypassPermissions'] as const) : [])];
    const index = modes.indexOf(runtime.engine.mode);
    runtime.engine.mode = modes[(index + 1) % modes.length]!;
  };

  stdout.write(`${style.bold(APP_DISPLAY_NAME)} ${style.dim(`v${VERSION}  ${runtime.providerName} / ${runtime.agent.model}`)}\n`);
  stdout.write(`${style.dim(`${runtime.projectDir}  -  /help for commands`)}\n`);
  for (const warning of runtime.warnings) stdout.write(`${style.yellow('! ')}${sanitize(warning)}\n`);
  if (runtime.engine.mode === 'bypassPermissions') {
    stdout.write(`${style.red('! bypassPermissions: tools run without asking. Use this only in an isolated environment.')}\n`);
  }
  if (runtime.agent.messages.length > 0) {
    stdout.write(`${style.dim(`Resumed session with ${runtime.agent.messages.length} messages.`)}\n`);
  }
  stdout.write('\n');

  const withInterrupt = async (work: (signal: AbortSignal, spinner: Spinner) => Promise<void>): Promise<void> => {
    const controller = new AbortController();
    const spinner = new Spinner();
    const watcher = watchInterrupt(() => controller.abort());
    prompter.beforePrompt = () => {
      spinner.stop();
      watcher.pause();
    };
    prompter.afterPrompt = () => {
      watcher.resume();
      spinner.start();
    };
    spinner.start();
    try {
      await work(controller.signal, spinner);
    } finally {
      spinner.stop();
      watcher.stop();
      prompter.beforePrompt = () => {};
      prompter.afterPrompt = () => {};
    }
  };

  const runTurn = (text: string, activation?: SkillActivation): Promise<void> =>
    withInterrupt(async (signal, spinner) => {
      const md = new MarkdownStream((chunk) => stdout.write(chunk));
      const thinking = new MarkdownStream((chunk) => stdout.write(style.dim(chunk)));
      for await (const event of runtime.agent.run(text, signal, activation)) renderEvent(event, runtime, md, thinking, spinner);
    });

  const io: CommandIO = {
    choose: async (title, options) => {
      const value = await pickFromList(title, options.map((label, i) => ({ value: String(i), label })));
      return value === null ? null : Number(value);
    },
    pick: (title, items, options) => pickFromList(title, items, options),
    ask: (question, options) => (options?.secret ? readSecret(question) : input.read(question)),
  };

  // Background work finishing, and scheduled prompts coming due, drive turns without the user typing.
  const runNotes = (): Promise<void> =>
    withInterrupt(async (signal, spinner) => {
      const md = new MarkdownStream((chunk) => stdout.write(chunk));
      const thinking = new MarkdownStream((chunk) => stdout.write(style.dim(chunk)));
      for await (const event of runtime.agent.resumeForNotes(signal)) renderEvent(event, runtime, md, thinking, spinner);
    });
  const drainWakes = async (): Promise<void> => {
    while (runtime.wakes.pending()) {
      const { prompts, notes } = runtime.wakes.take();
      for (const prompt of prompts) await runTurn(prompt);
      if (notes) await runNotes();
    }
  };

  if (initialPrompt) await runTurn(initialPrompt);

  for (;;) {
    await drainWakes();
    const wake = new AbortController();
    const stopWaking = runtime.wakes.onWake(() => wake.abort());
    let line = await input.read(promptText(), { history: true, commands: true, signal: wake.signal });
    stopWaking();
    // A null line means end-of-input, unless a wake closed the prompt so we can handle it.
    if (line === null && runtime.wakes.pending()) continue;
    if (line === null) break;
    while (line.endsWith('\\')) {
      const more = await input.read(style.dim('… '));
      if (more === null) break;
      line = `${line.slice(0, -1)}\n${more}`;
    }
    const text = line.trim();
    if (!text) continue;

    if (text.startsWith('/')) {
      let result: CommandResult = {};
      try {
        result = await runSlashCommand(text, runtime, io);
        if (result.run) {
          // Deferred work can run injected commands or wait on a browser, so it can be interrupted.
          const started = result;
          await withInterrupt(async (signal) => {
            result = await settleCommand(started, signal);
          });
        }
      } catch (error) {
        stdout.write(`${style.red(sanitize((error as Error).message))}\n`);
        continue;
      }
      if (result.output) stdout.write(`${sanitize(result.output)}\n`);
      if (result.exit) break;
      if (result.compact) {
        const focus = result.compact.focus;
        await withInterrupt(async (signal) => {
          try {
            await runtime.agent.compact(focus ?? '', signal);
            stdout.write(`${style.dim('Conversation compacted.')}\n`);
          } catch (error) {
            stdout.write(`${style.red(`Compaction failed: ${sanitize((error as Error).message)}`)}\n`);
          }
        });
      }
      if (result.prompt) await runTurn(result.prompt, result.activation);
      continue;
    }
    await runTurn(text);
  }
  stdin.pause();
}
