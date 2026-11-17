/** The user's own status line command. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { loadSettings } from '../src/config/settings.ts';
import { keepColors, StatusCommand } from '../src/ui/status-command.ts';

const until = async (check: () => boolean, ms = 3_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('the status line command', () => {
  it('gets the session as JSON on stdin and shows what it prints, padded and at most three lines', async () => {
    let updates = 0;
    let model = 'model-a';
    const command = new StatusCommand(
      { type: 'command', command: `read -r line; printf '%s\\nsecond\\nthird\\nfourth\\n' "$(printf '%s' "$line" | sed 's/.*"id":"\\([^"]*\\)".*/\\1/')"`, padding: 2 },
      { input: () => ({ model: { id: model } }), cwd: () => tmpdir(), onUpdate: () => updates++ },
    );
    command.start();
    await until(() => command.lines().length > 0);
    assert.deepEqual(command.lines(), ['  model-a', '  second', '  third']);
    model = 'model-b';
    command.refresh();
    await until(() => command.lines()[0] === '  model-b');
    assert.equal(updates, 2);
    command.stop();
  });

  it('keeps the last output when the command fails, and runs one at a time', async () => {
    const dir = realpathSync(mkdtempSync(`${tmpdir()}/karst-status-`));
    const command = new StatusCommand(
      { type: 'command', command: `cat > /dev/null; if [ -e fail ]; then exit 1; fi; sleep 0.2; echo ok; echo run >> runs` },
      { input: () => ({}), cwd: () => dir, onUpdate: () => {} },
    );
    command.start();
    for (let i = 0; i < 5; i++) command.refresh();
    await until(() => command.lines()[0] === 'ok');
    await new Promise((resolve) => setTimeout(resolve, 900));
    const runs = readFileSync(`${dir}/runs`, 'utf8').trim().split('\n').length;
    assert.ok(runs <= 2, `refreshes while one runs make at most one more run, not ${runs}`);
    writeFileSync(`${dir}/fail`, '');
    command.refresh();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(command.lines(), ['ok']);
    command.stop();
  });

  it('keeps colors but drops other escape sequences', () => {
    assert.equal(keepColors('\x1b[31mred\x1b[0m \x1b]0;title\x07\x1b[2Jdone\x07'), '\x1b[31mred\x1b[0m done');
  });

  it('is read from settings, and a project needs trust for it', () => {
    const dir = realpathSync(mkdtempSync(`${tmpdir()}/karst-status-settings-`));
    const settingsArg = JSON.stringify({ statusLine: { type: 'command', command: 'echo hi' } });
    assert.equal(loadSettings({ cwd: dir, trusted: true, settingsArg }).statusLine?.command, 'echo hi');
    const bad = loadSettings({ cwd: dir, trusted: true, settingsArg: JSON.stringify({ statusLine: { command: 'echo hi' } }) });
    assert.equal(bad.statusLine, undefined);
    assert.match(bad.warnings.join('\n'), /statusLine needs/);
    mkdirSync(join(dir, '.karst'));
    writeFileSync(join(dir, '.karst/settings.json'), settingsArg);
    const untrusted = loadSettings({ cwd: dir, trusted: false });
    assert.equal(untrusted.statusLine, undefined, "an untrusted project's command does not run");
    assert.equal(untrusted.needsTrust, true);
    assert.equal(loadSettings({ cwd: dir, trusted: true }).statusLine?.command, 'echo hi');
  });
});
