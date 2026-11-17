/** Themes and /theme. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'bun:test';
import { runSlashCommand } from '../src/commands/slash.ts';
import { createRuntime } from '../src/core/runtime.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { Prompter } from '../src/tools/types.ts';
import { currentTheme, setTheme, style } from '../src/ui/theme.ts';

const prompter: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };

describe('themes', () => {
  afterEach(() => {
    setTheme('default');
  });

  it('switch every color in place, and refuse a name they do not know', () => {
    const before = style.error;
    assert.equal(setTheme('colorblind'), true);
    assert.equal(currentTheme(), 'colorblind');
    assert.notEqual(style.error, before, 'style.error is a new function');
    assert.equal(setTheme('neon'), false);
    assert.equal(currentTheme(), 'colorblind');
  });

  it('/theme lists them, and changes and saves one', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'karst-theme-home-')));
    process.env.KARST_HOME = home;
    const runtime = await createRuntime({ cwd: realpathSync(mkdtempSync(join(tmpdir(), 'karst-theme-'))), prompter, provider: new ScriptedProvider([]) });
    const noChoice = { choose: async () => null };
    assert.match((await runSlashCommand('/theme', runtime, noChoice)).output!, /Theme: default\. Themes: default, dark, light, colorblind, ansi/);
    assert.match((await runSlashCommand('/theme neon', runtime, noChoice)).output!, /Unknown theme/);
    assert.match((await runSlashCommand('/theme light', runtime, noChoice)).output!, /Theme: light, saved in/);
    assert.equal(currentTheme(), 'light');
    assert.equal((JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { theme: string }).theme, 'light');
    await runtime.shutdown();
  });
});
