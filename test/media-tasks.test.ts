/** Reading pictures, PDFs and notebooks, and commands running in the background. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import { createRuntime } from '../src/core/runtime.ts';
import { toApiMessages } from '../src/providers/anthropic.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import { bashTool } from '../src/tools/bash.ts';
import { readTool } from '../src/tools/files.ts';
import { countPdfPages, imageMediaType, parsePageRange } from '../src/tools/media.ts';
import { notebookEditTool } from '../src/tools/notebook.ts';
import { TaskRegistry, taskStopTool } from '../src/tools/tasks.ts';
import { FileTracker } from '../src/tools/types.ts';
import type { Prompter, ToolContext } from '../src/tools/types.ts';

const CLI = resolve(import.meta.dirname, '../src/cli.ts');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

function tempDir(prefix = 'cairn-media-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const prompter: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };

function context(dir: string, tasks?: TaskRegistry): ToolContext {
  return {
    cwd: () => dir,
    setCwd: () => {},
    workingDirs: () => [dir],
    signal: new AbortController().signal,
    files: new FileTracker(),
    prompter,
    todos: { items: [] },
    tasks: tasks ?? new TaskRegistry({ logDir: join(dir, '.logs') }),
    secretEnvVars: [],
    isReadDenied: () => false,
    getMode: () => 'default',
    setMode: () => {},
  };
}

function pdfWithPages(count: number): Buffer {
  return Buffer.from(`%PDF-1.4\n${'1 0 obj <</Type /Page>> endobj\n'.repeat(count)}2 0 obj <</Type /Pages>> endobj\n%%EOF`, 'latin1');
}

const until = async (condition: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  assert.ok(condition(), 'timed out waiting');
};

describe('Read for pictures', () => {
  it('returns the image as an attachment, with its real type', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.png'), PNG);
    const output = await readTool.execute({ file_path: join(dir, 'a.png') }, context(dir));
    assert.equal(output.isError, undefined);
    assert.equal(output.attachments![0]!.kind, 'image');
    assert.equal(output.attachments![0]!.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(output.attachments![0]!.data, 'base64'), PNG);
  });

  it('goes by the content, not the name', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'really-png.jpg'), PNG);
    writeFileSync(join(dir, 'text.png'), 'not an image');
    const renamed = await readTool.execute({ file_path: join(dir, 'really-png.jpg') }, context(dir));
    assert.equal(renamed.attachments![0]!.mediaType, 'image/png');
    assert.equal((await readTool.execute({ file_path: join(dir, 'text.png') }, context(dir))).isError, true);
  });

  it('recognises each format from its first bytes', () => {
    assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(imageMediaType(Buffer.from('GIF89a')), 'image/gif');
    assert.equal(imageMediaType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'image/webp');
    assert.equal(imageMediaType(Buffer.from('hello world')), null);
  });

  it.skipIf(process.platform !== 'darwin')('shrinks an image over the limit, and says so', async () => {
    const dir = tempDir();
    const big = join(dir, 'big.png');
    // Random pixels do not compress, so this stays over the limit as a PNG.
    const made = spawnSync('python3', ['-c', `
import os, zlib, struct
w, h = 2200, 2200
raw = b''.join(b'\\x00' + os.urandom(w * 3) for _ in range(h))
def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
open(${JSON.stringify(big)}, 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 1)) + chunk(b'IEND', b''))
`]);
    assert.equal(made.status, 0, String(made.stderr));
    const output = await readTool.execute({ file_path: big }, context(dir));
    assert.equal(output.attachments![0]!.mediaType, 'image/jpeg');
    assert.match(output.content, /shrunk/);
    assert.ok(Buffer.from(output.attachments![0]!.data, 'base64').length < 4 * 1024 * 1024);
  });

  it('reaches the API as content blocks inside the tool result', () => {
    const [message] = toApiMessages([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Image', attachments: [{ kind: 'image', mediaType: 'image/png', data: 'QUJD' }] }] },
    ]) as [{ content: { content: unknown }[] }];
    assert.deepEqual(message.content[0]!.content, [
      { type: 'text', text: 'Image' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('keeps plain results as a string, so nothing changes for text', () => {
    const [message] = toApiMessages([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'plain' }] }]) as [{ content: { content: unknown }[] }];
    assert.equal(message.content[0]!.content, 'plain');
  });
});

describe('Read for PDFs', () => {
  it('attaches a short PDF whole', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.pdf'), pdfWithPages(3));
    const output = await readTool.execute({ file_path: join(dir, 'a.pdf') }, context(dir));
    assert.equal(output.attachments![0]!.kind, 'document');
    assert.equal(output.attachments![0]!.mediaType, 'application/pdf');
  });

  it('asks for a range when the PDF is long', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'long.pdf'), pdfWithPages(40));
    const output = await readTool.execute({ file_path: join(dir, 'long.pdf') }, context(dir));
    assert.equal(output.isError, true);
    assert.match(output.content, /about 40 pages/);
  });

  it('refuses a file that only calls itself a PDF', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'fake.pdf'), 'hello');
    assert.equal((await readTool.execute({ file_path: join(dir, 'fake.pdf') }, context(dir))).isError, true);
  });

  it('checks page ranges before doing any work', async () => {
    assert.deepEqual(parsePageRange('3'), { first: 3, last: 3 });
    assert.deepEqual(parsePageRange(' 1 - 5 '), { first: 1, last: 5 });
    assert.equal(parsePageRange('5-1'), null);
    assert.equal(parsePageRange('0'), null);
    assert.equal(parsePageRange('a'), null);
    const dir = tempDir();
    writeFileSync(join(dir, 'a.pdf'), pdfWithPages(40));
    assert.match((await readTool.execute({ file_path: join(dir, 'a.pdf'), pages: '1-21' }, context(dir))).content, /more than 20/);
    assert.match((await readTool.execute({ file_path: join(dir, 'a.pdf'), pages: 'x' }, context(dir))).content, /Could not read the page range/);
  });

  it.skipIf(spawnSync('/bin/sh', ['-c', 'command -v pdftoppm']).status === 0)('explains what to install when a page range cannot be rendered', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.pdf'), pdfWithPages(40));
    const output = await readTool.execute({ file_path: join(dir, 'a.pdf'), pages: '1-2' }, context(dir));
    assert.equal(output.isError, true);
    assert.match(output.content, /pdftoppm is not installed/);
  });

  it('counts pages without counting the page tree node', () => {
    assert.equal(countPdfPages(pdfWithPages(4)), 4);
    assert.equal(countPdfPages(Buffer.from('%PDF-1.7 compressed')), 0);
  });
});

describe('notebooks', () => {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3' } },
    cells: [
      { id: 'one', cell_type: 'markdown', metadata: {}, source: ['# Title\n'] },
      { id: 'two', cell_type: 'code', metadata: {}, execution_count: 3, source: ['print(1)\n', 'print(2)'], outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n2\n'] }] },
    ],
  };

  function setup(content: unknown = notebook): { path: string; ctx: ToolContext } {
    const dir = tempDir();
    const path = join(dir, 'n.ipynb');
    writeFileSync(path, JSON.stringify(content));
    return { path, ctx: context(dir) };
  }

  it('reads cells with their ids and outputs', async () => {
    const { path, ctx } = setup();
    const output = await readTool.execute({ file_path: path }, ctx);
    assert.match(output.content, /<cell id="one" type="markdown">\n# Title/);
    assert.match(output.content, /print\(2\)\n<outputs>\n1\n2/);
  });

  it('shows an image output as a picture', async () => {
    const data = PNG.toString('base64');
    const { path, ctx } = setup({ ...notebook, cells: [{ id: 'p', cell_type: 'code', source: [], outputs: [{ output_type: 'display_data', data: { 'image/png': `${data}\n` } }] }] });
    const output = await readTool.execute({ file_path: path }, ctx);
    assert.equal(output.attachments![0]!.mediaType, 'image/png');
  });

  it('refuses a broken notebook', async () => {
    const { path, ctx } = setup({ not: 'a notebook' });
    assert.equal((await readTool.execute({ file_path: path }, ctx)).isError, true);
  });

  it('needs a read first, and refuses a stale copy', async () => {
    const { path, ctx } = setup();
    assert.match((await notebookEditTool.execute({ notebook_path: path, cell_id: 'one', new_source: 'x' }, ctx)).content, /not been read/);
    await readTool.execute({ file_path: path }, ctx);
    writeFileSync(path, JSON.stringify({ ...notebook, nbformat_minor: 4 }));
    assert.match((await notebookEditTool.execute({ notebook_path: path, cell_id: 'one', new_source: 'x' }, ctx)).content, /changed on disk/);
  });

  it('replaces a code cell and clears its stale outputs', async () => {
    const { path, ctx } = setup();
    await readTool.execute({ file_path: path }, ctx);
    const output = await notebookEditTool.execute({ notebook_path: path, cell_id: 'two', new_source: 'a = 1\nb = 2' }, ctx);
    assert.equal(output.isError, undefined);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as typeof notebook;
    assert.deepEqual(saved.cells[1]!.source, ['a = 1\n', 'b = 2']);
    assert.deepEqual(saved.cells[1]!.outputs, []);
    assert.equal(saved.cells[1]!.execution_count, null);
    assert.deepEqual(saved.metadata, notebook.metadata, 'the rest of the notebook is untouched');
  });

  it('inserts after a cell, or at the start with no cell_id, and needs a type', async () => {
    const { path, ctx } = setup();
    await readTool.execute({ file_path: path }, ctx);
    assert.match((await notebookEditTool.execute({ notebook_path: path, edit_mode: 'insert', new_source: 'x' }, ctx)).content, /needs cell_type/);
    await notebookEditTool.execute({ notebook_path: path, edit_mode: 'insert', cell_id: 'one', cell_type: 'code', new_source: 'mid' }, ctx);
    await notebookEditTool.execute({ notebook_path: path, edit_mode: 'insert', cell_type: 'markdown', new_source: 'first' }, ctx);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { cells: { id: string; source: string[]; outputs?: unknown[] }[] };
    assert.deepEqual(saved.cells.map((cell) => cell.source.join('')), ['first', '# Title\n', 'mid', 'print(1)\nprint(2)']);
    assert.equal(typeof saved.cells[0]!.id, 'string');
    assert.deepEqual(saved.cells[2]!.outputs, []);
  });

  it('deletes a cell, and reports one that does not exist', async () => {
    const { path, ctx } = setup();
    await readTool.execute({ file_path: path }, ctx);
    assert.match((await notebookEditTool.execute({ notebook_path: path, cell_id: 'nope', new_source: '', edit_mode: 'delete' }, ctx)).content, /No cell/);
    await notebookEditTool.execute({ notebook_path: path, cell_id: 'one', new_source: '', edit_mode: 'delete' }, ctx);
    assert.equal((JSON.parse(readFileSync(path, 'utf8')) as typeof notebook).cells.length, 1);
  });

  it('addresses cells by position in older notebooks with no ids', async () => {
    const { path, ctx } = setup({ nbformat: 4, nbformat_minor: 2, cells: [{ cell_type: 'code', source: 'x', outputs: [] }] });
    const read = await readTool.execute({ file_path: path }, ctx);
    assert.match(read.content, /id="cell-0"/);
    assert.equal((await notebookEditTool.execute({ notebook_path: path, cell_id: 'cell-0', new_source: 'y' }, ctx)).isError, undefined);
  });

  it('counts as a file change for permissions', () => {
    const ctx = setup().ctx;
    assert.equal(notebookEditTool.access({ notebook_path: 'n.ipynb', new_source: '' }, ctx).kind, 'edit');
  });
});

describe('background commands', () => {
  it('reports when one exits, with its status and log', async () => {
    const dir = tempDir();
    const notes: string[] = [];
    const tasks = new TaskRegistry({ logDir: join(dir, 'logs'), onFinished: (_task, message) => notes.push(message) });
    await bashTool.execute({ command: 'echo out; exit 3', run_in_background: true, description: 'quick job' }, context(dir, tasks));
    await until(() => notes.length > 0);
    assert.match(notes[0]!, /"quick job"/);
    assert.match(notes[0]!, /exited with code 3/);
    assert.equal(tasks.list()[0]!.status, 'exited');
    assert.match(readFileSync(tasks.list()[0]!.logPath, 'utf8'), /out/);
  });

  it('stops by id through TaskStop, without a notice that sounds like a crash', async () => {
    const dir = tempDir();
    const notes: string[] = [];
    const tasks = new TaskRegistry({ logDir: join(dir, 'logs'), onFinished: (_task, message) => notes.push(message) });
    const ctx = context(dir, tasks);
    await bashTool.execute({ command: 'sleep 30', run_in_background: true }, ctx);
    const task = tasks.list()[0]!;
    assert.match((await taskStopTool.execute({ task_id: task.id }, ctx)).content, /Stopped/);
    assert.equal(task.status, 'stopped');
    assert.match((await taskStopTool.execute({ task_id: task.id }, ctx)).content, /not running/);
    assert.equal((await taskStopTool.execute({ task_id: 'nope' }, ctx)).isError, true);
    await Bun.sleep(50);
    assert.equal(notes.length, 0);
  });

  it('applies a time limit only when unattended', async () => {
    const dir = tempDir();
    const notes: string[] = [];
    const unattended = new TaskRegistry({ logDir: join(dir, 'a'), defaultLimitMs: 60_000, onFinished: (_task, message) => notes.push(message) });
    await bashTool.execute({ command: 'sleep 30', run_in_background: true, timeout: 100 }, context(dir, unattended));
    await until(() => notes.length > 0);
    assert.match(notes[0]!, /background time limit/);
    assert.equal(unattended.list()[0]!.status, 'timed_out');

    const attended = new TaskRegistry({ logDir: join(dir, 'b') });
    await bashTool.execute({ command: 'sleep 30', run_in_background: true, timeout: 50 }, context(dir, attended));
    await Bun.sleep(150);
    assert.equal(attended.list()[0]!.status, 'running', 'someone at a terminal can stop it themselves');
    attended.stopAll();
  });

  it('moves a foreground command to the background at its timeout, keeping its output', async () => {
    const dir = tempDir();
    const tasks = new TaskRegistry({ logDir: join(dir, 'logs') });
    const marker = join(dir, 'finished');
    const output = await bashTool.execute({ command: `echo early; sleep 0.4; echo late; touch ${marker}`, timeout: 100 }, { ...context(dir, tasks), autoBackground: true });
    assert.match(output.content, /did not complete within/);
    assert.match(output.content, /Session cwd remains/);
    assert.equal(output.isError, undefined);
    await until(() => existsSync(marker));
    await until(() => tasks.running().length === 0);
    await Bun.sleep(50);
    const log = readFileSync(tasks.list()[0]!.logPath, 'utf8');
    assert.match(log, /early/);
    assert.match(log, /late/);
  });

  it('blocks a bare foreground sleep rather than running or backgrounding it', async () => {
    const dir = tempDir();
    const tasks = new TaskRegistry({ logDir: join(dir, 'logs') });
    const output = await bashTool.execute({ command: 'sleep 30' }, { ...context(dir, tasks), autoBackground: true });
    assert.equal(output.isError, true);
    assert.match(output.content, /Foreground sleep is blocked/);
    assert.equal(tasks.list().length, 0);
  });

  it('tells the model at its next message, and lets it read the log without a prompt', async () => {
    const dir = tempDir();
    process.env.CAIRN_HOME = tempDir('cairn-taskhome-');
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'Bash', input: { command: 'echo logged', run_in_background: true } }] },
      { text: 'waiting' },
      { text: 'noted' },
    ]);
    const runtime = await createRuntime({ cwd: dir, provider, persist: false, allowedTools: ['Bash(echo logged)'], prompter });
    const drain = async (prompt: string): Promise<void> => {
      for await (const _event of runtime.agent.run(prompt, new AbortController().signal)) {
        // Run it to the end.
      }
    };
    await drain('start it');
    await until(() => runtime.context.tasks.running().length === 0);
    await drain('and now?');
    assert.match(JSON.stringify(provider.requests.at(-1)!.messages.at(-1)), /exited with code 0/);
    const log = runtime.context.tasks.list()[0]!.logPath;
    assert.equal(runtime.engine.check('Read', { kind: 'read', paths: [log] }).behavior, 'allow');
    await runtime.shutdown();
  });

  it('stops what a subagent started when that subagent ends', async () => {
    const dir = tempDir();
    process.env.CAIRN_HOME = tempDir('cairn-taskhome-');
    const marker = join(dir, 'should-not-exist');
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'Agent', input: { description: 'd', prompt: 'p' } }] },
      { toolCalls: [{ name: 'Bash', input: { command: `sleep 1; touch ${marker}`, run_in_background: true } }] },
      { text: 'sub done' },
      { text: 'parent done' },
    ]);
    const runtime = await createRuntime({ cwd: dir, provider, persist: false, mode: 'bypassPermissions', prompter });
    for await (const _event of runtime.agent.run('go', new AbortController().signal)) {
      // Run it to the end.
    }
    await Bun.sleep(1_300);
    assert.equal(existsSync(marker), false);
    await runtime.shutdown();
  });

  it('keeps a print-mode run open until its background command exits', () => {
    const dir = tempDir();
    const home = tempDir('cairn-taskhome-');
    const marker = join(dir, 'finished');
    const script = join(home, 'script.json');
    writeFileSync(script, JSON.stringify([{ toolCalls: [{ name: 'Bash', input: { command: `sleep 0.3; touch ${marker}`, run_in_background: true } }] }, { text: 'started' }]));
    const result = spawnSync(process.execPath, [CLI, '--provider', 'scripted', '-p', 'go', '--dangerously-skip-permissions'], {
      cwd: dir,
      env: { ...process.env, CAIRN_HOME: home, CAIRN_SCRIPT: script },
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'started\n');
    assert.equal(existsSync(marker), true);
  });
});
