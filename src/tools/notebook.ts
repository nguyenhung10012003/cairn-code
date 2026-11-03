/** Jupyter notebooks: Read shows the cells, and NotebookEdit changes one cell at a time. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Attachment } from '../core/messages.ts';
import { imageMediaType } from './media.ts';
import type { Tool, ToolContext, ToolOutput } from './types.ts';

const MAX_NOTEBOOK_BYTES = 100 * 1024 * 1024;
const MAX_RENDERED_CHARS = 256 * 1024;
const MAX_OUTPUT_CHARS = 10_000;
const MAX_IMAGE_OUTPUTS = 8;
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

interface NotebookCell {
  id?: string;
  cell_type: string;
  source: string | string[];
  outputs?: NotebookOutput[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

interface NotebookOutput {
  output_type: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface Notebook {
  cells: NotebookCell[];
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

function joined(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join('') : (value ?? '');
}

function parseNotebook(text: string): Notebook | null {
  try {
    const parsed = JSON.parse(text) as Notebook;
    return Array.isArray(parsed?.cells) ? parsed : null;
  } catch {
    return null;
  }
}

/** Older notebooks have no cell ids, so a position works too: `cell-0` is the first cell. */
function cellIdOf(cell: NotebookCell, index: number): string {
  return cell.id ?? `cell-${index}`;
}

function renderOutput(output: NotebookOutput, attachments: Attachment[]): string {
  if (output.output_type === 'error') return `${output.ename}: ${output.evalue}`;
  if (output.output_type === 'stream') return joined(output.text);
  for (const type of IMAGE_MIME_TYPES) {
    const data = output.data?.[type];
    if (data === undefined) continue;
    const encoded = joined(data).replace(/\s+/g, '');
    if (attachments.length < MAX_IMAGE_OUTPUTS && imageMediaType(Buffer.from(encoded, 'base64')) === type) {
      attachments.push({ kind: 'image', mediaType: type, data: encoded });
      return `[image output ${attachments.length} attached]`;
    }
    return `[${type} output not shown]`;
  }
  return joined(output.data?.['text/plain']);
}

export async function readNotebook(path: string, size: number, ctx: ToolContext): Promise<ToolOutput> {
  if (size > MAX_NOTEBOOK_BYTES) return { content: `${path} is too large to read. Extract a slice of its cells with a shell command.`, isError: true };
  const buffer = await readFile(path);
  const notebook = parseNotebook(buffer.toString('utf8'));
  if (!notebook) return { content: `${path} is not a valid notebook.`, isError: true };
  const attachments: Attachment[] = [];
  const parts = notebook.cells.map((cell, index) => {
    const outputs = (cell.outputs ?? []).map((output) => renderOutput(output, attachments).slice(0, MAX_OUTPUT_CHARS)).filter(Boolean);
    const shownOutputs = outputs.length > 0 ? `\n<outputs>\n${outputs.join('\n')}\n</outputs>` : '';
    return `<cell id="${cellIdOf(cell, index)}" type="${cell.cell_type}">\n${joined(cell.source)}${shownOutputs}\n</cell>`;
  });
  const body = parts.join('\n');
  if (body.length > MAX_RENDERED_CHARS) {
    return { content: `${path} comes to ${body.length} characters across its cells, over the limit of ${MAX_RENDERED_CHARS}. Extract a slice of its cells with a shell command.`, isError: true };
  }
  ctx.files.record(path, buffer);
  return {
    content: body || `${path} has no cells.`,
    display: `${notebook.cells.length} cells`,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function resolveNotebookPath(input: Record<string, unknown>, ctx: ToolContext): string {
  const given = input.notebook_path as string;
  if (given === '~' || given.startsWith('~/')) return join(homedir(), given.slice(2));
  return resolve(ctx.cwd(), given);
}

/** Jupyter stores source as a list of lines that keep their line endings. */
function sourceLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function newCell(type: 'code' | 'markdown', source: string, notebook: Notebook): NotebookCell {
  const hasIds = (notebook.nbformat ?? 0) > 4 || ((notebook.nbformat ?? 0) === 4 && (notebook.nbformat_minor ?? 0) >= 5);
  return {
    ...(hasIds ? { id: randomBytes(4).toString('hex') } : {}),
    cell_type: type,
    metadata: {},
    source: sourceLines(source),
    ...(type === 'code' ? { outputs: [], execution_count: null } : {}),
  };
}

export const notebookEditTool: Tool = {
  name: 'NotebookEdit',
  description: `Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).

Usage:
- You must use the Read tool on the notebook in this conversation before editing — this tool will fail otherwise.
- \`notebook_path\` must be an absolute path.
- \`cell_id\` is the \`id\` attribute shown in the Read tool's \`<cell id="...">\` output. It is required for \`replace\` and \`delete\`.
- \`edit_mode\` defaults to \`replace\`. Use \`insert\` to add a new cell after the cell with the given \`cell_id\` (or at the beginning of the notebook if \`cell_id\` is omitted) — \`cell_type\` is required when inserting. Use \`delete\` to remove the cell.`,
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { description: 'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)', type: 'string' },
      cell_id: {
        description: 'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
        type: 'string',
      },
      new_source: { description: 'The new source for the cell', type: 'string' },
      cell_type: {
        description: 'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
        type: 'string',
        enum: ['code', 'markdown'],
      },
      edit_mode: { description: 'The type of edit to make (replace, insert, delete). Defaults to replace.', type: 'string', enum: ['replace', 'insert', 'delete'] },
    },
    required: ['notebook_path', 'new_source'],
    additionalProperties: false,
  },
  isReadOnly: () => false,
  access: (input, ctx) => ({ kind: 'edit', paths: [resolveNotebookPath(input, ctx)] }),
  async execute(input, ctx) {
    const path = resolveNotebookPath(input, ctx);
    let current: Buffer;
    try {
      current = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { content: `File does not exist: ${path}`, isError: true };
      throw error;
    }
    const status = ctx.files.status(path, current);
    if (status === 'unread') return { content: `${path} has not been read yet. Read it first, then retry.`, isError: true };
    if (status === 'stale') return { content: `${path} changed on disk since it was last read. Read it again, then retry.`, isError: true };
    const notebook = parseNotebook(current.toString('utf8'));
    if (!notebook) return { content: `${path} is not a valid notebook.`, isError: true };

    const mode = (input.edit_mode as string | undefined) ?? 'replace';
    const cellId = input.cell_id as string | undefined;
    const source = input.new_source as string;
    const type = input.cell_type as 'code' | 'markdown' | undefined;
    const index = cellId === undefined ? -1 : notebook.cells.findIndex((cell, i) => cellIdOf(cell, i) === cellId);
    if (cellId !== undefined && index === -1) return { content: `No cell with id ${cellId} in ${path}.`, isError: true };
    if (mode !== 'insert' && index === -1) return { content: `edit_mode ${mode} needs a cell_id.`, isError: true };

    let summary: string;
    if (mode === 'insert') {
      if (!type) return { content: 'edit_mode insert needs cell_type to be code or markdown.', isError: true };
      notebook.cells.splice(index + 1, 0, newCell(type, source, notebook));
      summary = 'Inserted a cell';
    } else if (mode === 'delete') {
      notebook.cells.splice(index, 1);
      summary = `Deleted cell ${cellId}`;
    } else {
      const cell = notebook.cells[index]!;
      cell.source = sourceLines(source);
      if (type) cell.cell_type = type;
      // Outputs from the old source would now be misleading.
      if (cell.cell_type === 'code') {
        cell.outputs = [];
        cell.execution_count = null;
      } else {
        delete cell.outputs;
        delete cell.execution_count;
      }
      summary = `Replaced cell ${cellId}`;
    }
    await ctx.checkpoints?.snapshot(path);
    const updated = `${JSON.stringify(notebook, null, 1)}\n`;
    await writeFile(path, updated);
    ctx.files.record(path, updated);
    return { content: `${summary} in ${path}.`, display: summary.toLowerCase() };
  },
};
