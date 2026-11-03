/**
 * A small POSIX shell parser, used only for permission analysis. It never executes anything.
 *
 * The rule throughout is to fail closed: anything not fully understood marks the analysis
 * `parseable: false`, which means "never auto-approve". Commands found before the failure
 * are still reported, so deny and ask rules keep working on a best-effort basis.
 */

export interface Word {
  /** Source text, including any quotes. */
  raw: string;
  /** Text after quote removal. Meaningless where `dynamic` is true. */
  value: string;
  /** Contains an expansion or substitution, so the real value is unknown until runtime. */
  dynamic: boolean;
  /** Contains an unquoted glob or brace expansion. */
  glob: boolean;
  quoted: boolean;
}

export interface Redirect {
  op: string;
  target: Word;
}

export interface SimpleCommand {
  assignments: Word[];
  words: Word[];
  redirects: Redirect[];
  /** Came from a subshell, command substitution or process substitution. */
  nested: boolean;
}

export interface ShellAnalysis {
  parseable: boolean;
  reason?: string;
  commands: SimpleCommand[];
}

const MAX_ANALYZED_LENGTH = 10_000;
const CONTROL_PREFIX = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', '}', 'fi', 'done', 'esac']);
const CONTROL_DROP = new Set(['for', 'case', 'select', 'function', 'coproc', '[[']);
const REDIRECT_OPS = ['<<<', '<<-', '<<', '&>>', '&>', '>>', '>&', '>|', '<&', '<>', '>', '<'];

function newCommand(nested: boolean): SimpleCommand {
  return { assignments: [], words: [], redirects: [], nested };
}

class Parser {
  private readonly src: string;
  private i = 0;
  private pendingHeredocs: { delimiter: string; stripTabs: boolean; expands: boolean }[] = [];
  readonly commands: SimpleCommand[] = [];
  parseable = true;
  reason: string | undefined;

  constructor(src: string) {
    this.src = src;
  }

  run(): void {
    this.parseList(null, false);
    if (this.pendingHeredocs.length > 0) this.fail('here-document has no body');
  }

  private fail(reason: string): void {
    if (this.parseable) {
      this.parseable = false;
      this.reason = reason;
    }
  }

  private push(cmd: SimpleCommand): void {
    while (cmd.words[0] && !cmd.words[0].quoted && CONTROL_PREFIX.has(cmd.words[0].value)) {
      this.fail('control flow');
      cmd.words.shift();
    }
    const first = cmd.words[0];
    if (first && !first.quoted && CONTROL_DROP.has(first.value)) {
      this.fail('control flow');
      return;
    }
    if (cmd.words.length > 0 || cmd.assignments.length > 0 || cmd.redirects.length > 0) {
      this.commands.push(cmd);
    }
  }

  private parseList(stop: string | null, nested: boolean): void {
    let cur = newCommand(nested);
    let needsCommand = false;
    const finish = (): void => {
      if (cur.words.length > 0 || cur.assignments.length > 0 || cur.redirects.length > 0) needsCommand = false;
      this.push(cur);
      cur = newCommand(nested);
    };
    const src = this.src;

    while (this.i < src.length) {
      const c = src[this.i]!;
      const next = src[this.i + 1];

      if (c === ' ' || c === '\t') {
        this.i++;
      } else if (c === '\\' && next === '\n') {
        this.i += 2;
      } else if (c === '#') {
        while (this.i < src.length && src[this.i] !== '\n') this.i++;
      } else if (c === '\n') {
        this.i++;
        this.consumeHeredocs();
        finish();
      } else if (stop !== null && src.startsWith(stop, this.i)) {
        finish();
        this.i += stop.length;
        if (needsCommand) this.fail('dangling operator');
        return;
      } else if (c === ')') {
        this.fail('unbalanced )');
        this.i++;
      } else if (src.startsWith('&&', this.i) || src.startsWith('||', this.i) || src.startsWith('|&', this.i)) {
        finish();
        needsCommand = true;
        this.i += 2;
      } else if (c === '&' && next === '>') {
        this.readRedirect(cur);
      } else if (c === '|') {
        finish();
        needsCommand = true;
        this.i++;
      } else if (c === '&' || c === ';') {
        if (src.startsWith(';;', this.i)) this.fail('case statement');
        finish();
        this.i += src.startsWith(';;', this.i) ? 2 : 1;
      } else if (c === '(') {
        if (cur.words.length > 0 || cur.assignments.length > 0) this.fail('function definition or array');
        this.i++;
        this.parseList(')', true);
      } else if ((c === '<' || c === '>') && next === '(') {
        cur.words.push(this.readWord());
      } else if (this.atRedirect()) {
        this.readRedirect(cur);
      } else {
        const word = this.readWord();
        if (word.raw.length === 0) {
          // Defensive: an unexpected character must not stall the scanner.
          this.fail(`unexpected character ${c}`);
          this.i++;
        } else if (cur.words.length === 0 && !word.quoted && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.raw)) {
          cur.assignments.push(word);
        } else {
          cur.words.push(word);
        }
      }
    }

    if (stop !== null) this.fail(`unterminated ${stop}`);
    finish();
    if (needsCommand) this.fail('dangling operator');
  }

  private atRedirect(): boolean {
    let j = this.i;
    while (j < this.src.length && /[0-9]/.test(this.src[j]!)) j++;
    const c = this.src[j];
    return c === '<' || c === '>';
  }

  private readRedirect(cur: SimpleCommand): void {
    while (/[0-9]/.test(this.src[this.i] ?? '')) this.i++;
    const op = REDIRECT_OPS.find((candidate) => this.src.startsWith(candidate, this.i));
    if (!op) {
      this.fail('bad redirect');
      this.i++;
      return;
    }
    this.i += op.length;
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i++;
    const target = this.readWord();
    if (target.raw.length === 0) {
      this.fail('redirect without target');
      return;
    }
    if (op === '<<' || op === '<<-') {
      this.pendingHeredocs.push({ delimiter: target.value, stripTabs: op === '<<-', expands: !target.quoted });
      return;
    }
    if (op === '<<<') return;
    // `2>&1` and `<&3` duplicate a descriptor and touch no file.
    if ((op === '>&' || op === '<&') && /^[0-9-]+$/.test(target.value)) return;
    cur.redirects.push({ op, target });
  }

  private consumeHeredocs(): void {
    for (const heredoc of this.pendingHeredocs) {
      let closed = false;
      while (this.i < this.src.length) {
        let end = this.src.indexOf('\n', this.i);
        if (end === -1) end = this.src.length;
        const line = this.src.slice(this.i, end);
        this.i = Math.min(end + 1, this.src.length);
        if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
          closed = true;
          break;
        }
        // An unquoted delimiter means the body expands, so it can hide commands.
        if (heredoc.expands && (line.includes('$(') || line.includes('`'))) {
          this.fail('command substitution inside here-document');
        }
      }
      if (!closed) this.fail('unterminated here-document');
    }
    this.pendingHeredocs = [];
  }

  private readWord(): Word {
    const src = this.src;
    const start = this.i;
    let value = '';
    let dynamic = false;
    let glob = false;
    let quoted = false;

    while (this.i < src.length) {
      const c = src[this.i]!;
      if ((c === '<' || c === '>') && src[this.i + 1] === '(') {
        this.i += 2;
        this.parseList(')', true);
        dynamic = true;
      } else if (' \t\n;&|()<>'.includes(c)) {
        break;
      } else if (c === '\\') {
        if (this.i + 1 >= src.length) {
          this.fail('trailing backslash');
          this.i++;
        } else if (src[this.i + 1] === '\n') {
          this.i += 2;
        } else {
          value += src[this.i + 1];
          this.i += 2;
          quoted = true;
        }
      } else if (c === "'") {
        const end = src.indexOf("'", this.i + 1);
        if (end === -1) {
          this.fail('unterminated single quote');
          value += src.slice(this.i + 1);
          this.i = src.length;
        } else {
          value += src.slice(this.i + 1, end);
          this.i = end + 1;
        }
        quoted = true;
      } else if (c === '"') {
        this.i++;
        quoted = true;
        const inner = this.readDoubleQuoted();
        value += inner.value;
        dynamic ||= inner.dynamic;
      } else if (c === '`') {
        this.readBacktick();
        dynamic = true;
      } else if (c === '$') {
        const before = this.i;
        const isDynamic = this.readDollar();
        if (isDynamic) dynamic = true;
        else value += src.slice(before, this.i);
      } else {
        if (c === '*' || c === '?' || c === '[') glob = true;
        if (c === '{' && /^\{[^}\s]*(,|\.\.)[^}\s]*\}/.test(src.slice(this.i))) glob = true;
        value += c;
        this.i++;
      }
    }
    return { raw: src.slice(start, this.i), value, dynamic, glob, quoted };
  }

  private readDoubleQuoted(): { value: string; dynamic: boolean } {
    const src = this.src;
    let value = '';
    let dynamic = false;
    while (this.i < src.length) {
      const c = src[this.i]!;
      if (c === '"') {
        this.i++;
        return { value, dynamic };
      }
      if (c === '\\') {
        const next = src[this.i + 1];
        if (next === '\n') {
          this.i += 2;
        } else if (next !== undefined && '"\\$`'.includes(next)) {
          value += next;
          this.i += 2;
        } else {
          value += c;
          this.i++;
        }
      } else if (c === '`') {
        this.readBacktick();
        dynamic = true;
      } else if (c === '$') {
        const before = this.i;
        if (this.readDollar()) dynamic = true;
        else value += src.slice(before, this.i);
      } else {
        value += c;
        this.i++;
      }
    }
    this.fail('unterminated double quote');
    return { value, dynamic };
  }

  private readBacktick(): void {
    const src = this.src;
    let j = this.i + 1;
    let body = '';
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\' && j + 1 < src.length) {
        body += src[j + 1];
        j += 2;
      } else {
        body += src[j];
        j++;
      }
    }
    if (j >= src.length) {
      this.fail('unterminated backtick');
      this.i = src.length;
      return;
    }
    this.i = j + 1;
    const inner = new Parser(body);
    inner.run();
    if (!inner.parseable) this.fail(inner.reason ?? 'unparseable substitution');
    for (const cmd of inner.commands) this.commands.push({ ...cmd, nested: true });
  }

  /** Consumes a `$` construct. Returns false when the `$` turned out to be a literal. */
  private readDollar(): boolean {
    const src = this.src;
    const next = src[this.i + 1];
    if (next === '(') {
      if (src[this.i + 2] === '(') {
        const end = src.indexOf('))', this.i + 3);
        if (end === -1) {
          this.fail('unterminated arithmetic');
          this.i = src.length;
          return true;
        }
        const body = src.slice(this.i + 3, end);
        if (body.includes('$(') || body.includes('`')) this.fail('substitution inside arithmetic');
        this.i = end + 2;
        return true;
      }
      this.i += 2;
      this.parseList(')', true);
      return true;
    }
    if (next === '{') {
      let depth = 1;
      let j = this.i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      if (depth > 0) {
        this.fail('unterminated ${');
        this.i = src.length;
        return true;
      }
      const body = src.slice(this.i + 2, j - 1);
      if (body.includes('$(') || body.includes('`')) this.fail('substitution inside ${}');
      this.i = j;
      return true;
    }
    if (next === "'" || next === '"') {
      this.fail('ANSI-C or locale quoting');
      this.i++;
      return true;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      this.i += 2;
      while (this.i < src.length && /[A-Za-z0-9_]/.test(src[this.i]!)) this.i++;
      return true;
    }
    if (next !== undefined && /[0-9@*#?!$-]/.test(next)) {
      this.i += 2;
      return true;
    }
    this.i++;
    return false;
  }
}

export function analyzeShell(command: string): ShellAnalysis {
  const parser = new Parser(command);
  parser.run();
  if (command.length > MAX_ANALYZED_LENGTH) {
    return { parseable: false, reason: 'command is too long to analyze', commands: parser.commands };
  }
  const analysis: ShellAnalysis = { parseable: parser.parseable, commands: parser.commands };
  if (parser.reason !== undefined) analysis.reason = parser.reason;
  return analysis;
}

/** Removes wrappers that simply run their argument as the real command. */
export function stripWrappers(words: Word[]): Word[] {
  let w = words;
  for (;;) {
    const first = w[0];
    if (!first || first.dynamic) return w;
    const name = first.value;
    if (name === 'nohup' || name === 'noglob') {
      w = w.slice(1);
    } else if (name === 'time') {
      w = skipFlags(w.slice(1), new Set());
    } else if (name === 'nice') {
      w = skipFlags(w.slice(1), new Set(['-n', '--adjustment']));
    } else if (name === 'stdbuf') {
      w = skipFlags(w.slice(1), new Set(['-i', '-o', '-e']));
    } else if (name === 'timeout') {
      const rest = skipFlags(w.slice(1), new Set(['-k', '--kill-after', '-s', '--signal']));
      if (!rest[0] || rest[0].dynamic || !/^[0-9.]+[smhd]?$/.test(rest[0].value)) return w;
      w = rest.slice(1);
    } else if (name === 'command' || name === 'builtin' || name === 'xargs') {
      // `command -v` is a lookup and `xargs -n1` changes semantics: both stay as they are.
      if (!w[1] || w[1].value.startsWith('-')) return w;
      w = w.slice(1);
    } else {
      return w;
    }
  }
}

function skipFlags(words: Word[], flagsWithValue: Set<string>): Word[] {
  let i = 0;
  while (words[i]?.value.startsWith('-')) {
    if (flagsWithValue.has(words[i]!.value)) i++;
    i++;
  }
  return words.slice(i);
}

/** Text used for matching allow rules: exactly what was written, minus wrappers and redirects. */
export function rawText(words: Word[]): string {
  return words.map((w) => w.raw).join(' ');
}

/** Text after quote removal, so `git 'push'` still hits a deny rule for `git push`. */
export function valueText(words: Word[]): string {
  return words.map((w) => w.value).join(' ');
}
