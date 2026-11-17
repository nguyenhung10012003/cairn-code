/**
 * Line diffs for the approval prompt of Edit and Write, so the user sees the change in its place
 * in the file, with line numbers and the lines around it, rather than only the old and new text.
 */
import { readFile, stat } from 'node:fs/promises';
import { sanitize, style } from './render.ts';

export type DiffLine =
  | { kind: 'same'; text: string; oldNumber: number; newNumber: number }
  | { kind: 'removed'; text: string; oldNumber: number }
  | { kind: 'added'; text: string; newNumber: number };

/** More than this many changed lines is shown as a whole replacement, as working it out costs too much. */
const MAX_EDIT_DISTANCE = 1_000;
/** A file larger than this is not read for a preview. */
const MAX_PREVIEW_FILE_BYTES = 2 * 1024 * 1024;
const CONTEXT_LINES = 3;
const MAX_SHOWN_LINES = 80;

/** The steps that turn `a` into `b`, by Myers' algorithm, or null past `maxEdits` changes. */
function editScript(a: readonly string[], b: readonly string[], maxEdits: number): ('=' | '-' | '+')[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // What v held after each round, over the diagonals that round could reach.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, edits: number): ('=' | '-' | '+')[] {
  const steps: ('=' | '-' | '+')[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const previous = trace[d - 1]!;
    const at = (k: number): number => previous[k + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      steps.push('=');
      x--;
      y--;
    }
    steps.push(down ? '+' : '-');
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    steps.push('=');
    x--;
    y--;
  }
  return steps.reverse();
}

/** Every line of both texts, marked as kept, removed or added, or null when too much changed. */
export function diffLines(before: readonly string[], after: readonly string[], maxEdits = MAX_EDIT_DISTANCE): DiffLine[] | null {
  // Most edits change a few lines in the middle, so the rest is matched without the algorithm.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const steps = editScript(before.slice(start, before.length - end), after.slice(start, after.length - end), maxEdits);
  if (!steps) return null;
  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  const same = (): void => {
    lines.push({ kind: 'same', text: before[oldIndex]!, oldNumber: oldIndex + 1, newNumber: newIndex + 1 });
    oldIndex++;
    newIndex++;
  };
  for (let i = 0; i < start; i++) same();
  for (const step of steps) {
    if (step === '=') same();
    else if (step === '-') lines.push({ kind: 'removed', text: before[oldIndex]!, oldNumber: ++oldIndex });
    else lines.push({ kind: 'added', text: after[newIndex]!, newNumber: ++newIndex });
  }
  for (let i = 0; i < end; i++) same();
  return lines;
}

/** The changed lines with `context` kept lines around each run of them, split where runs are far apart. */
export function hunks(lines: readonly DiffLine[], context = CONTEXT_LINES): DiffLine[][] {
  const changed = lines.map((line, i) => (line.kind === 'same' ? -1 : i)).filter((i) => i >= 0);
  const groups: DiffLine[][] = [];
  let from = -1;
  let to = -1;
  for (const i of changed) {
    if (from === -1) {
      from = Math.max(0, i - context);
    } else if (i - context > to + 1) {
      groups.push(lines.slice(from, to + 1));
      from = i - context;
    }
    to = Math.min(lines.length - 1, i + context);
  }
  if (from !== -1) groups.push(lines.slice(from, to + 1));
  return groups;
}

function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The diff drawn for the terminal: a number column, then `-`, `+` or a space, then the line. */
export function renderDiff(path: string, lines: readonly DiffLine[]): string[] {
  const groups = hunks(lines);
  const out = [style.bold(`  ${sanitize(path)}`)];
  if (groups.length === 0) return [...out, style.dim('  (no change)')];
  const widest = Math.max(...groups.flat().map((line) => (line.kind === 'removed' ? line.oldNumber : line.newNumber)));
  const width = String(widest).length;
  let shown = 0;
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  for (const [index, group] of groups.entries()) {
    if (index > 0) out.push(style.dim(`  ${' '.repeat(width)} ⋮`));
    for (const line of group) {
      if (shown === MAX_SHOWN_LINES) {
        out.push(style.dim(`  ... ${total - shown} more lines`));
        return out;
      }
      shown++;
      const number = String(line.kind === 'removed' ? line.oldNumber : line.newNumber).padStart(width);
      const text = sanitize(line.text);
      if (line.kind === 'removed') out.push(style.error(`  ${number} - ${text}`));
      else if (line.kind === 'added') out.push(style.success(`  ${number} + ${text}`));
      else out.push(style.dim(`  ${number}   ${text}`));
    }
  }
  return out;
}

async function readText(path: string): Promise<string | null | undefined> {
  try {
    if ((await stat(path)).size > MAX_PREVIEW_FILE_BYTES) return undefined;
    const bytes = await readFile(path);
    return bytes.includes(0) ? undefined : bytes.toString('utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

/**
 * The preview of an Edit or Write as a diff against the file as it is now. Undefined when there
 * is none to show, such as for a large or binary file, an edit that would fail, or a change too
 * large to work out; the caller then shows the old and new text as they are.
 */
export async function editDiffPreview(toolName: string, input: Record<string, unknown>, path: string | undefined): Promise<string[] | undefined> {
  if (!path || (toolName !== 'Edit' && toolName !== 'Write')) return undefined;
  const current = await readText(path);
  if (current === undefined) return undefined;
  let updated: string;
  if (toolName === 'Write') {
    if (typeof input.content !== 'string') return undefined;
    updated = input.content;
  } else {
    const oldString = input.old_string;
    const newString = input.new_string;
    if (current === null || typeof oldString !== 'string' || typeof newString !== 'string' || oldString === '') return undefined;
    const parts = current.split(oldString);
    if (parts.length === 1 || (parts.length > 2 && input.replace_all !== true)) return undefined;
    updated = parts.join(newString);
  }
  const lines = diffLines(toLines(current ?? ''), toLines(updated));
  if (!lines) return undefined;
  const shownPath = typeof input.file_path === 'string' ? input.file_path : path;
  return renderDiff(current === null ? `${shownPath} (new file)` : shownPath, lines);
}
