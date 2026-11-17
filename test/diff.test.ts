/** The diff shown when Edit or Write asks for approval. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { diffLines, editDiffPreview, hunks } from '../src/ui/diff.ts';
import type { DiffLine } from '../src/ui/diff.ts';
import { sanitize } from '../src/ui/render.ts';

function rebuild(lines: DiffLine[]): { before: string[]; after: string[] } {
  return {
    before: lines.filter((line) => line.kind !== 'added').map((line) => line.text),
    after: lines.filter((line) => line.kind !== 'removed').map((line) => line.text),
  };
}

/** A fixed sequence, so a failure can be repeated. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

describe('the approval diff', () => {
  it('keeps every line of both texts, in order, with their numbers', () => {
    const next = random(7);
    for (let round = 0; round < 300; round++) {
      const words = ['a', 'b', 'c', 'd'];
      const text = (length: number): string[] => Array.from({ length }, () => words[Math.floor(next() * words.length)]!);
      const before = text(Math.floor(next() * 12));
      const after = text(Math.floor(next() * 12));
      const lines = diffLines(before, after)!;
      assert.deepEqual(rebuild(lines), { before, after }, `${before} -> ${after}`);
      const oldNumbers = lines.flatMap((line) => (line.kind === 'added' ? [] : [line.oldNumber]));
      const newNumbers = lines.flatMap((line) => (line.kind === 'removed' ? [] : [line.newNumber]));
      assert.deepEqual(oldNumbers, before.map((_, i) => i + 1));
      assert.deepEqual(newNumbers, after.map((_, i) => i + 1));
    }
  });

  it('finds the smallest change', () => {
    const lines = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])!;
    assert.deepEqual(
      lines.map((line) => `${line.kind[0]}${line.text}`),
      ['sa', 'rb', 'ax', 'sc', 'sd', 'ae'],
    );
  });

  it('gives up past its limit, so a huge rewrite does not stall the prompt', () => {
    const before = Array.from({ length: 50 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 50 }, (_, i) => `new ${i}`);
    assert.equal(diffLines(before, after, 20), null);
    assert.notEqual(diffLines(before, after), null);
  });

  it('shows three lines around each change, and splits changes far apart', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[2] = 'changed 3';
    after[25] = 'changed 26';
    const groups = hunks(diffLines(before, after)!);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups[0]!.map((line) => line.text),
      ['line 1', 'line 2', 'line 3', 'changed 3', 'line 4', 'line 5', 'line 6'],
    );
    assert.equal(groups[1]![0]!.text, 'line 23');
  });

  it('shows an Edit in its place in the file, with line numbers', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-diff-')));
    const path = join(dir, 'a.ts');
    writeFileSync(path, Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n');
    const preview = (await editDiffPreview('Edit', { file_path: path, old_string: 'const v10 = 10;', new_string: 'const v10 = 100;\nconst extra = 0;' }, path))!.map(sanitize);
    assert.deepEqual(preview, [
      `  ${path}`,
      '   7   const v7 = 7;',
      '   8   const v8 = 8;',
      '   9   const v9 = 9;',
      '  10 - const v10 = 10;',
      '  10 + const v10 = 100;',
      '  11 + const extra = 0;',
      '  12   const v11 = 11;',
      '  13   const v12 = 12;',
      '  14   const v13 = 13;',
    ]);
  });

  it('shows a Write as a diff against the file it replaces, or as a new file', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-diff-')));
    const path = join(dir, 'b.txt');
    const fresh = (await editDiffPreview('Write', { file_path: path, content: 'one\ntwo\n' }, path))!.map(sanitize);
    assert.deepEqual(fresh, [`  ${path} (new file)`, '  1 + one', '  2 + two']);
    writeFileSync(path, 'one\ntwo\n');
    const replaced = (await editDiffPreview('Write', { file_path: path, content: 'one\n2\n' }, path))!.map(sanitize);
    assert.deepEqual(replaced, [`  ${path}`, '  1   one', '  2 - two', '  2 + 2']);
  });

  it('leaves the plain preview to the caller when the edit would fail or the file is binary', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'karst-diff-')));
    const path = join(dir, 'c.txt');
    writeFileSync(path, 'same\nsame\n');
    assert.equal(await editDiffPreview('Edit', { file_path: path, old_string: 'missing', new_string: 'x' }, path), undefined);
    assert.equal(await editDiffPreview('Edit', { file_path: path, old_string: 'same', new_string: 'x' }, path), undefined, 'not unique');
    assert.notEqual(await editDiffPreview('Edit', { file_path: path, old_string: 'same', new_string: 'x', replace_all: true }, path), undefined);
    writeFileSync(path, Buffer.from([0, 1, 2]));
    assert.equal(await editDiffPreview('Write', { file_path: path, content: 'text' }, path), undefined);
    assert.equal(await editDiffPreview('Bash', { command: 'ls' }, path), undefined);
  });
});
