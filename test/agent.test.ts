import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, it } from 'bun:test';
import { workspaceSettingsPath } from '../src/config/paths.ts';
import type { AgentEvent } from '../src/core/agent.ts';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime, RuntimeOptions } from '../src/core/runtime.ts';
import type { ToolResultBlock } from '../src/core/messages.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { ScriptedTurn } from '../src/providers/scripted.ts';
import type { PermissionAnswer, PermissionPrompt, Prompter } from '../src/tools/types.ts';

beforeAll(() => {
  process.env.CAIRN_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-home-')));
});

function project(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-agent-')));
}

interface Harness {
  runtime: Runtime;
  provider: ScriptedProvider;
  prompts: PermissionPrompt[];
  dir: string;
}

async function harness(turns: ScriptedTurn[], options: Partial<RuntimeOptions> & { answer?: PermissionAnswer; contextWindow?: number; dir?: string } = {}): Promise<Harness> {
  const dir = options.dir ?? project();
  const provider = new ScriptedProvider(turns, options.contextWindow ? { contextWindow: options.contextWindow } : {});
  const prompts: PermissionPrompt[] = [];
  const prompter: Prompter = {
    permission: async (prompt) => {
      prompts.push(prompt);
      return options.answer ?? { behavior: 'allow' };
    },
    questions: async () => null,
    approvePlan: async () => true,
  };
  const { answer: _answer, contextWindow: _window, dir: _dir, ...rest } = options;
  const runtime = await createRuntime({ cwd: dir, prompter, provider, ...rest });
  return { runtime, provider, prompts, dir };
}

async function collect(runtime: Runtime, prompt: string, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runtime.agent.run(prompt, signal)) events.push(event);
  return events;
}

function lastTurn(events: AgentEvent[]): Extract<AgentEvent, { type: 'turn_end' }> {
  return events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>;
}

function toolResults(h: Harness, requestIndex: number): ToolResultBlock[] {
  const request = h.provider.requests[requestIndex]!;
  return request.messages.at(-1)!.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
}

describe('agent loop', () => {
  it('ends when the model answers without tools', async () => {
    const h = await harness([{ text: 'Hello there' }]);
    const events = await collect(h.runtime, 'hi');
    const turn = lastTurn(events);
    assert.equal(turn.stopReason, 'end_turn');
    assert.equal(turn.text, 'Hello there');
    assert.equal(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join(''), 'Hello there');
  });

  it('runs a tool, returns the result, and continues', async () => {
    const dir = project();
    writeFileSync(join(dir, 'a.txt'), 'content here');
    const h = await harness(
      [{ toolCalls: [{ name: 'Read', input: { file_path: join(dir, 'a.txt') } }] }, { text: 'done' }],
      { dir },
    );
    const events = await collect(h.runtime, 'read it');
    assert.equal(lastTurn(events).text, 'done');
    assert.equal(h.provider.requests.length, 2);
    assert.match(toolResults(h, 1)[0]!.content, /content here/);
    assert.deepEqual(h.runtime.agent.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  });

  it('returns parallel results in one user message, in call order', async () => {
    const dir = project();
    writeFileSync(join(dir, 'a'), 'AAA');
    writeFileSync(join(dir, 'b'), 'BBB');
    const h = await harness(
      [
        {
          toolCalls: [
            { name: 'Read', input: { file_path: join(dir, 'a') }, id: 't1' },
            { name: 'Read', input: { file_path: join(dir, 'b') }, id: 't2' },
            { name: 'Bash', input: { command: 'echo CCC' }, id: 't3' },
            { name: 'Read', input: { file_path: join(dir, 'a') }, id: 't4' },
          ],
        },
        { text: 'ok' },
      ],
      { dir },
    );
    await collect(h.runtime, 'go');
    const results = toolResults(h, 1);
    assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2', 't3', 't4']);
    assert.match(results[2]!.content, /CCC/);
    assert.equal(h.provider.requests[1]!.messages.length, 3);
  });

  it('actually runs read-only calls at the same time', async () => {
    const dir = project();
    const h = await harness(
      [{ toolCalls: [
        { name: 'Agent', input: { description: 'one', prompt: 'x' } },
        { name: 'Agent', input: { description: 'two', prompt: 'x' } },
      ] }, { text: 'sub' }, { text: 'sub' }, { text: 'main' }],
      { dir },
    );
    const events = await collect(h.runtime, 'go');
    const order = events.filter((e) => e.type === 'tool_start' || e.type === 'tool_end').map((e) => e.type);
    assert.deepEqual(order, ['tool_start', 'tool_start', 'tool_end', 'tool_end']);
  });

  it('hands an unknown tool or invalid input back to the model as an error', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Nope', input: {} }, { name: 'Read', input: { wrong: 1 } }] },
      { text: 'recovered' },
    ]);
    const events = await collect(h.runtime, 'go');
    const results = toolResults(h, 1);
    assert.match(results[0]!.content, /No such tool/);
    assert.equal(results[0]!.is_error, true);
    assert.match(results[1]!.content, /Invalid input/);
    assert.equal(lastTurn(events).text, 'recovered');
  });

  it('turns a thrown tool error into a result the model can see', async () => {
    const dir = project();
    const h = await harness(
      [{ toolCalls: [{ name: 'Write', input: { file_path: join(dir, 'a.txt', 'b'), content: 'x' } }] }, { text: 'ok' }],
      { dir, mode: 'bypassPermissions' },
    );
    writeFileSync(join(dir, 'a.txt'), 'a file, not a directory');
    await collect(h.runtime, 'go');
    assert.equal(toolResults(h, 1)[0]!.is_error, true);
  });

  it('stops at the turn limit', async () => {
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }] }, { toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }] }],
      { maxTurns: 1, mode: 'bypassPermissions' },
    );
    assert.equal(lastTurn(await collect(h.runtime, 'go')).stopReason, 'max_turns');
  });

  it('accumulates usage', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }], usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
      { text: 'ok', usage: { inputTokens: 200, outputTokens: 20 } },
    ], { mode: 'bypassPermissions' });
    await collect(h.runtime, 'go');
    assert.equal(h.runtime.agent.totalUsage.inputTokens, 300);
    assert.equal(h.runtime.agent.totalUsage.outputTokens, 30);
    assert.equal(h.runtime.agent.totalUsage.cacheReadTokens, 50);
  });
});

describe('stop reasons', () => {
  it('never runs a tool call that was cut off by max_tokens', async () => {
    const dir = project();
    const target = join(dir, 'should-not-exist');
    const h = await harness(
      [
        { toolCalls: [{ name: 'Write', input: { file_path: target, content: 'partial' } }], stopReason: 'max_tokens' },
        { text: 'retried' },
      ],
      { dir, mode: 'bypassPermissions' },
    );
    const events = await collect(h.runtime, 'go');
    assert.equal(existsSync(target), false);
    assert.match(toolResults(h, 1)[0]!.content, /cut off/);
    assert.equal(lastTurn(events).text, 'retried');
  });

  it('reports text cut off by max_tokens', async () => {
    const h = await harness([{ text: 'partial', stopReason: 'max_tokens' }]);
    const turn = lastTurn(await collect(h.runtime, 'go'));
    assert.equal(turn.stopReason, 'max_tokens');
    assert.equal(turn.text, 'partial');
  });

  it('stops on a refusal, runs nothing from it, and keeps none of it in history', async () => {
    const dir = project();
    const marker = join(dir, 'marker');
    const h = await harness(
      [{ text: 'partial', toolCalls: [{ name: 'Bash', input: { command: `touch ${marker}` } }], stopReason: 'refusal', stopDetail: 'policy' }, { text: 'next' }],
      { dir, mode: 'bypassPermissions' },
    );
    const events = await collect(h.runtime, 'go');
    assert.equal(lastTurn(events).stopReason, 'refusal');
    assert.equal(lastTurn(events).text, '');
    assert.ok(events.some((e) => e.type === 'notice' && e.text.includes('policy')));
    assert.equal(existsSync(marker), false);
    assert.deepEqual(h.runtime.agent.messages.map((m) => m.role), ['user']);
    assert.equal(lastTurn(await collect(h.runtime, 'again')).text, 'next');
  });

  it('adds no empty assistant message, which the API would reject', async () => {
    const h = await harness([{}, { text: 'second' }]);
    assert.equal(lastTurn(await collect(h.runtime, 'first')).stopReason, 'end_turn');
    assert.deepEqual(h.runtime.agent.messages.map((m) => m.role), ['user']);
    await collect(h.runtime, 'again');
    assert.ok(h.provider.requests[1]!.messages.every((m) => m.content.length > 0));
  });

  it('tells the user once when another model answers, and again if that changes', async () => {
    const h = await harness([{ text: 'a', servedBy: 'other' }, { text: 'b', servedBy: 'other' }, { text: 'c' }, { text: 'd', servedBy: 'other' }]);
    const notices = async (prompt: string) => (await collect(h.runtime, prompt)).filter((e) => e.type === 'notice' && e.text.includes('answered instead')).length;
    assert.deepEqual([await notices('1'), await notices('2'), await notices('3'), await notices('4')], [1, 0, 0, 1]);
  });

  it('adds up estimated cost, and flags the total when a price is unknown', async () => {
    const h = await harness([{ text: 'a', costUsd: 0.25 }, { text: 'b', costUsd: 0.5 }]);
    await collect(h.runtime, '1');
    await collect(h.runtime, '2');
    assert.equal(h.runtime.agent.totalCostUsd, 0.75);
    assert.equal(h.runtime.agent.costIsPartial, false);
    const unknown = await harness([{ text: 'a' }]);
    await collect(unknown.runtime, '1');
    assert.equal(unknown.runtime.agent.costIsPartial, true);
  });

  it('shows what the provider has to say about the response', async () => {
    const h = await harness([{ text: 'a', notices: ['heads up'] }]);
    assert.ok((await collect(h.runtime, '1')).some((e) => e.type === 'notice' && e.text === 'heads up'));
  });

  it('resends on a pause without adding a message', async () => {
    const h = await harness([{ text: 'partway', stopReason: 'pause' }, { text: 'finished' }]);
    const events = await collect(h.runtime, 'go');
    assert.equal(lastTurn(events).text, 'finished');
    assert.equal(h.provider.requests[1]!.messages.at(-1)!.role, 'assistant');
  });

  it('reports a provider error without breaking the session', async () => {
    const h = await harness([{ error: 'overloaded' }, { text: 'back' }]);
    const failed = lastTurn(await collect(h.runtime, 'first'));
    assert.equal(failed.stopReason, 'error');
    assert.equal(failed.error, 'overloaded');
    assert.equal(lastTurn(await collect(h.runtime, 'second')).text, 'back');
  });
});

describe('permissions in the loop', () => {
  it('asks, then runs the call on approval', async () => {
    const h = await harness([{ toolCalls: [{ name: 'Bash', input: { command: 'mkdir made && echo approved' } }] }, { text: 'ok' }]);
    await collect(h.runtime, 'go');
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0]!.toolName, 'Bash');
    assert.match(toolResults(h, 1)[0]!.content, /approved/);
  });

  it('does not run the call when declined, and passes on the feedback', async () => {
    const dir = project();
    const target = join(dir, 'marker');
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: `touch ${target}` } }] }, { text: 'ok' }],
      { dir, answer: { behavior: 'deny', feedback: 'use make instead' } },
    );
    await collect(h.runtime, 'go');
    assert.equal(existsSync(target), false);
    const result = toolResults(h, 1)[0]!;
    assert.equal(result.is_error, true);
    assert.match(result.content, /use make instead/);
  });

  it('applies "always" to later calls in the session and saves shell approvals', async () => {
    const dir = project();
    const h = await harness(
      [
        { toolCalls: [{ name: 'Bash', input: { command: 'echo one' } }] },
        { toolCalls: [{ name: 'Bash', input: { command: 'npm-like run' } }] },
        { toolCalls: [{ name: 'Bash', input: { command: 'npm-like run' } }] },
        { text: 'ok' },
      ],
      { dir, answer: { behavior: 'allow', always: true } },
    );
    await collect(h.runtime, 'go');
    assert.equal(h.prompts.length, 1);
    const saved = JSON.parse(readFileSync(workspaceSettingsPath(dir), 'utf8')) as { permissions: { allow: string[] } };
    assert.deepEqual(saved.permissions.allow, ['Bash(npm-like run)']);
    assert.equal(existsSync(join(dir, '.cairn')), false);
  });

  it('does not offer a saved rule for a forced prompt', async () => {
    const dir = project();
    const h = await harness([{ toolCalls: [{ name: 'Bash', input: { command: 'rm -rf /nonexistent-top' } }] }, { text: 'ok' }], { dir, answer: { behavior: 'deny' } });
    await collect(h.runtime, 'go');
    assert.equal(h.prompts[0]!.forced, true);
  });

  it('hides a tool removed by a bare deny rule, and refuses a call to it anyway', async () => {
    const h = await harness([{ toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }] }, { text: 'ok' }], { disallowedTools: ['Bash'] });
    await collect(h.runtime, 'go');
    assert.ok(!h.provider.requests[0]!.tools.some((t) => t.name === 'Bash'));
    assert.match(toolResults(h, 1)[0]!.content, /No such tool/);
  });

  it('in plan mode refuses edits but allows ExitPlanMode to unlock them', async () => {
    const dir = project();
    const file = join(dir, 'f');
    const h = await harness(
      [
        { toolCalls: [{ name: 'Write', input: { file_path: file, content: 'x' } }] },
        { toolCalls: [{ name: 'ExitPlanMode', input: { plan: 'the plan' } }] },
        { toolCalls: [{ name: 'Write', input: { file_path: file, content: 'x' } }] },
        { text: 'ok' },
      ],
      { dir, mode: 'plan', answer: { behavior: 'allow' } },
    );
    await collect(h.runtime, 'go');
    assert.match(toolResults(h, 1)[0]!.content, /Plan mode/);
    assert.equal(h.runtime.engine.mode, 'default');
    assert.equal(readFileSync(file, 'utf8'), 'x');
  });
});

describe('interruption', () => {
  it('stops mid-request and leaves a usable session', async () => {
    const controller = new AbortController();
    const h = await harness([{ text: 'slow', delayMs: 5000 }, { text: 'next' }]);
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const events = await collect(h.runtime, 'first', controller.signal);
    assert.ok(Date.now() - started < 2000);
    assert.equal(lastTurn(events).stopReason, 'interrupted');
    assert.equal(lastTurn(await collect(h.runtime, 'second')).text, 'next');
  });

  it('closes every open tool call when interrupted during tools', async () => {
    const controller = new AbortController();
    const h = await harness(
      [
        {
          toolCalls: [
            { name: 'Bash', input: { command: 'tail -f /dev/null' }, id: 'a' },
            { name: 'Bash', input: { command: 'echo never' }, id: 'b' },
          ],
        },
        { text: 'next' },
      ],
      { mode: 'bypassPermissions' },
    );
    setTimeout(() => controller.abort(), 100);
    const events = await collect(h.runtime, 'go', controller.signal);
    assert.equal(lastTurn(events).stopReason, 'interrupted');
    const results = h.runtime.agent.messages.at(-1)!.content as ToolResultBlock[];
    assert.deepEqual(results.map((r) => r.tool_use_id), ['a', 'b']);
    assert.ok(results.every((r) => r.is_error === true));
  });
});

describe('interruption while a call is being approved', () => {
  it('does not start a call when the interrupt arrived during its approval', async () => {
    const dir = project();
    const marker = join(dir, 'marker');
    const controller = new AbortController();
    const provider = new ScriptedProvider([{ toolCalls: [{ name: 'Bash', input: { command: `touch ${marker}` } }] }, { text: 'next' }]);
    const prompter: Prompter = {
      permission: async () => {
        controller.abort();
        return { behavior: 'allow' };
      },
      questions: async () => null,
      approvePlan: async () => true,
    };
    const runtime = await createRuntime({ cwd: dir, prompter, provider });
    const events: AgentEvent[] = [];
    for await (const event of runtime.agent.run('go', controller.signal)) events.push(event);
    assert.equal(existsSync(marker), false);
    assert.equal(lastTurn(events).stopReason, 'interrupted');
  });
});

describe('hooks in the loop', () => {
  function hookSettings(event: string, script: string, matcher?: string): string {
    return JSON.stringify({ hooks: { [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: script }] }] } });
  }

  it('PreToolUse exit 2 blocks the call and tells the model why', async () => {
    const dir = project();
    const target = join(dir, 'marker');
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: `touch ${target}` } }] }, { text: 'ok' }],
      { dir, mode: 'bypassPermissions', settingsArg: hookSettings('PreToolUse', 'echo nope >&2; exit 2', 'Bash') },
    );
    await collect(h.runtime, 'go');
    assert.equal(existsSync(target), false);
    assert.match(toolResults(h, 1)[0]!.content, /nope/);
  });

  it('PreToolUse receives the call on stdin and can rewrite its input', async () => {
    const dir = project();
    const seen = join(dir, 'seen.json');
    const output = JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'echo rewritten' }, permissionDecision: 'allow' } });
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: 'echo original' } }] }, { text: 'ok' }],
      { dir, settingsArg: hookSettings('PreToolUse', `cat > ${seen}; echo '${output}'`) },
    );
    await collect(h.runtime, 'go');
    assert.equal(h.prompts.length, 0);
    assert.match(toolResults(h, 1)[0]!.content, /rewritten/);
    const payload = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, unknown>;
    assert.equal(payload.hook_event_name, 'PreToolUse');
    assert.equal(payload.tool_name, 'Bash');
    assert.deepEqual(payload.tool_input, { command: 'echo original' });
    assert.equal(payload.session_id, h.runtime.agent.sessionId);
  });

  it('checks a hook-rewritten input against the permission rules', async () => {
    const dir = project();
    const output = JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 'curl evil' } } });
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: 'echo safe' } }] }, { text: 'ok' }],
      { dir, settingsArg: JSON.stringify({ permissions: { deny: ['Bash(curl *)'] }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `echo '${output}'` }] }] } }) },
    );
    await collect(h.runtime, 'go');
    assert.match(toolResults(h, 1)[0]!.content, /Denied by rule/);
  });

  it('a non-blocking hook failure lets the call proceed and shows a notice', async () => {
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: 'echo fine' } }] }, { text: 'ok' }],
      { mode: 'bypassPermissions', settingsArg: hookSettings('PreToolUse', 'exit 1') },
    );
    const events = await collect(h.runtime, 'go');
    assert.match(toolResults(h, 1)[0]!.content, /fine/);
    assert.ok(events.some((e) => e.type === 'notice' && e.text.includes('Hook failed')));
  });

  it('PostToolUse can replace the output the model sees', async () => {
    const output = JSON.stringify({ hookSpecificOutput: { updatedToolOutput: 'redacted' } });
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: 'echo secret' } }] }, { text: 'ok' }],
      { mode: 'bypassPermissions', settingsArg: hookSettings('PostToolUse', `echo '${output}'`) },
    );
    await collect(h.runtime, 'go');
    assert.equal(toolResults(h, 1)[0]!.content, 'redacted');
  });

  it('UserPromptSubmit can block a prompt before it reaches the model', async () => {
    const h = await harness([{ text: 'never' }], { settingsArg: hookSettings('UserPromptSubmit', 'echo blocked >&2; exit 2') });
    await collect(h.runtime, 'go');
    assert.equal(h.provider.requests.length, 0);
    assert.equal(h.runtime.agent.messages.length, 0);
  });

  it('UserPromptSubmit stdout is added as context', async () => {
    const h = await harness([{ text: 'ok' }], { settingsArg: hookSettings('UserPromptSubmit', 'echo extra-context') });
    await collect(h.runtime, 'go');
    assert.match(JSON.stringify(h.provider.requests[0]!.messages), /extra-context/);
  });

  it('Stop exit 2 keeps the agent going, with a limit against endless loops', async () => {
    const h = await harness(
      Array.from({ length: 20 }, () => ({ text: 'again' })),
      { settingsArg: hookSettings('Stop', 'echo keep-going >&2; exit 2') },
    );
    await collect(h.runtime, 'go');
    assert.equal(h.provider.requests.length, 6);
    assert.match(JSON.stringify(h.provider.requests[1]!.messages), /keep-going/);
  });

  it('SessionStart output reaches the system prompt', async () => {
    const h = await harness([{ text: 'ok' }], { settingsArg: hookSettings('SessionStart', 'echo session-context') });
    await collect(h.runtime, 'go');
    assert.match(JSON.stringify(h.provider.requests[0]!.system), /session-context/);
  });
});

describe('subagents', () => {
  it('runs in a fresh context and returns only its final report', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Agent', input: { description: 'look', prompt: 'find the thing' } }] },
      { text: 'the subagent report' },
      { text: 'main done' },
    ]);
    const events = await collect(h.runtime, 'main prompt');
    const sub = h.provider.requests[1]!;
    assert.equal(sub.messages.length, 1);
    assert.match(JSON.stringify(sub.messages), /find the thing/);
    assert.doesNotMatch(JSON.stringify(sub.messages), /main prompt/);
    assert.match(toolResults(h, 2)[0]!.content, /the subagent report/);
    assert.equal(lastTurn(events).text, 'main done');
  });

  it('cannot start further subagents or ask the user questions', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Agent', input: { description: 'look', prompt: 'p' } }] },
      { text: 'report' },
      { text: 'done' },
    ]);
    await collect(h.runtime, 'go');
    const names = h.provider.requests[1]!.tools.map((t) => t.name);
    assert.ok(!names.includes('Agent'));
    assert.ok(!names.includes('AskUserQuestion'));
  });

  it('the explore type only gets read tools', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Agent', input: { description: 'look', prompt: 'p', subagent_type: 'explore' } }] },
      { text: 'report' },
      { text: 'done' },
    ]);
    await collect(h.runtime, 'go');
    assert.deepEqual(h.provider.requests[1]!.tools.map((t) => t.name).sort(), ['Glob', 'Grep', 'Read']);
  });

  it('is subject to the same permissions as the main agent', async () => {
    const dir = project();
    const target = join(dir, 'marker');
    const h = await harness(
      [
        { toolCalls: [{ name: 'Agent', input: { description: 'do', prompt: 'p' } }] },
        { toolCalls: [{ name: 'Bash', input: { command: `touch ${target}` } }] },
        { text: 'report' },
        { text: 'done' },
      ],
      { dir, answer: { behavior: 'deny' } },
    );
    await collect(h.runtime, 'go');
    assert.equal(h.prompts.length, 1);
    assert.equal(existsSync(target), false);
  });

  it('does not move the main session when it changes directory', async () => {
    const dir = project();
    const h = await harness(
      [
        { toolCalls: [{ name: 'Agent', input: { description: 'do', prompt: 'p' } }] },
        { toolCalls: [{ name: 'Bash', input: { command: 'mkdir -p sub && cd sub' } }] },
        { text: 'report' },
        { text: 'done' },
      ],
      { dir, mode: 'bypassPermissions' },
    );
    await collect(h.runtime, 'go');
    assert.equal(h.runtime.context.cwd(), dir);
  });

  it('reports an unknown type as an error, and counts subagent usage', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Agent', input: { description: 'x', prompt: 'p', subagent_type: 'nope' } }] },
      { toolCalls: [{ name: 'Agent', input: { description: 'x', prompt: 'p' } }] },
      { text: 'report', usage: { inputTokens: 1000, outputTokens: 1 } },
      { text: 'done' },
    ]);
    await collect(h.runtime, 'go');
    assert.match(toolResults(h, 1)[0]!.content, /Unknown subagent type/);
    assert.ok(h.runtime.agent.totalUsage.inputTokens >= 1000);
  });
});

describe('compaction', () => {
  it('compacts automatically near the context limit and continues', async () => {
    const h = await harness(
      [
        { toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }], usage: { inputTokens: 900 } },
        { text: 'SUMMARY OF WORK' },
        { text: 'after compaction' },
      ],
      { contextWindow: 1000, mode: 'bypassPermissions' },
    );
    const events = await collect(h.runtime, 'go');
    assert.ok(events.some((e) => e.type === 'compacted'));
    const summarizer = h.provider.requests[1]!;
    assert.deepEqual(summarizer.tools, []);
    assert.equal(summarizer.messages.length, 1);
    assert.ok(summarizer.messages[0]!.content.every((b) => b.type === 'text'));
    const after = h.provider.requests[2]!;
    assert.match(JSON.stringify(after.messages), /SUMMARY OF WORK/);
    assert.equal(after.messages.length, 1);
    assert.equal(lastTurn(events).text, 'after compaction');
  });

  it('treats a summary cut off by the output limit as a failure', async () => {
    const h = await harness(
      [
        { toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }], usage: { inputTokens: 900 } },
        { text: 'partial summ', stopReason: 'max_tokens' },
        { text: 'carried on' },
      ],
      { contextWindow: 1000, mode: 'bypassPermissions' },
    );
    const events = await collect(h.runtime, 'go');
    assert.ok(!events.some((e) => e.type === 'compacted'));
    assert.ok(events.some((e) => e.type === 'notice' && e.text.includes('Auto-compaction failed')));
    assert.equal(lastTurn(events).text, 'carried on');
    assert.ok(h.runtime.agent.messages.length > 1);
  });

  it('asks the provider not to cache the one-off summary request', async () => {
    const seen: boolean[] = [];
    const provider = new ScriptedProvider([{ text: 'hello' }, { text: 'summary' }]);
    const original = provider.stream.bind(provider);
    provider.stream = (request) => {
      seen.push(request.disableCache === true);
      return original(request);
    };
    const runtime = await createRuntime({ cwd: project(), prompter: { permission: async () => ({ behavior: 'allow' }), questions: async () => null, approvePlan: async () => true }, provider });
    for await (const _ of runtime.agent.run('go', new AbortController().signal)) { /* drain */ }
    await runtime.agent.compact('x');
    assert.deepEqual(seen, [false, true]);
  });

  it('gives up after repeated failures instead of looping', async () => {
    const usage = { inputTokens: 900 };
    const call = { toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }], usage };
    const failing = { error: 'cannot summarize' };
    const h = await harness(
      [call, failing, call, failing, call, failing, call, { text: 'end', usage }],
      { contextWindow: 1000, mode: 'bypassPermissions' },
    );
    const events = await collect(h.runtime, 'go');
    assert.equal(events.filter((e) => e.type === 'notice' && e.text.includes('Auto-compaction failed')).length, 3);
    assert.equal(lastTurn(events).text, 'end');
  });

  it('a manual compact uses the focus text', async () => {
    const h = await harness([{ text: 'hello' }, { text: 'summary' }]);
    await collect(h.runtime, 'go');
    await h.runtime.agent.compact('the API changes');
    assert.match(JSON.stringify(h.provider.requests[1]!.messages), /the API changes/);
    assert.equal(h.runtime.agent.messages.length, 1);
  });

  it('does not compact when turned off', async () => {
    const h = await harness(
      [{ toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }], usage: { inputTokens: 900 } }, { text: 'ok' }],
      { contextWindow: 1000, mode: 'bypassPermissions', settingsArg: JSON.stringify({ autoCompact: false }) },
    );
    assert.ok(!(await collect(h.runtime, 'go')).some((e) => e.type === 'compacted'));
  });
});

describe('server tools', () => {
  it('offers web search by default', async () => {
    const h = await harness([{ text: 'ok' }]);
    await collect(h.runtime, 'go');
    assert.deepEqual(h.provider.requests[0]!.serverTools, ['web_search']);
  });

  it('a bare deny rule or --tools removes it', async () => {
    const denied = await harness([{ text: 'ok' }], { disallowedTools: ['WebSearch'] });
    await collect(denied.runtime, 'go');
    assert.equal(denied.provider.requests[0]!.serverTools, undefined);
    const limited = await harness([{ text: 'ok' }], { tools: ['Read'] });
    await collect(limited.runtime, 'go');
    assert.equal(limited.provider.requests[0]!.serverTools, undefined);
    const allowed = await harness([{ text: 'ok' }], { tools: ['Read', 'WebSearch'] });
    await collect(allowed.runtime, 'go');
    assert.deepEqual(allowed.provider.requests[0]!.serverTools, ['web_search']);
  });

  it('is left off the read-only explore subagent and the summary request', async () => {
    const h = await harness([
      { toolCalls: [{ name: 'Agent', input: { description: 'x', prompt: 'p', subagent_type: 'explore' } }] },
      { text: 'report' },
      { text: 'done' },
      { text: 'summary' },
    ]);
    await collect(h.runtime, 'go');
    assert.equal(h.provider.requests[1]!.serverTools, undefined);
    await h.runtime.agent.compact('x');
    assert.equal(h.provider.requests[3]!.serverTools, undefined);
  });
});

describe('resuming with a frozen system prompt', () => {
  it('sends the recorded prompt, not a rebuilt one, even if the project changed', async () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), 'Original instructions.');
    const first = await harness([{ text: 'one' }], { dir });
    await collect(first.runtime, 'go');
    const original = JSON.stringify(first.provider.requests[0]!.system);

    writeFileSync(join(dir, 'CAIRN.md'), 'Changed instructions.');
    const resumed = await harness([{ text: 'two' }], { dir, continueLast: true, appendSystemPrompt: 'Different text' });
    await collect(resumed.runtime, 'again');
    assert.equal(JSON.stringify(resumed.provider.requests[0]!.system), original);
  });

  it('a new session picks up the changed instructions', async () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), 'Original instructions.');
    const first = await harness([{ text: 'one' }], { dir });
    await collect(first.runtime, 'go');
    writeFileSync(join(dir, 'CAIRN.md'), 'Changed instructions.');
    const fresh = await harness([{ text: 'two' }], { dir });
    await collect(fresh.runtime, 'go');
    assert.match(JSON.stringify(fresh.provider.requests[0]!.system), /Changed instructions/);
  });

  it('a fork and /resume keep the recorded prompt too', async () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), 'Original instructions.');
    const first = await harness([{ text: 'one' }], { dir });
    await collect(first.runtime, 'go');
    const id = first.runtime.agent.sessionId;
    const original = JSON.stringify(first.provider.requests[0]!.system);
    writeFileSync(join(dir, 'CAIRN.md'), 'Changed instructions.');

    const fork = await harness([{ text: 'two' }], { dir, resume: id, fork: true });
    await collect(fork.runtime, 'go');
    assert.equal(JSON.stringify(fork.provider.requests[0]!.system), original);

    const later = await harness([{ text: 'three' }], { dir });
    assert.equal(later.runtime.resumeSession(id), true);
    await collect(later.runtime, 'go');
    assert.equal(JSON.stringify(later.provider.requests[0]!.system), original);
  });

  it('adds new SessionStart context to the conversation, leaving the prompt alone', async () => {
    const dir = project();
    const first = await harness([{ text: 'one' }], { dir });
    await collect(first.runtime, 'go');
    const original = JSON.stringify(first.provider.requests[0]!.system);
    const settings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo fresh-context' }] }] } });
    const resumed = await harness([{ text: 'two' }], { dir, continueLast: true, settingsArg: settings });
    await collect(resumed.runtime, 'again');
    const request = resumed.provider.requests[0]!;
    assert.equal(JSON.stringify(request.system), original);
    assert.match(JSON.stringify(request.messages), /fresh-context/);
  });
});

describe('prompt stability', () => {
  it('keeps the system prompt and tools byte-identical across a session', async () => {
    const h = await harness([{ toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }] }, { text: 'ok' }], { mode: 'bypassPermissions' });
    await collect(h.runtime, 'go');
    const [first, second] = h.provider.requests;
    assert.equal(JSON.stringify(first!.system), JSON.stringify(second!.system));
    assert.equal(JSON.stringify(first!.tools), JSON.stringify(second!.tools));
  });

  it('only appends to history between requests', async () => {
    const h = await harness([{ toolCalls: [{ name: 'Bash', input: { command: 'echo x' } }] }, { text: 'ok' }], { mode: 'bypassPermissions' });
    await collect(h.runtime, 'go');
    const [first, second] = h.provider.requests;
    assert.deepEqual(second!.messages.slice(0, first!.messages.length), first!.messages);
  });

  it('includes project instructions and the environment', async () => {
    const dir = project();
    writeFileSync(join(dir, 'CAIRN.md'), 'Always use tabs.');
    const h = await harness([{ text: 'ok' }], { dir });
    await collect(h.runtime, 'go');
    const system = JSON.stringify(h.provider.requests[0]!.system);
    assert.match(system, /Always use tabs/);
    assert.match(system, new RegExp(dir.replace(/[/]/g, '\\/')));
  });
});
