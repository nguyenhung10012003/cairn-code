import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { bashTool } from '../src/tools/bash.ts';
import { TaskRegistry } from '../src/tools/tasks.ts';
import { editTool, readTool, writeTool } from '../src/tools/files.ts';
import { askUserTool, exitPlanModeTool, todoWriteTool } from '../src/tools/interaction.ts';
import { globTool, grepTool } from '../src/tools/search.ts';
import { FileTracker, validateInput } from '../src/tools/types.ts';
import type { Prompter, ToolContext } from '../src/tools/types.ts';
import { htmlToText, isPrivateAddress, webFetchTool } from '../src/tools/web.ts';
import type { PermissionMode } from '../src/permissions/engine.ts';

function setup(overrides: Partial<ToolContext> = {}): { dir: string; ctx: ToolContext } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-tools-')));
  let cwd = dir;
  let mode: PermissionMode = 'default';
  const prompter: Prompter = {
    permission: async () => ({ behavior: 'allow' }),
    questions: async () => ['first'],
    approvePlan: async () => true,
  };
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: (next) => {
      cwd = next;
    },
    workingDirs: () => [dir],
    signal: new AbortController().signal,
    files: new FileTracker(),
    prompter,
    todos: { items: [] },
    tasks: new TaskRegistry({ logDir: join(dir, '.logs') }),
    secretEnvVars: ['CAIRN_TEST_SECRET'],
    isReadDenied: () => false,
    getMode: () => mode,
    setMode: (next) => {
      mode = next;
    },
    ...overrides,
  };
  return { dir, ctx };
}

describe('Read', () => {
  it('numbers lines and pages with offset and limit', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'one\ntwo\nthree\n');
    assert.equal((await readTool.execute({ file_path: path }, ctx)).content, '1\tone\n2\ttwo\n3\tthree');
    const page = await readTool.execute({ file_path: path, offset: 2, limit: 1 }, ctx);
    assert.match(page.content, /^2\ttwo\n\n\[Showing lines 2-2 of 3\.\]$/);
  });

  it('reports missing files, directories, binaries and bad offsets as errors', async () => {
    const { dir, ctx } = setup();
    writeFileSync(join(dir, 'bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, 'small'), 'x\n');
    for (const input of [{ file_path: join(dir, 'nope') }, { file_path: dir }, { file_path: join(dir, 'bin') }, { file_path: join(dir, 'small'), offset: 9 }]) {
      assert.equal((await readTool.execute(input, ctx)).isError, true);
    }
  });

  it('resolves a relative path against the session directory', async () => {
    const { dir, ctx } = setup();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f'), 'hi');
    ctx.setCwd(join(dir, 'sub'));
    assert.equal((await readTool.execute({ file_path: 'f' }, ctx)).content, '1\thi');
  });
});

describe('Edit and Write', () => {
  it('refuses to change a file that was not read, or that changed since', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'a');
    writeFileSync(path, 'old');
    const edit = { file_path: path, old_string: 'old', new_string: 'new' };
    assert.match((await editTool.execute(edit, ctx)).content, /has not been read/);
    assert.match((await writeTool.execute({ file_path: path, content: 'x' }, ctx)).content, /has not been read/);

    await readTool.execute({ file_path: path }, ctx);
    writeFileSync(path, 'changed by someone else');
    assert.match((await editTool.execute(edit, ctx)).content, /changed on disk/);
    assert.equal(readFileSync(path, 'utf8'), 'changed by someone else');
  });

  it('allows consecutive edits without another read', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'a');
    writeFileSync(path, 'one two');
    await readTool.execute({ file_path: path }, ctx);
    await editTool.execute({ file_path: path, old_string: 'one', new_string: '1' }, ctx);
    const second = await editTool.execute({ file_path: path, old_string: 'two', new_string: '2' }, ctx);
    assert.equal(second.isError, undefined);
    assert.equal(readFileSync(path, 'utf8'), '1 2');
  });

  it('requires a unique match unless replace_all is set', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'a');
    writeFileSync(path, 'x x x');
    await readTool.execute({ file_path: path }, ctx);
    assert.match((await editTool.execute({ file_path: path, old_string: 'x', new_string: 'y' }, ctx)).content, /matches 3 places/);
    await editTool.execute({ file_path: path, old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    assert.equal(readFileSync(path, 'utf8'), 'y y y');
  });

  it('inserts replacement text literally, without $ patterns', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'a');
    writeFileSync(path, 'price');
    await readTool.execute({ file_path: path }, ctx);
    await editTool.execute({ file_path: path, old_string: 'price', new_string: "$& $1 $'" }, ctx);
    assert.equal(readFileSync(path, 'utf8'), "$& $1 $'");
  });

  it('rejects empty and no-op edits, and missing files', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'a');
    assert.match((await editTool.execute({ file_path: path, old_string: 'a', new_string: 'a' }, ctx)).content, /identical/);
    assert.match((await editTool.execute({ file_path: path, old_string: '', new_string: 'a' }, ctx)).content, /empty/);
    assert.match((await editTool.execute({ file_path: path, old_string: 'a', new_string: 'b' }, ctx)).content, /does not exist/);
  });

  it('creates a new file and its parent directories without a read', async () => {
    const { dir, ctx } = setup();
    const path = join(dir, 'deep/er/new.txt');
    assert.match((await writeTool.execute({ file_path: path, content: 'hi' }, ctx)).content, /Created/);
    assert.equal(readFileSync(path, 'utf8'), 'hi');
  });
});

describe('Bash', () => {
  it('returns output, and exit codes as errors', async () => {
    const { ctx } = setup();
    assert.equal((await bashTool.execute({ command: 'echo hello' }, ctx)).content, 'hello');
    const failed = await bashTool.execute({ command: 'echo oops >&2; exit 3' }, ctx);
    assert.equal(failed.isError, true);
    assert.match(failed.content, /oops/);
  });

  it('carries the working directory across calls, not the environment', async () => {
    const { dir, ctx } = setup();
    mkdirSync(join(dir, 'sub'));
    await bashTool.execute({ command: 'cd sub; export FOO=bar' }, ctx);
    assert.equal(ctx.cwd(), join(dir, 'sub'));
    assert.equal((await bashTool.execute({ command: 'pwd; echo "[$FOO]"' }, ctx)).content, `${join(dir, 'sub')}\n[]`);
  });

  it('keeps the directory inside the allowed ones', async () => {
    const { dir, ctx } = setup();
    const result = await bashTool.execute({ command: 'cd /' }, ctx);
    assert.equal(ctx.cwd(), dir);
    assert.match(result.content, /outside the working directories/);
  });

  it('hides credentials from the commands it runs, foreground and background', async () => {
    const { ctx } = setup();
    process.env.CAIRN_TEST_SECRET = 'super-secret-value';
    process.env.CAIRN_TEST_VISIBLE = 'ordinary';
    try {
      const output = (await bashTool.execute({ command: 'env' }, ctx)).content;
      assert.doesNotMatch(output, /super-secret-value/);
      assert.match(output, /CAIRN_TEST_VISIBLE=ordinary/);

      await bashTool.execute({ command: 'env', run_in_background: true }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const log = readFileSync(ctx.tasks.list()[0]!.logPath, 'utf8');
      assert.match(log, /CAIRN_TEST_VISIBLE=ordinary/);
      assert.doesNotMatch(log, /super-secret-value/);
    } finally {
      delete process.env.CAIRN_TEST_SECRET;
      delete process.env.CAIRN_TEST_VISIBLE;
    }
  });

  it('preserves the exit status of a failing command while tracking the directory', async () => {
    const { ctx } = setup();
    assert.equal((await bashTool.execute({ command: 'false' }, ctx)).isError, true);
    assert.equal((await bashTool.execute({ command: 'true' }, ctx)).isError, false);
  });

  it('enforces a timeout and kills what the command started', async () => {
    const { dir, ctx } = setup();
    const started = Date.now();
    const result = await bashTool.execute({ command: `sleep 30 & echo $! > ${dir}/pid; wait`, timeout: 200 }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content, /timed out/);
    assert.ok(Date.now() - started < 5000);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0));
  });

  it('stops when interrupted', async () => {
    const controller = new AbortController();
    const { ctx } = setup({ signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await bashTool.execute({ command: 'tail -f /dev/null' }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content, /interrupted/);
    assert.ok(Date.now() - started < 5000);
  });

  it('does not hang on a backgrounded process holding the output pipe', async () => {
    const { ctx } = setup();
    const started = Date.now();
    await bashTool.execute({ command: 'sleep 20 & echo started' }, ctx);
    assert.ok(Date.now() - started < 5000);
  });

  it('keeps the start and end of very long output', async () => {
    const { ctx } = setup();
    const result = await bashTool.execute({ command: `node -e "console.log('A'.repeat(50000)); console.log('END')"` }, ctx);
    assert.ok(result.content.length < 31_000);
    assert.match(result.content, /characters of output omitted/);
    assert.match(result.content, /END$/);
  });

  it('runs background commands, logs their output and can stop them', async () => {
    const { ctx } = setup();
    const result = await bashTool.execute({ command: 'echo from-bg; sleep 30', run_in_background: true }, ctx);
    assert.match(result.content, /task [0-9a-f]{8}/);
    const { pid, logPath } = ctx.tasks.list()[0]!;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(readFileSync(logPath, 'utf8'), /from-bg/);
    ctx.tasks.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0));
    assert.equal(ctx.tasks.running().length, 0);
  });
});

describe('Glob and Grep', () => {
  function project(): { dir: string; ctx: ToolContext } {
    const made = setup();
    const { dir } = made;
    mkdirSync(join(dir, 'src/deep'), { recursive: true });
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
    mkdirSync(join(dir, 'ignored'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'const needle = 1;\nconst other = 2;\n');
    writeFileSync(join(dir, 'src/deep/b.ts'), 'NEEDLE\n');
    writeFileSync(join(dir, 'src/c.md'), 'needle in docs\n');
    writeFileSync(join(dir, 'node_modules/pkg/index.ts'), 'needle\n');
    writeFileSync(join(dir, 'ignored/d.ts'), 'needle\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n*.log\n');
    return made;
  }

  it('Glob finds files by pattern and skips dependency directories', async () => {
    const { dir, ctx } = project();
    const lines = (await globTool.execute({ pattern: '**/*.ts' }, ctx)).content.split('\n').sort();
    assert.ok(lines.includes(join(dir, 'src/a.ts')));
    assert.ok(lines.includes(join(dir, 'src/deep/b.ts')));
    assert.ok(!lines.some((line) => line.includes('node_modules')));
  });

  it('Glob understands brace patterns and hidden directories', async () => {
    const { dir, ctx } = project();
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config/d.ts'), '');
    const lines = (await globTool.execute({ pattern: '**/*.{ts,md}' }, ctx)).content.split('\n');
    assert.ok(lines.includes(join(dir, 'src/c.md')));
    assert.ok(lines.includes(join(dir, '.config/d.ts')));
    assert.ok(!lines.some((line) => line.includes('node_modules')));
  });

  it('Glob accepts an absolute pattern inside the search directory, and refuses to leave it', async () => {
    const { dir, ctx } = project();
    const inside = await globTool.execute({ pattern: join(dir, 'src/*.ts') }, ctx);
    assert.ok(inside.content.split('\n').includes(join(dir, 'src/a.ts')));
    for (const pattern of ['../*', 'src/../../*', '/etc/*']) {
      assert.equal((await globTool.execute({ pattern }, ctx)).isError, true, pattern);
    }
  });

  it('Glob reports no match plainly, and hides denied files', async () => {
    const { dir, ctx } = project();
    assert.equal((await globTool.execute({ pattern: '*.nope' }, ctx)).content, 'No files found.');
    ctx.isReadDenied = (path) => path.endsWith('a.ts');
    const lines = (await globTool.execute({ pattern: 'src/*.ts', path: dir }, ctx)).content;
    assert.equal(lines, 'No files found.');
  });

  it('Grep lists files, honours .gitignore and skips binary and dependency files', async () => {
    const { dir, ctx } = project();
    const files = (await grepTool.execute({ pattern: 'needle' }, ctx)).content.split('\n').sort();
    assert.deepEqual(files, [join(dir, 'src/a.ts'), join(dir, 'src/c.md')].sort());
  });

  it('Grep supports case-insensitive search, a file glob, and count and content modes', async () => {
    const { dir, ctx } = project();
    const tsOnly = await grepTool.execute({ pattern: 'needle', case_insensitive: true, glob: '*.ts', output_mode: 'count' }, ctx);
    assert.deepEqual(tsOnly.content.split('\n').sort(), [`${join(dir, 'src/a.ts')}:1`, `${join(dir, 'src/deep/b.ts')}:1`].sort());
    const content = await grepTool.execute({ pattern: 'needle', glob: 'a.ts', output_mode: 'content', context: 1 }, ctx);
    assert.equal(content.content, `${join(dir, 'src/a.ts')}:1:const needle = 1;\n${join(dir, 'src/a.ts')}-2-const other = 2;`);
  });

  it('Grep hides denied files, stops at head_limit and says so, and rejects a bad pattern', async () => {
    const { ctx } = project();
    assert.equal((await grepTool.execute({ pattern: '(' }, ctx)).isError, true);
    const limited = await grepTool.execute({ pattern: 'needle', head_limit: 1 }, ctx);
    assert.match(limited.content, /Stopped at 1 results/);
    ctx.isReadDenied = () => true;
    assert.match((await grepTool.execute({ pattern: 'needle' }, ctx)).content, /No matches/);
  });

  it('Grep can search one file', async () => {
    const { dir, ctx } = project();
    assert.equal((await grepTool.execute({ pattern: 'needle', path: join(dir, 'src/c.md') }, ctx)).content, join(dir, 'src/c.md'));
  });
});

describe('WebFetch safeguards', () => {
  it('recognizes private and local addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
  });

  it('refuses local addresses and unsupported protocols without connecting', async () => {
    const { ctx } = setup();
    for (const url of ['https://127.0.0.1/', 'http://localhost/', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/']) {
      const result = await webFetchTool.execute({ url }, ctx);
      assert.equal(result.isError, true, url);
      assert.match(result.content, /private or local/, url);
    }
    assert.match((await webFetchTool.execute({ url: 'file:///etc/passwd' }, ctx)).content, /Unsupported protocol/);
    assert.match((await webFetchTool.execute({ url: 'not a url' }, ctx)).content, /Invalid URL/);
  });

  it('turns HTML into readable text and drops scripts', () => {
    const text = htmlToText('<html><head><title>x</title></head><body><script>evil()</script><p>Hello &amp; <b>world</b></p><p>Next</p></body></html>');
    assert.equal(text, 'Hello & world\n\nNext');
  });
});

describe('interaction tools', () => {
  it('TodoWrite stores the checklist', async () => {
    const { ctx } = setup();
    const result = await todoWriteTool.execute({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, ctx);
    assert.match(result.content, /1\/2 done/);
    assert.equal(ctx.todos.items.length, 2);
  });

  it('AskUserQuestion returns the answer, and an error when nobody can answer', async () => {
    const question = { questions: [{ question: 'Pick?', options: [{ label: 'first' }] }] };
    assert.match((await askUserTool.execute(question, setup().ctx)).content, /"Pick\?"="first"/);
    const prompter: Prompter = { permission: async () => ({ behavior: 'deny' }), questions: async () => null, approvePlan: async () => false };
    assert.equal((await askUserTool.execute(question, setup({ prompter }).ctx)).isError, true);
  });

  it('ExitPlanMode leaves plan mode only on approval', async () => {
    const { ctx } = setup();
    assert.equal((await exitPlanModeTool.execute({ plan: 'p' }, ctx)).isError, true);
    ctx.setMode('plan');
    await exitPlanModeTool.execute({ plan: 'p' }, ctx);
    assert.equal(ctx.getMode(), 'default');

    const prompter: Prompter = { permission: async () => ({ behavior: 'deny' }), questions: async () => null, approvePlan: async () => false };
    const declined = setup({ prompter }).ctx;
    declined.setMode('plan');
    assert.equal((await exitPlanModeTool.execute({ plan: 'p' }, declined)).isError, true);
    assert.equal(declined.getMode(), 'plan');
  });
});

describe('input validation', () => {
  const schema = readTool.inputSchema;

  it('accepts valid input', () => {
    assert.equal(validateInput(schema, { file_path: 'a', limit: 3 }), null);
  });

  it('rejects missing, wrongly typed and unknown fields', () => {
    assert.match(validateInput(schema, {})!, /file_path is required/);
    assert.match(validateInput(schema, { file_path: 1 })!, /must be of type string/);
    assert.match(validateInput(schema, { file_path: 'a', limit: 1.5 })!, /must be of type integer/);
    assert.match(validateInput(schema, { file_path: 'a', extra: true })!, /not a recognized parameter/);
  });

  it('checks nested arrays and enums', () => {
    assert.match(validateInput(todoWriteTool.inputSchema, { todos: [{ content: 'a', status: 'nope' }] })!, /must be one of/);
    assert.equal(existsSync('/definitely/not/here'), false);
  });
});
