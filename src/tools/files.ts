import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { IMAGE_EXTENSIONS, PDF_PAGES_PER_READ, readImage, readPdf, WHOLE_PDF_PAGE_LIMIT } from './media.ts';
import { readNotebook } from './notebook.ts';
import type { Tool, ToolContext, ToolOutput } from './types.ts';

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** About 25,000 tokens: more than this in one read needs allow_large. */
const MAX_READ_CHARS = 100_000;
const LARGE_READ_CHARS = 400_000;
/** A format Read cannot show. Saying so is better than a page of garbled text. */
const UNREADABLE_EXTENSIONS = new Set(['.xlsx', '.xls', '.parquet', '.heic', '.zip', '.gz', '.tar', '.7z', '.docx', '.pptx']);

export function resolvePath(input: string, ctx: ToolContext): string {
  if (input === '~' || input.startsWith('~/')) return join(homedir(), input.slice(2));
  return resolve(ctx.cwd(), input);
}

function pathOf(input: Record<string, unknown>, ctx: ToolContext): string {
  return resolvePath(input.file_path as string, ctx);
}

function errorResult(content: string): ToolOutput {
  return { content, isError: true };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}

/** The shared precondition for changing an existing file. Returns an error message, or null. */
function staleReason(path: string, current: Buffer, ctx: ToolContext): string | null {
  const status = ctx.files.status(path, current);
  if (status === 'unread') return `${path} has not been read yet. Read it first, then retry.`;
  if (status === 'stale') return `${path} changed on disk since it was last read. Read it again, then retry.`;
  return null;
}

export const readTool: Tool = {
  name: 'Read',
  description: `Reads a file from the local filesystem.

- \`file_path\` must be an absolute path.
- Reads up to ${DEFAULT_LINE_LIMIT} lines by default.
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- Reads images (PNG, JPG, …) and presents them visually. Reads PDFs via the \`pages\` parameter (e.g. "1-5", max ${PDF_PAGES_PER_READ} pages/request; required for PDFs over ${WHOLE_PDF_PAGE_LIMIT} pages). Reads Jupyter notebooks (.ipynb) as cells with outputs.
- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.
- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { description: 'The absolute path to the file to read', type: 'string' },
      offset: { description: 'The line number to start reading from. Only provide if the file is too large to read at once', type: 'integer', minimum: 0 },
      limit: { description: 'The number of lines to read. Only provide if the file is too large to read at once.', type: 'integer', minimum: 1 },
      pages: { description: `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_PAGES_PER_READ} pages per request.`, type: 'string' },
      allow_large: {
        description:
          'Set to true to read a text file, or a line range of one, that is over the usual size limits, up to what still fits in your context. Only use this when you genuinely need all of it or the user asked for the whole file; otherwise read it in parts with offset and limit, or search it.',
        type: 'boolean',
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  isReadOnly: () => true,
  access: (input, ctx) => ({ kind: 'read', paths: [pathOf(input, ctx)] }),
  async execute(input, ctx) {
    const path = pathOf(input, ctx);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return errorResult(`File does not exist: ${path}`);
      throw error;
    }
    if (info.isDirectory()) return errorResult(`${path} is a directory. Use Glob or ls to list it.`);
    const extension = extname(path).toLowerCase();
    if (IMAGE_EXTENSIONS.has(extension)) return readImage(path, info.size, ctx.signal);
    if (extension === '.pdf') return readPdf(path, info.size, input.pages as string | undefined, ctx.signal);
    if (extension === '.ipynb') return readNotebook(path, info.size, ctx);
    if (UNREADABLE_EXTENSIONS.has(extension)) {
      return errorResult(`Read cannot show ${extension} files. Convert ${path} with a shell command or a script, then read the result.`);
    }
    if (info.size > MAX_FILE_BYTES) {
      return errorResult(`${path} is ${info.size} bytes, over the ${MAX_FILE_BYTES} byte limit. Use Grep to search it.`);
    }
    const buffer = await readFile(path);
    if (looksBinary(buffer)) return errorResult(`${path} looks like a binary file.`);
    ctx.files.record(path, buffer);

    const text = buffer.toString('utf8');
    if (text.length === 0) return { content: `${path} is empty.`, display: 'empty file' };
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const start = Math.max(1, (input.offset as number | undefined) ?? 1);
    const limit = Math.max(1, (input.limit as number | undefined) ?? DEFAULT_LINE_LIMIT);
    if (start > lines.length) return errorResult(`offset ${start} is past the end of the file (${lines.length} lines).`);

    const selected = lines.slice(start - 1, start - 1 + limit);
    const body = selected
      .map((line, i) => {
        const shown = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]` : line;
        return `${start + i}\t${shown}`;
      })
      .join('\n');
    const end = start - 1 + selected.length;
    const remainder = end < lines.length ? `\n\n[Showing lines ${start}-${end} of ${lines.length}.]` : '';
    const allowLarge = input.allow_large === true;
    const cap = allowLarge ? LARGE_READ_CHARS : MAX_READ_CHARS;
    if (body.length > cap) {
      return errorResult(
        allowLarge
          ? `Lines ${start}-${end} of ${path} are ${body.length} characters, more than fits even with allow_large (${LARGE_READ_CHARS}). Read it in parts with offset and limit.`
          : `Lines ${start}-${end} of ${path} are ${body.length} characters, over the ${MAX_READ_CHARS} character limit for one read. Read it in parts with offset and limit, search it, or set allow_large if you genuinely need all of it.`,
      );
    }
    return { content: body + remainder, display: `${selected.length} lines`, ...(allowLarge ? { maxChars: LARGE_READ_CHARS + 200 } : {}) };
  },
};

export const writeTool: Tool = {
  name: 'Write',
  description: `Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { description: 'The absolute path to the file to write (must be absolute, not relative)', type: 'string' },
      content: { description: 'The content to write to the file', type: 'string' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: (input, ctx) => ({ kind: 'edit', paths: [pathOf(input, ctx)] }),
  async execute(input, ctx) {
    const path = pathOf(input, ctx);
    const content = input.content as string;
    const current = await readIfExists(path);
    if (current) {
      const stale = staleReason(path, current, ctx);
      if (stale) return errorResult(stale);
    }
    await ctx.checkpoints?.snapshot(path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    ctx.files.record(path, content);
    const lineCount = content.split('\n').length;
    return { content: `${current ? 'Replaced' : 'Created'} ${path}.`, display: `${lineCount} lines` };
  },
};

export const editTool: Tool = {
  name: 'Edit',
  description: `Performs exact string replacement in a file.

- You must Read the file in this conversation before editing, or the call will fail.
- \`old_string\` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.
- \`replace_all: true\` replaces every occurrence instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { description: 'The absolute path to the file to modify', type: 'string' },
      old_string: { description: 'The text to replace', type: 'string' },
      new_string: { description: 'The text to replace it with (must be different from old_string)', type: 'string' },
      replace_all: { description: 'Replace all occurrences of old_string (default false)', default: false, type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: (input, ctx) => ({ kind: 'edit', paths: [pathOf(input, ctx)] }),
  async execute(input, ctx) {
    const path = pathOf(input, ctx);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    if (oldString === newString) return errorResult('old_string and new_string are identical.');
    if (oldString.length === 0) return errorResult('old_string is empty. Use Write to create a file.');

    const current = await readIfExists(path);
    if (!current) return errorResult(`File does not exist: ${path}`);
    const stale = staleReason(path, current, ctx);
    if (stale) return errorResult(stale);

    const text = current.toString('utf8');
    const parts = text.split(oldString);
    const occurrences = parts.length - 1;
    if (occurrences === 0) return errorResult(`old_string was not found in ${path}.`);
    if (occurrences > 1 && input.replace_all !== true) {
      return errorResult(`old_string matches ${occurrences} places in ${path}. Add surrounding text, or set replace_all.`);
    }
    await ctx.checkpoints?.snapshot(path);
    // Split and join rather than String.replace, whose `$&` patterns would corrupt the new text.
    const updated = parts.join(newString);
    await writeFile(path, updated);
    ctx.files.record(path, updated);
    const noun = occurrences === 1 ? 'replacement' : 'replacements';
    return { content: `Edited ${path} (${occurrences} ${noun}).`, display: `${occurrences} ${noun}` };
  },
};
