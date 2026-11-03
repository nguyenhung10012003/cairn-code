/**
 * Permission rule parsing and matching: `Tool` or `Tool(specifier)`. Behaviour follows the
 * rule semantics in Claude Code's public permission docs.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export type RuleBehavior = 'allow' | 'ask' | 'deny';
export type RuleSource = 'user' | 'project' | 'local' | 'flag' | 'cli' | 'session';

export interface PermissionRule {
  tool: string;
  specifier?: string;
  behavior: RuleBehavior;
  source: RuleSource;
  /** Directory that a `/path` pattern in this rule anchors at. */
  anchor: string;
  text: string;
}

export function parseRule(
  text: string,
  behavior: RuleBehavior,
  source: RuleSource,
  anchor: string,
): PermissionRule | null {
  const match = /^([A-Za-z0-9_*-]+)(?:\(([\s\S]*)\))?$/.exec(text.trim());
  if (!match) return null;
  let tool = match[1]!;
  let specifier = match[2];
  if (tool.startsWith('mcp__') && specifier !== undefined) return null;
  // A wildcard may only approve tools from one named MCP server, never "everything".
  if (tool.includes('*') && behavior === 'allow' && !/^mcp__[^*]+?__/.test(tool)) return null;
  // Write has no rule form of its own upstream, which silently disables a deny rule written
  // for it. Treating it as Edit makes that mistake safe.
  if (tool === 'Write' && specifier !== undefined) tool = 'Edit';
  if (specifier === '*' || specifier === '') specifier = undefined;
  const rule: PermissionRule = { tool, behavior, source, anchor, text: text.trim() };
  if (specifier !== undefined) rule.specifier = specifier;
  return rule;
}

const RULE_FAMILIES: Record<string, string[]> = {
  Edit: ['Edit', 'Write'],
  Read: ['Read', 'Grep', 'Glob'],
};

export function ruleCoversTool(rule: PermissionRule, toolName: string): boolean {
  if (rule.tool.includes('*')) {
    const pattern = rule.tool.split('*').map(escapeRegExp).join('.*');
    return new RegExp(`^${pattern}$`).test(toolName);
  }
  if (rule.tool === toolName) return true;
  // `mcp__github` names a whole server. Server names never contain `__`, so this is unambiguous.
  if (rule.tool.startsWith('mcp__') && !rule.tool.slice(5).includes('__')) return toolName.startsWith(`${rule.tool}__`);
  return RULE_FAMILIES[rule.tool]?.includes(toolName) ?? false;
}

/** Splits on commas and whitespace, except inside the parentheses of a rule like Bash(git log *). */
export function splitRuleList(values: string[]): string[] {
  const rules: string[] = [];
  for (const value of values) {
    let depth = 0;
    let current = '';
    for (const c of value) {
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && (c === ',' || c === ' ' || c === '\t' || c === '\n')) {
        if (current) rules.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    if (current) rules.push(current);
  }
  return rules;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchBashPattern(pattern: string, command: string): boolean {
  const normalized = pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern;
  const stars = normalized.split('*').length - 1;
  if (stars === 0) return normalized === command;
  if (stars === 1 && normalized.endsWith(' *')) {
    // A lone trailing ` *` also matches the bare command: `ls *` matches `ls`.
    const prefix = normalized.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return new RegExp(`^${normalized.split('*').map(escapeRegExp).join('[\\s\\S]*')}$`).test(command);
}

export function globToRegExp(glob: string, nocase = false): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '/' && glob.slice(i + 1) === '**') {
      // `src/**` covers the directory itself as well as everything under it.
      out += '(?:/.*)?';
      i += 3;
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
        i++;
      } else {
        const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = end + 1;
      }
    } else {
      out += escapeRegExp(c);
      i++;
    }
  }
  return new RegExp(`^${out}$`, nocase ? 'i' : '');
}

export interface PathMatchContext {
  cwd: string;
  home: string;
  anchor: string;
  behavior: RuleBehavior;
}

export function matchPathPattern(pattern: string, absPath: string, ctx: PathMatchContext): boolean {
  let base: string;
  let rest: string;
  let isRelative = false;
  if (pattern.startsWith('//')) {
    base = '/';
    rest = pattern.slice(2);
  } else if (pattern === '~' || pattern.startsWith('~/')) {
    base = ctx.home;
    rest = pattern.slice(2);
  } else if (pattern.startsWith('/')) {
    base = ctx.anchor;
    rest = pattern.slice(1);
  } else {
    base = ctx.cwd;
    rest = pattern.replace(/^\.\//, '');
    isRelative = true;
  }
  if (!isInside(absPath, base)) return false;

  const singleDirSegment = /^[^/*]+\/\*\*$/.test(rest);
  if (isRelative && (!rest.includes('/') || (singleDirSegment && ctx.behavior !== 'allow'))) {
    rest = `**/${rest}`;
  }
  if (rest.endsWith('/')) rest += '**';

  // macOS and Windows filesystems are usually case-insensitive, so `.ENV` is the same file as
  // `.env`. Restrictive rules must catch both spellings. Allow rules stay exact.
  const nocase = ctx.behavior !== 'allow' && (process.platform === 'darwin' || process.platform === 'win32');
  return globToRegExp(rest, nocase).test(relative(base, absPath).split(sep).join('/'));
}

export function matchDomain(specifier: string, hostname: string): boolean {
  if (!specifier.startsWith('domain:')) return false;
  const domain = specifier.slice('domain:'.length).toLowerCase();
  const host = hostname.toLowerCase();
  if (domain === '*') return true;
  if (domain.startsWith('*.')) return host.endsWith(domain.slice(1));
  return host === domain;
}

export function isInside(path: string, dir: string): boolean {
  if (dir === '/' || dir === sep) return path.startsWith(sep);
  return path === dir || path.startsWith(dir + sep);
}

/**
 * Resolves symlinks in the deepest existing ancestor, so a path that does not exist yet still
 * reports where it would really land.
 */
export function canonicalize(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...missing);
  } catch {
    return absolute;
  }
}

const PROTECTED_DIRS = new Set([
  '.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.cairn', '.claude',
]);
const PROTECTED_FILES = new Set([
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout',
  '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.profile', '.envrc', '.npmrc', '.yarnrc',
  '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml', '.bazelrc',
  '.bazelversion', '.bazeliskrc', 'gradle-wrapper.properties', 'maven-wrapper.properties',
  '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml',
  '.ripgreprc', 'pyrightconfig.json', '.devcontainer.json', '.mcp.json',
]);

/** Paths whose contents can run code or change tool behaviour. Writes are never auto-approved. */
export function isProtectedPath(path: string): boolean {
  const segments = path.split(sep);
  if (PROTECTED_FILES.has(segments.at(-1) ?? '')) return true;
  if (segments.some((segment) => PROTECTED_DIRS.has(segment))) return true;
  return segments.some((segment, i) => segment === '.config' && segments[i + 1] === 'git');
}
