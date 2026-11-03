import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'bun:test';
import type { ScriptedTurn } from '../src/providers/scripted.ts';

const CLI = resolve(import.meta.dirname, '../src/cli.ts');

function workspace(): { dir: string; home: string } {
  return {
    dir: realpathSync(mkdtempSync(join(tmpdir(), 'cairn-cli-'))),
    home: realpathSync(mkdtempSync(join(tmpdir(), 'cairn-clihome-'))),
  };
}

function run(args: string[], options: { dir: string; home: string; turns?: ScriptedTurn[]; input?: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env, CAIRN_HOME: options.home };
  const scriptArgs: string[] = [];
  if (options.turns) {
    const script = join(options.home, 'script.json');
    writeFileSync(script, JSON.stringify(options.turns));
    env.CAIRN_SCRIPT = script;
    scriptArgs.push('--provider', 'scripted');
  }
  return spawnSync(process.execPath, [CLI, ...scriptArgs, ...args], {
    cwd: options.dir,
    env,
    encoding: 'utf8',
    input: options.input ?? '',
    timeout: 30_000,
  });
}

describe('command line', () => {
  it('prints help and version', () => {
    const w = workspace();
    assert.match(run(['--help'], w).stdout, /Usage: cairn/);
    assert.match(run(['--version'], w).stdout, /^\d+\.\d+\.\d+\n$/);
  });

  it('prints the final answer in text mode', () => {
    const w = workspace();
    const result = run(['-p', 'hi'], { ...w, turns: [{ text: 'The answer' }] });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'The answer\n');
  });

  it('takes the whole prompt from stdin when no argument is given', () => {
    const w = workspace();
    const result = run(['-p'], { ...w, input: 'only from stdin', turns: [{ text: 'ok' }] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ok\n');
  });

  it('passes piped input through to the model', () => {
    const w = workspace();
    const result = run(['-p', 'summarize', '--output-format', 'stream-json', '--system-prompt', 'x'], {
      ...w,
      input: 'piped data',
      turns: [{ toolCalls: [{ name: 'TodoWrite', input: { todos: [] } }] }, { text: 'ok' }],
    });
    assert.equal(result.status, 0, result.stderr);
    const [session] = readdirSync(join(w.home, 'projects', w.dir.replace(/[^a-zA-Z0-9]/g, '-')));
    const transcript = readFileSync(join(w.home, 'projects', w.dir.replace(/[^a-zA-Z0-9]/g, '-'), session!), 'utf8');
    assert.match(transcript, /summarize\\n\\npiped data/);
  });

  it('does not hang when stdin stays open and a prompt was given', async () => {
    const w = workspace();
    const script = join(w.home, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'answered' }]));
    const child = spawn(process.execPath, [CLI, '--provider', 'scripted', '-p', 'hi'], {
      cwd: w.dir,
      env: { ...process.env, CAIRN_HOME: w.home, CAIRN_SCRIPT: script },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const [code] = (await once(child, 'close')) as [number | null];
    clearTimeout(timer);
    assert.equal(code, 0);
    assert.equal(stdout, 'answered\n');
  });

  it('gives a clear error for bad arguments', () => {
    const w = workspace();
    assert.equal(run(['-p'], w).status, 2);
    assert.match(run(['-p', 'x', '--permission-mode', 'nope'], w).stderr, /Unknown permission mode/);
    assert.match(run(['-p', 'x', '--effort', 'nope'], w).stderr, /Unknown effort/);
    assert.match(run(['-p', 'x', '--output-format', 'nope'], w).stderr, /Unknown output format/);
    assert.match(run(['-p', 'x', '--max-turns', '0'], w).stderr, /--max-turns/);
    assert.equal(run(['--no-such-flag'], w).status, 2);
  });

  it('names the available providers when given an unknown one', () => {
    const w = workspace();
    const result = run(['-p', 'hi', '--provider', 'nope'], w);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown provider "nope"\. Available: anthropic, openai, ollama, scripted/);
  });

  it('does not load the MCP SDK when no server is configured, so startup stays quick', () => {
    const w = workspace();
    const script = join(w.home, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'ok' }]));
    const trace = join(w.home, 'trace.ts');
    writeFileSync(trace, "process.on('exit', () => { if (Object.keys(require.cache).some((path) => path.includes('modelcontextprotocol'))) process.stderr.write('MCP SDK LOADED\\n'); });\n");
    const start = (...extra: string[]) =>
      spawnSync(process.execPath, ['--preload', trace, CLI, '--provider', 'scripted', '-p', 'hi', ...extra], {
        cwd: w.dir,
        env: { ...process.env, CAIRN_HOME: w.home, CAIRN_SCRIPT: script },
        encoding: 'utf8',
        input: '',
        timeout: 30_000,
      });
    const plain = start();
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stderr, /MCP SDK LOADED/);
    // Without this control the check above would also pass if the trace stopped working.
    const fixture = resolve(import.meta.dirname, 'fixtures/mcp-test-server.ts');
    const withServer = start('--mcp-config', JSON.stringify({ mcpServers: { fix: { command: process.execPath, args: [fixture] } } }));
    assert.match(withServer.stderr, /MCP SDK LOADED/);
  });

  it('says how to fix missing credentials', () => {
    const w = workspace();
    const { ANTHROPIC_API_KEY: _key, ANTHROPIC_AUTH_TOKEN: _token, ...env } = process.env;
    const result = spawnSync(process.execPath, [CLI, '-p', 'hi'], {
      cwd: w.dir,
      env: { ...env, CAIRN_HOME: w.home },
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set ANTHROPIC_API_KEY/);
    assert.doesNotMatch(result.stderr, /at .*node_modules/);
  });

  it('emits one result object in json mode', () => {
    const w = workspace();
    const result = run(['-p', 'hi', '--output-format', 'json'], { ...w, turns: [{ text: 'hello', usage: { inputTokens: 7, outputTokens: 3 } }] });
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed.type, 'result');
    assert.equal(parsed.is_error, false);
    assert.equal(parsed.result, 'hello');
    assert.equal(parsed.num_turns, 1);
    assert.equal((parsed.usage as { inputTokens: number }).inputTokens, 7);
    assert.equal(typeof parsed.session_id, 'string');
  });

  it('emits an event per line in stream-json mode', () => {
    const w = workspace();
    const result = run(['-p', 'hi', '--output-format', 'stream-json', '--allowedTools', 'Bash(echo streamed)'], {
      ...w,
      turns: [{ toolCalls: [{ name: 'Bash', input: { command: 'echo streamed' } }] }, { text: 'done' }],
    });
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; subtype?: string; event?: { type: string }; message?: { content: { type: string; content?: string; text?: string }[] } });
    assert.equal(events[0]!.type, 'system');
    assert.equal(events.at(-1)!.type, 'result');
    assert.equal(events.at(-1)!.subtype, 'success');
    assert.ok(!events.some((e) => e.type === 'stream_event'), 'partial text only comes when asked for');
    const toolResult = events.flatMap((e) => (e.type === 'user' ? e.message!.content : [])).find((block) => block.type === 'tool_result');
    assert.match(toolResult!.content!, /streamed/);
    assert.ok(events.some((e) => e.type === 'assistant' && e.message!.content.some((block) => block.text === 'done')));
  });

  it('refuses in print mode what would need a prompt, and says how to allow it', () => {
    const w = workspace();
    const marker = join(w.dir, 'marker');
    const result = run(['-p', 'hi'], {
      ...w,
      turns: [{ toolCalls: [{ name: 'Bash', input: { command: `touch ${marker}` } }] }, { text: 'gave up' }],
    });
    assert.equal(existsSync(marker), false);
    assert.match(result.stderr, /--allowedTools/);
    assert.equal(result.stdout, 'gave up\n');
  });

  it('accepts rules with spaces and commas in --allowedTools', () => {
    const w = workspace();
    const marker = join(w.dir, 'marker');
    const result = run(['-p', 'hi', '--allowedTools', `Read,Bash(touch ${marker})`], {
      ...w,
      turns: [{ toolCalls: [{ name: 'Bash', input: { command: `touch ${marker}` } }] }, { text: 'ok' }],
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(marker), true);
  });

  it('--disallowedTools and --tools limit what the model is offered', () => {
    const w = workspace();
    const denied = run(['-p', 'hi', '--disallowedTools', 'Bash', '--output-format', 'json'], {
      ...w,
      turns: [{ toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }] }, { text: 'ok' }],
    });
    assert.equal(denied.status, 0);
    const limited = run(['-p', 'hi', '--tools', 'Read,Grep', '--output-format', 'json'], {
      ...w,
      turns: [{ toolCalls: [{ name: 'Write', input: { file_path: join(w.dir, 'x'), content: 'x' } }] }, { text: 'ok' }],
    });
    assert.equal(limited.status, 0);
    assert.equal(existsSync(join(w.dir, 'x')), false);
  });

  it('returns a failure status on refusal, provider error and turn limit', () => {
    const w = workspace();
    assert.equal(run(['-p', 'x'], { ...w, turns: [{ text: 'no', stopReason: 'refusal' }] }).status, 1);
    const failed = run(['-p', 'x'], { ...w, turns: [{ error: 'boom' }] });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /boom/);
    assert.equal(
      run(['-p', 'x', '--max-turns', '1', '--dangerously-skip-permissions'], {
        ...w,
        turns: [{ toolCalls: [{ name: 'Bash', input: { command: 'true' } }] }],
      }).status,
      1,
    );
  });

  it('continues a session across separate runs', () => {
    const w = workspace();
    run(['-p', 'first'], { ...w, turns: [{ text: 'one' }] });
    const second = run(['-p', 'second', '-c', '--output-format', 'json'], { ...w, turns: [{ text: 'two' }] });
    const first = JSON.parse(second.stdout) as { session_id: string };
    const third = run(['-p', 'third', '--resume', first.session_id, '--output-format', 'json'], { ...w, turns: [{ text: 'three' }] });
    assert.equal((JSON.parse(third.stdout) as { session_id: string }).session_id, first.session_id);
  });

  it('leaves no transcript with --no-session-persistence', () => {
    const w = workspace();
    run(['-p', 'x', '--no-session-persistence'], { ...w, turns: [{ text: 'ok' }] });
    assert.equal(existsSync(join(w.home, 'projects')), false);
  });

  it('does not run an untrusted project\'s hooks or allow rules unless told to', () => {
    const w = workspace();
    const hookMarker = join(w.dir, 'hook-ran');
    const toolMarker = join(w.dir, 'tool-ran');
    mkdirSync(join(w.dir, '.cairn'));
    writeFileSync(
      join(w.dir, '.cairn/settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }] },
      }),
    );
    const turns: ScriptedTurn[] = [{ toolCalls: [{ name: 'Bash', input: { command: `touch ${toolMarker}` } }] }, { text: 'ok' }];
    const untrusted = run(['-p', 'x'], { ...w, turns });
    assert.equal(existsSync(hookMarker), false);
    assert.equal(existsSync(toolMarker), false);
    assert.match(untrusted.stderr, /stay inactive/);

    run(['-p', 'x', '--trust'], { ...w, turns });
    assert.equal(existsSync(hookMarker), true);
    assert.equal(existsSync(toolMarker), true);
  });

  it('runs the whole edit flow from a script', () => {
    const w = workspace();
    const file = join(w.dir, 'app.txt');
    writeFileSync(file, 'hello world\n');
    const result = run(['-p', 'fix it', '--permission-mode', 'acceptEdits'], {
      ...w,
      turns: [
        { toolCalls: [{ name: 'Read', input: { file_path: file } }] },
        { toolCalls: [{ name: 'Edit', input: { file_path: file, old_string: 'world', new_string: 'cairn' } }] },
        { text: 'Edited.' },
      ],
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'hello cairn\n');
  });
});
