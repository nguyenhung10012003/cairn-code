/** Language servers, and the errors the model sees after Edit and Write. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import { createRuntime } from '../src/core/runtime.ts';
import { LspManager, lspServers } from '../src/lsp/manager.ts';
import type { LspServerConfig } from '../src/lsp/manager.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { Prompter } from '../src/tools/types.ts';

const FAKE = resolve(import.meta.dirname, 'fixtures/fake-lsp.ts');
const prompter: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'karst-lsp-')));
}

const fake = (extra: Partial<LspServerConfig> = {}): LspServerConfig => ({
  name: 'fake',
  command: process.execPath,
  args: [FAKE],
  extensionToLanguage: { '.fake': 'fake' },
  ...extra,
});

describe('language servers', () => {
  it('report the errors in a file after each change, and nothing once it is fixed', async () => {
    const dir = tempDir();
    const log = join(dir, 'log');
    const manager = new LspManager({ rootDir: dir, servers: [fake({ env: { FAKE_LSP_LOG: log } })] });
    const path = join(dir, 'a.fake');
    const first = await manager.report(path, 'fine\nthis is BAD\nMEH\n');
    assert.match(first!.note, /<diagnostics file="a\.fake">/);
    assert.match(first!.note, /2:9 fake F1: BAD is not allowed/);
    assert.doesNotMatch(first!.note, /meh/, 'warnings are left out');
    assert.equal(first!.errors, 1);
    assert.equal(await manager.report(path, 'fine\n'), null);
    assert.equal(await manager.report(join(dir, 'b.txt'), 'BAD'), null, 'no server covers .txt');
    await manager.close();
    const methods = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(methods.slice(0, 3), ['initialize', 'initialized', 'textDocument/didOpen']);
    assert.ok(methods.includes('textDocument/didChange'), 'the second change is a change, not another open');
    assert.ok(methods.includes('shutdown') && methods.includes('exit'));
  });

  it('turn a server off for the session when it cannot start, and say so once', async () => {
    const warnings: string[] = [];
    const manager = new LspManager({ rootDir: tempDir(), servers: [fake({ command: '/no/such/server' })], onWarning: (text) => warnings.push(text) });
    assert.equal(await manager.report('/x/a.fake', 'BAD'), null);
    assert.equal(await manager.report('/x/a.fake', 'BAD'), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /fake language server is off for this session/);
  });

  it('come from settings, the built-in TypeScript one, and servers on the PATH, any of which settings can turn off', () => {
    const bin = tempDir();
    writeFileSync(join(bin, 'gopls'), '');
    const env = { PATH: bin };
    const names = (settings: Parameters<typeof lspServers>[0]) => lspServers(settings, env).servers.map((server) => server.name);
    assert.deepEqual(names(undefined), ['typescript', 'gopls']);
    assert.deepEqual(names({ servers: { gopls: false } }), ['typescript']);
    assert.deepEqual(names({ servers: { vue: { command: 'vue-language-server', args: ['--stdio'], extensionToLanguage: { '.vue': 'vue' } } } }), ['vue', 'typescript', 'gopls']);
    assert.deepEqual(names({ enabled: false }), []);
    assert.match(lspServers({ servers: { broken: { command: 'x' } as never } }, env).warnings[0]!, /needs "command" and "extensionToLanguage"/);
  });

  it('show the model the errors an Edit leaves, in a trusted project only', async () => {
    for (const trust of [true, false]) {
      const dir = tempDir();
      const file = join(dir, 'a.fake');
      writeFileSync(file, 'good\n');
      const provider = new ScriptedProvider([
        { toolCalls: [{ name: 'Read', input: { file_path: file } }] },
        { toolCalls: [{ name: 'Edit', input: { file_path: file, old_string: 'good', new_string: 'BAD' } }] },
        { text: 'done' },
      ]);
      const settingsArg = JSON.stringify({ lsp: { servers: { fake: { command: process.execPath, args: [FAKE], extensionToLanguage: { '.fake': 'fake' } } } } });
      const runtime = await createRuntime({ cwd: dir, prompter, provider, mode: 'bypassPermissions', settingsArg, trust });
      for await (const _ of runtime.agent.run('edit', new AbortController().signal)) {
        // drain
      }
      const result = JSON.stringify(provider.requests[2]!.messages.at(-1));
      if (trust) assert.match(result, /BAD is not allowed/);
      else assert.doesNotMatch(result, /diagnostics/, 'no language server runs in an untrusted directory');
      await runtime.shutdown();
    }
  });

  it('check TypeScript with the server Karst ships, using the project\'s own TypeScript', async () => {
    const dir = tempDir();
    const typescript = resolve(import.meta.dirname, '../node_modules/typescript');
    if (!existsSync(typescript)) return;
    const { symlinkSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(typescript, join(dir, 'node_modules/typescript'));
    const manager = new LspManager({ rootDir: dir, servers: lspServers(undefined, { PATH: '' }).servers });
    const report = await manager.report(join(dir, 'a.ts'), "const n: number = 'text';\nexport {};\n");
    assert.match(report?.note ?? 'no report', /2322: Type 'string' is not assignable to type 'number'/);
    await manager.close();
  }, 60_000);
});
