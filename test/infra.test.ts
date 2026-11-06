import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, it } from 'bun:test';
import { commandNames, runSlashCommand, settleCommand } from '../src/commands/slash.ts';
import { workspaceSettingsPath } from '../src/config/paths.ts';
import { appendLocalAllowRule, loadSettings } from '../src/config/settings.ts';
import { isTrusted, markTrusted } from '../src/config/trust.ts';
import { danglingToolResults } from '../src/core/messages.ts';
import type { Message } from '../src/core/messages.ts';
import { loadInstructions } from '../src/core/instructions.ts';
import { parseFrontmatter } from '../src/core/frontmatter.ts';
import { createRuntime, loadAgentDefinitions } from '../src/core/runtime.ts';
import { HookRunner } from '../src/hooks/runner.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import { CheckpointStore } from '../src/session/checkpoints.ts';
import { listSessions, restoreHistory, SessionStore } from '../src/session/store.ts';
import type { Prompter } from '../src/tools/types.ts';
import { sanitize } from '../src/ui/render.ts';

let home: string;
beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-home-')));
  process.env.CAIRN_HOME = home;
});

function project(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-infra-')));
}

const prompter: Prompter = {
  permission: async () => ({ behavior: 'allow' }),
  questions: async () => null,
  approvePlan: async () => true,
};
const noChoice = { choose: async () => null };

function writeProjectSettings(dir: string, settings: unknown, file = 'settings.json'): void {
  mkdirSync(join(dir, '.cairn'), { recursive: true });
  writeFileSync(join(dir, '.cairn', file), JSON.stringify(settings));
}

describe('sessions', () => {
  const user: Message = { role: 'user', content: [{ type: 'text', text: 'hello there' }] };
  const assistant: Message = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };

  it('round-trips a conversation through disk, privately', () => {
    const dir = project();
    const store = SessionStore.create(dir, 'm');
    store.appendMessage(user);
    store.appendMessage(assistant);
    assert.deepEqual(restoreHistory(dir, store.id)!.messages, [user, assistant]);
    assert.equal(statSync(store.path!).mode & 0o777, 0o600);
  });

  it('tolerates a partial final line left by a crash', () => {
    const dir = project();
    const store = SessionStore.create(dir, 'm');
    store.appendMessage(user);
    appendFileSync(store.path!, '{"type":"message","mess');
    assert.deepEqual(restoreHistory(dir, store.id)!.messages, [user]);
  });

  it('repairs tool calls that never got a result', () => {
    const dir = project();
    const store = SessionStore.create(dir, 'm');
    store.appendMessage(user);
    store.appendMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] });
    const restored = restoreHistory(dir, store.id)!;
    assert.equal(restored.messages.length, 3);
    assert.equal(restored.repairs!.content[0]!.type, 'tool_result');
    assert.equal(danglingToolResults(restored.messages).length, 0);
  });

  it('starts from the summary after a compaction record', () => {
    const dir = project();
    const store = SessionStore.create(dir, 'm');
    store.appendMessage(user);
    store.appendCompaction('the summary');
    store.appendMessage(assistant);
    assert.deepEqual(restoreHistory(dir, store.id)!.messages, [{ role: 'user', content: [{ type: 'text', text: 'the summary' }] }, assistant]);
  });

  it('lists sessions newest first, with a preview', async () => {
    const dir = project();
    const first = SessionStore.create(dir, 'm');
    first.appendMessage(user);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = SessionStore.create(dir, 'm');
    second.appendMessage({ role: 'user', content: [{ type: 'text', text: 'second one' }] });
    const list = listSessions(dir);
    assert.deepEqual(list.map((s) => s.id), [second.id, first.id]);
    assert.equal(list[1]!.preview, 'hello there');
  });

  it('leaves a session with no messages out of the list', () => {
    const dir = project();
    const real = SessionStore.create(dir, 'm');
    real.appendMessage(user);
    SessionStore.create(dir, 'm');
    assert.deepEqual(listSessions(dir).map((s) => s.id), [real.id]);
  });

  it('writes nothing for an ephemeral store', () => {
    const store = SessionStore.ephemeral();
    store.appendMessage(user);
    assert.equal(store.path, null);
  });
});

describe('resume through the runtime', () => {
  async function runOnce(dir: string, options: Record<string, unknown>, turns = [{ text: 'reply' }]) {
    const provider = new ScriptedProvider(turns);
    const runtime = await createRuntime({ cwd: dir, prompter, provider, ...options });
    for await (const _ of runtime.agent.run('prompt', new AbortController().signal)) { /* drain */ }
    return { runtime, provider };
  }

  it('--continue picks up the latest session under the same id', async () => {
    const dir = project();
    const first = await runOnce(dir, {});
    const second = await runOnce(dir, { continueLast: true });
    assert.equal(second.runtime.agent.sessionId, first.runtime.agent.sessionId);
    assert.equal(second.provider.requests[0]!.messages.length, 3);
  });

  it('--resume finds a session by id, and fails clearly if it does not exist', async () => {
    const dir = project();
    const first = await runOnce(dir, {});
    await runOnce(dir, {});
    const resumed = await runOnce(dir, { resume: first.runtime.agent.sessionId });
    assert.equal(resumed.runtime.agent.sessionId, first.runtime.agent.sessionId);
    await assert.rejects(createRuntime({ cwd: dir, prompter, provider: new ScriptedProvider([]), resume: 'nope' }), /No session nope/);
  });

  it('--fork-session copies history and leaves the original alone', async () => {
    const dir = project();
    const first = await runOnce(dir, {});
    const originalLength = restoreHistory(dir, first.runtime.agent.sessionId)!.messages.length;
    const fork = await runOnce(dir, { resume: first.runtime.agent.sessionId, fork: true });
    assert.notEqual(fork.runtime.agent.sessionId, first.runtime.agent.sessionId);
    assert.equal(fork.provider.requests[0]!.messages.length, 3);
    assert.equal(restoreHistory(dir, first.runtime.agent.sessionId)!.messages.length, originalLength);
  });

  it('does not treat old reads as current after a resume', async () => {
    const dir = project();
    const file = join(dir, 'f');
    writeFileSync(file, 'old');
    await runOnce(dir, {}, [{ toolCalls: [{ name: 'Read', input: { file_path: file } }] } as never, { text: 'ok' }]);
    const second = await runOnce(dir, { continueLast: true, mode: 'bypassPermissions' }, [
      { toolCalls: [{ name: 'Edit', input: { file_path: file, old_string: 'old', new_string: 'new' } }] } as never,
      { text: 'ok' },
    ]);
    assert.match(JSON.stringify(second.provider.requests[1]!.messages.at(-1)), /has not been read/);
    assert.equal(readFileSync(file, 'utf8'), 'old');
  });

  it('--no-session-persistence leaves nothing on disk', async () => {
    const dir = project();
    const { runtime } = await runOnce(dir, { persist: false });
    assert.equal(runtime.agent.transcriptPath, null);
    assert.equal(listSessions(dir).length, 0);
    assert.equal(runtime.context.checkpoints, undefined);
  });
});

describe('checkpoints', () => {
  it('restores changed files and removes created ones', async () => {
    const dir = project();
    const edited = join(dir, 'edited');
    const created = join(dir, 'created');
    writeFileSync(edited, 'original');
    const store = new CheckpointStore('s1');
    store.beginTurn();
    await store.snapshot(edited);
    await store.snapshot(created);
    writeFileSync(edited, 'changed');
    writeFileSync(created, 'new');
    const result = await store.rewind();
    assert.deepEqual(result.restored, [edited]);
    assert.deepEqual(result.removed, [created]);
    assert.equal(readFileSync(edited, 'utf8'), 'original');
    assert.equal(existsSync(created), false);
  });

  it('keeps the first snapshot of a turn, and rewinds across turns', async () => {
    const dir = project();
    const file = join(dir, 'f');
    writeFileSync(file, 'v0');
    const store = new CheckpointStore('s2');
    store.beginTurn();
    await store.snapshot(file);
    writeFileSync(file, 'v1');
    await store.snapshot(file);
    writeFileSync(file, 'v2');
    store.beginTurn();
    await store.snapshot(file);
    writeFileSync(file, 'v3');

    await store.rewind(1);
    assert.equal(readFileSync(file, 'utf8'), 'v2');
    await store.rewind(1);
    assert.equal(readFileSync(file, 'utf8'), 'v0');
    assert.deepEqual((await store.rewind(1)).restored, []);
  });

  it('rewinding several turns at once lands on the earliest state', async () => {
    const dir = project();
    const file = join(dir, 'f');
    writeFileSync(file, 'v0');
    const store = new CheckpointStore('s3');
    for (const next of ['v1', 'v2']) {
      store.beginTurn();
      await store.snapshot(file);
      writeFileSync(file, next);
    }
    await store.rewind(2);
    assert.equal(readFileSync(file, 'utf8'), 'v0');
  });

  it('survives a restart', async () => {
    const dir = project();
    const file = join(dir, 'f');
    writeFileSync(file, 'before');
    const store = new CheckpointStore('s4');
    store.beginTurn();
    await store.snapshot(file);
    writeFileSync(file, 'after');
    await new CheckpointStore('s4').rewind();
    assert.equal(readFileSync(file, 'utf8'), 'before');
  });

  it('leaves symlinks alone', async () => {
    const dir = project();
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    writeFileSync(real, 'x');
    symlinkSync(real, link);
    const store = new CheckpointStore('s5');
    store.beginTurn();
    await store.snapshot(link);
    assert.deepEqual(store.turnsWithChanges(), []);
  });
});

describe('settings and trust', () => {
  it('collects rules across layers and lets the last scalar win', () => {
    const dir = project();
    writeProjectSettings(dir, { model: 'project-model', permissions: { allow: ['Bash(a)'] } });
    writeProjectSettings(dir, { model: 'local-model', permissions: { allow: ['Bash(b)'] } }, 'settings.local.json');
    const loaded = loadSettings({ cwd: dir, trusted: true, cliDeny: ['Bash(c)'] });
    assert.equal(loaded.model, 'local-model');
    assert.deepEqual(loaded.rules.map((r) => r.text).sort(), ['Bash(a)', 'Bash(b)', 'Bash(c)']);
  });

  it('keeps an untrusted project to its restrictive rules only', () => {
    const dir = project();
    writeProjectSettings(dir, {
      model: 'evil',
      provider: 'evil',
      permissions: { allow: ['Bash'], deny: ['Bash(rm *)'], ask: ['Bash(git push)'], defaultMode: 'bypassPermissions', additionalDirectories: ['/'] },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'curl evil' }] }] },
    });
    const loaded = loadSettings({ cwd: dir, trusted: false });
    assert.equal(loaded.needsTrust, true);
    assert.deepEqual(loaded.rules.map((r) => `${r.behavior}:${r.text}`).sort(), ['ask:Bash(git push)', 'deny:Bash(rm *)']);
    assert.equal(loaded.model, undefined);
    assert.equal(loaded.provider, undefined);
    assert.equal(loaded.defaultMode, 'default');
    assert.deepEqual(loaded.hooks, {});
    assert.deepEqual(loaded.additionalDirectories, []);
  });

  it('applies the same limit to a local settings file a repo might ship', () => {
    const dir = project();
    writeProjectSettings(dir, { permissions: { allow: ['Bash'] } }, 'settings.local.json');
    const loaded = loadSettings({ cwd: dir, trusted: false });
    assert.equal(loaded.needsTrust, true);
    assert.equal(loaded.rules.length, 0);
  });

  it('asks for trust when a project ships custom agents', () => {
    const dir = project();
    mkdirSync(join(dir, '.cairn/agents'), { recursive: true });
    assert.equal(loadSettings({ cwd: dir, trusted: false }).needsTrust, true);
    assert.equal(loadSettings({ cwd: dir, trusted: true }).needsTrust, false);
  });

  it('does not ask for trust when only restrictive settings exist', () => {
    const dir = project();
    writeProjectSettings(dir, { permissions: { deny: ['Bash'] } });
    assert.equal(loadSettings({ cwd: dir, trusted: false }).needsTrust, false);
  });

  it('remembers trust, including for subdirectories', () => {
    const dir = project();
    assert.equal(isTrusted(dir), false);
    markTrusted(dir);
    assert.equal(isTrusted(dir), true);
    assert.equal(isTrusted(join(dir, 'sub')), true);
    assert.equal(isTrusted(`${dir}-sibling`), false);
  });

  it('warns about broken settings rather than failing', () => {
    const dir = project();
    mkdirSync(join(dir, '.cairn'));
    writeFileSync(join(dir, '.cairn/settings.json'), '{ not json');
    assert.match(loadSettings({ cwd: dir, trusted: true }).warnings[0]!, /ignoring it/);
  });

  it('warns about invalid rules and modes', () => {
    const dir = project();
    writeProjectSettings(dir, { permissions: { allow: ['*', 42], defaultMode: 'yolo' } });
    assert.equal(loadSettings({ cwd: dir, trusted: true }).warnings.length, 3);
  });

  it('saves an always-allow rule once, in a private file outside the repository', () => {
    const dir = project();
    appendLocalAllowRule(dir, 'Bash(x)');
    appendLocalAllowRule(dir, 'Bash(x)');
    const path = workspaceSettingsPath(dir);
    assert.equal(existsSync(join(dir, '.cairn')), false);
    assert.deepEqual((JSON.parse(readFileSync(path, 'utf8')) as { permissions: { allow: string[] } }).permissions.allow, ['Bash(x)']);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe('instructions', () => {
  it('loads from the root down, so closer instructions come last', () => {
    const dir = project();
    mkdirSync(join(dir, 'a/b'), { recursive: true });
    writeFileSync(join(dir, 'CAIRN.md'), 'top');
    writeFileSync(join(dir, 'a/CAIRN.md'), 'middle');
    writeFileSync(join(dir, 'a/b/CAIRN.md'), 'bottom');
    writeFileSync(join(dir, 'a/b/CAIRN.local.md'), 'personal');
    const contents = loadInstructions(join(dir, 'a/b'), false).files.map((f) => f.content).filter((c) => ['top', 'middle', 'bottom', 'personal'].includes(c));
    assert.deepEqual(contents, ['top', 'middle', 'bottom', 'personal']);
  });

  it('falls back to AGENTS.md, then CLAUDE.md, in a directory with no CAIRN.md', () => {
    const dir = project();
    writeFileSync(join(dir, 'CLAUDE.md'), 'from claude');
    assert.ok(loadInstructions(dir, false).files.some((f) => f.content === 'from claude'));
    writeFileSync(join(dir, 'AGENTS.md'), 'from agents');
    const contents = loadInstructions(dir, false).files.map((f) => f.content);
    assert.ok(contents.includes('from agents'));
    assert.ok(!contents.includes('from claude'));
  });

  it('follows imports relative to the importing file, up to the depth limit', () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), 'See @f1');
    for (let i = 1; i <= 6; i++) writeFileSync(join(dir, `f${i}`), `level ${i} @f${i + 1}`);
    const { files, warnings } = loadInstructions(dir, false);
    const loaded = files.map((f) => f.content);
    assert.ok(loaded.some((c) => c.startsWith('level 4')));
    assert.ok(!loaded.some((c) => c.startsWith('level 5')));
    assert.ok(warnings.some((w) => w.includes('deeper than')));
  });

  it('survives an import cycle', () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), '@other');
    writeFileSync(join(dir, 'other'), '@CAIRN.md');
    assert.equal(loadInstructions(dir, false).files.length, 2);
  });

  it('does not treat code as an import', () => {
    const dir = project();
    writeFileSync(join(dir, 'x'), 'imported');
    writeFileSync(join(dir, 'CAIRN.md'), 'Use `@x` here.\n```\n@x\n```\nor user@x');
    assert.equal(loadInstructions(dir, false).files.length, 1);
  });

  it('blocks imports from outside the project until trusted', () => {
    const dir = project();
    const outside = project();
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, 'outside content');
    writeFileSync(join(dir, 'CAIRN.md'), `@${secret}`);
    const untrusted = loadInstructions(dir, false);
    assert.ok(!untrusted.files.some((f) => f.content === 'outside content'));
    assert.ok(untrusted.warnings.some((w) => w.includes('outside the project')));
    assert.ok(loadInstructions(dir, true).files.some((f) => f.content === 'outside content'));
  });

  it('strips maintainer comments but keeps those in code blocks', () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), 'keep\n<!-- hidden -->\n<!--\nalso hidden\n-->\n```\n<!-- shown -->\n```');
    const content = loadInstructions(dir, false).files.find((f) => f.path.endsWith('CAIRN.md'))!.content;
    assert.doesNotMatch(content, /hidden/);
    assert.match(content, /shown/);
  });
});

describe('hook runner', () => {
  const common = { session_id: 's', transcript_path: null, cwd: tmpdir(), permission_mode: 'default' };
  const runner = (command: string, matcher?: string, extra: Record<string, unknown> = {}) =>
    new HookRunner({ PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command, ...extra }] }] }, tmpdir());
  const input = { tool_name: 'Edit', tool_input: { file_path: '/a' } };

  it('matches tool names exactly, by list, by regex or for everything', async () => {
    const cases: [string | undefined, string, boolean][] = [
      [undefined, 'Edit', true], ['', 'Edit', true], ['*', 'Edit', true], ['Edit', 'Edit', true], ['Edit|Write', 'Write', true],
      ['Edit', 'EditMore', false], ['Ed', 'Edit', false], ['Ed.*', 'Edit', true], ['(unbalanced', 'Edit', false],
    ];
    for (const [matcher, tool, expected] of cases) {
      const result = await runner('exit 2', matcher).run('PreToolUse', common, { tool_name: tool });
      assert.equal(result.blocked, expected, `${matcher} vs ${tool}`);
    }
  });

  it('applies an `if` rule to narrow when a hook runs', async () => {
    const hook = runner('exit 2', undefined, { if: 'Bash(rm *)' });
    assert.equal((await hook.run('PreToolUse', common, { tool_name: 'Bash', tool_input: { command: 'rm x' } })).blocked, true);
    assert.equal((await hook.run('PreToolUse', common, { tool_name: 'Bash', tool_input: { command: 'ls' } })).blocked, false);
    assert.equal((await hook.run('PreToolUse', common, { tool_name: 'Edit', tool_input: {} })).blocked, false);
  });

  it('picks the most restrictive decision across several hooks', async () => {
    const decision = (d: string) => `echo '${JSON.stringify({ hookSpecificOutput: { permissionDecision: d, permissionDecisionReason: d } })}'`;
    const hook = new HookRunner({ PreToolUse: [{ hooks: [{ type: 'command', command: decision('allow') }, { type: 'command', command: decision('deny') }, { type: 'command', command: decision('ask') }] }] }, tmpdir());
    const result = await hook.run('PreToolUse', common, input);
    assert.equal(result.permission, 'deny');
    assert.equal(result.permissionReason, 'deny');
  });

  it('treats other exit codes and bad JSON as non-blocking notices', async () => {
    const failed = await runner('echo boom >&2; exit 7').run('PreToolUse', common, input);
    assert.equal(failed.blocked, false);
    assert.match(failed.notices[0]!, /exit 7.*boom/);
    const bad = await runner(`echo '{broken'`).run('PreToolUse', common, input);
    assert.equal(bad.blocked, false);
    assert.match(bad.notices[0]!, /invalid JSON/);
  });

  it('times out a stuck hook without blocking', async () => {
    const started = Date.now();
    const result = await runner('sleep 30', undefined, { timeout: 0.2 }).run('PreToolUse', common, input);
    assert.ok(Date.now() - started < 5000);
    assert.equal(result.blocked, false);
    assert.match(result.notices[0]!, /timed out/);
  });

  it('does not fail on a hook that ignores its stdin', async () => {
    const big = { tool_name: 'Edit', tool_input: { content: 'x'.repeat(5_000_000) } };
    assert.equal((await runner('exit 0').run('PreToolUse', common, big)).blocked, false);
  });

  it('exposes the project directory, and does nothing with no hooks configured', async () => {
    const result = await new HookRunner({ SessionStart: [{ hooks: [{ type: 'command', command: 'echo $CAIRN_PROJECT_DIR' }] }] }, '/some/dir').run('SessionStart', common);
    assert.deepEqual(result.additionalContext, ['/some/dir']);
    assert.deepEqual((await new HookRunner({}, tmpdir()).run('Stop', common)).notices, []);
  });
});

describe('slash commands', () => {
  async function runtimeWith(turns = [{ text: 'hi' }], dir = project()) {
    return createRuntime({ cwd: dir, prompter, provider: new ScriptedProvider(turns) });
  }

  it('reports status, cost and permissions', async () => {
    const runtime = await runtimeWith();
    assert.match((await runSlashCommand('/status', runtime, noChoice)).output!, /Provider: scripted/);
    assert.match((await runSlashCommand('/cost', runtime, noChoice)).output!, /Input:/);
    assert.match((await runSlashCommand('/permissions', runtime, noChoice)).output!, /Mode: default/);
    assert.match((await runSlashCommand('/context', runtime, noChoice)).output!, /No measurement yet/);
  });

  it('changes the model, effort and mode, and rejects bad values', async () => {
    const runtime = await runtimeWith();
    await runSlashCommand('/model other', runtime, noChoice);
    assert.equal(runtime.agent.model, 'other');
    await runSlashCommand('/effort high', runtime, noChoice);
    assert.equal(runtime.agent.effort, 'high');
    await runSlashCommand('/mode plan', runtime, noChoice);
    assert.equal(runtime.engine.mode, 'plan');
    assert.match((await runSlashCommand('/mode nope', runtime, noChoice)).output!, /Unknown mode/);
    assert.match((await runSlashCommand('/effort nope', runtime, noChoice)).output!, /Unknown effort/);
    assert.equal(runtime.engine.mode, 'plan');
  });

  it('/clear starts a new session with an empty history', async () => {
    const runtime = await runtimeWith();
    for await (const _ of runtime.agent.run('x', new AbortController().signal)) { /* drain */ }
    const before = runtime.agent.sessionId;
    await runSlashCommand('/clear', runtime, noChoice);
    assert.notEqual(runtime.agent.sessionId, before);
    assert.equal(runtime.agent.messages.length, 0);
  });

  it('/rewind undoes the agent\'s file edits end to end', async () => {
    const dir = project();
    const file = join(dir, 'f');
    writeFileSync(file, 'original');
    const runtime = await createRuntime({
      cwd: dir,
      prompter,
      mode: 'bypassPermissions',
      provider: new ScriptedProvider([
        { toolCalls: [{ name: 'Read', input: { file_path: file } }] },
        { toolCalls: [{ name: 'Edit', input: { file_path: file, old_string: 'original', new_string: 'changed' } }] },
        { text: 'done' },
      ]),
    });
    for await (const _ of runtime.agent.run('edit', new AbortController().signal)) { /* drain */ }
    assert.equal(readFileSync(file, 'utf8'), 'changed');
    assert.match((await runSlashCommand('/rewind', runtime, noChoice)).output!, /restored/);
    assert.equal(readFileSync(file, 'utf8'), 'original');
    assert.match((await runSlashCommand('/rewind', runtime, noChoice)).output!, /No file changes/);
    assert.match((await runSlashCommand('/rewind x', runtime, noChoice)).output!, /Usage/);
  });

  it('/resume switches session through the picker', async () => {
    const dir = project();
    const first = await runtimeWith([{ text: 'one' }], dir);
    for await (const _ of first.agent.run('first prompt', new AbortController().signal)) { /* drain */ }
    const second = await runtimeWith([], dir);
    const result = await runSlashCommand('/resume', second, { choose: async () => 0 });
    assert.match(result.output!, /Resumed/);
    assert.equal(second.agent.sessionId, first.agent.sessionId);
    assert.equal(second.agent.messages.length, 2);
  });

  it('expands custom commands with $ARGUMENTS and lists them', async () => {
    const dir = project();
    mkdirSync(join(dir, '.cairn/commands'), { recursive: true });
    writeFileSync(join(dir, '.cairn/commands/review.md'), '---\ndescription: Review a thing\n---\nReview $ARGUMENTS carefully.');
    writeFileSync(join(dir, '.cairn/commands/plain.md'), 'Do the plain thing.');
    const runtime = await createRuntime({ cwd: dir, prompter, provider: new ScriptedProvider([]), trust: true });
    const run = async (line: string) => settleCommand(await runSlashCommand(line, runtime, noChoice), new AbortController().signal);
    assert.match((await run('/review src/a.ts')).prompt!, /Review src\/a\.ts carefully\.$/);
    assert.match((await run('/plain extra')).prompt!, /Do the plain thing\.\n\nARGUMENTS: extra$/);
    assert.match((await run('/help')).output!, /review\s+Review a thing/);
    assert.ok(commandNames(runtime).includes('/review'));
  });

  it('ignores an untrusted project\'s custom commands', async () => {
    const dir = project();
    mkdirSync(join(dir, '.cairn/commands'), { recursive: true });
    writeFileSync(join(dir, '.cairn/commands/review.md'), 'Review it.');
    const runtime = await runtimeWith([], dir);
    assert.match((await runSlashCommand('/review', runtime, noChoice)).output!, /Unknown command/);
  });

  it('/trust records the directory', async () => {
    const dir = project();
    const runtime = await runtimeWith([], dir);
    assert.match((await runSlashCommand('/trust', runtime, noChoice)).output!, /Trusted/);
    assert.equal(isTrusted(dir), true);
  });

  it('handles exit, compact and unknown commands', async () => {
    const runtime = await runtimeWith();
    assert.equal((await runSlashCommand('/exit', runtime, noChoice)).exit, true);
    assert.equal((await runSlashCommand('/quit', runtime, noChoice)).exit, true);
    assert.match((await runSlashCommand('/compact', runtime, noChoice)).output!, /Nothing to compact/);
    for await (const _ of runtime.agent.run('x', new AbortController().signal)) { /* drain */ }
    assert.deepEqual((await runSlashCommand('/compact the API', runtime, noChoice)).compact, { focus: 'the API' });
    assert.match((await runSlashCommand('/nope', runtime, noChoice)).output!, /Unknown command/);
    assert.ok((await runSlashCommand('/init', runtime, noChoice)).prompt);
  });
});

describe('agent definitions', () => {
  it('parses frontmatter, and leaves text without it alone', () => {
    assert.deepEqual(parseFrontmatter('---\nname: x\ntools: "a, b"\n---\nbody'), { fields: { name: 'x', tools: 'a, b' }, body: 'body' });
    assert.deepEqual(parseFrontmatter('plain'), { fields: {}, body: 'plain' });
  });

  it('loads custom agents, and project ones only when trusted', () => {
    const dir = project();
    mkdirSync(join(dir, '.cairn/agents'), { recursive: true });
    writeFileSync(join(dir, '.cairn/agents/rev.md'), '---\ndescription: Reviews\ntools: Read, Grep\nmodel: small\n---\nYou review.');
    assert.ok(!loadAgentDefinitions(dir, false).some((a) => a.name === 'rev'));
    const rev = loadAgentDefinitions(dir, true).find((a) => a.name === 'rev')!;
    assert.deepEqual(rev.tools, ['Read', 'Grep']);
    assert.equal(rev.model, 'small');
    assert.equal(rev.prompt, 'You review.');
  });
});

describe('terminal output safety', () => {
  it('strips escape sequences and control characters, and keeps ordinary text', () => {
    assert.equal(sanitize('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(sanitize('a\x1b]0;evil title\x07b'), 'ab');
    assert.equal(sanitize('a\rb\x07c\x00d'), 'abcd');
    assert.equal(sanitize('line one\n\ttabbed tiếng Việt'), 'line one\n\ttabbed tiếng Việt');
  });

  it('confirms home is isolated for these tests', () => {
    assert.equal(process.env.CAIRN_HOME, home);
  });
});
