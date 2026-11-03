/**
 * Skills: Markdown instructions the model or the user can load on demand. `.cairn/commands/*.md`
 * files are the same thing in a simpler form. This module only reads and renders text; running
 * a skill's commands is in tools/skill.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { appHome, PROJECT_DIR } from '../config/paths.ts';
import type { HooksConfig } from '../config/settings.ts';
import { booleanField, listField, parseFrontmatter, pathList, stringField } from '../core/frontmatter.ts';
import { globMatch } from '../core/glob.ts';
import type { Effort } from '../core/provider.ts';
import { expandPluginVars } from '../plugins/plugins.ts';
import type { Plugin } from '../plugins/plugins.ts';
import { isInside } from '../permissions/rules.ts';

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]*$/;
const MAX_DESCRIPTION_CHARS = 1536;
const MAX_LISTING_CHARS = 16_000;
const SKILL_FILE = 'SKILL.md';

export type SkillSource = 'user' | 'project' | 'plugin' | 'added';

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** Directory that holds the skill's supporting files. */
  dir: string;
  path: string;
  source: SkillSource;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  argumentHint?: string;
  argumentNames: string[];
  model?: string;
  effort?: Effort;
  fork: boolean;
  agent?: string;
  /** Glob patterns: the model is told about this skill only once it works on a matching file. */
  paths: string[];
  /** Registered when the skill is invoked, for the rest of the session. */
  hooks?: HooksConfig;
}

export interface LoadedSkills {
  skills: Map<string, Skill>;
  warnings: string[];
}

/** What a skill changes for the turn that invokes it. */
export interface SkillActivation {
  allowedTools: string[];
  disallowedTools: string[];
  model?: string;
  effort?: Effort;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstParagraph(body: string): string {
  const line = body.split('\n').map((text) => text.trim()).find((text) => text && !text.startsWith('#'));
  return line ?? '';
}

function buildSkill(defaultName: string, path: string, dir: string, source: SkillSource, warnings: string[], allowNameField: boolean): Skill | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    warnings.push(`Could not read ${path}: ${(error as Error).message}`);
    return null;
  }
  const { fields, body, error } = parseFrontmatter(text);
  // A stray colon in a description is easy to write, and it silently drops every other field.
  if (error) warnings.push(`${path}: the frontmatter is not valid YAML, so its fields are ignored. ${error}`);
  const name = (allowNameField ? stringField(fields, 'name') : undefined) ?? defaultName;
  if (!NAME_PATTERN.test(name)) {
    warnings.push(`Skipping skill with an invalid name: ${JSON.stringify(name)} (${path})`);
    return null;
  }
  const whenToUse = stringField(fields, 'when_to_use');
  const summary = [stringField(fields, 'description') ?? firstParagraph(body), whenToUse].filter(Boolean).join(' ');
  const effort = stringField(fields, 'effort');
  const skill: Skill = {
    name,
    description: summary.slice(0, MAX_DESCRIPTION_CHARS),
    body: body.trim(),
    dir,
    path,
    source,
    disableModelInvocation: booleanField(fields, 'disable-model-invocation') ?? false,
    userInvocable: booleanField(fields, 'user-invocable') ?? true,
    allowedTools: listField(fields, 'allowed-tools'),
    disallowedTools: listField(fields, 'disallowed-tools'),
    argumentNames: listField(fields, 'arguments'),
    fork: stringField(fields, 'context') === 'fork',
    paths: pathList(fields.paths),
  };
  const hooks = fields.hooks;
  if (typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)) skill.hooks = hooks as HooksConfig;
  // The usual `argument-hint: [issue]`, with no quotes, is a list as far as YAML is concerned.
  const rawHint = fields['argument-hint'];
  const hint = Array.isArray(rawHint) ? `[${rawHint.join(', ')}]` : stringField(fields, 'argument-hint');
  if (hint) skill.argumentHint = hint;
  const model = stringField(fields, 'model');
  if (model) skill.model = model;
  if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) skill.effort = effort as Effort;
  const agent = stringField(fields, 'agent');
  if (agent) skill.agent = agent;
  return skill;
}

function commandFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return readdirSync(dir).sort().flatMap((entry) => {
    const path = join(dir, entry);
    if (isDirectory(path)) return commandFiles(path);
    return entry.endsWith('.md') && isFile(path) ? [path] : [];
  });
}

function readScope(root: string, source: SkillSource, into: Map<string, Skill>, warnings: string[]): void {
  const commandsDir = join(root, 'commands');
  for (const path of commandFiles(commandsDir)) {
    // `commands/frontend/button.md` becomes `/frontend:button`.
    const name = relative(commandsDir, path).replace(/\.md$/, '').split(sep).join(':');
    const skill = buildSkill(name, path, dirname(path), source, warnings, false);
    if (skill) into.set(skill.name, skill);
  }
  const skillsDir = join(root, 'skills');
  if (!isDirectory(skillsDir)) return;
  for (const entry of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, entry);
    const path = join(dir, SKILL_FILE);
    if (!isFile(path)) continue;
    const skill = buildSkill(entry, path, dir, source, warnings, true);
    if (skill) into.set(skill.name, skill);
  }
}

function readPluginSkills(plugin: Plugin, projectDir: string, into: Map<string, Skill>, warnings: string[]): void {
  const add = (skill: Skill | null): void => {
    if (!skill) return;
    skill.body = expandPluginVars(skill.body, plugin, projectDir);
    skill.allowedTools = skill.allowedTools.map((rule) => expandPluginVars(rule, plugin, projectDir));
    into.set(skill.name, skill);
  };
  for (const dir of plugin.skillDirs) {
    if (isFile(join(dir, SKILL_FILE))) {
      add(buildSkill(`${plugin.name}:${basename(dir)}`, join(dir, SKILL_FILE), dir, 'plugin', warnings, false));
      continue;
    }
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry, SKILL_FILE);
      if (isFile(path)) add(buildSkill(`${plugin.name}:${entry}`, path, join(dir, entry), 'plugin', warnings, false));
    }
  }
  for (const given of plugin.commandPaths) {
    const files = isDirectory(given) ? commandFiles(given) : [given];
    const base = isDirectory(given) ? given : dirname(given);
    for (const path of files) {
      const name = relative(base, path).replace(/\.md$/, '').split(sep).join(':');
      add(buildSkill(`${plugin.name}:${name}`, path, dirname(path), 'plugin', warnings, false));
    }
  }
}

/** A name another source already has runs under a prefix that says where it comes from. */
function mergeWithPrefix(from: Map<string, Skill>, prefix: string, into: Map<string, Skill>): void {
  for (const [name, skill] of from) {
    if (into.has(name)) skill.name = `${prefix}:${name}`;
    into.set(skill.name, skill);
  }
}

export interface SkillSources {
  addDirs?: string[];
  plugins?: Plugin[];
  /** Directories below the project the model has reached, whose skills now count. */
  nestedDirs?: string[];
  /** False with --disable-slash-commands or --safe-mode. */
  enabled?: boolean;
  /** False with --bare: only what the command line names. */
  discover?: boolean;
}

function ancestorsToRepoRoot(projectDir: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(projectDir); dir !== dirname(dir); dir = dirname(dir)) {
    dirs.push(dir);
    if (existsSync(join(dir, '.git'))) return dirs.reverse();
  }
  // Not in a repository, so a parent directory's skills have nothing to do with this project.
  return [];
}

/**
 * A personal skill overrides a project one of the same name, and a skill overrides a command
 * file. A project's skills count only once it is trusted, because `allowed-tools` pre-approves
 * tools and `` !`cmd` `` runs commands.
 */
export function loadSkills(projectDir: string, trusted: boolean, sources: SkillSources = {}): LoadedSkills {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];
  if (sources.enabled === false) return { skills, warnings };
  const discover = sources.discover !== false;
  if (trusted && discover) {
    const inRepository = existsSync(join(projectDir, '.git')) ? [] : ancestorsToRepoRoot(projectDir);
    for (const dir of [...inRepository, projectDir]) readScope(join(dir, PROJECT_DIR), 'project', skills, warnings);
  }
  if (discover) readScope(appHome(), 'user', skills, warnings);
  if (trusted) {
    for (const dir of sources.nestedDirs ?? []) {
      const nested = new Map<string, Skill>();
      readScope(join(dir, PROJECT_DIR), 'project', nested, warnings);
      mergeWithPrefix(nested, relative(projectDir, dir).split(sep).join('/'), skills);
    }
    for (const dir of sources.addDirs ?? []) {
      const added = new Map<string, Skill>();
      readScope(join(dir, PROJECT_DIR), 'added', added, warnings);
      mergeWithPrefix(added, basename(dir), skills);
    }
  }
  for (const plugin of sources.plugins ?? []) readPluginSkills(plugin, projectDir, skills, warnings);
  return { skills, warnings };
}

/** Does this skill's `paths` cover a file? Patterns are relative to the project, as for rules. */
export function skillMatchesPath(skill: Skill, projectDir: string, path: string): boolean {
  if (!isInside(path, projectDir)) return false;
  const inside = relative(projectDir, path).split(sep).join('/');
  return skill.paths.some((pattern) => {
    try {
      return globMatch(pattern, inside);
    } catch {
      return false;
    }
  });
}

export type SkillSegment = { kind: 'text'; text: string } | { kind: 'command'; command: string };

const INLINE_COMMAND = /(^|\s)!`([^`\n]+)`/g;

/**
 * Finds `` !`cmd` `` and ```` ```! ```` blocks in the skill as written, before any argument is
 * filled in. Scanning afterwards would let an argument smuggle in a command to run. Examples
 * inside ordinary code fences are left alone.
 */
export function splitInjectedCommands(body: string): SkillSegment[] {
  const segments: SkillSegment[] = [];
  const addText = (text: string): void => {
    const last = segments.at(-1);
    if (last?.kind === 'text') last.text += text;
    else if (text) segments.push({ kind: 'text', text });
  };
  const lines = body.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const newline = i < lines.length - 1 ? '\n' : '';
    if (!inFence && /^```!\s*$/.test(line)) {
      const end = lines.findIndex((candidate, index) => index > i && /^```\s*$/.test(candidate));
      if (end !== -1) {
        segments.push({ kind: 'command', command: lines.slice(i + 1, end).join('\n') });
        addText(end < lines.length - 1 ? '\n' : '');
        i = end;
        continue;
      }
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      addText(line + newline);
    } else if (inFence) {
      addText(line + newline);
    } else {
      let position = 0;
      for (const match of line.matchAll(INLINE_COMMAND)) {
        addText(line.slice(position, match.index) + match[1]!);
        segments.push({ kind: 'command', command: match[2]! });
        position = match.index + match[0].length;
      }
      addText(line.slice(position) + newline);
    }
  }
  return segments;
}

export function hasInjectedCommands(body: string): boolean {
  return splitInjectedCommands(body).some((segment) => segment.kind === 'command');
}

/**
 * Can this skill do more than add text to the conversation? Only then does the model need
 * approval to load it.
 */
export function isPrivilegedSkill(skill: Skill): boolean {
  return skill.allowedTools.length > 0 || skill.fork || skill.hooks !== undefined || hasInjectedCommands(skill.body);
}

export function splitArguments(args: string): string[] {
  const parts = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((part) => (/^(".*"|'.*')$/.test(part) ? part.slice(1, -1) : part));
}

export interface SkillVariables {
  sessionId: string;
  projectDir: string;
  effort: string;
}

const PLACEHOLDER =
  /\\\$|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)|\$\{(?:CAIRN|CLAUDE)_(SKILL_DIR|PROJECT_DIR|SESSION_ID|EFFORT)\}|\$([A-Za-z_][A-Za-z0-9_-]*)/g;

/** One pass only, so text coming from an argument is never expanded again. */
export function substitute(
  text: string,
  args: string,
  skill: Pick<Skill, 'dir' | 'argumentNames'>,
  variables: SkillVariables,
  onArgumentUsed: () => void = () => {},
): string {
  const positional = splitArguments(args);
  return text.replace(PLACEHOLDER, (match, index: string | undefined, digit: string | undefined, variable: string | undefined, named: string | undefined, offset: number) => {
    if (match === '\\$') {
      const rest = text.slice(offset + 2);
      const escapesPlaceholder = /^\d|^ARGUMENTS\b/.test(rest) || skill.argumentNames.some((name) => rest.startsWith(name));
      return escapesPlaceholder ? '$' : match;
    }
    if (variable === 'SKILL_DIR') return skill.dir;
    if (variable === 'PROJECT_DIR') return variables.projectDir;
    if (variable === 'SESSION_ID') return variables.sessionId;
    if (variable === 'EFFORT') return variables.effort;
    if (match === '$ARGUMENTS') {
      onArgumentUsed();
      return args;
    }
    const position = index ?? digit;
    if (position !== undefined) {
      onArgumentUsed();
      return positional[Number(position)] ?? '';
    }
    const namedIndex = named === undefined ? -1 : skill.argumentNames.indexOf(named);
    if (namedIndex === -1) return match;
    onArgumentUsed();
    return positional[namedIndex] ?? '';
  });
}

/** The lines added to the system prompt. Bodies stay out of context until a skill is used. */
export function renderSkillListing(skills: Map<string, Skill>, activated: ReadonlySet<string> = new Set()): { text: string; omitted: number } {
  const visible = [...skills.values()]
    .filter((skill) => !skill.disableModelInvocation && (skill.paths.length === 0 || activated.has(skill.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const skill of visible) {
    const line = `- ${skill.name}: ${skill.description.replace(/\s+/g, ' ')}`;
    if (used + line.length > MAX_LISTING_CHARS) {
      omitted++;
      lines.push(`- ${skill.name}`);
    } else {
      used += line.length;
      lines.push(line);
    }
  }
  return { text: lines.join('\n'), omitted };
}

export function projectHasSkillFiles(projectDir: string): boolean {
  return ['skills', 'commands'].some((name) => existsSync(join(projectDir, PROJECT_DIR, name)));
}
