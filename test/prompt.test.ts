/** What reaches the model as text, and whether what it says can be relied on. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime, RuntimeOptions } from '../src/core/runtime.ts';
import { buildSystemPrompt } from '../src/core/system-prompt.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { ScriptedTurn } from '../src/providers/scripted.ts';
import { builtinTools } from '../src/tools/index.ts';
import { globTool, grepTool } from '../src/tools/search.ts';
import { skillTool } from '../src/tools/skill.ts';
import type { Prompter, Tool } from '../src/tools/types.ts';

const allowAll: Prompter = {
  permission: async () => ({ behavior: 'allow' }),
  questions: async () => null,
  approvePlan: async () => true,
};

const everyTool: Tool[] = [...builtinTools(), skillTool];
const basePrompt = { cwd: '/project', additionalDirectories: [], instructions: [] };

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

async function turn(runtime: Runtime, prompt: string): Promise<void> {
  for await (const _event of runtime.agent.run(prompt, new AbortController().signal)) {
    // Run it to the end.
  }
}

function undescribed(schema: Record<string, unknown>, path: string): string[] {
  const missing: string[] = [];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, property] of Object.entries(properties)) {
    const here = `${path}.${name}`;
    if (typeof property.description !== 'string' || property.description.length === 0) missing.push(here);
    missing.push(...undescribed(property, here));
    if (property.items) missing.push(...undescribed(property.items as Record<string, unknown>, `${here}[]`));
  }
  return missing;
}

describe('the core prompt', () => {
  const core = buildSystemPrompt(basePrompt)[0]!.text;

  it('names no tool, because configuration can turn any of them off', () => {
    for (const tool of everyTool) assert.doesNotMatch(core, new RegExp(`\\b${tool.name}\\b`), tool.name);
  });

  it('stays the same across projects and models, so the cached prefix can be reused', () => {
    const other = buildSystemPrompt({ ...basePrompt, cwd: '/elsewhere', model: 'claude-sonnet-5-5' });
    assert.equal(other[0]!.text, core);
  });

  it('keeps its safety rules', () => {
    assert.match(core, /confirm first/);
    assert.match(core, /did not come from the user/);
    assert.match(core, /adjust, don't retry verbatim/);
    assert.match(core, /Report outcomes faithfully/);
  });
});

describe('the environment block', () => {
  it('states the shell and the starting model', () => {
    const text = buildSystemPrompt({ ...basePrompt, model: 'claude-opus-5-5' })[1]!.text;
    assert.match(text, /^ - Shell: \S+/m);
    assert.match(text, /^ - Model at session start: claude-opus-5-5$/m);
  });

  it('leaves out a model it was not told', () => {
    assert.doesNotMatch(buildSystemPrompt(basePrompt)[1]!.text, /Model at session start/);
  });

  it('names no vendor product or knowledge cutoff for the model', () => {
    const text = buildSystemPrompt({ ...basePrompt, model: 'claude-opus-5-5' }).map((block) => block.text).join('\n');
    assert.doesNotMatch(text, /powered by|knowledge cutoff|Opus 5\.5/);
  });
});

describe('tool definitions', () => {
  it('give each tool a non-trivial description', () => {
    for (const tool of everyTool) {
      assert.ok(tool.description.trim().length >= 30, `${tool.name}: ${tool.description}`);
    }
  });

  it('describe every parameter, at any depth', () => {
    const missing = everyTool.flatMap((tool) => undescribed(tool.inputSchema as Record<string, unknown>, tool.name));
    assert.deepEqual(missing, []);
  });
});

describe('at run time', () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    dir = tempDir('cairn-prompt-');
    previousHome = process.env.CAIRN_HOME;
    process.env.CAIRN_HOME = tempDir('cairn-prompt-home-');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CAIRN_HOME;
    else process.env.CAIRN_HOME = previousHome;
  });

  const start = async (turns: ScriptedTurn[], extra: Partial<RuntimeOptions> = {}): Promise<{ runtime: Runtime; provider: ScriptedProvider }> => {
    const provider = new ScriptedProvider(turns);
    const runtime = await createRuntime({ cwd: dir, prompter: allowAll, provider, trust: true, persist: false, ...extra });
    return { runtime, provider };
  };

  const agentFile = (front: string): string => `---\n${front}\n---\nDo the review.`;

  it('tells the model which custom subagent types exist', async () => {
    write(dir, '.cairn/agents/reviewer.md', agentFile('description: Reviews diffs'));
    const { runtime, provider } = await start([{ text: 'ok' }]);
    await turn(runtime, 'hello');
    assert.match(provider.requests[0]!.system.map((block) => block.text).join('\n'), /## Agents[\s\S]*- reviewer: Reviews diffs/);
    await runtime.shutdown();
  });

  it('says nothing about subagent types when there are no custom ones', async () => {
    const { runtime, provider } = await start([{ text: 'ok' }]);
    await turn(runtime, 'hello');
    assert.doesNotMatch(JSON.stringify(provider.requests[0]!.system), /# Subagent types/);
    await runtime.shutdown();
  });

  it('says nothing about subagent types when the Agent tool is off', async () => {
    write(dir, '.cairn/agents/reviewer.md', agentFile('description: Reviews diffs'));
    const { runtime, provider } = await start([{ text: 'ok' }], { tools: ['Read'] });
    await turn(runtime, 'hello');
    assert.doesNotMatch(JSON.stringify(provider.requests[0]!.system), /Reviews diffs/);
    await runtime.shutdown();
  });

  it('gives a subagent the model it runs on', async () => {
    write(dir, '.cairn/agents/reviewer.md', agentFile('description: Reviews diffs\nmodel: claude-sonnet-5-5'));
    const { runtime, provider } = await start([
      { toolCalls: [{ name: 'Agent', input: { description: 'review', prompt: 'look', subagent_type: 'reviewer' } }] },
      { text: 'report' },
      { text: 'done' },
    ]);
    await turn(runtime, 'hello');
    assert.match(provider.requests[1]!.system.map((block) => block.text).join('\n'), /Model at session start: claude-sonnet-5-5/);
    await runtime.shutdown();
  });

  it('tags a background command ending, so it cannot pass for the user typing', async () => {
    const { runtime, provider } = await start([
      { toolCalls: [{ name: 'Bash', input: { command: 'echo logged', run_in_background: true } }] },
      { text: 'waiting' },
      { text: 'noted' },
    ]);
    await turn(runtime, 'start it');
    for (let i = 0; i < 200 && runtime.context.tasks.running().length > 0; i++) await Bun.sleep(25);
    await turn(runtime, 'and now?');
    assert.match(JSON.stringify(provider.requests.at(-1)!.messages.at(-1)), /<task-notification>[\s\S]*exited with code 0[\s\S]*<\/task-notification>/);
    await runtime.shutdown();
  });

  describe('what the search tools promise', () => {
    const run = async (tool: Tool, input: Record<string, unknown>): Promise<string> => {
      const { runtime } = await start([]);
      const output = await tool.execute(input, { ...runtime.context, signal: new AbortController().signal });
      await runtime.shutdown();
      return output.content as string;
    };

    beforeEach(() => {
      write(dir, 'top.ts', 'alpha\nbeta\n');
      write(dir, 'deep/down/low.ts', 'alpha\n');
      write(dir, 'node_modules/pkg/hidden.ts', 'alpha\n');
    });

    it('Glob: *.ts stays at the top level and **/*.ts goes deeper, but never into skipped directories', async () => {
      const shallow = await run(globTool, { pattern: '*.ts' });
      assert.match(shallow, /top\.ts/);
      assert.doesNotMatch(shallow, /low\.ts/);
      const deep = await run(globTool, { pattern: '**/*.ts' });
      assert.match(deep, /low\.ts/);
      assert.doesNotMatch(deep, /hidden\.ts/);
    });

    it('Grep: a glob with no slash matches at any depth', async () => {
      const found = await run(grepTool, { pattern: 'alpha', glob: '*.ts' });
      assert.match(found, /top\.ts/);
      assert.match(found, /low\.ts/);
      assert.doesNotMatch(found, /hidden\.ts/);
    });

    it('Grep: a pattern cannot match across lines', async () => {
      assert.match(await run(grepTool, { pattern: 'alpha\\nbeta' }), /No matches found/);
    });
  });
});
