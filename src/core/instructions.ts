/**
 * Project instruction discovery. Files load from the user's home directory, then from the
 * filesystem root down to the working directory, so closer instructions are read last.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import {
  appHome,
  FALLBACK_INSTRUCTION_FILES,
  INSTRUCTION_FILE,
  LOCAL_INSTRUCTION_FILE,
  PROJECT_DIR,
} from '../config/paths.ts';
import { parseFrontmatter, pathList } from './frontmatter.ts';
import { globMatch } from './glob.ts';
import { isInside } from '../permissions/rules.ts';

const MAX_IMPORT_DEPTH = 4;
const MAX_FILE_CHARS = 100_000;
const MAX_RULE_DIR_DEPTH = 8;
const RULES_DIR = 'rules';

export interface InstructionFile {
  path: string;
  content: string;
  scope: 'user' | 'project';
}

/** A rule with `paths`, which joins the conversation when the model works on a matching file. */
export interface ConditionalRule {
  path: string;
  content: string;
  patterns: string[];
  /** The directory its patterns are relative to. */
  base: string;
}

export interface LoadedInstructions {
  files: InstructionFile[];
  conditional: ConditionalRule[];
  warnings: string[];
}

function stripBlockComments(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let inComment = false;
  for (const line of text.split('\n')) {
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^\s*<!--/.test(line)) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** `@path` references outside code spans and fenced blocks. A `\ ` keeps a space in the path. */
function findImports(text: string): string[] {
  const imports: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const withoutSpans = line.replace(/`[^`]*`/g, '');
    for (const match of withoutSpans.matchAll(/(?:^|\s)@((?:\\ |[^\s"'`])+)/g)) {
      imports.push(match[1]!.replace(/\\ /g, ' '));
    }
  }
  return imports;
}

function readTextFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

interface LoadContext {
  files: InstructionFile[];
  warnings: string[];
  seen: Set<string>;
  scope: 'user' | 'project';
  projectRoot: string;
  /** Project files may only pull in files from elsewhere once the workspace is trusted. */
  allowExternalImports: boolean;
}

function loadFile(path: string, depth: number, ctx: LoadContext, text?: string): void {
  if (ctx.seen.has(path)) return;
  const raw = text ?? readTextFile(path);
  if (raw === null) return;
  ctx.seen.add(path);

  let content = stripBlockComments(raw);
  if (content.length > MAX_FILE_CHARS) {
    content = `${content.slice(0, MAX_FILE_CHARS)}\n[Truncated: this file is over ${MAX_FILE_CHARS} characters.]`;
    ctx.warnings.push(`${path} is over ${MAX_FILE_CHARS} characters and was truncated.`);
  }
  ctx.files.push({ path, content, scope: ctx.scope });

  for (const target of findImports(content)) {
    const expanded = target === '~' || target.startsWith('~/') ? join(homedir(), target.slice(2)) : target;
    const resolved = isAbsolute(expanded) ? expanded : resolve(dirname(path), expanded);
    if (!existsSync(resolved)) continue;
    if (depth >= MAX_IMPORT_DEPTH) {
      ctx.warnings.push(`Import ${target} in ${path} is deeper than ${MAX_IMPORT_DEPTH} hops; skipped.`);
      continue;
    }
    if (ctx.scope === 'project' && !ctx.allowExternalImports && !isInside(resolved, ctx.projectRoot)) {
      ctx.warnings.push(`Skipped import outside the project: ${target} (in ${path}). Trust this directory to allow it.`);
      continue;
    }
    loadFile(resolved, depth + 1, ctx);
  }
}

function ancestorsFromRoot(cwd: string): string[] {
  const root = parse(cwd).root;
  const dirs: string[] = [];
  let current = cwd;
  while (current !== root) {
    dirs.unshift(current);
    current = dirname(current);
  }
  // Instructions at the filesystem root are not a normal setup, so `/` is skipped.
  return dirs;
}

function ruleFiles(dir: string, depth = 0): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    let info;
    try {
      info = statSync(path);
    } catch {
      return [];
    }
    if (info.isDirectory()) return depth < MAX_RULE_DIR_DEPTH ? ruleFiles(path, depth + 1) : [];
    return info.isFile() && entry.endsWith('.md') ? [path] : [];
  });
}

/** Rules without `paths` load like any instruction file. The rest wait for a matching file. */
function loadRules(dir: string, base: string, ctx: LoadContext, conditional: ConditionalRule[]): void {
  for (const path of ruleFiles(dir)) {
    if (ctx.seen.has(path)) continue;
    const raw = readTextFile(path);
    if (raw === null) continue;
    const { fields, body, error } = parseFrontmatter(raw);
    if (error) ctx.warnings.push(`${path}: the frontmatter is not valid YAML, so this rule applies everywhere. ${error}`);
    const patterns = pathList(fields.paths);
    if (patterns.length === 0) {
      loadFile(path, 0, ctx, body);
    } else {
      ctx.seen.add(path);
      conditional.push({ path, content: stripBlockComments(body).trim(), patterns, base });
    }
  }
}

function loadDirectory(dir: string, ctx: LoadContext, conditional: ConditionalRule[]): void {
  const candidates = [join(dir, INSTRUCTION_FILE), join(dir, PROJECT_DIR, INSTRUCTION_FILE)];
  const primary = candidates.find((path) => existsSync(path));
  const fallback = FALLBACK_INSTRUCTION_FILES.map((name) => join(dir, name)).find((path) => existsSync(path));
  const chosen = primary ?? fallback;
  if (chosen) loadFile(chosen, 0, ctx);
  loadRules(join(dir, PROJECT_DIR, RULES_DIR), dir, ctx, conditional);
  loadFile(join(dir, LOCAL_INSTRUCTION_FILE), 0, ctx);
}

export function loadInstructions(cwd: string, trusted: boolean): LoadedInstructions {
  const files: InstructionFile[] = [];
  const conditional: ConditionalRule[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const base = { files, warnings, seen, projectRoot: cwd, allowExternalImports: trusted };

  const userCtx: LoadContext = { ...base, scope: 'user', allowExternalImports: true };
  loadFile(join(appHome(), INSTRUCTION_FILE), 0, userCtx);
  loadRules(join(appHome(), RULES_DIR), cwd, userCtx, conditional);

  for (const dir of ancestorsFromRoot(cwd)) {
    // A parent directory's own files count as inside the project for import checks.
    const ctx: LoadContext = { ...base, scope: 'project', projectRoot: isInside(cwd, dir) ? dir : cwd };
    loadDirectory(dir, ctx, conditional);
  }
  return { files, conditional, warnings };
}

function ruleApplies(rule: ConditionalRule, path: string): boolean {
  const inside = relative(rule.base, path).split(sep).join('/');
  if (inside.startsWith('../') || isAbsolute(inside)) return false;
  return rule.patterns.some((pattern) => {
    try {
      return globMatch(pattern, inside);
    } catch {
      return false;
    }
  });
}

function renderLoaded(path: string, content: string, why: string): string {
  return `<instructions path="${path.split(sep).join('/')}" reason="${why}">\n${content.trim()}\n</instructions>`;
}

export interface WatcherOptions {
  projectDir: string;
  trusted: boolean;
  loaded: LoadedInstructions;
  /** The model worked on a file in this directory for the first time. */
  onDirectory?: (dir: string) => void;
  /** An instruction file joined the conversation. */
  onLoaded?: (path: string, reason: string) => void;
  /** Called for each file touched, so path-scoped skills can wake up. */
  onFile?: (path: string) => void;
}

/**
 * Feeds the conversation what becomes relevant as the model works: path-scoped rules, and the
 * instructions of subdirectories it reaches. The system prompt stays frozen, so all of this goes
 * in as text alongside the next tool results or prompt.
 */
export class ConversationWatcher {
  private readonly options: WatcherOptions;
  private seen: Set<string>;
  private readonly startupFiles: Set<string>;
  private conditional: ConditionalRule[];
  private readonly visitedDirs = new Set<string>();
  private queue: string[] = [];
  warnings: string[] = [];

  constructor(options: WatcherOptions) {
    this.options = options;
    this.startupFiles = new Set(options.loaded.files.map((file) => file.path));
    this.seen = new Set(this.startupFiles);
    this.conditional = [...options.loaded.conditional];
  }

  /** A message for the conversation's next turn. */
  note(text: string): void {
    this.queue.push(text);
  }

  drain(): string[] {
    const drained = this.queue;
    this.queue = [];
    return drained;
  }

  /** After compaction or /clear, what was attached is gone, so it may be attached again. */
  reset(): void {
    this.seen = new Set(this.startupFiles);
    this.visitedDirs.clear();
    this.queue = [];
  }

  private visit(dir: string): void {
    if (this.visitedDirs.has(dir)) return;
    this.visitedDirs.add(dir);
    this.options.onDirectory?.(dir);
    const files: InstructionFile[] = [];
    const conditional: ConditionalRule[] = [];
    const known = new Set(this.seen);
    for (const rule of this.conditional) known.add(rule.path);
    const ctx: LoadContext = {
      files,
      warnings: this.warnings,
      seen: known,
      scope: 'project',
      projectRoot: this.options.projectDir,
      allowExternalImports: this.options.trusted,
    };
    loadDirectory(dir, ctx, conditional);
    this.conditional.push(...conditional);
    for (const file of files) {
      this.seen.add(file.path);
      this.queue.push(renderLoaded(file.path, file.content, `applies to files under ${dir}`));
      this.options.onLoaded?.(file.path, 'nested_traversal');
    }
  }

  touched(paths: string[]): void {
    const root = this.options.projectDir;
    for (const path of paths) {
      this.options.onFile?.(path);
      if (isInside(path, root)) {
        const chain: string[] = [];
        for (let dir = dirname(path); dir !== root && isInside(dir, root); dir = dirname(dir)) chain.unshift(dir);
        for (const dir of chain) this.visit(dir);
      }
      for (const rule of this.conditional) {
        if (this.seen.has(rule.path) || !ruleApplies(rule, path)) continue;
        this.seen.add(rule.path);
        this.queue.push(renderLoaded(rule.path, rule.content, `its paths match ${path.split(sep).join('/')}`));
        this.options.onLoaded?.(rule.path, 'path_glob_match');
      }
    }
  }
}

/** How Claude Code labels each kind of instruction file. */
function instructionLabel(file: InstructionFile): string {
  if (file.scope === 'user') return "user's private global instructions for all projects";
  if (file.path.endsWith(`${sep}${LOCAL_INSTRUCTION_FILE}`)) return "user's private project instructions, not checked in";
  return 'project instructions, checked into the codebase';
}

export function renderInstructions(files: InstructionFile[]): string {
  return files
    .map((file) => `Contents of ${file.path.split(sep).join('/')} (${instructionLabel(file)}):\n\n${file.content.trim()}`)
    .join('\n\n');
}
