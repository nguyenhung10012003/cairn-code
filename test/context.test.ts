/** What joins the conversation as the model works: rules, nested instructions, skills, tasks. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'bun:test';
import { loadInstructions } from '../src/core/instructions.ts';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime, RuntimeOptions } from '../src/core/runtime.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { ScriptedTurn } from '../src/providers/scripted.ts';
import { loadSkills } from '../src/skills/skills.ts';
import type { Prompter } from '../src/tools/types.ts';

const allowAll: Prompter = {
  permission: async () => ({ behavior: 'allow' }),
  questions: async () => null,
  approvePlan: async () => true,
};

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function write(root: string, path: string, content: string): string {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

async function start(dir: string, turns: ScriptedTurn[], extra: Partial<RuntimeOptions> = {}): Promise<{ runtime: Runtime; provider: ScriptedProvider }> {
  const provider = new ScriptedProvider(turns);
  const runtime = await createRuntime({ cwd: dir, prompter: allowAll, provider, trust: true, persist: false, ...extra });
  return { runtime, provider };
}

async function turn(runtime: Runtime, prompt: string): Promise<void> {
  for await (const _event of runtime.agent.run(prompt, new AbortController().signal)) {
    // Run it to the end.
  }
}

const read = (file_path: string): ScriptedTurn => ({ toolCalls: [{ name: 'Read', input: { file_path } }] });

function lastUserText(provider: ScriptedProvider): string {
  const message = provider.requests.at(-1)!.messages.at(-1)!;
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

describe('rules', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = tempDir('cairn-rules-');
    home = tempDir('cairn-ruleshome-');
    process.env.CAIRN_HOME = home;
  });

  it('loads a rule without paths at startup, from nested folders too, and strips its frontmatter', () => {
    write(dir, '.cairn/rules/style.md', '---\nunrelated: true\n---\nUse tabs.');
    write(dir, '.cairn/rules/backend/api.md', 'Validate input.');
    write(home, 'rules/mine.md', 'Be brief.');
    const loaded = loadInstructions(dir, false);
    const text = loaded.files.map((file) => file.content).join('\n');
    assert.match(text, /Use tabs\./);
    assert.match(text, /Validate input\./);
    assert.match(text, /Be brief\./);
    assert.doesNotMatch(text, /unrelated/);
    assert.equal(loaded.conditional.length, 0);
  });

  it('treats a rule with broken YAML as applying everywhere, and says so', () => {
    write(dir, '.cairn/rules/bad.md', '---\npaths: [unclosed\n---\nStill applies.');
    const loaded = loadInstructions(dir, false);
    assert.match(loaded.files.map((file) => file.content).join('\n'), /Still applies\./);
    assert.ok(loaded.warnings.some((warning) => warning.includes('not valid YAML')));
  });

  it('holds back a path-scoped rule until a matching file is read, and attaches it once', async () => {
    write(dir, '.cairn/rules/api.md', '---\npaths:\n  - "src/api/**/*.ts"\n---\nAPI RULE');
    const handler = write(dir, 'src/api/h.ts', 'x');
    const other = write(dir, 'README.md', 'x');
    const { runtime, provider } = await start(dir, [read(other), read(handler), read(handler), { text: 'done' }]);
    await turn(runtime, 'go');
    assert.doesNotMatch(JSON.stringify(provider.requests[0]!.system), /API RULE/);
    assert.doesNotMatch(JSON.stringify(provider.requests[1]!.messages), /API RULE/);
    assert.match(JSON.stringify(provider.requests[2]!.messages.at(-1)), /API RULE/);
    const mentions = JSON.stringify(provider.requests[3]!.messages).match(/API RULE/g) ?? [];
    assert.equal(mentions.length, 1, 'a second read does not attach it again');
    await runtime.shutdown();
  });

  it('keeps tool results first in the message that carries a rule, as the API requires', async () => {
    write(dir, '.cairn/rules/api.md', '---\npaths: "**/*.ts"\n---\nTS RULE');
    const file = write(dir, 'a.ts', 'x');
    const { runtime, provider } = await start(dir, [read(file), { text: 'done' }]);
    await turn(runtime, 'go');
    const blocks = provider.requests[1]!.messages.at(-1)!.content;
    assert.equal(blocks[0]!.type, 'tool_result');
    assert.equal(blocks[1]!.type, 'text');
    await runtime.shutdown();
  });

  it('accepts a comma-separated string with a brace group in it', async () => {
    write(dir, '.cairn/rules/web.md', '---\npaths: "web/*.{ts,tsx}, lib/*.ts"\n---\nWEB RULE');
    const file = write(dir, 'web/a.tsx', 'x');
    const { runtime, provider } = await start(dir, [read(file), { text: 'done' }]);
    await turn(runtime, 'go');
    assert.match(lastUserText(provider), /WEB RULE/);
    await runtime.shutdown();
  });

  it('applies a rule again after compaction, since the summary dropped it', async () => {
    write(dir, '.cairn/rules/api.md', '---\npaths: "*.ts"\n---\nTS RULE');
    const file = write(dir, 'a.ts', 'x');
    const { runtime, provider } = await start(dir, [read(file), { text: 'one' }, { text: 'summary' }, read(file), { text: 'two' }]);
    await turn(runtime, 'first');
    await runtime.agent.compact('focus');
    assert.doesNotMatch(JSON.stringify(runtime.agent.messages), /TS RULE/);
    await turn(runtime, 'second');
    assert.match(lastUserText(provider), /TS RULE/);
    await runtime.shutdown();
  });
});

describe('instructions in subdirectories', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir('cairn-nested-');
    process.env.CAIRN_HOME = tempDir('cairn-nestedhome-');
  });

  it('are not read at startup, and join when the model reaches a file there', async () => {
    write(dir, 'CAIRN.md', 'ROOT NOTES');
    write(dir, 'pkg/CAIRN.md', 'PKG NOTES');
    write(dir, 'pkg/deep/.cairn/rules/r.md', 'DEEP RULE');
    const file = write(dir, 'pkg/deep/a.txt', 'x');
    const { runtime, provider } = await start(dir, [read(file), { text: 'done' }]);
    await turn(runtime, 'go');
    const system = JSON.stringify(provider.requests[0]!.system);
    assert.match(system, /ROOT NOTES/);
    assert.doesNotMatch(system, /PKG NOTES/);
    const attached = lastUserText(provider);
    assert.match(attached, /PKG NOTES/);
    assert.match(attached, /DEEP RULE/);
    await runtime.shutdown();
  });

  it('does not attach anything for a file outside the project', async () => {
    const outside = tempDir('cairn-outside-');
    write(outside, 'CAIRN.md', 'OUTSIDE NOTES');
    const file = write(outside, 'a.txt', 'x');
    const { runtime, provider } = await start(dir, [read(file), { text: 'done' }]);
    await turn(runtime, 'go');
    assert.doesNotMatch(JSON.stringify(provider.requests[1]!.messages), /OUTSIDE NOTES/);
    await runtime.shutdown();
  });

  it('gives a subagent its own view: a rule it triggers does not leak to the parent', async () => {
    write(dir, '.cairn/rules/api.md', '---\npaths: "*.ts"\n---\nTS RULE');
    const file = write(dir, 'a.ts', 'x');
    const { runtime, provider } = await start(dir, [
      { toolCalls: [{ name: 'Agent', input: { description: 'look', prompt: 'read it' } }] },
      read(file),
      { text: 'sub done' },
      { text: 'parent done' },
    ]);
    await turn(runtime, 'go');
    assert.match(JSON.stringify(provider.requests[2]!.messages), /TS RULE/, 'the subagent sees it');
    assert.doesNotMatch(JSON.stringify(provider.requests[3]!.messages), /TS RULE/, 'the parent does not');
    await runtime.shutdown();
  });
});

describe('where skills come from', () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = tempDir('cairn-skillsrc-');
    home = tempDir('cairn-skillsrchome-');
    process.env.CAIRN_HOME = home;
  });

  const skill = (body: string, front = 'description: A skill'): string => `---\n${front}\n---\n${body}`;

  it('leaves a path-scoped skill out of the listing until a matching file is touched', async () => {
    write(dir, '.cairn/skills/sql/SKILL.md', skill('SQL BODY', 'description: Writes SQL\npaths: "**/*.sql"'));
    const file = write(dir, 'db/q.sql', 'select 1');
    const other = write(dir, 'a.txt', 'x');
    const { runtime, provider } = await start(dir, [read(other), { text: 'one' }, read(file), { text: 'two' }, { text: 'three' }]);
    await turn(runtime, 'first');
    assert.doesNotMatch(JSON.stringify(provider.requests[0]!.system), /Writes SQL/);
    await turn(runtime, 'second');
    assert.doesNotMatch(lastUserText(provider), /Writes SQL/);
    await turn(runtime, 'third');
    assert.match(lastUserText(provider), /now available[\s\S]*Writes SQL/);
    await runtime.shutdown();
  });

  it('tells the model about a skill written during the session', async () => {
    const { runtime, provider } = await start(dir, [{ text: 'one' }, { text: 'two' }]);
    await turn(runtime, 'first');
    write(dir, '.cairn/skills/fresh/SKILL.md', skill('x', 'description: Brand new'));
    await turn(runtime, 'second');
    assert.match(lastUserText(provider), /now available[\s\S]*Brand new/);
    await runtime.shutdown();
  });

  it('finds skills in parent directories up to the repository root, and no further', () => {
    const root = tempDir('cairn-repo-');
    mkdirSync(join(root, '.git'));
    write(root, '.cairn/skills/shared/SKILL.md', skill('x'));
    const sub = join(root, 'apps/web');
    mkdirSync(sub, { recursive: true });
    write(sub, '.cairn/skills/local/SKILL.md', skill('x'));
    const names = [...loadSkills(sub, true).skills.keys()];
    assert.ok(names.includes('shared'));
    assert.ok(names.includes('local'));
    const noRepo = tempDir('cairn-norepo-');
    write(noRepo, '.cairn/skills/parent/SKILL.md', skill('x'));
    const child = join(noRepo, 'child');
    mkdirSync(child);
    assert.ok(!loadSkills(child, true).skills.has('parent'));
  });

  it('loads an added directory, under a prefix when the name is taken, and only when trusted', () => {
    const other = tempDir('cairn-other-');
    write(dir, '.cairn/skills/verify/SKILL.md', skill('mine'));
    write(other, '.cairn/skills/verify/SKILL.md', skill('theirs'));
    write(other, '.cairn/skills/unique/SKILL.md', skill('x'));
    const loaded = loadSkills(dir, true, { addDirs: [other] }).skills;
    assert.match(loaded.get('verify')!.body, /mine/);
    assert.ok(loaded.has(`${other.split('/').at(-1)}:verify`));
    assert.ok(loaded.has('unique'));
    assert.ok(!loadSkills(dir, false, { addDirs: [other] }).skills.has('unique'));
  });

  it('adds a nested skill once the model reaches its directory', async () => {
    write(dir, 'apps/web/.cairn/skills/deploy/SKILL.md', skill('x', 'description: Deploys the web app'));
    const file = write(dir, 'apps/web/a.txt', 'x');
    const { runtime, provider } = await start(dir, [read(file), { text: 'one' }, { text: 'two' }]);
    await turn(runtime, 'first');
    assert.doesNotMatch(JSON.stringify(provider.requests[0]!.system), /Deploys the web app/);
    await turn(runtime, 'second');
    assert.match(lastUserText(provider), /Deploys the web app/);
    await runtime.shutdown();
  });

  it("registers a skill's hooks when invoked, and treats a skill with hooks as privileged", async () => {
    const marker = join(dir, 'hook-ran');
    write(dir, '.cairn/skills/hooked/SKILL.md', `---\ndescription: Hooked\nhooks:\n  PostToolUse:\n    - hooks:\n        - type: command\n          command: touch ${marker}\n---\nbody`);
    const prompts: string[] = [];
    const file = write(dir, 'a.txt', 'x');
    const { runtime } = await start(dir, [{ toolCalls: [{ name: 'Skill', input: { skill: 'hooked' } }] }, read(file), { text: 'done' }], {
      prompter: { ...allowAll, permission: async (prompt) => { prompts.push(prompt.toolName); return { behavior: 'allow' }; } },
    });
    await turn(runtime, 'go');
    assert.ok(prompts.includes('Skill'), 'a skill that adds hooks asks first');
    assert.equal(existsSync(marker), true);
    await runtime.shutdown();
  });

  it('runs no skills with --disable-slash-commands', async () => {
    write(dir, '.cairn/skills/x/SKILL.md', skill('x'));
    const { runtime, provider } = await start(dir, [{ text: 'ok' }], { disableSlashCommands: true });
    await turn(runtime, 'go');
    assert.ok(!provider.requests[0]!.tools.some((tool) => tool.name === 'Skill'));
    await runtime.shutdown();
  });
});
