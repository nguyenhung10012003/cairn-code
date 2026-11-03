import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, it } from 'bun:test';
import { commandNames, resolveExtensionCommand, runSlashCommand, settleCommand } from '../src/commands/slash.ts';
import { loadSettings } from '../src/config/settings.ts';
import { booleanField, listField, parseFrontmatter } from '../src/core/frontmatter.ts';
import type { AgentEvent } from '../src/core/agent.ts';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime, RuntimeOptions } from '../src/core/runtime.ts';
import type { ToolResultBlock } from '../src/core/messages.ts';
import { PermissionEngine } from '../src/permissions/engine.ts';
import type { PermissionMode } from '../src/permissions/engine.ts';
import { parseRule } from '../src/permissions/rules.ts';
import type { RuleBehavior } from '../src/permissions/rules.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { ScriptedTurn } from '../src/providers/scripted.ts';
import { hasInjectedCommands, isPrivilegedSkill, loadSkills, renderSkillListing, splitArguments, splitInjectedCommands, substitute } from '../src/skills/skills.ts';
import type { Skill } from '../src/skills/skills.ts';
import type { PermissionAnswer, PermissionPrompt, Prompter } from '../src/tools/types.ts';

const CLI = resolve(import.meta.dirname, '../src/cli.ts');

let home: string;
beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-skills-home-')));
});
beforeEach(() => {
  // Each test gets an empty personal skills folder.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-skills-home-')));
  process.env.CAIRN_HOME = home;
});

function project(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-skills-')));
}

function writeSkill(root: string, name: string, content: string): string {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
  return dir;
}

const projectSkill = (dir: string, name: string, content: string): string => writeSkill(join(dir, '.cairn'), name, content);

describe('frontmatter', () => {
  it('parses real YAML: folded text, colons, lists', () => {
    const { fields, body } = parseFrontmatter('---\nname: x\ndescription: >\n  Folded: with a colon\n  over lines\nallowed-tools:\n  - Read\n  - Bash(git *)\n---\nThe body\n');
    assert.equal(fields.name, 'x');
    assert.equal(fields.description, 'Folded: with a colon over lines\n');
    assert.deepEqual(listField(fields, 'allowed-tools'), ['Read', 'Bash(git *)']);
    assert.equal(body, 'The body\n');
  });

  it('counts only when it opens the file, and tolerates bad YAML', () => {
    assert.deepEqual(parseFrontmatter('text\n---\nname: x\n---\n').fields, {});
    const bad = parseFrontmatter('---\nname: [unclosed\n---\nbody');
    assert.deepEqual(bad.fields, {});
    assert.equal(bad.body, 'body');
    assert.deepEqual(parseFrontmatter('---\n---\nbody'), { fields: {}, body: 'body' });
    assert.deepEqual(parseFrontmatter('---\n- a\n- b\n---\nbody').fields, {});
  });

  it('does not end at a --- inside a value', () => {
    assert.equal(parseFrontmatter('---\nname: a---b\n---\nbody').fields.name, 'a---b');
  });

  it('accepts the usual spellings of booleans', () => {
    const check = (value: unknown) => booleanField({ k: value }, 'k');
    for (const yes of [true, 1, 'yes', 'on', 'TRUE', '1']) assert.equal(check(yes), true, String(yes));
    for (const no of [false, 0, 'no', 'off', 'false', '0']) assert.equal(check(no), false, String(no));
    assert.equal(check('maybe'), undefined);
    assert.equal(check(undefined), undefined);
  });

  it('splits a string list without breaking rules that contain spaces', () => {
    assert.deepEqual(listField({ k: 'Bash(git add *) Bash(git commit *), Read' }, 'k'), ['Bash(git add *)', 'Bash(git commit *)', 'Read']);
    assert.deepEqual(listField({ k: 42 }, 'k'), []);
  });
});

describe('finding skills', () => {
  it('loads from project and personal folders, with personal winning', () => {
    const dir = project();
    projectSkill(dir, 'only-project', '---\ndescription: P\n---\nBody P');
    projectSkill(dir, 'both', '---\ndescription: from project\n---\nx');
    writeSkill(home, 'both', '---\ndescription: from personal\n---\ny');
    writeSkill(home, 'only-personal', '---\ndescription: U\n---\nz');
    const { skills } = loadSkills(dir, true);
    assert.equal(skills.get('both')!.description, 'from personal');
    assert.equal(skills.get('both')!.source, 'user');
    assert.equal(skills.get('only-project')!.source, 'project');
    assert.ok(skills.has('only-personal'));
  });

  it('ignores an untrusted project entirely, and asks for trust', () => {
    const dir = project();
    projectSkill(dir, 'evil', '---\nallowed-tools: Bash\n---\n!`curl evil`');
    assert.equal(loadSkills(dir, false).skills.size, 0);
    assert.equal(loadSettings({ cwd: dir, trusted: false }).needsTrust, true);
    assert.equal(loadSkills(dir, true).skills.size, 1);
  });

  it('treats command files as skills, nested by colons, and lets a skill win', () => {
    const dir = project();
    mkdirSync(join(dir, '.cairn/commands/frontend'), { recursive: true });
    writeFileSync(join(dir, '.cairn/commands/deploy.md'), '---\ndescription: As a command\n---\nCommand body');
    writeFileSync(join(dir, '.cairn/commands/frontend/button.md'), 'Make a button.');
    writeFileSync(join(dir, '.cairn/commands/notes.txt'), 'not a command');
    projectSkill(dir, 'deploy', '---\ndescription: As a skill\n---\nSkill body');
    const { skills } = loadSkills(dir, true);
    assert.equal(skills.get('deploy')!.description, 'As a skill');
    assert.equal(skills.get('frontend:button')!.body, 'Make a button.');
    assert.equal(skills.size, 2);
  });

  it('takes the name from frontmatter, or the folder, and rejects unusable names', () => {
    writeSkill(home, 'folder-name', '---\nname: real-name\n---\nx');
    writeSkill(home, 'plain', 'no frontmatter');
    writeSkill(home, 'bad', '---\nname: "has spaces"\n---\nx');
    const { skills, warnings } = loadSkills(project(), false);
    assert.ok(skills.has('real-name'));
    assert.ok(skills.has('plain'));
    assert.ok(!skills.has('has spaces'));
    assert.match(warnings[0]!, /invalid name/);
  });

  it('skips a folder with no SKILL.md', () => {
    mkdirSync(join(home, 'skills/empty'), { recursive: true });
    assert.equal(loadSkills(project(), false).skills.size, 0);
  });

  it('reads every field', () => {
    writeSkill(home, 'full', `---
description: Does things
when_to_use: When things need doing
argument-hint: "[thing]"
arguments: [first, second]
disable-model-invocation: yes
user-invocable: off
allowed-tools: Read Bash(ls *)
disallowed-tools: [Write]
model: claude-haiku-5-5
effort: low
context: fork
agent: explore
---
# Heading
The body`);
    const skill = loadSkills(project(), false).skills.get('full')!;
    assert.equal(skill.description, 'Does things When things need doing');
    assert.equal(skill.argumentHint, '[thing]');
    assert.deepEqual(skill.argumentNames, ['first', 'second']);
    assert.equal(skill.disableModelInvocation, true);
    assert.equal(skill.userInvocable, false);
    assert.deepEqual(skill.allowedTools, ['Read', 'Bash(ls *)']);
    assert.deepEqual(skill.disallowedTools, ['Write']);
    assert.equal(skill.model, 'claude-haiku-5-5');
    assert.equal(skill.effort, 'low');
    assert.equal(skill.fork, true);
    assert.equal(skill.agent, 'explore');
  });

  it('reads an unquoted argument hint, which YAML sees as a list', () => {
    writeSkill(home, 'a', '---\nargument-hint: [issue-number]\n---\nx');
    writeSkill(home, 'b', '---\nargument-hint: [one, two]\n---\nx');
    writeSkill(home, 'c', '---\nargument-hint: <file>\n---\nx');
    const { skills } = loadSkills(project(), false);
    assert.equal(skills.get('a')!.argumentHint, '[issue-number]');
    assert.equal(skills.get('b')!.argumentHint, '[one, two]');
    assert.equal(skills.get('c')!.argumentHint, '<file>');
  });

  it('warns about broken YAML, and still loads the skill', () => {
    writeSkill(home, 'broken', '---\ndescription: Use when: something\nallowed-tools: Bash\n---\nThe body.');
    const { skills, warnings } = loadSkills(project(), false);
    const skill = skills.get('broken')!;
    assert.equal(skill.body, 'The body.');
    assert.deepEqual(skill.allowedTools, [], 'a broken file must not grant anything');
    assert.match(warnings[0]!, /not valid YAML/);
  });

  it('falls back to the first paragraph, and ignores an unknown effort', () => {
    writeSkill(home, 'nodesc', '---\neffort: enormous\n---\n# Title\n\nFirst real line.\nSecond.');
    const skill = loadSkills(project(), false).skills.get('nodesc')!;
    assert.equal(skill.description, 'First real line.');
    assert.equal(skill.effort, undefined);
  });

  it('cuts a long description at the listing limit', () => {
    writeSkill(home, 'long', `---\ndescription: ${'x'.repeat(3000)}\n---\nbody`);
    assert.equal(loadSkills(project(), false).skills.get('long')!.description.length, 1536);
  });
});

describe('the listing the model sees', () => {
  const skill = (name: string, description: string, extra: Partial<Skill> = {}): [string, Skill] => [name, { name, description, disableModelInvocation: false, paths: [], ...extra } as Skill];

  it('shows names and descriptions, leaving out user-only skills', () => {
    const { text } = renderSkillListing(new Map([skill('b', 'second\nline'), skill('a', 'first'), skill('hidden', 'x', { disableModelInvocation: true })]));
    assert.equal(text, '- a: first\n- b: second line');
  });

  it('keeps names but drops descriptions past the budget', () => {
    const big = 'd'.repeat(1500);
    const entries = Array.from({ length: 20 }, (_, i) => skill(`s${String(i).padStart(2, '0')}`, big));
    const { text, omitted } = renderSkillListing(new Map(entries));
    assert.ok(omitted > 0);
    assert.match(text, /^- s19$/m);
    assert.ok(text.length < 20_000);
  });
});

describe('filling in arguments', () => {
  const vars = { sessionId: 'sess-1', projectDir: '/proj', effort: 'high' };
  const skill = { dir: '/skills/x', argumentNames: ['issue', 'branch-name'] };
  const fill = (text: string, args = ''): string => substitute(text, args, skill, vars);

  it('handles every placeholder form', () => {
    assert.equal(fill('$ARGUMENTS', 'a b'), 'a b');
    assert.equal(fill('$0 and $1', 'a b'), 'a and b');
    assert.equal(fill('$ARGUMENTS[1]', 'a b'), 'b');
    assert.equal(fill('$issue / $branch-name', 'a b'), 'a / b');
    assert.equal(fill('${CAIRN_SKILL_DIR} ${CAIRN_PROJECT_DIR} ${CAIRN_SESSION_ID} ${CAIRN_EFFORT}'), '/skills/x /proj sess-1 high');
  });

  it('groups quoted arguments', () => {
    assert.deepEqual(splitArguments(`one "two words" 'three words' four`), ['one', 'two words', 'three words', 'four']);
    assert.equal(fill('$1', 'a "b c"'), 'b c');
  });

  it('leaves a missing position empty, and unknown names alone', () => {
    assert.equal(fill('[$5]', 'a'), '[]');
    assert.equal(fill('$UNDECLARED $HOME'), '$UNDECLARED $HOME');
    assert.equal(fill('$ARGUMENTSX'), '$ARGUMENTSX');
  });

  it('honours an escaped dollar, only where it would otherwise be a placeholder', () => {
    assert.equal(fill('costs \\$1.00', 'a b'), 'costs $1.00');
    assert.equal(fill('\\$ARGUMENTS', 'a'), '$ARGUMENTS');
    assert.equal(fill('\\$issue', 'a'), '$issue');
    assert.equal(fill('regex \\$end'), 'regex \\$end');
  });

  it('never expands text that came from an argument', () => {
    assert.equal(fill('$0', '$1 ${CAIRN_SESSION_ID}'), '$1');
    assert.equal(fill('$ARGUMENTS', '$0 ${CAIRN_SESSION_ID}'), '$0 ${CAIRN_SESSION_ID}');
  });

  it('reports whether any argument was used', () => {
    let used = false;
    substitute('no placeholders', 'a', skill, vars, () => { used = true; });
    assert.equal(used, false);
    substitute('$0', 'a', skill, vars, () => { used = true; });
    assert.equal(used, true);
  });
});

describe('finding injected commands', () => {
  const commands = (body: string): string[] => splitInjectedCommands(body).flatMap((s) => (s.kind === 'command' ? [s.command] : []));

  it('finds inline and fenced forms', () => {
    assert.deepEqual(commands('Status:\n!`git status`\nAnd !`date` too'), ['git status', 'date']);
    assert.deepEqual(commands('```!\nline one\nline two\n```\nafter'), ['line one\nline two']);
  });

  it('keeps the surrounding text in order', () => {
    assert.deepEqual(splitInjectedCommands('a !`x` b'), [{ kind: 'text', text: 'a ' }, { kind: 'command', command: 'x' }, { kind: 'text', text: ' b' }]);
  });

  it('ignores lookalikes and examples in code fences', () => {
    assert.deepEqual(commands('wow!`not this`'), []);
    assert.deepEqual(commands('```\n!`example only`\n```'), []);
    assert.deepEqual(commands('```bash\n!`example only`\n```\n!`real`'), ['real']);
    assert.deepEqual(commands('```!\nunterminated'), []);
  });

  it('says whether a skill needs approval', () => {
    assert.equal(hasInjectedCommands('plain'), false);
    const base = { body: 'plain', allowedTools: [], fork: false } as unknown as Skill;
    assert.equal(isPrivilegedSkill(base), false);
    assert.equal(isPrivilegedSkill({ ...base, allowedTools: ['Read'] }), true);
    assert.equal(isPrivilegedSkill({ ...base, fork: true }), true);
    assert.equal(isPrivilegedSkill({ ...base, body: '!`date`' }), true);
  });
});

describe('permission rules for skills', () => {
  const cwd = '/tmp/cairn-skill-perms';
  function engine(mode: PermissionMode = 'default', rules: Partial<Record<RuleBehavior, string[]>> = {}): PermissionEngine {
    const parsed = (['allow', 'ask', 'deny'] as const).flatMap((behavior) => (rules[behavior] ?? []).map((text) => parseRule(text, behavior, 'user', cwd)!));
    return new PermissionEngine({ mode, rules: parsed, workingDirs: [cwd], cwd: () => cwd });
  }
  const check = (e: PermissionEngine, name = 'deploy', args = '', privileged = true) => e.check('Skill', { kind: 'skill', name, args, privileged });

  it('loads a text-only skill freely, and asks for one with powers', () => {
    assert.equal(check(engine(), 'notes', '', false).behavior, 'allow');
    const decision = check(engine());
    assert.equal(decision.behavior, 'ask');
    assert.deepEqual(decision.suggestions, [{ rule: 'Skill(deploy *)', persist: true }]);
  });

  it('matches exact and prefix rules', () => {
    assert.equal(check(engine('default', { allow: ['Skill(deploy)'] })).behavior, 'allow');
    assert.equal(check(engine('default', { allow: ['Skill(deploy)'] }), 'deploy', 'prod').behavior, 'ask');
    assert.equal(check(engine('default', { allow: ['Skill(deploy *)'] }), 'deploy', 'prod').behavior, 'allow');
    assert.equal(check(engine('default', { allow: ['Skill(deploy *)'] }), 'deployer').behavior, 'ask');
    assert.equal(check(engine('default', { allow: ['Skill'] })).behavior, 'allow');
  });

  it('a deny or ask rule applies even to a text-only skill', () => {
    assert.equal(check(engine('default', { deny: ['Skill(deploy *)'] }), 'deploy', '', false).behavior, 'deny');
    assert.equal(check(engine('default', { ask: ['Skill(notes)'] }), 'notes', '', false).behavior, 'ask');
    assert.ok(engine('default', { deny: ['Skill'] }).isToolRemoved('Skill'));
  });

  it('becomes a denial where nobody can answer', () => {
    assert.equal(check(engine('dontAsk')).behavior, 'deny');
    assert.equal(check(engine('dontAsk'), 'notes', '', false).behavior, 'allow');
    assert.equal(check(engine('bypassPermissions')).behavior, 'allow');
  });
});

describe('turn-long rules', () => {
  const cwd = '/tmp/cairn-turn-rules';
  const engine = (): PermissionEngine => new PermissionEngine({ mode: 'default', rules: [], workingDirs: [cwd], cwd: () => cwd });
  const bash = (e: PermissionEngine, command: string) => e.check('Bash', { kind: 'bash', command }).behavior;

  it('apply until cleared', () => {
    const e = engine();
    e.addTurnRules(['Bash(make *)'], ['Bash(ls *)']);
    assert.equal(bash(e, 'make all'), 'allow');
    assert.equal(bash(e, 'ls'), 'deny');
    e.clearTurnRules();
    assert.equal(bash(e, 'make all'), 'ask');
    assert.equal(bash(e, 'ls'), 'allow');
  });

  it('never change which tools are offered, which would break the prompt cache', () => {
    const e = engine();
    e.addTurnRules([], ['Bash']);
    assert.equal(e.isToolRemoved('Bash'), false);
    assert.equal(bash(e, 'ls'), 'deny');
  });

  it('cannot pre-approve past plan mode or a critical removal', () => {
    const e = engine();
    e.mode = 'plan';
    e.addTurnRules(['Bash(make *)', 'Edit'], []);
    assert.equal(bash(e, 'make all'), 'deny');
    assert.equal(e.check('Edit', { kind: 'edit', paths: [join(cwd, 'a')] }).behavior, 'deny');
    e.mode = 'default';
    e.addTurnRules(['Bash'], []);
    assert.equal(bash(e, 'rm -rf /'), 'ask');
  });
});

describe('skills through the agent', () => {
  async function harness(turns: ScriptedTurn[], options: Partial<RuntimeOptions> & { answer?: PermissionAnswer; dir?: string } = {}) {
    const dir = options.dir ?? project();
    const provider = new ScriptedProvider(turns);
    const prompts: PermissionPrompt[] = [];
    const prompter: Prompter = {
      permission: async (prompt) => {
        prompts.push(prompt);
        return options.answer ?? { behavior: 'allow' };
      },
      questions: async () => null,
      approvePlan: async () => true,
    };
    const { answer: _a, dir: _d, ...rest } = options;
    const runtime = await createRuntime({ cwd: dir, prompter, provider, trust: true, ...rest });
    return { runtime, provider, prompts, dir };
  }
  async function collect(runtime: Runtime, prompt: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of runtime.agent.run(prompt, new AbortController().signal)) events.push(event);
    return events;
  }
  const result = (h: { provider: ScriptedProvider }, index: number, at = 0): ToolResultBlock => h.provider.requests[index]!.messages.at(-1)!.content[at] as ToolResultBlock;
  const call = (skill: string, args?: string): ScriptedTurn => ({ toolCalls: [{ name: 'Skill', input: { skill, ...(args ? { args } : {}) } }] });

  it('offers the tool and lists skills in the system prompt, only when there are any', async () => {
    writeSkill(home, 'review', '---\ndescription: Reviews code carefully\n---\nHow to review.');
    writeSkill(home, 'secret', '---\ndescription: User only\ndisable-model-invocation: true\n---\nx');
    const h = await harness([{ text: 'ok' }]);
    await collect(h.runtime, 'go');
    const request = h.provider.requests[0]!;
    assert.ok(request.tools.some((tool) => tool.name === 'Skill'));
    const system = JSON.stringify(request.system);
    assert.match(system, /- review: Reviews code carefully/);
    assert.doesNotMatch(system, /User only/);
    assert.doesNotMatch(system, /How to review/, 'bodies stay out until used');
  });

  it('with no skills yet, offers the tool for ones written later, but no listing', async () => {
    const h = await harness([{ text: 'ok' }]);
    await collect(h.runtime, 'go');
    assert.ok(h.provider.requests[0]!.tools.some((tool) => tool.name === 'Skill'));
    assert.doesNotMatch(JSON.stringify(h.provider.requests[0]!.system), /# Skills/);
  });

  it('a bare deny takes away both the tool and the listing', async () => {
    writeSkill(home, 'review', '---\ndescription: Reviews\n---\nx');
    const h = await harness([{ text: 'ok' }], { disallowedTools: ['Skill'] });
    await collect(h.runtime, 'go');
    assert.ok(!h.provider.requests[0]!.tools.some((tool) => tool.name === 'Skill'));
    assert.doesNotMatch(JSON.stringify(h.provider.requests[0]!.system), /# Skills/);
  });

  it('returns the instructions with arguments filled in and the base directory', async () => {
    const dir = writeSkill(home, 'review', 'Review $ARGUMENTS with care.');
    const h = await harness([call('review', 'src/a.ts'), { text: 'done' }]);
    await collect(h.runtime, 'go');
    assert.equal(result(h, 1).content, `Base directory for this skill: ${dir}\n\nReview src/a.ts with care.`);
    assert.equal(h.prompts.length, 0, 'a text-only skill needs no approval');
  });

  it('appends arguments when no placeholder took them', async () => {
    writeSkill(home, 'plain', 'Do the thing.');
    const h = await harness([call('plain', 'extra'), { text: 'done' }]);
    await collect(h.runtime, 'go');
    assert.match(result(h, 1).content, /Do the thing\.\n\nARGUMENTS: extra$/);
  });

  it('reports an unknown skill, and refuses a user-only one', async () => {
    writeSkill(home, 'mine', '---\ndisable-model-invocation: true\n---\nSecret deploy steps.');
    const h = await harness([call('nope'), call('mine'), { text: 'done' }]);
    await collect(h.runtime, 'go');
    assert.match(result(h, 1).content, /No skill named "nope"/);
    assert.match(result(h, 2).content, /only be run by the user/);
    assert.doesNotMatch(result(h, 2).content, /Secret deploy steps/);
  });

  it('asks before loading a skill with commands, and respects a refusal', async () => {
    const dir = project();
    const marker = join(dir, 'ran');
    writeSkill(home, 'powerful', `---\nallowed-tools: Bash(touch *)\n---\n!\`touch ${marker}\``);
    const h = await harness([call('powerful'), { text: 'done' }], { dir, answer: { behavior: 'deny' } });
    await collect(h.runtime, 'go');
    assert.equal(h.prompts[0]!.toolName, 'Skill');
    assert.equal(existsSync(marker), false);
  });

  describe('injected commands', () => {
    it('run before the model sees the text, with output in place', async () => {
      const dir = project();
      writeFileSync(join(dir, 'note.txt'), 'contents of the note');
      writeSkill(home, 'inject', 'Before.\n!`cat note.txt`\nAfter.');
      const h = await harness([call('inject'), { text: 'done' }], { dir });
      await collect(h.runtime, 'go');
      assert.match(result(h, 1).content, /Before\.\ncontents of the note\nAfter\.$/);
    });

    it('stop the whole skill if not allowed, without running or prompting', async () => {
      const dir = project();
      const marker = join(dir, 'ran');
      writeSkill(home, 'blocked', `Text.\n!\`touch ${marker}\``);
      const h = await harness([call('blocked'), { text: 'done' }], { dir });
      await collect(h.runtime, 'go');
      assert.equal(h.prompts.length, 1, 'only the prompt for loading the skill');
      assert.equal(existsSync(marker), false);
      assert.equal(result(h, 1).is_error, true);
      assert.match(result(h, 1).content, /not allowed/);
      assert.doesNotMatch(result(h, 1).content, /^Text\./);
    });

    it('run when the skill\'s allowed-tools cover them', async () => {
      const dir = project();
      const marker = join(dir, 'ran');
      writeSkill(home, 'granted', `---\nallowed-tools: Bash(touch *)\n---\n!\`touch ${marker}\`\nDone.`);
      const h = await harness([call('granted'), { text: 'done' }], { dir });
      await collect(h.runtime, 'go');
      assert.equal(existsSync(marker), true);
      assert.equal(result(h, 1).is_error, undefined);
    });

    it('a deny rule beats the skill\'s own allowed-tools', async () => {
      const dir = project();
      const marker = join(dir, 'ran');
      writeSkill(home, 'denied', `---\nallowed-tools: Bash(touch *)\n---\n!\`touch ${marker}\``);
      const h = await harness([call('denied'), { text: 'done' }], { dir, disallowedTools: ['Bash(touch *)'] });
      await collect(h.runtime, 'go');
      assert.equal(existsSync(marker), false);
      assert.match(result(h, 1).content, /Denied by rule/);
    });

    it('stop on failure, except exit 1 from a search', async () => {
      const dir = project();
      writeFileSync(join(dir, 'f'), 'hello');
      writeSkill(home, 'search', 'Found: [!`grep missing f`]');
      writeSkill(home, 'failing', '---\nallowed-tools: Bash(ls *)\n---\nx\n!`ls /nonexistent-path-xyz`');
      const h = await harness([call('search'), call('failing'), { text: 'done' }], { dir, allowedTools: ['Read'] });
      await collect(h.runtime, 'go');
      assert.match(result(h, 1).content, /Found: \[\]?/);
      assert.equal(result(h, 1).is_error, undefined);
      assert.equal(result(h, 2).is_error, true);
      assert.match(result(h, 2).content, /stopped because/);
    });

    it('do not move the session when they change directory', async () => {
      const dir = project();
      mkdirSync(join(dir, 'sub'));
      writeSkill(home, 'mover', '---\nallowed-tools: Bash(cd *)\n---\n!`cd sub`');
      const h = await harness([call('mover'), { text: 'done' }], { dir });
      await collect(h.runtime, 'go');
      assert.equal(h.runtime.context.cwd(), dir);
    });

    it('never run a command smuggled in through an argument', async () => {
      const dir = project();
      const marker = join(dir, 'pwned');
      writeSkill(home, 'echoes', 'You said: $ARGUMENTS');
      const h = await harness([call('echoes', `!\`touch ${marker}\``), { text: 'done' }], { dir, mode: 'bypassPermissions' });
      await collect(h.runtime, 'go');
      assert.equal(existsSync(marker), false);
      assert.ok(result(h, 1).content.includes(`You said: !\`touch ${marker}\``));
    });

    it('check an argument inserted into a command, as part of the final command', async () => {
      const dir = project();
      const marker = join(dir, 'pwned');
      writeSkill(home, 'lister', '---\nallowed-tools: Bash(ls *)\n---\n!`ls $ARGUMENTS`');
      const h = await harness([call('lister', `; touch ${marker}`), { text: 'done' }], { dir });
      await collect(h.runtime, 'go');
      assert.equal(existsSync(marker), false);
      assert.match(result(h, 1).content, /not allowed/);
    });
  });

  describe('allowed-tools', () => {
    it('last for the invoking turn only', async () => {
      const dir = project();
      writeSkill(home, 'grant', '---\nallowed-tools: Bash(mkdir *)\n---\nGo ahead.');
      const h = await harness(
        [call('grant'), { toolCalls: [{ name: 'Bash', input: { command: 'mkdir during-turn' } }] }, { text: 'one' }, { toolCalls: [{ name: 'Bash', input: { command: 'mkdir next-turn' } }] }, { text: 'two' }],
        { dir, answer: { behavior: 'allow' } },
      );
      await collect(h.runtime, 'first');
      assert.equal(existsSync(join(dir, 'during-turn')), true);
      const promptsAfterFirst = h.prompts.filter((p) => p.toolName === 'Bash').length;
      assert.equal(promptsAfterFirst, 0, 'pre-approved during the turn');
      await collect(h.runtime, 'second');
      assert.equal(h.prompts.filter((p) => p.toolName === 'Bash').length, 1, 'asks again next turn');
    });

    it('disallowed-tools block a tool for the turn without changing the tool list', async () => {
      const dir = project();
      writeSkill(home, 'block', '---\ndisallowed-tools: Write\n---\nNo writing.');
      const target = join(dir, 'out');
      const write = { toolCalls: [{ name: 'Write', input: { file_path: target, content: 'x' } }] };
      const h = await harness([call('block'), write, { text: 'one' }, write, { text: 'two' }], { dir, mode: 'bypassPermissions' });
      await collect(h.runtime, 'first');
      assert.equal(existsSync(target), false);
      assert.match(result(h, 2).content, /Denied by rule/);
      assert.equal(JSON.stringify(h.provider.requests[0]!.tools), JSON.stringify(h.provider.requests[1]!.tools));
      await collect(h.runtime, 'second');
      assert.equal(existsSync(target), true);
    });
  });

  it('lets the model read a personal skill\'s files without a prompt, from then on', async () => {
    const skillDir = writeSkill(home, 'docs', 'See reference.md');
    writeFileSync(join(skillDir, 'reference.md'), 'the reference');
    const read = { toolCalls: [{ name: 'Read', input: { file_path: join(skillDir, 'reference.md') } }] };
    const h = await harness([read, call('docs'), read, { text: 'done' }]);
    await collect(h.runtime, 'go');
    assert.equal(h.prompts.length, 1, 'asks before the skill is loaded, not after');
    assert.match(result(h, 3).content, /the reference/);
  });

  it('notes a repeat rather than sending the same text again', async () => {
    writeSkill(home, 'same', 'Always the same text.');
    const h = await harness([call('same'), call('same'), call('same', 'different'), { text: 'done' }]);
    await collect(h.runtime, 'go');
    assert.match(result(h, 1).content, /Always the same text/);
    assert.match(result(h, 2).content, /already loaded/);
    assert.match(result(h, 3).content, /ARGUMENTS: different/);
  });

  it('applies a model and effort override for the rest of the turn only', async () => {
    writeSkill(home, 'cheap', '---\nmodel: small-model\neffort: low\n---\nx');
    const h = await harness([call('cheap'), { text: 'one' }, { text: 'two' }], { model: 'main-model' });
    await collect(h.runtime, 'first');
    await collect(h.runtime, 'second');
    const seen = h.provider.requests.map((r) => [r.model, r.effort]);
    assert.deepEqual(seen, [['main-model', undefined], ['small-model', 'low'], ['main-model', undefined]]);
    assert.equal(h.runtime.agent.model, 'main-model');
  });

  describe('context: fork', () => {
    it('runs in a subagent, and only the report comes back', async () => {
      writeSkill(home, 'research', '---\ncontext: fork\nagent: explore\nmodel: small-model\n---\nFind out about $ARGUMENTS.');
      const h = await harness([call('research', 'caching'), { text: 'the findings' }, { text: 'done' }]);
      await collect(h.runtime, 'go');
      const sub = h.provider.requests[1]!;
      assert.match(JSON.stringify(sub.messages), /Find out about caching/);
      assert.doesNotMatch(JSON.stringify(sub.messages), /"go"/);
      assert.deepEqual(sub.tools.map((t) => t.name).sort(), ['Glob', 'Grep', 'Read']);
      assert.equal(sub.model, 'small-model');
      assert.equal(result(h, 2).content, 'the findings');
    });

    it('keeps the skill\'s grants inside the subagent\'s work', async () => {
      const dir = project();
      writeSkill(home, 'builder', '---\ncontext: fork\nallowed-tools: Bash(mkdir *)\n---\nBuild.');
      const h = await harness(
        [call('builder'), { toolCalls: [{ name: 'Bash', input: { command: 'mkdir made' } }] }, { text: 'report' }, { text: 'done' }],
        { dir, answer: { behavior: 'allow' } },
      );
      await collect(h.runtime, 'go');
      assert.equal(existsSync(join(dir, 'made')), true);
      assert.equal(h.prompts.filter((p) => p.toolName === 'Bash').length, 0);
    });

    it('subagents do not get the Skill tool themselves', async () => {
      writeSkill(home, 'any', 'x');
      const h = await harness([{ toolCalls: [{ name: 'Agent', input: { description: 'd', prompt: 'p' } }] }, { text: 'r' }, { text: 'done' }]);
      await collect(h.runtime, 'go');
      assert.ok(!h.provider.requests[1]!.tools.some((t) => t.name === 'Skill'));
    });
  });

  describe('compaction', () => {
    it('keeps loaded skills, and a repeat call stays a short note', async () => {
      writeSkill(home, 'rules', 'Always write tests first.');
      const h = await harness([call('rules'), { text: 'one' }, { text: 'SUMMARY' }, call('rules'), { text: 'two' }]);
      await collect(h.runtime, 'first');
      await h.runtime.agent.compact('x');
      const kept = JSON.stringify(h.runtime.agent.messages);
      assert.match(kept, /SUMMARY/);
      assert.match(kept, /Always write tests first/);
      await collect(h.runtime, 'second');
      assert.match(result(h, 4).content, /already loaded/);
    });

    it('clips a huge skill, and loads it again in full when next called', async () => {
      const huge = 'y'.repeat(50_000);
      writeSkill(home, 'huge', huge);
      const h = await harness([call('huge'), { text: 'one' }, { text: 'SUMMARY' }, call('huge'), { text: 'two' }]);
      await collect(h.runtime, 'first');
      await h.runtime.agent.compact('x');
      assert.ok(JSON.stringify(h.runtime.agent.messages).length < 30_000);
      await collect(h.runtime, 'second');
      assert.ok(result(h, 4).content.includes(huge));
    });
  });

  it('/clear forgets what was loaded', async () => {
    writeSkill(home, 'same', 'The text.');
    const h = await harness([call('same'), { text: 'one' }, call('same'), { text: 'two' }]);
    await collect(h.runtime, 'first');
    h.runtime.newSession();
    await collect(h.runtime, 'second');
    assert.match(result(h, 3).content, /The text\./);
  });

  it('resuming keeps the listing recorded for that conversation', async () => {
    const dir = project();
    writeSkill(home, 'first-skill', '---\ndescription: The first\n---\nx');
    const first = await harness([{ text: 'one' }], { dir });
    await collect(first.runtime, 'go');
    writeSkill(home, 'later-skill', '---\ndescription: Added later\n---\ny');
    const resumed = await harness([{ text: 'two' }], { dir, continueLast: true });
    await collect(resumed.runtime, 'again');
    assert.equal(JSON.stringify(resumed.provider.requests[0]!.system), JSON.stringify(first.provider.requests[0]!.system));
  });

  describe('run by the user', () => {
    const io = { choose: async () => null };
    const run = async (runtime: Runtime, line: string) => settleCommand(await runSlashCommand(line, runtime, io), new AbortController().signal);

    it('/name renders the skill into the next prompt, with its grants', async () => {
      const dir = writeSkill(home, 'fix', '---\nallowed-tools: Bash(make *)\nmodel: small-model\n---\nFix $0 now.');
      const h = await harness([{ text: 'ok' }]);
      const result2 = await run(h.runtime, '/fix bug-123');
      assert.equal(result2.prompt, `Base directory for this skill: ${dir}\n\nFix bug-123 now.`);
      assert.deepEqual(result2.activation!.allowedTools, ['Bash(make *)']);
      assert.equal(result2.activation!.model, 'small-model');
      await collect(h.runtime, result2.prompt!);
    });

    it('expands the skill directory inside allowed-tools', async () => {
      const dir = writeSkill(home, 'script', '---\nallowed-tools: Bash(${CAIRN_SKILL_DIR}/run.sh *)\n---\nx');
      const h = await harness([]);
      assert.deepEqual((await run(h.runtime, '/script')).activation!.allowedTools, [`Bash(${dir}/run.sh *)`]);
    });

    it('a user-only skill works, and a model-only one does not', async () => {
      writeSkill(home, 'mine', '---\ndisable-model-invocation: true\n---\nMine.');
      writeSkill(home, 'theirs', '---\nuser-invocable: false\n---\nTheirs.');
      const h = await harness([]);
      assert.match((await run(h.runtime, '/mine')).prompt!, /Mine\./);
      assert.match((await run(h.runtime, '/theirs')).output!, /Unknown command/);
      const names = commandNames(h.runtime);
      assert.ok(names.includes('/mine'));
      assert.ok(!names.includes('/theirs'));
      assert.ok(names.includes('/skills'));
    });

    it('shows the error when an injected command is not allowed', async () => {
      writeSkill(home, 'bad', 'x\n!`make something`');
      const h = await harness([]);
      const result2 = await run(h.runtime, '/bad');
      assert.equal(result2.prompt, undefined);
      assert.match(result2.output!, /not allowed/);
    });

    it('a built-in command wins, and /skills points out the clash', async () => {
      writeSkill(home, 'help', '---\ndescription: My help\n---\nx');
      const h = await harness([]);
      assert.match((await run(h.runtime, '/help')).output!, /Show this list/);
      assert.match((await run(h.runtime, '/skills')).output!, /shadowed by a built-in/);
    });

    it('a forked skill reports back into the conversation', async () => {
      writeSkill(home, 'away', '---\ncontext: fork\n---\nDo it.');
      const h = await harness([{ text: 'subagent report' }]);
      assert.match((await run(h.runtime, '/away')).prompt!, /ran in a subagent and reported:\n\nsubagent report/);
    });

    it('/skills lists who can use what, and helps when there are none', async () => {
      const empty = await harness([]);
      assert.match((await run(empty.runtime, '/skills')).output!, /No skills/);
      writeSkill(home, 'a', '---\ndescription: Alpha\n---\nx');
      writeSkill(home, 'b', '---\ndisable-model-invocation: true\n---\ny');
      writeSkill(home, 'c', '---\nuser-invocable: false\n---\nz');
      writeSkill(home, 'bad', '---\nname: "not valid"\n---\nz');
      const h = await harness([]);
      const output = (await run(h.runtime, '/skills')).output!;
      assert.match(output, /a\s+user\s+you and the model\n\s+Alpha/);
      assert.match(output, /b\s+user\s+only you/);
      assert.match(output, /c\s+user\s+only the model/);
      assert.match(output, /invalid name/);
    });

    it('/help shows the argument hint', async () => {
      writeSkill(home, 'hinted', '---\ndescription: D\nargument-hint: "[file]"\n---\nx');
      const h = await harness([]);
      assert.match((await run(h.runtime, '/help')).output!, /\/hinted \[file\]\s+D/);
    });

    it('picks up a skill added during the session, for /name', async () => {
      const h = await harness([]);
      writeSkill(home, 'fresh', 'New skill.');
      assert.ok(resolveExtensionCommand('fresh', '', h.runtime));
    });
  });
});

describe('skills from the command line', () => {
  it('-p "/name args" runs a skill', () => {
    const dir = project();
    const script = join(home, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'ran it' }]));
    writeSkill(home, 'greet', 'Say hello to $0.');
    const result = spawnSync(process.execPath, [CLI, '-p', '/greet world', '--provider', 'scripted'], {
      cwd: dir,
      env: { ...process.env, CAIRN_HOME: home, CAIRN_SCRIPT: script },
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ran it\n');
  });

  it('-p reports a skill that cannot run, without calling the model', () => {
    const dir = project();
    const script = join(home, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'should not be reached' }]));
    writeSkill(home, 'needs-make', '!`make deploy`');
    const result = spawnSync(process.execPath, [CLI, '-p', '/needs-make', '--provider', 'scripted'], {
      cwd: dir,
      env: { ...process.env, CAIRN_HOME: home, CAIRN_SCRIPT: script },
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not allowed/);
    assert.equal(result.stdout, '');
  });

  it('-p sends an unknown /word to the model as plain text', () => {
    const dir = project();
    const script = join(home, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'fine' }]));
    const result = spawnSync(process.execPath, [CLI, '-p', '/etc/hosts looks wrong', '--provider', 'scripted'], {
      cwd: dir,
      env: { ...process.env, CAIRN_HOME: home, CAIRN_SCRIPT: script },
      encoding: 'utf8',
      input: '',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'fine\n');
  });
});
