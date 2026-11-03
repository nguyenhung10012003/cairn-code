import { open, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { globMatch } from '../core/glob.ts';
import { globToRegExp } from '../permissions/rules.ts';
import { resolvePath } from './files.ts';
import type { Tool, ToolContext } from './types.ts';

const ALWAYS_SKIPPED = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', '.next', '__pycache__', '.venv']);
const GLOB_RESULT_LIMIT = 500;
const DEFAULT_HEAD_LIMIT = 250;
const MAX_SEARCHED_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SEARCHED_LINE_LENGTH = 10_000;
const MAX_SHOWN_LINE_LENGTH = 500;

function searchRoot(input: Record<string, unknown>, ctx: ToolContext): string {
  return input.path === undefined ? ctx.cwd() : resolvePath(input.path as string, ctx);
}

/**
 * The pattern relative to the search directory, or null if it points outside. Only that directory
 * was approved, so a `../` pattern must not be able to list anything beyond it.
 */
function patternWithin(pattern: string, root: string): string | null {
  const inside = isAbsolute(pattern) ? (pattern.startsWith(`${root}/`) ? pattern.slice(root.length + 1) : null) : pattern.replace(/^(\.\/)+/, '');
  return inside === null || inside.split('/').includes('..') ? null : inside;
}

export const globTool: Tool = {
  name: 'Glob',
  description:
    'Find files by name. Use this rather than find or ls -R. The pattern is matched against paths relative to the search directory, so **/*.ts finds TypeScript files at any depth and *.ts only at its top level. ' +
    `Returns absolute paths, newest first, up to ${GLOB_RESULT_LIMIT} with a note when there are more. ` +
    `It never looks inside ${[...ALWAYS_SKIPPED].join(', ')}, does not follow symbolic links, and does not apply .gitignore. ` +
    'A pattern that leaves the search directory is an error; set path instead.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern, such as src/**/*.test.ts.' },
      path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: (input, ctx) => ({ kind: 'read', paths: [searchRoot(input, ctx)] }),
  async execute(input, ctx) {
    const root = searchRoot(input, ctx);
    const pattern = patternWithin(input.pattern as string, root);
    if (pattern === null) return { content: 'The pattern must stay inside the search directory. To search elsewhere, set `path`.', isError: true };
    try {
      globMatch(pattern, '');
    } catch (error) {
      return { content: (error as Error).message, isError: true };
    }
    const found: { path: string; mtime: number }[] = [];
    // Walked by hand, so skipped directories such as node_modules are never even listed.
    for await (const path of walk(root, root, () => false, ctx.signal)) {
      if (!globMatch(pattern, relative(root, path).split(sep).join('/')) || ctx.isReadDenied(path)) continue;
      try {
        found.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {
        // The file vanished between listing and stat.
      }
    }
    if (found.length === 0) return { content: 'No files found.', display: '0 files' };
    found.sort((a, b) => b.mtime - a.mtime);
    const shown = found.slice(0, GLOB_RESULT_LIMIT).map((f) => f.path);
    const note = found.length > GLOB_RESULT_LIMIT ? `\n\n[Showing ${GLOB_RESULT_LIMIT} of ${found.length} files.]` : '';
    return { content: shown.join('\n') + note, display: `${found.length} files` };
  },
};

type IgnoreTest = (relativePath: string) => boolean;

/** Reads the root .gitignore. Negations are not honoured, so a re-included file stays hidden. */
async function loadIgnore(root: string): Promise<IgnoreTest> {
  let text: string;
  try {
    text = await readFile(join(root, '.gitignore'), 'utf8');
  } catch {
    return () => false;
  }
  const patterns: RegExp[] = [];
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    patterns.push(globToRegExp(`${anchored ? line : `**/${line}`}${directoryOnly ? '/**' : ''}`));
  }
  return (path) => patterns.some((pattern) => pattern.test(path));
}

async function* walk(dir: string, root: string, ignored: IgnoreTest, signal: AbortSignal): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (signal.aborted) return;
    if (entry.isSymbolicLink() || ALWAYS_SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (ignored(relative(root, path).split(sep).join('/'))) continue;
    if (entry.isDirectory()) yield* walk(path, root, ignored, signal);
    else if (entry.isFile()) yield path;
  }
}

async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const probe = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    return probe.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function clip(line: string): string {
  return line.length > MAX_SHOWN_LINE_LENGTH ? `${line.slice(0, MAX_SHOWN_LINE_LENGTH)}…` : line;
}

export const grepTool: Tool = {
  name: 'Grep',
  description:
    'Search file contents with a JavaScript regular expression, one line at a time, so a pattern cannot match across lines. Use this rather than grep or rg. ' +
    `It stops at head_limit results with a note, and cuts lines it shows at ${MAX_SHOWN_LINE_LENGTH} characters. ` +
    `It applies the .gitignore in the search directory only, without its ! lines, and never looks inside ${[...ALWAYS_SKIPPED].join(', ')} or follows symbolic links. ` +
    `Binary files, files over ${MAX_SEARCHED_FILE_BYTES / (1024 * 1024)} MB and lines over ${MAX_SEARCHED_LINE_LENGTH} characters are not searched.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Only search files matching this glob. With no slash, such as *.ts, it matches at any depth.' },
      output_mode: {
        type: 'string',
        enum: ['files_with_matches', 'content', 'count'],
        description: 'files_with_matches (the default) lists paths, content shows path:line:text, count shows path:count.',
      },
      case_insensitive: { type: 'boolean', description: 'Ignore case when matching.' },
      context: { type: 'integer', description: 'Lines of context around each match, in content mode.' },
      head_limit: { type: 'integer', description: `Maximum results. Default ${DEFAULT_HEAD_LIMIT}.` },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: (input, ctx) => ({ kind: 'read', paths: [searchRoot(input, ctx)] }),
  async execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern as string, input.case_insensitive === true ? 'i' : '');
    } catch (error) {
      return { content: `Invalid regular expression: ${(error as Error).message}`, isError: true };
    }
    const mode = (input.output_mode as string | undefined) ?? 'files_with_matches';
    const context = Math.max(0, (input.context as number | undefined) ?? 0);
    const limit = Math.max(1, (input.head_limit as number | undefined) ?? DEFAULT_HEAD_LIMIT);
    const pathGlob = input.glob as string | undefined;
    const fileFilter = pathGlob ? globToRegExp(pathGlob.includes('/') ? pathGlob : `**/${pathGlob}`) : null;

    const root = searchRoot(input, ctx);
    let rootInfo;
    try {
      rootInfo = await stat(root);
    } catch {
      return { content: `Path does not exist: ${root}`, isError: true };
    }

    const results: string[] = [];
    let truncated = false;
    let skippedLarge = 0;
    const ignored = rootInfo.isDirectory() ? await loadIgnore(root) : () => false;
    const files = rootInfo.isDirectory() ? walk(root, root, ignored, ctx.signal) : singleFile(root);

    for await (const path of files) {
      if (ctx.signal.aborted) break;
      if (ctx.isReadDenied(path)) continue;
      if (fileFilter && !fileFilter.test(relative(root, path).split(sep).join('/'))) continue;
      const info = await stat(path);
      if (info.size > MAX_SEARCHED_FILE_BYTES) {
        skippedLarge++;
        continue;
      }
      if (await isBinaryFile(path)) continue;
      const lines = (await readFile(path, 'utf8')).split('\n');
      const matched: number[] = [];
      lines.forEach((line, i) => {
        if (line.length <= MAX_SEARCHED_LINE_LENGTH && regex.test(line)) matched.push(i);
      });
      if (matched.length === 0) continue;

      if (mode === 'files_with_matches') {
        results.push(path);
      } else if (mode === 'count') {
        results.push(`${path}:${matched.length}`);
      } else {
        const shown = new Set<number>();
        for (const i of matched) {
          for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) shown.add(j);
        }
        const matchedSet = new Set(matched);
        let previous = -2;
        for (const i of [...shown].sort((a, b) => a - b)) {
          if (context > 0 && previous !== -2 && i !== previous + 1) results.push('--');
          const separator = matchedSet.has(i) ? ':' : '-';
          results.push(`${path}${separator}${i + 1}${separator}${clip(lines[i]!)}`);
          previous = i;
        }
      }
      if (results.length >= limit) {
        truncated = true;
        break;
      }
    }

    const notes: string[] = [];
    if (truncated) notes.push(`[Stopped at ${limit} results. Narrow the search or raise head_limit.]`);
    if (skippedLarge > 0) notes.push(`[Skipped ${skippedLarge} files over ${MAX_SEARCHED_FILE_BYTES} bytes.]`);
    if (results.length === 0) return { content: ['No matches found.', ...notes].join('\n'), display: '0 matches' };
    const body = results.slice(0, limit).join('\n');
    return {
      content: notes.length > 0 ? `${body}\n\n${notes.join('\n')}` : body,
      display: `${Math.min(results.length, limit)} results`,
    };
  },
};

async function* singleFile(path: string): AsyncGenerator<string> {
  yield path;
}
