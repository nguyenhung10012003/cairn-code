/** The OS sandbox. On macOS these run real commands through Seatbelt, and try to break out. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { PermissionEngine } from '../src/permissions/engine.ts';
import { hostDecision, isLocalAddress } from '../src/sandbox/proxy.ts';
import { bubblewrapArgs, createSandbox, globToSeatbeltRegex, mergeSandboxSettings, seatbeltProfile } from '../src/sandbox/sandbox.ts';
import type { Sandbox, SandboxSettings } from '../src/sandbox/sandbox.ts';

const isMac = process.platform === 'darwin';

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-box-')));
}

const madeOutside: string[] = [];

/** Outside the temp directory, which is writable from inside on purpose. */
function outsideDir(): string {
  const dir = realpathSync(mkdtempSync('/var/tmp/cairn-box-outside-'));
  madeOutside.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of madeOutside) rmSync(dir, { recursive: true, force: true });
});

async function box(dir: string, settings: SandboxSettings = {}): Promise<Sandbox> {
  const { sandbox } = await createSandbox({ enabled: true, ...settings }, { cwd: dir, workingDirs: () => [dir] });
  assert.ok(sandbox);
  return sandbox;
}

function run(sandbox: Sandbox, dir: string, command: string, unsandboxed = false): { status: number | null; stdout: string; stderr: string } {
  const wrapped = sandbox.wrap('/bin/sh', ['-c', command], { command, unsandboxed });
  const result = spawnSync(wrapped.file, wrapped.args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...wrapped.env }, timeout: 20_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** spawnSync would block the event loop the proxy runs on. */
function runAsync(sandbox: Sandbox, dir: string, command: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const wrapped = sandbox.wrap('/bin/sh', ['-c', command], { command, unsandboxed: false });
  return new Promise((resolve) => {
    const child = spawn(wrapped.file, wrapped.args, { cwd: dir, env: { ...process.env, ...wrapped.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(!isMac)('commands inside the sandbox', () => {
  let dir: string;
  let outside: string;
  let sandbox: Sandbox;
  beforeAll(async () => {
    dir = tempDir();
    outside = outsideDir();
    sandbox = await box(dir);
  });
  afterAll(() => sandbox.close());

  it('can write in the working directory and the temp directory', () => {
    assert.equal(run(sandbox, dir, `echo hi > ${join(dir, 'inside.txt')}`).status, 0);
    assert.equal(readFileSync(join(dir, 'inside.txt'), 'utf8'), 'hi\n');
    assert.equal(run(sandbox, dir, `echo hi > "${join(tmpdir(), `cairn-box-${process.pid}`)}"`).status, 0);
    assert.equal(run(sandbox, dir, 'echo hi > /dev/null').status, 0);
  });

  it('cannot write outside', () => {
    const target = join(outside, 'escape.txt');
    assert.notEqual(run(sandbox, dir, `echo hi > ${target}`).status, 0);
    assert.equal(existsSync(target), false);
  });

  it('holds for child processes too', () => {
    const target = join(outside, 'child.txt');
    run(sandbox, dir, `/bin/sh -c 'python3 -c "open(\\"${target}\\", \\"w\\")"; touch ${target}'`);
    assert.equal(existsSync(target), false);
  });

  it('cannot get out through a symlink', () => {
    const target = join(outside, 'via-link.txt');
    run(sandbox, dir, `ln -s ${outside} ${join(dir, 'link')}; echo hi > ${join(dir, 'link/via-link.txt')}`);
    assert.equal(existsSync(target), false);
  });

  it('cannot change the files that decide what runs later', () => {
    for (const relative of ['.git/hooks/pre-commit', '.git/config', '.cairn/settings.json', '.cairn/settings.local.json', '.cairn/hooks/x', '.mcp.json', 'CAIRN.md', 'packages/a/.git/hooks/post-commit']) {
      const path = join(dir, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      assert.notEqual(run(sandbox, dir, `echo evil > ${path}`).status, 0, relative);
      assert.equal(existsSync(path), false, relative);
    }
  });

  it('has no network', () => {
    assert.notEqual(run(sandbox, dir, 'curl -sS --max-time 3 https://example.com -o /dev/null').status, 0);
  });

  it('keeps running what it can: reading files and ordinary tools', () => {
    writeFileSync(join(dir, 'r.txt'), 'readable');
    assert.equal(run(sandbox, dir, 'cat r.txt').stdout, 'readable');
    assert.equal(run(sandbox, dir, 'git --version').status, 0);
  });

  it('runs outside when the model asks and the setting allows it', () => {
    const target = join(outside, 'allowed-out.txt');
    assert.equal(run(sandbox, dir, `echo hi > ${target}`, true).status, 0);
    assert.equal(existsSync(target), true);
  });
});

describe.skipIf(!isMac)('sandbox settings', () => {
  it('honours allowWrite, and denyWrite inside it', async () => {
    const dir = tempDir();
    const extra = outsideDir();
    mkdirSync(join(extra, 'locked'));
    const sandbox = await box(dir, { filesystem: { allowWrite: [extra], denyWrite: [join(extra, 'locked')] } });
    assert.equal(run(sandbox, dir, `echo a > ${join(extra, 'ok.txt')}`).status, 0);
    assert.notEqual(run(sandbox, dir, `echo a > ${join(extra, 'locked/no.txt')}`).status, 0);
    await sandbox.close();
  });

  it('honours denyRead, with allowRead carving out something narrower, and wildcards', async () => {
    const dir = tempDir();
    const secret = outsideDir();
    writeFileSync(join(secret, 'key'), 'secret');
    mkdirSync(join(secret, 'public'));
    writeFileSync(join(secret, 'public/ok'), 'fine');
    mkdirSync(join(dir, 'deep/er'), { recursive: true });
    writeFileSync(join(dir, 'deep/er/.env'), 'TOKEN=x');
    writeFileSync(join(dir, 'plain'), 'fine');
    const sandbox = await box(dir, { filesystem: { denyRead: [secret, `${dir}/**/.env`], allowRead: [join(secret, 'public')] } });
    assert.notEqual(run(sandbox, dir, `cat ${join(secret, 'key')}`).status, 0);
    assert.equal(run(sandbox, dir, `cat ${join(secret, 'public/ok')}`).stdout, 'fine');
    assert.notEqual(run(sandbox, dir, 'cat deep/er/.env').status, 0);
    assert.equal(run(sandbox, dir, 'cat plain').stdout, 'fine');
    await sandbox.close();
  });

  it('with allowUnsandboxedCommands off, ignores a request to leave', async () => {
    const dir = tempDir();
    const outside = outsideDir();
    const sandbox = await box(dir, { allowUnsandboxedCommands: false });
    const target = join(outside, 'no.txt');
    assert.notEqual(run(sandbox, dir, `echo a > ${target}`, true).status, 0);
    assert.equal(existsSync(target), false);
    await sandbox.close();
  });

  it('runs an excluded command outside, but not when another is chained on', async () => {
    const dir = tempDir();
    const outside = outsideDir();
    const sandbox = await box(dir, { excludedCommands: ['touch *'] });
    const free = join(outside, 'free.txt');
    assert.equal(run(sandbox, dir, `touch ${free}`).status, 0);
    assert.equal(existsSync(free), true);
    const smuggled = join(outside, 'smuggled.txt');
    assert.notEqual(run(sandbox, dir, `touch ${join(dir, 'y')}; echo evil > ${smuggled}`).status, 0);
    assert.equal(existsSync(smuggled), false);
    await sandbox.close();
  });
});

describe.skipIf(!isMac)('the network proxy', () => {
  let web: ReturnType<typeof createServer>;
  let port: number;
  beforeAll(async () => {
    web = createServer((_req, res) => res.end('reached'));
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    port = (web.address() as AddressInfo).port;
  });
  afterAll(() => web.close());

  it('lets an allowed host through, from inside the sandbox', async () => {
    const dir = tempDir();
    const sandbox = await box(dir, { network: { allowedDomains: ['127.0.0.1'] } });
    const result = await runAsync(sandbox, dir, `curl -sS --max-time 5 http://127.0.0.1:${port}/`);
    assert.equal(result.stdout, 'reached', result.stderr);
    await sandbox.close();
  });

  it('refuses a host not on the list, with a reason', async () => {
    const dir = tempDir();
    const sandbox = await box(dir, { network: { allowedDomains: ['example.com'] } });
    const result = await runAsync(sandbox, dir, `curl -sS --max-time 5 http://127.0.0.1:${port}/`);
    assert.doesNotMatch(result.stdout, /reached/);
    assert.match(result.stdout, /does not allow connections to 127\.0\.0\.1/);
    await sandbox.close();
  });

  it('cannot be skipped by telling the tool to ignore the proxy', async () => {
    const dir = tempDir();
    const sandbox = await box(dir, { network: { allowedDomains: ['example.com'] } });
    const result = await runAsync(sandbox, dir, `curl -sS --noproxy '*' --max-time 3 http://127.0.0.1:${port}/`);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /reached/);
    await sandbox.close();
  });

  it('refuses a tunnel to a host not on the list', async () => {
    const dir = tempDir();
    const sandbox = await box(dir, { network: { allowedDomains: ['example.com'] } });
    const result = await runAsync(sandbox, dir, 'curl -sS --max-time 5 https://evil.test/ 2>&1');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /403/);
    await sandbox.close();
  });
});

describe('proxy policy', () => {
  const policy = { allowedDomains: ['github.com', '*.npmjs.org', 'api.test:8443'], deniedDomains: ['bad.npmjs.org'] };

  it('matches exact names and subdomains, and a port when one is given', () => {
    assert.equal(hostDecision(policy, 'github.com', 443), true);
    assert.equal(hostDecision(policy, 'GitHub.com', 443), true);
    assert.equal(hostDecision(policy, 'registry.npmjs.org', 443), true);
    assert.equal(hostDecision(policy, 'api.test', 8443), true);
    assert.equal(hostDecision(policy, 'api.test', 443), false);
  });

  it('does not match lookalikes', () => {
    assert.equal(hostDecision(policy, 'github.com.evil.test', 443), false);
    assert.equal(hostDecision(policy, 'evilgithub.com', 443), false);
    assert.equal(hostDecision(policy, 'npmjs.org', 443), false, 'a wildcard covers subdomains, not the name itself');
    assert.equal(hostDecision(policy, 'evilnpmjs.org', 443), false);
  });

  it('lets deny win', () => {
    assert.equal(hostDecision(policy, 'bad.npmjs.org', 443), false);
  });

  it('recognises local addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1']) {
      assert.equal(isLocalAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(isLocalAddress(address), false, address);
  });
});

describe('sandbox profile', () => {
  const policy = { writable: ['/w'], denyWrite: [], denyRead: [], allowRead: [], proxyPort: null, allowLocalBinding: false };

  it('quotes paths, so a directory name cannot add rules', () => {
    const profile = seatbeltProfile({ ...policy, writable: ['/w") (allow file-write* (subpath "/'] });
    assert.ok(profile.includes('\\"'));
    assert.ok(!profile.includes('(subpath "/w") (allow'));
  });

  it('turns globs into regular expressions that stop at slashes', () => {
    const star = new RegExp(globToSeatbeltRegex('/a/*.env'));
    assert.ok(star.test('/a/x.env'));
    assert.ok(!star.test('/a/b/x.env'));
    const deep = new RegExp(globToSeatbeltRegex('/a/**/.env'));
    assert.ok(deep.test('/a/b/c/.env'));
    assert.ok(deep.test('/a/.env'));
    assert.ok(!new RegExp(globToSeatbeltRegex('/a.b/*')).test('/axb/c'), 'dots are literal');
  });

  it('builds a bubblewrap command with no network and a writable project', () => {
    const dir = tempDir();
    const args = bubblewrapArgs({ ...policy, writable: [dir] }, '/bin/sh', ['-c', 'x']);
    assert.ok(args.includes('--unshare-net'));
    assert.deepEqual(args.slice(args.indexOf('--bind'), args.indexOf('--bind') + 3), ['--bind', dir, dir]);
    assert.deepEqual(args.slice(-4), ['--', '/bin/sh', '-c', 'x']);
  });

  it('adds lists together across settings layers, so a deny cannot be removed', () => {
    const merged = mergeSandboxSettings(
      { enabled: true, filesystem: { denyRead: ['~/.ssh'] }, network: { allowedDomains: ['a.test'], deniedDomains: ['x.test'] } },
      { enabled: false, filesystem: { denyRead: ['~/.aws'] }, network: { allowedDomains: ['b.test'] } },
    );
    assert.deepEqual(merged.filesystem!.denyRead, ['~/.ssh', '~/.aws']);
    assert.deepEqual(merged.network!.allowedDomains, ['a.test', 'b.test']);
    assert.deepEqual(merged.network!.deniedDomains, ['x.test']);
    assert.equal(merged.enabled, false);
  });
});

describe('sandbox availability', () => {
  it('stays off unless enabled', async () => {
    assert.equal((await createSandbox({}, { cwd: '/', workingDirs: () => ['/'] })).sandbox, null);
  });

  it('warns and runs without it when it cannot run, unless told to refuse', async () => {
    const options = { cwd: '/', workingDirs: () => ['/'], platform: 'win32' as const };
    const created = await createSandbox({ enabled: true }, options);
    assert.equal(created.sandbox, null);
    assert.match(created.warnings[0]!, /not supported/);
    await assert.rejects(createSandbox({ enabled: true, failIfUnavailable: true }, options), /failIfUnavailable/);
  });
});

describe('permissions when sandboxed', () => {
  function engine(rules: { deny?: string[]; ask?: string[]; allow?: string[] } = {}, mode: 'default' | 'plan' | 'dontAsk' = 'default', autoAllow = true): PermissionEngine {
    const dir = tempDir();
    const instance = new PermissionEngine({ mode, rules: [], workingDirs: [dir], cwd: () => dir });
    for (const [behavior, list] of Object.entries(rules)) {
      for (const text of list) instance.addRule(text, behavior as 'deny', 'user');
    }
    instance.sandbox = { autoAllows: (_command, unsandboxed) => autoAllow && !unsandboxed };
    return instance;
  }

  const check = (e: PermissionEngine, command: string, unsandboxed = false) => e.check('Bash', { kind: 'bash', command, unsandboxed });

  it('runs a command without asking', () => {
    assert.equal(check(engine(), 'make build').behavior, 'allow');
  });

  it('still honours deny rules and ask rules that name the command', () => {
    assert.equal(check(engine({ deny: ['Bash(make *)'] }), 'make build').behavior, 'deny');
    assert.equal(check(engine({ ask: ['Bash(git push *)'] }), 'git push origin main').behavior, 'ask');
  });

  it('skips a bare Bash ask rule, except in plan mode', () => {
    assert.equal(check(engine({ ask: ['Bash'] }), 'make build').behavior, 'allow');
    assert.equal(check(engine({ ask: ['Bash'] }, 'plan'), 'make build').behavior, 'ask');
  });

  it('still asks before removing a critical path', () => {
    assert.equal(check(engine(), 'rm -rf /').behavior, 'ask');
  });

  it('asks before running unsandboxed, and says so', () => {
    const decision = check(engine(), 'make build', true);
    assert.equal(decision.behavior, 'ask');
    assert.match(decision.reason, /unsandboxed/);
  });

  it('lets an allow rule approve leaving, unless an ask rule targets the parameter', () => {
    assert.equal(check(engine({ allow: ['Bash(make *)'] }), 'make build', true).behavior, 'allow');
    assert.equal(check(engine({ allow: ['Bash(make *)'], ask: ['Bash(dangerouslyDisableSandbox:true)'] }), 'make build', true).behavior, 'ask');
  });

  it('denies leaving in dontAsk mode', () => {
    assert.equal(check(engine({}, 'dontAsk'), 'make build', true).behavior, 'deny');
  });

  it('keeps plan mode read-only regardless', () => {
    assert.equal(check(engine({}, 'plan'), 'make build').behavior, 'deny');
    assert.equal(check(engine({}, 'plan'), 'ls').behavior, 'allow');
  });

  it('uses normal permissions when auto-allow is off', () => {
    assert.equal(check(engine({}, 'default', false), 'make build').behavior, 'ask');
  });

  it.skipIf(!isMac)('sends a command that sets variables through the normal flow', async () => {
    const sandbox = await box(tempDir());
    assert.equal(sandbox.autoAllows('FOO=bar npm test', false), false);
    assert.equal(sandbox.autoAllows('npm test', false), true);
    await sandbox.close();
  });
});
