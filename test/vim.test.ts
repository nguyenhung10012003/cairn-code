/** Vim keys at the prompt. */
import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { LineEditor } from '../src/ui/editor.ts';
import { VimMode } from '../src/ui/vim.ts';

/** Types `keys` as vim would get them: `<Esc>` and `<CR>` are those keys, anything else one character each. */
function session(text: string, cursor = 0): { editor: LineEditor; vim: VimMode; type: (keys: string) => string[] } {
  const editor = new LineEditor();
  editor.set(text, cursor);
  const vim = new VimMode();
  vim.mode = 'normal';
  const type = (keys: string): string[] => {
    const outcomes: string[] = [];
    for (const token of keys.match(/<Esc>|<CR>|<BS>|./gsu) ?? []) {
      const key = token === '<Esc>' ? { name: 'escape' } : token === '<CR>' ? { name: 'return' } : token === '<BS>' ? { name: 'backspace' } : { name: token.toLowerCase(), sequence: token };
      const text = token.startsWith('<') && token.length > 1 ? undefined : token;
      const outcome = vim.handle(text, key, editor);
      // What the footer does with keys vim passes on in insert mode: it types them.
      if (outcome === 'pass' && vim.mode === 'insert' && text) editor.insert(text);
      outcomes.push(outcome);
    }
    return outcomes;
  };
  return { editor, vim, type };
}

describe('vim mode', () => {
  it('moves by characters, words and line ends, with counts', () => {
    const { editor, type } = session('one two-three  four');
    type('w');
    assert.equal(editor.cursor, 4);
    type('w');
    assert.equal(editor.cursor, 7, 'punctuation is a word of its own');
    type('B');
    assert.equal(editor.cursor, 4);
    type('W');
    assert.equal(editor.cursor, 15);
    type('B2W');
    assert.equal(editor.cursor, 18, 'past the last word, the cursor stays on the last character');
    type('$');
    assert.equal(editor.cursor, 18);
    type('0e');
    assert.equal(editor.cursor, 2);
    type('3l');
    assert.equal(editor.cursor, 5);
    type('^');
    assert.equal(editor.cursor, 0);
    type('fo');
    assert.equal(editor.cursor, 6, 'f finds the next o on the line');
    type(';');
    assert.equal(editor.cursor, 16);
    type(',');
    assert.equal(editor.cursor, 6);
    type('tr');
    assert.equal(editor.cursor, 9, 't stops before the character');
    type('d2fe');
    assert.equal(editor.text, 'one two-t  four', 'd with f takes the character found, here the second e');
  });

  it('deletes, changes and yanks with motions, and puts the text back', () => {
    const { editor, vim, type } = session('alpha beta gamma');
    type('dw');
    assert.equal(editor.text, 'beta gamma');
    type('cwBETA<Esc>');
    assert.equal(editor.text, 'BETA gamma', 'cw changes to the end of the word, keeping the space');
    assert.equal(vim.mode, 'normal');
    type('0yeP');
    assert.equal(editor.text, 'BETABETA gamma');
    type('$x');
    assert.equal(editor.text, 'BETABETA gamm');
    type('0D');
    assert.equal(editor.text, '');
    type('p');
    assert.equal(editor.text, 'BETABETA gamm', 'D put what it deleted in the register');
    type('u');
    assert.equal(editor.text, '');
    type('u');
    assert.equal(editor.text, 'BETABETA gamm');
  });

  it('works on whole lines with dd, yy, p, o and J', () => {
    const { editor, type } = session('first\nsecond\nthird');
    type('jdd');
    assert.equal(editor.text, 'first\nthird');
    type('p');
    assert.equal(editor.text, 'first\nthird\nsecond', 'a line put goes below the cursor line');
    type('ggyyP');
    assert.equal(editor.text, 'first\nfirst\nthird\nsecond');
    type('Gonew<Esc>');
    assert.equal(editor.text, 'first\nfirst\nthird\nsecond\nnew');
    type('ggJ');
    assert.equal(editor.text, 'first first\nthird\nsecond\nnew');
    type('2dd');
    assert.equal(editor.text, 'second\nnew');
    type('dG');
    assert.equal(editor.text, '');
  });

  it('enters insert mode in the places vim does, and steps back onto the last character on Esc', () => {
    const { editor, vim, type } = session('middle', 3);
    type('ia<Esc>');
    assert.equal(editor.text, 'midadle');
    assert.equal(editor.cursor, 3);
    type('Az<Esc>');
    assert.equal(editor.text, 'midadlez');
    type('I>');
    assert.equal(editor.text, '>midadlez');
    assert.equal(vim.mode, 'insert');
    type('<Esc>u');
    assert.equal(editor.text, 'midadlez', 'one insert is one change to undo');
  });

  it('replaces and toggles case, and gives up a pending command on Esc', () => {
    const { editor, type } = session('abc');
    type('rX');
    assert.equal(editor.text, 'Xbc');
    type('2~');
    assert.equal(editor.text, 'xBc');
    type('d<Esc>w');
    assert.equal(editor.text, 'xBc', 'Esc dropped the d, so w only moved');
  });

  it('sends with Enter, leaves Esc in normal mode and Ctrl keys to the prompt, and swallows other keys', () => {
    const { vim, editor, type } = session('text');
    assert.deepEqual(type('<CR>'), ['submit']);
    assert.deepEqual(type('<Esc>'), ['pass'], 'Esc in normal mode does what it does without vim');
    assert.equal(vim.handle(undefined, { name: 'c', ctrl: true }, editor), 'pass');
    assert.equal(vim.handle(undefined, { name: 'up' }, editor), 'pass');
    assert.deepEqual(type('Q'), ['handled']);
    assert.equal(editor.text, 'text');
    vim.reset();
    assert.equal(vim.mode, 'insert');
    assert.equal(vim.handle('\r', { name: 'return' }, editor), 'pass', 'in insert mode Enter is handled by the prompt');
  });

  it('goes through earlier messages with j and k on a single line', () => {
    const editor = new LineEditor();
    editor.setText('older');
    editor.take();
    editor.setText('draft');
    const vim = new VimMode();
    vim.mode = 'normal';
    vim.handle('k', { name: 'k', sequence: 'k' }, editor);
    assert.equal(editor.text, 'older');
    vim.handle('j', { name: 'j', sequence: 'j' }, editor);
    assert.equal(editor.text, 'draft');
  });
});
