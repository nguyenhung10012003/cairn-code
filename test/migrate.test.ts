import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import { loadSettings } from '../src/config/settings.ts';
import { loadInstructions } from '../src/core/instructions.ts';
import { expandPluginVars, readPlugin } from '../src/plugins/plugins.ts';
const CLI = resolve(import.meta.dirname, '../src/cli.ts');

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

/** Runs the CLI with `home` as the user's home folder, and neither KARST_HOME nor CAIRN_HOME set unless given. */
function run(args: string[], home: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...options.env };
  if (!options.env || !('KARST_HOME' in options.env)) delete env.KARST_HOME;
  if (!options.env || !('CAIRN_HOME' in options.env)) delete env.CAIRN_HOME;
  delete env.KARST_SCRIPT;
  return spawnSync(process.execPath, [CLI, ...args], { cwd: options.cwd ?? home, env, encoding: 'utf8', input: '', timeout: 30_000 });
}

/** What cairn-code 0.1.x left in ~/.cairn, plus one file of someone else's. */
function legacyHome(home: string): void {
  write(home, '.cairn/settings.json', '{"model":"claude-opus-5-5"}');
  write(home, '.cairn/credentials.json', '{"anthropic":{"key":"sk-test"}}');
  write(home, '.cairn/trust.json', '{"trusted":["/somewhere"]}');
  write(home, '.cairn/projects/-tmp-a/s1.jsonl', '{}\n');
  write(home, '.cairn/memory/-tmp-a/note.md', 'remember');
  write(home, '.cairn/CAIRN.md', 'Be brief.');
  write(home, '.cairn/update.lock', '{}');
  write(home, '.cairn/other-program.db', 'not ours');
}

describe('karst migrate', () => {
  it('moves what Cairn wrote, renames CAIRN.md, and leaves the rest', () => {
    const home = tempDir('karst-migrate-');
    legacyHome(home);
    const result = run(['migrate'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(home, '.karst/credentials.json'), 'utf8'), '{"anthropic":{"key":"sk-test"}}');
    assert.equal(readFileSync(join(home, '.karst/KARST.md'), 'utf8'), 'Be brief.');
    assert.ok(existsSync(join(home, '.karst/projects/-tmp-a/s1.jsonl')));
    assert.ok(existsSync(join(home, '.karst/memory/-tmp-a/note.md')));
    assert.ok(!existsSync(join(home, '.karst/CAIRN.md')));
    assert.ok(!existsSync(join(home, '.karst/update.lock')));
    // Not Cairn's, so it stays, and so does the folder holding it.
    assert.ok(existsSync(join(home, '.cairn/other-program.db')));
    assert.ok(!existsSync(join(home, '.cairn/credentials.json')));
    assert.match(result.stdout, /Moved from ~\/\.cairn to ~\/\.karst:/);
    assert.match(result.stdout, /CAIRN\.md \(as KARST\.md\)/);
    assert.match(result.stdout, /because Cairn did not write them[^\n]*\n  other-program\.db/);
  });

  it('merges into a home Karst already made, without replacing anything in it', () => {
    const home = tempDir('karst-migrate-');
    legacyHome(home);
    write(home, '.karst/trust.json', '{"trusted":["/new"]}');
    write(home, '.karst/projects/-tmp-b/s2.jsonl', '{}\n');
    write(home, '.cairn/projects/-tmp-b/s2.jsonl', 'older');
    const result = run(['migrate'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(home, '.karst/trust.json'), 'utf8'), '{"trusted":["/new"]}');
    assert.equal(readFileSync(join(home, '.karst/projects/-tmp-b/s2.jsonl'), 'utf8'), '{}\n');
    assert.ok(existsSync(join(home, '.karst/projects/-tmp-a/s1.jsonl')));
    assert.ok(existsSync(join(home, '.cairn/trust.json')));
    assert.match(result.stdout, /already has them:\n  projects\/-tmp-b\/s2\.jsonl\n  trust\.json/);
  });

  it('removes ~/.cairn once everything in it has moved', () => {
    const home = tempDir('karst-migrate-');
    write(home, '.cairn/settings.json', '{}');
    write(home, '.cairn/plans/p.md', 'plan');
    const result = run(['migrate'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(join(home, '.cairn')));
    assert.match(result.stdout, /is now empty and was removed/);
  });

  it('changes nothing with --dry-run', () => {
    const home = tempDir('karst-migrate-');
    legacyHome(home);
    const result = run(['migrate', '--dry-run'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Would move from ~\/\.cairn to ~\/\.karst:\n(  .*\n)*  credentials\.json/);
    assert.ok(existsSync(join(home, '.cairn/credentials.json')));
    assert.ok(existsSync(join(home, '.cairn/update.lock')));
    assert.ok(!existsSync(join(home, '.karst')));
  });

  it('says when there is nothing to move', () => {
    const home = tempDir('karst-migrate-');
    const result = run(['migrate'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /There is no ~\/\.cairn/);
  });

  it('points out settings that still use Cairn names', () => {
    const home = tempDir('karst-migrate-');
    write(home, '.cairn/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo $CAIRN_PROJECT_DIR' }] }] } }));
    const result = run(['migrate'], home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /These mention CAIRN_ variables[^\n]*\n  ~\/\.karst\/settings\.json/);
  });

  it('refuses when KARST_HOME is ~/.cairn itself', () => {
    const home = tempDir('karst-migrate-');
    write(home, '.cairn/settings.json', '{}');
    const result = run(['migrate'], home, { env: { KARST_HOME: join(home, '.cairn') } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Cairn's own folder/);
  });
});

describe('Cairn names', () => {
  it('suggests karst migrate once, before Karst has a home of its own', () => {
    const home = tempDir('karst-hint-');
    write(home, '.cairn/settings.json', '{}');
    const first = run(['--provider', 'scripted', '-p', 'hello'], home);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /Found ~\/\.cairn, from Cairn[^\n]*karst migrate/);
    assert.ok(existsSync(join(home, '.karst')));
    const second = run(['--provider', 'scripted', '-p', 'hello'], home);
    assert.doesNotMatch(second.stderr, /Found ~\/\.cairn/);
  });

  it('does not use CAIRN_HOME', () => {
    const home = tempDir('karst-hint-');
    const elsewhere = tempDir('karst-cairnhome-');
    const result = run(['--provider', 'scripted', '-p', 'hello'], home, { env: { CAIRN_HOME: elsewhere } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(home, '.karst')));
    assert.ok(!existsSync(join(elsewhere, 'workspaces')));
  });

  it('karst doctor points out ~/.cairn and Cairn files in the project', () => {
    const home = tempDir('karst-doctor-');
    const project = tempDir('karst-doctorproject-');
    write(home, '.cairn/settings.json', '{}');
    write(project, 'CAIRN.md', 'old instructions');
    write(project, '.cairn/settings.json', '{}');
    const result = run(['doctor'], home, { cwd: project });
    assert.match(result.stdout, /From Cairn: ~\/\.cairn is not read\. If it is from cairn-code, `karst migrate`/);
    assert.match(result.stdout, /From Cairn: \.cairn, CAIRN\.md in this directory are not read\. If written for cairn-code, rename to \.karst, KARST\.md/);
  });
});

describe('Cairn files in a project', () => {
  it('reads neither CAIRN.md nor .cairn/', () => {
    process.env.KARST_HOME = tempDir('karst-cairnfiles-home-');
    const dir = tempDir('karst-cairnfiles-');
    write(dir, 'CAIRN.md', 'CAIRN INSTRUCTIONS');
    write(dir, 'CAIRN.local.md', 'CAIRN LOCAL');
    write(dir, '.cairn/CAIRN.md', 'CAIRN NESTED');
    write(dir, '.cairn/rules/style.md', 'CAIRN RULE');
    write(dir, '.cairn/settings.json', JSON.stringify({ model: 'from-cairn' }));
    const text = loadInstructions(dir, true).files.map((file) => file.content).join('\n');
    assert.doesNotMatch(text, /CAIRN (INSTRUCTIONS|LOCAL|NESTED|RULE)/);
    assert.equal(loadSettings({ cwd: dir, trusted: true }).model, undefined);
    write(dir, 'KARST.md', 'KARST INSTRUCTIONS');
    assert.match(loadInstructions(dir, true).files.map((file) => file.content).join('\n'), /KARST INSTRUCTIONS/);
  });

  it('takes no manifest from .cairn-plugin, and leaves ${CAIRN_*} alone', () => {
    const root = tempDir('karst-cairnplugin-');
    write(root, '.cairn-plugin/plugin.json', JSON.stringify({ name: 'from-cairn', version: '1', description: 'd' }));
    const { plugin } = readPlugin(root, 'flag');
    assert.ok(plugin);
    assert.notEqual(plugin.name, 'from-cairn');
    assert.equal(expandPluginVars('${CAIRN_PLUGIN_ROOT}|${KARST_PLUGIN_ROOT}', plugin, root), `\${CAIRN_PLUGIN_ROOT}|${plugin.root}`);
  });
});
