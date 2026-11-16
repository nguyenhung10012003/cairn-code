/** The tools that act on the session itself: EnterWorktree, ExitWorktree and PushNotification. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, it, setSystemTime } from 'bun:test';
import type { ToolResultBlock } from '../src/core/messages.ts';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { Prompter } from '../src/tools/types.ts';

const prompter: Prompter = { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true };

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

beforeAll(() => {
  process.env.KARST_HOME = tempDir('karst-session-home-');
});

async function run(runtime: Runtime, prompt: string): Promise<void> {
  for await (const _event of runtime.agent.run(prompt, new AbortController().signal)) {
    // Run it to the end.
  }
}

/** Every tool result the model was sent, in order. */
function results(provider: ScriptedProvider): ToolResultBlock[] {
  return provider.requests.flatMap((request) => request.messages.at(-1)!.content.filter((block): block is ToolResultBlock => block.type === 'tool_result'));
}

describe('EnterWorktree and ExitWorktree', () => {
  function repo(): string {
    const root = tempDir('karst-wt-tools-');
    const git = (...args: string[]) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '));
    git('init', '-q');
    git('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'first');
    return root;
  }
  const branches = (root: string): string => spawnSync('git', ['branch'], { cwd: root, encoding: 'utf8' }).stdout;

  it('work in a new worktree, and remove it only once the model says to discard its changes', async () => {
    const root = repo();
    const worktree = join(root, '.karst/worktrees/feature');
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'EnterWorktree', input: { name: 'feature' } }] },
      { toolCalls: [{ name: 'Bash', input: { command: 'touch made-here' } }] },
      { toolCalls: [{ name: 'ExitWorktree', input: { action: 'remove' } }] },
      { toolCalls: [{ name: 'ExitWorktree', input: { action: 'remove', discard_changes: true } }] },
      { toolCalls: [{ name: 'ExitWorktree', input: { action: 'keep' } }] },
      { text: 'done' },
    ]);
    const runtime = await createRuntime({ cwd: root, provider, persist: false, prompter });
    await run(runtime, 'work in a worktree');
    const [entered, touched, refused, removed, noop] = results(provider);

    assert.match(entered!.content, new RegExp(`^Created the worktree at ${worktree} on branch worktree-feature`));
    assert.equal(touched!.is_error, undefined, touched!.content);
    assert.equal(existsSync(join(root, 'made-here')), false, 'the command ran in the worktree, not the main checkout');

    assert.equal(refused!.is_error, true);
    assert.match(refused!.content, /has work that removing it would lose:\nuncommitted changes:\n\?\? made-here/);
    assert.equal(removed!.is_error, undefined, removed!.content);
    assert.equal(removed!.content, `Removed the worktree at ${worktree}. Back in ${root}.`);
    assert.equal(noop!.content, 'No worktree session is active, so nothing was changed.');

    assert.equal(runtime.context.cwd(), root);
    assert.equal(existsSync(worktree), false);
    assert.doesNotMatch(branches(root), /worktree-feature/);
    await runtime.shutdown();
  });

  it('keep a worktree, switch back into it by path, and never remove one they did not create', async () => {
    const root = repo();
    const worktree = join(root, '.karst/worktrees/keepme');
    const outside = tempDir('karst-wt-outside-');
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'EnterWorktree', input: { name: 'keepme', path: worktree } }] },
      { toolCalls: [{ name: 'EnterWorktree', input: { name: 'keepme' } }] },
      { toolCalls: [{ name: 'EnterWorktree', input: { name: 'another' } }] },
      { toolCalls: [{ name: 'ExitWorktree', input: { action: 'keep' } }] },
      { toolCalls: [{ name: 'EnterWorktree', input: { path: worktree } }] },
      { toolCalls: [{ name: 'ExitWorktree', input: { action: 'remove', discard_changes: true } }] },
      { toolCalls: [{ name: 'ExitWorktree', input: { action: 'keep' } }] },
      { toolCalls: [{ name: 'EnterWorktree', input: { path: outside } }] },
      { text: 'done' },
    ]);
    const runtime = await createRuntime({ cwd: root, provider, persist: false, prompter });
    await run(runtime, 'use a worktree');
    const [both, created, second, kept, switched, notOurs, back, unlisted] = results(provider);

    assert.equal(both!.is_error, true);
    assert.equal(both!.content, 'Give name or path, not both.');
    assert.match(created!.content, /^Created the worktree/);
    assert.equal(second!.is_error, true);
    assert.match(second!.content, new RegExp(`^Already in a worktree session at ${worktree}`));
    assert.equal(kept!.content, `Kept the worktree at ${worktree} (branch worktree-keepme). Back in ${root}.`);
    assert.equal(existsSync(worktree), true);

    assert.match(switched!.content, new RegExp(`^Switched the session into the existing worktree at ${worktree}`));
    assert.equal(notOurs!.is_error, true);
    assert.match(notOurs!.content, /was not created by EnterWorktree in this session, so it is not removed/);
    assert.equal(back!.content, `Kept the worktree at ${worktree}. Back in ${root}.`);
    assert.equal(unlisted!.is_error, true);
    assert.match(unlisted!.content, /is not listed by git worktree list for this repository/);

    assert.equal(runtime.context.cwd(), root);
    assert.equal(existsSync(worktree), true, 'a worktree entered by path stays on disk');
    assert.match(branches(root), /worktree-keepme/);
    await runtime.shutdown();
  });
});

describe('PushNotification', () => {
  it('is skipped while the user is at the terminal, and sends one line of at most 200 characters once they are away', async () => {
    const shown: string[] = [];
    const long = `build failed:\n  ${'x'.repeat(250)}`;
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'PushNotification', input: { message: 'too soon', status: 'proactive' } }] },
      { text: 'ok' },
      { toolCalls: [{ name: 'PushNotification', input: { message: long, status: 'proactive' } }] },
      { text: 'ok' },
    ]);
    const runtime = await createRuntime({
      cwd: tempDir('karst-push-'),
      provider,
      persist: false,
      prompter,
      desktopNotification: (message) => shown.push(message) > 0,
    });
    await run(runtime, 'start the build');
    setSystemTime(new Date(Date.now() + 2 * 60_000));
    try {
      await run(runtime, 'the build finished');
    } finally {
      setSystemTime();
    }

    const [skipped, sent] = results(provider);
    assert.equal(skipped!.content, 'Not sent: the user is at the terminal, so your output already reaches them.');
    assert.equal(sent!.content, 'Sent: shown as a desktop notification.');
    assert.deepEqual(shown, [`build failed: ${'x'.repeat(250)}`.slice(0, 200)]);
    await runtime.shutdown();
  });

  it('is not offered to a session nobody is watching', async () => {
    const provider = new ScriptedProvider([{ text: 'ok' }]);
    const runtime = await createRuntime({ cwd: tempDir('karst-push-'), provider, persist: false, prompter, unattended: true });
    await run(runtime, 'hi');
    const offered = provider.requests[0]!.tools.map((tool) => tool.name);
    assert.ok(offered.includes('Read'), offered.join(', '));
    assert.equal(offered.includes('PushNotification'), false);
    await runtime.shutdown();
  });
});
