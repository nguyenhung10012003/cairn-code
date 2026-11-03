/**
 * The installed `cairn` is the compiled binary, not `bun src/cli.ts`, because plain Bun reads
 * `.env` and `bunfig.toml` from the working directory. A repository could use those to send the
 * API key elsewhere or to run code at startup, before any trust check.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, it } from 'bun:test';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(import.meta.dirname, 'fixtures/mcp-test-server.ts');

function workspace(): { dir: string; home: string } {
  return {
    dir: realpathSync(mkdtempSync(join(tmpdir(), 'cairn-build-'))),
    home: realpathSync(mkdtempSync(join(tmpdir(), 'cairn-buildhome-'))),
  };
}

describe('the compiled binary', () => {
  let binary: string;

  beforeAll(() => {
    // Uses the real build script, so removing one of its flags fails this test.
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: { build: string } };
    binary = join(realpathSync(mkdtempSync(join(tmpdir(), 'cairn-bin-'))), 'cairn');
    const args = manifest.scripts.build.replace('dist/cairn', binary).split(' ').slice(1);
    const built = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
  });

  function run(args: string[], w: { dir: string; home: string }, env: NodeJS.ProcessEnv = {}) {
    const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ANTHROPIC_BASE_URL: _url, ...clean } = process.env;
    return spawnSync(binary, args, { cwd: w.dir, env: { ...clean, CAIRN_HOME: w.home, ...env }, encoding: 'utf8', input: '', timeout: 30_000 });
  }

  it('answers a prompt without Bun being involved in the working directory', () => {
    const w = workspace();
    const script = join(w.home, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'from the binary' }]));
    assert.match(run(['--version'], w).stdout, /^\d+\.\d+\.\d+\n$/);
    const result = run(['--provider', 'scripted', '-p', 'hi'], w, { CAIRN_SCRIPT: script });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'from the binary\n');
  });

  it("does not take credentials or an API address from a repository's .env", () => {
    const w = workspace();
    writeFileSync(join(w.dir, '.env'), 'ANTHROPIC_API_KEY=from-the-repo\nANTHROPIC_BASE_URL=http://127.0.0.1:1\n');
    const result = run(['-p', 'hi'], w);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set ANTHROPIC_API_KEY/);
  });

  it("does not run a repository's bunfig.toml preload", () => {
    const w = workspace();
    const marker = join(w.home, 'preload-ran');
    writeFileSync(join(w.dir, 'evil.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    writeFileSync(join(w.dir, 'bunfig.toml'), 'preload = ["./evil.ts"]\n');
    run(['--version'], w);
    assert.equal(existsSync(marker), false);
  });

  it('still loads the MCP SDK, which is imported on demand', () => {
    const w = workspace();
    const added = run(['mcp', 'add', 'fix', process.execPath, '--', FIXTURE], w);
    assert.equal(added.status, 0, added.stderr);
    const listed = run(['mcp', 'list'], w);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /fix: .* - connected \(\d+ tools\)/);
  });
});
