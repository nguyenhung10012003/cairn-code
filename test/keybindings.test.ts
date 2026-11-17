/** The user's keyboard shortcuts. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { Keybindings, keystrokeOf, parseKeybindings, parseKeystroke } from '../src/ui/keybindings.ts';

describe('keybindings', () => {
  it('read keys in any order of modifiers, and the same way as they arrive', () => {
    assert.equal(parseKeystroke('Shift+Ctrl+A'), 'ctrl+shift+a');
    assert.equal(parseKeystroke('alt+p'), 'meta+p');
    assert.equal(parseKeystroke('enter'), 'return');
    assert.equal(parseKeystroke('ctrl+hyper'), null);
    assert.equal(parseKeystroke('super+a'), null);
    assert.equal(keystrokeOf('\x07', { name: 'g', ctrl: true }), 'ctrl+g');
    assert.equal(keystrokeOf(undefined, { name: 'tab', shift: true }), 'shift+tab');
    assert.equal(keystrokeOf('\r', { name: 'enter' }), 'return');
  });

  it('take the Global and Chat contexts, null to unbind, and warn about the rest', () => {
    const loaded = parseKeybindings(
      JSON.stringify({
        bindings: [
          { context: 'Chat', bindings: { 'ctrl+g': 'chat:submit', 'ctrl+s': null, 'meta+k': 'command:compact', 'ctrl+x ctrl+e': 'chat:externalEditor', 'ctrl+q': 'chat:fly' } },
          { context: 'Global', bindings: { f5: 'app:redraw' } },
          { context: 'Transcript', bindings: { j: 'transcript:down' } },
        ],
      }),
    );
    assert.deepEqual([...loaded.bindings], [['ctrl+g', 'chat:submit'], ['ctrl+s', null], ['meta+k', 'command:compact'], ['f5', 'app:redraw']]);
    assert.equal(loaded.warnings.length, 3);
    assert.match(loaded.warnings.join('\n'), /sequence of keys/);
    assert.match(loaded.warnings.join('\n'), /chat:fly/);
    assert.match(loaded.warnings.join('\n'), /"Transcript" context/);
    assert.match(parseKeybindings('{').warnings[0]!, /not valid JSON/);
  });

  it('are read again when the file changes', async () => {
    const path = join(realpathSync(mkdtempSync(join(tmpdir(), 'karst-keys-'))), 'keybindings.json');
    const bindings = new Keybindings(path);
    assert.equal(bindings.lookup('ctrl+g'), undefined, 'no file: every key does what it does by default');
    writeFileSync(path, JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+g': 'chat:submit' } }] }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    assert.equal(bindings.lookup('ctrl+g'), 'chat:submit');
  });
});

describe('keybindings at the prompt', () => {
  it('run before the built-in keys: a bound key acts, an unbound one does nothing', async () => {
    const { Footer } = await import('../src/ui/footer.ts');
    const path = join(realpathSync(mkdtempSync(join(tmpdir(), 'karst-keys-'))), 'keybindings.json');
    writeFileSync(path, JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+g': 'chat:submit', 'ctrl+u': null, 'meta+k': 'command:compact', 'ctrl+j': 'chat:newline' } }] }));
    const sent: string[] = [];
    const footer = new Footer({
      prompt: () => '> ',
      status: () => '',
      above: () => [],
      commands: () => [],
      onSubmit: (text) => sent.push(text),
      onEscape: () => {},
      onInterrupt: () => {},
      onEof: () => {},
      onShiftTab: () => {},
    });
    footer.keybindings = new Keybindings(path);
    const press = (text: string | undefined, key: Record<string, unknown>): void => (footer as unknown as { onKey: (t?: string, k?: object) => void }).onKey(text, key);
    press('a', { name: 'a', sequence: 'a' });
    press(undefined, { name: 'j', ctrl: true });
    press('b', { name: 'b', sequence: 'b' });
    press(undefined, { name: 'u', ctrl: true });
    assert.equal(footer.editor.text, 'a\nb', 'ctrl+j made a new line, and ctrl+u, unbound, did not clear it');
    press(undefined, { name: 'k', meta: true });
    assert.deepEqual(sent, ['/compact']);
    assert.equal(footer.editor.text, 'a\nb', 'the draft stays when a bound command runs');
    press(undefined, { name: 'g', ctrl: true });
    assert.deepEqual(sent, ['/compact', 'a\nb']);
    assert.equal(footer.editor.text, '');
  });
});
