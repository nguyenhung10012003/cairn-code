/**
 * .gitignore files read the way git reads them, for Grep. A file's patterns are relative to its
 * own directory, a deeper file overrides a shallower one, the last line that matches wins, and a
 * `!` line takes a path back. A directory that is ignored is never entered, so, as in git, nothing
 * under it can be taken back. `.git/info/exclude` and a global excludes file are not read.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

interface Rule {
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
}

interface IgnoreFile {
  dir: string;
  rules: Rule[];
}

/** One glob from a .gitignore line, with its leading and trailing slashes already removed. */
function globBody(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) {
      out += escapeRegExp(glob[i + 1]!);
      i += 2;
    } else if (c === '*' && glob[i + 1] === '*' && (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/')) {
      // `**` as a whole segment: any number of directories.
      if (i + 2 === glob.length) {
        out += '.*';
        i += 2;
      } else {
        out += '(?:.*/)?';
        i += 3;
      }
    } else if (c === '*') {
      // Any other run of stars is a plain `*`.
      while (glob[i] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        out += '\\[';
        i++;
      } else {
        const body = glob.slice(i + 1, end).replace(/^[!^]/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = end + 1;
      }
    } else {
      out += escapeRegExp(c);
      i++;
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The rules in one .gitignore, in file order. Lines that cannot be read as a pattern are skipped. */
export function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // Trailing spaces do not count unless escaped with a backslash.
    let end = line.length;
    while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--;
    line = line.slice(0, end);
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);
    const directoryOnly = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    if (line === '') continue;
    // A slash at the start or in the middle ties the pattern to this file's directory. Without
    // one, it matches a name at any depth below it.
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    if (line === '') continue;
    try {
      rules.push({ regex: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${globBody(line)}$`), negated, directoryOnly });
    } catch {
      // A malformed character class, which git would not match either.
    }
  }
  return rules;
}

async function readRules(dir: string): Promise<IgnoreFile | null> {
  let text: string;
  try {
    text = await readFile(join(dir, '.gitignore'), 'utf8');
  } catch {
    return null;
  }
  const rules = parseGitignore(text);
  return rules.length > 0 ? { dir, rules } : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The .gitignore rules that apply in one directory: its own and those of the directories above it. */
export class IgnoreRules {
  private readonly files: readonly IgnoreFile[];

  private constructor(files: readonly IgnoreFile[]) {
    this.files = files;
  }

  /**
   * The rules a search of `root` starts with: those of the directories above it, up to the root
   * of its git repository. Outside a repository there are none, and only the .gitignore files in
   * and below `root` apply. `root` itself is searched even if those rules ignore it.
   */
  static async above(root: string): Promise<IgnoreRules> {
    const parents: string[] = [];
    let dir = root;
    while (!(await exists(join(dir, '.git')))) {
      const parent = dirname(dir);
      if (parent === dir) return new IgnoreRules([]);
      parents.unshift(parent);
      dir = parent;
    }
    const files: IgnoreFile[] = [];
    for (const parent of parents) {
      const file = await readRules(parent);
      if (file) files.push(file);
    }
    return new IgnoreRules(files);
  }

  /** These rules with `dir`'s own .gitignore added, for the entries of `dir`. */
  async enter(dir: string): Promise<IgnoreRules> {
    const file = await readRules(dir);
    return file ? new IgnoreRules([...this.files, file]) : this;
  }

  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const file of this.files) {
      const inside = relative(file.dir, path);
      if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
      const relativePath = inside.split(sep).join('/');
      for (const rule of file.rules) {
        // A line that would leave the answer as it is cannot change it.
        if (rule.negated !== ignored) continue;
        if (rule.directoryOnly && !isDirectory) continue;
        if (rule.regex.test(relativePath)) ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
