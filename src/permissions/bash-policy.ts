/**
 * Classifies parsed shell commands: read-only, safe to accept automatically, or a critical
 * removal. Anything uncertain falls through to "ask". Rules here are a guard rail against
 * mistakes, not a sandbox: a determined command can always be phrased to avoid them.
 */
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { analyzeShell, stripWrappers, rawText, valueText } from './shell.ts';
import type { SimpleCommand, Word } from './shell.ts';
import { canonicalize, isInside, isProtectedPath } from './rules.ts';

export interface BashContext {
  cwd: string;
  workingDirs: string[];
}

const READ_ONLY = new Set([
  'ls', 'cat', 'pwd', 'echo', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'which', 'type', 'diff',
  'stat', 'du', 'df', 'cd', 'file', 'sort', 'uniq', 'cut', 'tr', 'date', 'whoami', 'uname', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'printf', 'nl', 'tac', 'rev', 'seq',
  'hostname', 'id', 'ps', 'find', 'git', 'cmp', 'comm', 'md5', 'md5sum', 'shasum', 'sha256sum', 'tree',
]);

/** These take no file paths, so their arguments need no location check. */
const PATH_AGNOSTIC = new Set([
  'echo', 'printf', 'pwd', 'true', 'false', 'date', 'whoami', 'uname', 'basename', 'dirname', 'seq', 'which',
  'type', 'hostname', 'id', 'ps', 'tr', 'df',
]);

/** Unquoted globs could expand to one of the write-capable or exec-capable flags of these. */
const GLOB_SENSITIVE = new Set(['find', 'sort', 'git', 'rg', 'file', 'tree']);

const FIND_BANNED = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from',
]);

const GIT_READ_ONLY = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'describe', 'shortlog', 'rev-list',
  'cat-file', 'merge-base', 'branch', 'tag', 'remote', 'config',
]);

const SAFE_ENV_ASSIGNMENTS = new Set([
  'NODE_ENV', 'RUST_LOG', 'RUST_BACKTRACE', 'LANG', 'LC_ALL', 'TZ', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'DEBUG',
]);

const ACCEPT_EDITS_COMMANDS = new Set(['mkdir', 'touch', 'mv', 'cp']);
const INLINE_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

function hasFlag(args: Word[], prefixes: string[]): boolean {
  return args.some((a) => prefixes.some((p) => a.value === p || a.value.startsWith(`${p}=`)));
}

function gitIsReadOnly(args: Word[]): boolean {
  const sub = args[0];
  // `git -C dir` and `git -c key=value` can redirect git into running arbitrary programs.
  if (!sub || !GIT_READ_ONLY.has(sub.value)) return false;
  const rest = args.slice(1);
  if (hasFlag(rest, ['--output', '--ext-diff', '--textconv', '--exec', '--filters', '-O'])) return false;
  const values = rest.map((a) => a.value);
  switch (sub.value) {
    case 'branch':
      return values.every((v) => ['--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--list'].includes(v));
    case 'tag':
      return values.length > 0 && values.every((v) => v === '-l' || v === '--list');
    case 'remote':
      return values.every((v) => v === '-v' || v === '--verbose');
    case 'config':
      return ['--get', '--get-all', '--list', '-l', '--get-regexp'].includes(values[0] ?? '');
    default:
      return true;
  }
}

function flagsAreReadOnly(name: string, args: Word[]): boolean {
  const values = args.map((a) => a.value);
  switch (name) {
    case 'find':
      return !values.some((v) => FIND_BANNED.has(v));
    case 'sort':
      return !hasFlag(args, ['--output', '--compress-program']) && !values.some((v) => /^-[a-zA-Z]*o/.test(v));
    case 'uniq':
      // A second positional argument is an output file.
      return values.filter((v) => !v.startsWith('-')).length <= 1;
    case 'file':
      return !hasFlag(args, ['-m', '--magic-file', '-f', '--files-from', '-C', '--compile']);
    case 'ps':
      // `e` as a BSD-style option prints every process's environment, which often holds secrets.
      return !values.some((v) => !v.startsWith('-') && v.includes('e')) &&
        !(values.includes('-e') && values.some((v) => !v.startsWith('-')));
    case 'rg':
      return !hasFlag(args, ['--pre', '--hostname-bin']);
    case 'date':
      return !hasFlag(args, ['-s', '--set']);
    case 'hostname':
      return args.length === 0;
    case 'tree':
      return !hasFlag(args, ['-o']);
    case 'printf':
      return !hasFlag(args, ['-v']);
    case 'git':
      return gitIsReadOnly(args);
    default:
      return true;
  }
}

/** The filesystem path a shell word refers to, if any. Flags with attached values are unpacked. */
function pathOfWord(word: Word, cwd: string): string | null {
  let value = word.value;
  const assignedFlag = /^--?[A-Za-z0-9-]+=(.*)$/.exec(value);
  const attachedShort = /^-[A-Za-z]([/~.].*)$/.exec(value);
  if (assignedFlag) value = assignedFlag[1]!;
  else if (attachedShort) value = attachedShort[1]!;
  else if (value.startsWith('-')) return null;
  if (word.glob) value = value.slice(0, value.search(/[*?[{]/));
  if (value === '~' || value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return resolve(cwd, value);
}

function insideWorkingDirs(path: string, ctx: BashContext): boolean {
  const real = canonicalize(path);
  return ctx.workingDirs.some((dir) => isInside(real, dir));
}

/** Files a read-capable command touches. Used to enforce Read deny rules on `cat .env`. */
export function readPaths(cmd: SimpleCommand, cwd: string): string[] {
  const words = stripWrappers(cmd.words);
  const name = words[0]?.value;
  if (!name || !READ_ONLY.has(name) || PATH_AGNOSTIC.has(name)) return [];
  return words.slice(1).flatMap((w) => {
    const path = pathOfWord(w, cwd);
    return path === null ? [] : [path];
  });
}

/** Output redirect targets, plus the files `tee` writes. */
export function writeTargets(cmd: SimpleCommand): Word[] {
  const targets = cmd.redirects
    .filter((r) => r.op !== '<' && r.op !== '<>')
    .map((r) => r.target)
    .filter((t) => t.value !== '/dev/null');
  const words = stripWrappers(cmd.words);
  if (words[0]?.value === 'tee') targets.push(...words.slice(1).filter((w) => !w.value.startsWith('-')));
  return targets;
}

export function writePath(target: Word, cwd: string): string | null {
  if (target.dynamic || target.glob || target.value.startsWith('~')) return null;
  return resolve(cwd, target.value);
}

/** True when every write target is a known path, inside the working dirs, and not protected. */
export function writeTargetsAreSafe(cmd: SimpleCommand, ctx: BashContext): boolean {
  return writeTargets(cmd).every((target) => {
    const path = writePath(target, ctx.cwd);
    return path !== null && insideWorkingDirs(path, ctx) && !isProtectedPath(canonicalize(path));
  });
}

export function isReadOnlyCommand(cmd: SimpleCommand, ctx: BashContext): boolean {
  if (cmd.assignments.length > 0) return false;
  const words = stripWrappers(cmd.words);
  const first = words[0];
  if (!first || first.dynamic || first.glob || words.some((w) => w.dynamic)) return false;
  for (const redirect of cmd.redirects) {
    const isInput = redirect.op === '<';
    if (!isInput && redirect.target.value !== '/dev/null') return false;
    if (redirect.target.dynamic || redirect.target.glob) return false;
    if (isInput && !insideWorkingDirs(resolve(ctx.cwd, redirect.target.value), ctx)) return false;
  }
  const name = first.value;
  if (!READ_ONLY.has(name)) return false;
  const args = words.slice(1);
  if (GLOB_SENSITIVE.has(name) && args.some((a) => a.glob)) return false;
  if (!flagsAreReadOnly(name, args)) return false;
  if (PATH_AGNOSTIC.has(name)) return true;
  return args.every((word) => {
    const path = pathOfWord(word, ctx.cwd);
    return path === null || insideWorkingDirs(path, ctx);
  });
}

/** `mkdir`, `touch`, `mv`, `cp` that stay inside the working directories. */
export function isAcceptEditsCommand(cmd: SimpleCommand, ctx: BashContext): boolean {
  if (cmd.assignments.length > 0 || cmd.redirects.length > 0) return false;
  const words = stripWrappers(cmd.words);
  const first = words[0];
  if (!first || !ACCEPT_EDITS_COMMANDS.has(first.value) || words.some((w) => w.dynamic)) return false;
  return words.slice(1).every((word) => {
    const path = pathOfWord(word, ctx.cwd);
    return path === null || (insideWorkingDirs(path, ctx) && !isProtectedPath(canonicalize(path)));
  });
}

/**
 * Removing `/`, a top-level directory, home, the working directory or one of its parents.
 * A target unknown until runtime counts too, because it cannot be ruled out.
 */
export function isCriticalRemoval(cmd: SimpleCommand, ctx: BashContext): boolean {
  let words = stripWrappers(cmd.words);
  if (words[0]?.value === 'sudo') words = stripWrappers(words.slice(1));
  const first = words[0];
  if (!first) return false;
  const name = basename(first.value);
  if (name !== 'rm' && name !== 'rmdir') return false;
  const home = homedir();
  return words.slice(1).some((target) => {
    if (target.dynamic) return true;
    const value = target.value;
    if (value.startsWith('-')) return false;
    if (target.glob && /^(\/|~\/|\.\/)?\*+$/.test(value)) return true;
    const absolute = value === '~' || value.startsWith('~/') ? resolve(home, value.slice(2)) : resolve(ctx.cwd, value);
    return (
      absolute === '/' ||
      dirname(absolute) === '/' ||
      absolute === home ||
      absolute === ctx.cwd ||
      isInside(ctx.cwd, absolute)
    );
  });
}

/** `a && b` running `cd` to another directory first can make later commands misleading. */
export function hasRiskyCdCombination(commands: SimpleCommand[], ctx: BashContext): boolean {
  const movesDir = commands.some((c) => {
    const words = stripWrappers(c.words);
    if (words[0]?.value !== 'cd') return false;
    const target = words[1];
    return !target || target.dynamic || resolve(ctx.cwd, target.value) !== ctx.cwd;
  });
  if (!movesDir) return false;
  return commands.some((c) => {
    const words = stripWrappers(c.words);
    // Running git in a new directory can execute that directory's hooks and config.
    return words[0]?.value === 'git' || writeTargets(c).length > 0;
  });
}

/** Command text checked against allow rules, or null when a risky assignment blocks matching. */
export function allowForm(cmd: SimpleCommand): string | null {
  const unsafe = cmd.assignments.some((a) => !SAFE_ENV_ASSIGNMENTS.has(a.raw.split('=')[0]!.replace(/\+$/, '')));
  if (unsafe) return null;
  return rawText(stripWrappers(cmd.words));
}

/** All spellings checked against deny and ask rules. Deliberately broader than allowForm. */
export function restrictiveForms(cmd: SimpleCommand): string[] {
  const words = stripWrappers(cmd.words);
  if (words.length === 0) return [];
  const forms = new Set([rawText(words), valueText(words)]);
  const first = words[0]!;
  if (first.value.includes('/')) {
    const rest = words.slice(1);
    forms.add([basename(first.value), ...rest.map((w) => w.raw)].join(' '));
    forms.add([basename(first.value), ...rest.map((w) => w.value)].join(' '));
  }
  return [...forms];
}

/** Commands hidden in `sh -c '...'` with a static payload, analysed for deny and ask rules. */
export function inlineShellCommands(cmd: SimpleCommand): SimpleCommand[] {
  const words = stripWrappers(cmd.words);
  const first = words[0];
  if (!first) return [];
  const name = basename(first.value);
  let payload: Word | undefined;
  if (name === 'eval') {
    payload = words[1];
  } else if (INLINE_SHELLS.has(name)) {
    const flag = words.findIndex((w) => /^-[a-z]*c$/.test(w.value));
    if (flag > 0) payload = words[flag + 1];
  }
  if (!payload || payload.dynamic) return [];
  const inner = analyzeShell(payload.value).commands;
  return [...inner, ...inner.flatMap(inlineShellCommands)];
}
