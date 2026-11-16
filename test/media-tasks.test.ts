/** Reading pictures, PDFs and notebooks, commands running in the background, and scheduled prompts. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, setSystemTime } from 'bun:test';
import { runSlashCommand } from '../src/commands/slash.ts';
import { createRuntime } from '../src/core/runtime.ts';
import { WakeQueue } from '../src/core/wakes.ts';
import { toApiMessages } from '../src/providers/anthropic.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import { bashTool } from '../src/tools/bash.ts';
import { readTool } from '../src/tools/files.ts';
import { countPdfPages, imageMediaType, parsePageRange } from '../src/tools/media.ts';
import { monitorTool } from '../src/tools/monitor.ts';
import { notebookEditTool } from '../src/tools/notebook.ts';
import { Reaper } from '../src/tools/reaper.ts';
import { TaskRegistry, taskStopTool } from '../src/tools/tasks.ts';
import { FileTracker } from '../src/tools/types.ts';
import type { Prompter, ToolContext } from '../src/tools/types.ts';

const CLI = resolve(import.meta.dirname, '../src/cli.ts');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

function tempDir(prefix = 'karst-media-'): string {
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

/** A request whose newest message says this, such as a note that woke the conversation. */
const asked = (provider: ScriptedProvider, pattern: RegExp): boolean => provider.requests.some((request) => pattern.test(JSON.stringify(request.messages.at(-1))));

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
    process.env.KARST_HOME = tempDir('karst-taskhome-');
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

  it('stops its background commands when Karst\'s process dies without stopping them', async () => {
    const dir = tempDir();
    const script = join(dir, 'crash.ts');
    const source = (path: string): string => JSON.stringify(resolve(import.meta.dirname, '..', path));
    writeFileSync(
      script,
      `import { Reaper } from ${source('src/tools/reaper.ts')};
import { TaskRegistry } from ${source('src/tools/tasks.ts')};
const tasks = new TaskRegistry({ logDir: ${JSON.stringify(join(dir, 'logs'))}, reaper: new Reaper() });
const task = tasks.start('/bin/sh', ['-c', 'sleep 30'], { command: 'sleep 30', cwd: ${JSON.stringify(dir)}, env: process.env });
console.log(task.pid);
// As a crash or kill -9 would: no shutdown, no exit handlers.
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);
`,
    );
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 });
    const pid = Number(result.stdout.trim());
    assert.ok(pid > 0, result.stderr);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await until(() => !alive(), 6_000);
    } finally {
      if (alive()) process.kill(-pid, 'SIGKILL');
    }
  });

  it('gives the process that stops orphans none of Karst\'s environment', async () => {
    process.env.KARST_TEST_SECRET = 'sk-should-not-leak';
    const reaper = new Reaper();
    const sleeper = spawn('/bin/sh', ['-c', 'sleep 5'], { detached: true, stdio: 'ignore' });
    try {
      reaper.add(sleeper.pid);
      await until(() => reaper.pid !== undefined);
      const environment =
        process.platform === 'linux'
          ? readFileSync(`/proc/${reaper.pid}/environ`, 'utf8')
          : spawnSync('ps', ['-wwE', '-o', 'command=', '-p', String(reaper.pid)], { encoding: 'utf8' }).stdout;
      assert.match(environment, /PATH=/, 'the environment can be seen at all');
      assert.doesNotMatch(environment, /sk-should-not-leak/);
    } finally {
      delete process.env.KARST_TEST_SECRET;
      reaper.remove(sleeper.pid);
      reaper.close();
      sleeper.kill('SIGKILL');
    }
  });

  it('empties a running command\'s log once it passes the size limit, and the command keeps writing', async () => {
    const dir = tempDir();
    const tasks = new TaskRegistry({ logDir: join(dir, 'logs'), maxLogBytes: 1_000 });
    const marker = join(dir, 'later');
    const task = tasks.start('/bin/sh', ['-c', `head -c 5000 /dev/zero | tr '\\\\0' x; sleep 3; echo after; touch ${marker}`], { command: 'chatty', cwd: dir, env: process.env })!;
    await until(() => readFileSync(task.logPath, 'utf8').includes('Karst emptied it'), 5_000);
    await until(() => existsSync(marker), 6_000);
    await Bun.sleep(50);
    const log = readFileSync(task.logPath, 'utf8');
    assert.match(log, /^\[.*this log passed 1000 bytes, so Karst emptied it.*\]\nafter\n$/);
    tasks.stopAll();
  });

  it('wakes a subagent when its background command exits, and its report says what came of it', async () => {
    const dir = tempDir();
    process.env.KARST_HOME = tempDir('karst-taskhome-');
    // Rules rather than a list, so the replies do not depend on whether the command ends before
    // or after the subagent is told it is still running.
    const provider = new ScriptedProvider({
      rules: [
        { regex: '^go$', steps: [{ toolCalls: [{ name: 'Agent', input: { description: 'd', prompt: 'build it' } }] }, { text: 'parent done' }] },
        { match: 'build it', steps: [{ toolCalls: [{ name: 'Bash', input: { command: 'sleep 1; echo built', run_in_background: true } }] }, { text: 'started the build' }] },
        { match: 'exited with code 0', steps: [{ text: 'the build finished' }] },
        { match: 'still running', steps: [{ text: 'waiting for the build' }] },
      ],
    });
    const runtime = await createRuntime({ cwd: dir, provider, persist: false, mode: 'bypassPermissions', prompter });
    for await (const _event of runtime.agent.run('go', new AbortController().signal)) {
      // Run it to the end.
    }
    assert.ok(asked(provider, /still running[\s\S]*sleep 1; echo built/), 'told what is still running when its turn ended');
    assert.ok(asked(provider, /exited with code 0/), 'woken when the command exited');
    assert.match(JSON.stringify(provider.requests.at(-1)!.messages.at(-1)), /the build finished/);
    await runtime.shutdown();
  });

  it('stops what a subagent started when that subagent is stopped', async () => {
    const dir = tempDir();
    process.env.KARST_HOME = tempDir('karst-taskhome-');
    const marker = join(dir, 'should-not-exist');
    const provider = new ScriptedProvider({
      rules: [
        { regex: '^go$', steps: [{ toolCalls: [{ name: 'Agent', input: { description: 'd', prompt: 'build it' } }] }, { text: 'parent done' }] },
        { match: 'build it', steps: [{ toolCalls: [{ name: 'Bash', input: { command: `sleep 1; touch ${marker}`, run_in_background: true } }] }, { text: 'started' }] },
        { match: 'still running', steps: [{ text: 'waiting' }] },
      ],
    });
    const runtime = await createRuntime({ cwd: dir, provider, persist: false, mode: 'bypassPermissions', prompter });
    const controller = new AbortController();
    const run = (async () => {
      for await (const _event of runtime.agent.run('go', controller.signal)) {
        // Run it until it is stopped.
      }
    })();
    await until(() => asked(provider, /still running/));
    await Bun.sleep(50);
    controller.abort();
    await run;
    await Bun.sleep(1_300);
    assert.equal(existsSync(marker), false);
    await runtime.shutdown();
  });

  it('lets a print-mode run see how its background command ended before it answers', () => {
    const dir = tempDir();
    const home = tempDir('karst-taskhome-');
    const marker = join(dir, 'finished');
    const script = join(home, 'script.json');
    writeFileSync(
      script,
      JSON.stringify({
        rules: [
          { regex: '^go$', steps: [{ toolCalls: [{ name: 'Bash', input: { command: `sleep 0.5; touch ${marker}`, run_in_background: true } }] }, { text: 'started' }] },
          { match: 'exited with code 0', steps: [{ text: 'it finished' }] },
          { match: 'still running', steps: [{ text: 'waiting' }] },
        ],
      }),
    );
    const result = spawnSync(process.execPath, [CLI, '--provider', 'scripted', '-p', 'go', '--dangerously-skip-permissions'], {
      cwd: dir,
      env: { ...process.env, KARST_HOME: home, KARST_SCRIPT: script },
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'it finished\n');
    assert.equal(existsSync(marker), true);
  });

  it('stops the old conversation\'s background work on /clear, but not on /branch or a failed /resume', async () => {
    const dir = tempDir();
    process.env.KARST_HOME = tempDir('karst-taskhome-');
    const provider = new ScriptedProvider({
      rules: [
        {
          regex: '^go$',
          steps: [
            { toolCalls: [{ name: 'Agent', input: { description: 'slow', prompt: 'slow task' } }, { name: 'Bash', input: { command: 'sleep 30', run_in_background: true } }] },
            { text: 'ok' },
          ],
        },
        { match: 'slow task', steps: [{ text: 'never', delayMs: 30_000 }] },
      ],
    });
    const runtime = await createRuntime({ cwd: dir, provider, persist: false, mode: 'bypassPermissions', prompter, backgroundAgents: true });
    for await (const _event of runtime.agent.run('go', new AbortController().signal)) {
      // Run it to the end.
    }
    runtime.cron!.create('7 9 * * *', 'morning check', true);
    const running = (): number[] => [runtime.backgroundAgents.running(), runtime.context.tasks.running().length, runtime.cron!.list().length];
    assert.deepEqual(running(), [1, 1, 1]);

    runtime.forkSession();
    assert.equal(runtime.resumeSession('no-such-session'), null);
    assert.deepEqual(running(), [1, 1, 1], 'the branch has the history the work belongs to');

    const cleared = await runSlashCommand('/clear', runtime, { choose: async () => null });
    assert.equal(cleared.notice, 'Stopped what the previous conversation left running: 1 agent, 1 shell command, 1 scheduled job.');
    assert.deepEqual(running(), [0, 0, 0]);
    await Bun.sleep(100);
    assert.equal(runtime.wakes.pending(), false, 'nothing reports to the new conversation');
    assert.equal((await runSlashCommand('/clear', runtime, { choose: async () => null })).notice, undefined);
    await runtime.shutdown();
  });
});

describe('background agents', () => {
  /** Three Agent calls in one response, each for a subagent that takes `delayMs` to answer. */
  const threeAtOnce = (delayMs: number): ScriptedProvider =>
    new ScriptedProvider({
      rules: [
        {
          regex: '^go$',
          steps: [
            { toolCalls: [1, 2, 3].map((n) => ({ name: 'Agent', input: { description: `job ${n}`, prompt: `slow job ${n}` } })) },
            { text: 'ok' },
          ],
        },
        { match: 'slow job', steps: [{ text: 'done', delayMs }] },
      ],
    });
  const results = (provider: ScriptedProvider): string[] =>
    provider.requests.flatMap((request) => request.messages.at(-1)!.content.flatMap((block) => (block.type === 'tool_result' ? [String(block.content)] : [])));

  for (const background of [true, false]) {
    it(`refuses a subagent past the limit of how many run at once${background ? ', in the background' : ', inline'}`, async () => {
      const dir = tempDir();
      process.env.KARST_HOME = tempDir('karst-taskhome-');
      process.env.KARST_MAX_CONCURRENT_SUBAGENTS = '2';
      try {
        const provider = threeAtOnce(background ? 30_000 : 200);
        const runtime = await createRuntime({ cwd: dir, provider, persist: false, mode: 'bypassPermissions', prompter, backgroundAgents: background });
        for await (const _event of runtime.agent.run('go', new AbortController().signal)) {
          // Run it to the end.
        }
        const refused = results(provider).filter((text) => /2 subagents are already running, the most at once/.test(text));
        assert.equal(refused.length, 1, results(provider).join('\n---\n'));
        await runtime.shutdown();
      } finally {
        delete process.env.KARST_MAX_CONCURRENT_SUBAGENTS;
      }
    });
  }

  it('gives a message that came during an agent\'s last request a turn of its own once it is done', async () => {
    const dir = tempDir();
    process.env.KARST_HOME = tempDir('karst-taskhome-');
    const provider = new ScriptedProvider({
      rules: [
        { regex: '^go$', steps: [{ toolCalls: [{ name: 'Agent', input: { description: 'worker', prompt: 'do the work' } }] }, { text: 'launched' }] },
        // Its only request ends the turn, so no tool round is left for a message to arrive at.
        { match: 'do the work', steps: [{ text: 'work report', delayMs: 300 }] },
        { match: 'also check X', steps: [{ text: 'X is fine' }] },
      ],
    });
    const runtime = await createRuntime({ cwd: dir, provider, persist: false, mode: 'bypassPermissions', prompter, backgroundAgents: true });
    for await (const _event of runtime.agent.run('go', new AbortController().signal)) {
      // Run it to the end.
    }
    await until(() => asked(provider, /do the work/));
    assert.match(await runtime.backgroundAgents.send('worker', 'also check X', 'main'), /Delivered/);
    await until(() => asked(provider, /also check X/) && runtime.backgroundAgents.list()[0]!.status === 'completed');

    for await (const _event of runtime.agent.resumeForNotes(new AbortController().signal)) {
      // The main conversation hears from it.
    }
    const heard = JSON.stringify(provider.requests.at(-1)!.messages.at(-1));
    assert.match(heard, /work report/, 'the report it finished with still arrives');
    assert.match(heard, /X is fine/);
    await runtime.shutdown();
  });
});

describe('monitors', () => {
  it('a burst of notes that may wait wakes an idle session once, and one that may not takes them along', async () => {
    const wakes = new WakeQueue();
    let woken = 0;
    wakes.onWake(() => woken++);
    wakes.notify(100);
    wakes.notify(100);
    await Bun.sleep(30);
    wakes.notify(100);
    assert.equal(woken, 0);
    assert.equal(wakes.pending(), true);
    await Bun.sleep(120);
    assert.equal(woken, 1);
    wakes.notify(100);
    wakes.notify();
    assert.equal(woken, 2);
    await Bun.sleep(150);
    assert.equal(woken, 2);
  });

  it('wakes the conversation once for events that come close together', async () => {
    const dir = tempDir();
    process.env.KARST_HOME = tempDir('karst-taskhome-');
    const runtime = await createRuntime({ cwd: dir, provider: new ScriptedProvider([]), persist: false, mode: 'bypassPermissions', prompter });
    let woken = 0;
    runtime.wakes.onWake(() => woken++);
    const ctx = { ...runtime.context, signal: new AbortController().signal };
    const started = await monitorTool.execute({ description: 'two events', timeout_ms: 10_000, command: "printf 'one\\n'; sleep 0.5; printf 'two\\n'; sleep 5" }, ctx);
    // Both events have come by then: the second about 0.7 seconds in, and the settled wake at 1.5.
    await Bun.sleep(2_500);
    assert.equal(woken, 1);
    assert.equal(runtime.wakes.take().notes, true);
    const id = /task (\w+)/.exec(started.content as string)![1]!;
    runtime.context.tasks.stop(id);
    await runtime.shutdown();
  });
});

describe('scheduled prompts', () => {
  it('runs a prompt that came due several times while busy once', () => {
    const wakes = new WakeQueue();
    assert.equal(wakes.prompt('check the deploy', 'cron:a'), true);
    assert.equal(wakes.prompt('check the deploy', 'cron:a'), false);
    wakes.prompt('check the deploy', 'cron:a');
    wakes.prompt('look at CI', 'cron:b');
    wakes.prompt('typed twice');
    wakes.prompt('typed twice');
    assert.deepEqual(wakes.take().prompts.map((prompt) => prompt.text), ['check the deploy', 'look at CI', 'typed twice', 'typed twice']);
    // Once its run has started, the job's next match is a new run.
    assert.equal(wakes.prompt('check the deploy', 'cron:a'), true);
  });

  it('does not take a scheduled prompt for the user being at the terminal', async () => {
    const dir = tempDir();
    process.env.KARST_HOME = tempDir('karst-taskhome-');
    const shown: string[] = [];
    const runtime = await createRuntime({
      cwd: dir,
      provider: new ScriptedProvider([{ text: 'checked' }]),
      persist: false,
      prompter,
      desktopNotification: (message) => shown.push(message) > 0,
    });
    const push = runtime.context.pushNotification!;
    runtime.noteUserActivity();
    assert.match((await push('too soon')).reason, /at the terminal/);
    setSystemTime(new Date(Date.now() + 2 * 60_000));
    try {
      // What a job coming due does: a prompt nobody typed.
      for await (const _event of runtime.agent.run('check the deploy', new AbortController().signal)) {
        // Run it to the end.
      }
      assert.deepEqual(await push('deploy finished'), { sent: true, reason: 'shown as a desktop notification.' });
      assert.deepEqual(shown, ['deploy finished']);
    } finally {
      setSystemTime();
    }
    await runtime.shutdown();
  });
});
