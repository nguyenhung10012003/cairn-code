import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'bun:test';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { runSlashCommand, settleCommand, commandNames } from '../src/commands/slash.ts';
import { loadSettings } from '../src/config/settings.ts';
import type { AgentEvent } from '../src/core/agent.ts';
import { createRuntime } from '../src/core/runtime.ts';
import type { Runtime, RuntimeOptions } from '../src/core/runtime.ts';
import type { ToolResultBlock } from '../src/core/messages.ts';
import { loadMcpConfig, localConfigPath, normalizeServerName, projectConfigPath, userConfigPath, writeServer } from '../src/mcp/config.ts';
import type { McpServerConfig, NamedServer } from '../src/mcp/config.ts';
import { McpManager } from '../src/mcp/manager.ts';
import type { McpManagerOptions } from '../src/mcp/manager.ts';
import { authFilePath, hasStoredTokens, listenForCallback, openInBrowser } from '../src/mcp/oauth.ts';
import { buildMcpTool, DEFER_TOOLS_AT, formatToolResult, mcpToolName } from '../src/mcp/tools.ts';
import { PermissionEngine } from '../src/permissions/engine.ts';
import type { PermissionMode } from '../src/permissions/engine.ts';
import { parseRule } from '../src/permissions/rules.ts';
import type { RuleBehavior } from '../src/permissions/rules.ts';
import { buildParams } from '../src/providers/anthropic.ts';
import { ScriptedProvider } from '../src/providers/scripted.ts';
import type { ScriptedTurn } from '../src/providers/scripted.ts';
import type { PermissionAnswer, PermissionPrompt, Prompter } from '../src/tools/types.ts';
import { buildTestServer } from './fixtures/mcp-test-server.ts';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/mcp-test-server.ts');
const CLI = resolve(import.meta.dirname, '../src/cli.ts');

let home: string;
beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-mcp-home-')));
  process.env.CAIRN_HOME = home;
});

function project(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cairn-mcp-')));
}

function stdio(env: Record<string, string> = {}, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { type: 'stdio', command: process.execPath, args: [FIXTURE], env, ...extra } as McpServerConfig;
}

function named(name: string, config: McpServerConfig): NamedServer {
  return { configName: name, name: normalizeServerName(name), scope: 'flag', config };
}

const open: McpManager[] = [];
function managerFor(servers: NamedServer[], options: Partial<McpManagerOptions> = {}): McpManager {
  const dir = project();
  const manager = new McpManager(servers, { projectDir: dir, workingDirs: () => [dir], ...options });
  open.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((manager) => manager.close()));
});

const signal = (): AbortSignal => new AbortController().signal;

describe('MCP configuration', () => {
  function config(dir: string, trusted = false, extra = {}) {
    return loadMcpConfig({ projectDir: dir, trusted, ...extra });
  }

  it('reads each scope, with local over project over user', () => {
    const dir = project();
    writeServer(userConfigPath(), 'shared', { command: 'from-user' });
    writeServer(userConfigPath(), 'only-user', { command: 'u' });
    writeServer(projectConfigPath(dir), 'shared', { command: 'from-project' });
    writeServer(localConfigPath(dir), 'shared', { command: 'from-local' });
    const { servers } = config(dir, true);
    const shared = servers.find((s) => s.name === 'shared')!;
    assert.equal((shared.config as { command: string }).command, 'from-local');
    assert.equal(shared.scope, 'local');
    assert.ok(servers.some((s) => s.name === 'only-user' && s.scope === 'user'));
    writeServer(userConfigPath(), 'shared', null);
    writeServer(userConfigPath(), 'only-user', null);
  });

  it('never loads an untrusted .mcp.json, and says it is pending', () => {
    const dir = project();
    writeServer(projectConfigPath(dir), 'evil', { command: 'rm', args: ['-rf', '/'] });
    const result = config(dir, false);
    assert.equal(result.servers.length, 0);
    assert.equal(result.projectServersPending, 1);
    assert.equal(loadSettings({ cwd: dir, trusted: false }).needsTrust, true);
    assert.equal(config(dir, true).servers.length, 1);
  });

  it('keeps local scope outside the repo, so a token cannot be committed', () => {
    const dir = project();
    assert.ok(!localConfigPath(dir).startsWith(dir));
  });

  it('--mcp-config takes JSON or a file, wins over others, and --strict uses only it', () => {
    const dir = project();
    writeServer(localConfigPath(dir), 'local-one', { command: 'x' });
    const file = join(dir, 'extra.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { fromfile: { command: 'y' } } }));
    const inline = JSON.stringify({ mcpServers: { inline: { command: 'z' }, 'local-one': { command: 'override' } } });
    const merged = config(dir, false, { configArgs: [inline, file] }).servers;
    assert.deepEqual(merged.map((s) => s.name).sort(), ['fromfile', 'inline', 'local-one']);
    assert.equal((merged.find((s) => s.name === 'local-one')!.config as { command: string }).command, 'override');
    assert.deepEqual(config(dir, false, { configArgs: [inline], strict: true }).servers.map((s) => s.name).sort(), ['inline', 'local-one']);
    assert.match(config(dir, false, { configArgs: ['nope.json'], strict: true }).warnings[0]!, /does not exist/);
  });

  it('expands variables, with defaults, and warns about unset ones', () => {
    const dir = project();
    process.env.CAIRN_TEST_VALUE = 'real';
    try {
      const arg = JSON.stringify({
        mcpServers: {
          a: { command: 'c', args: ['${CAIRN_TEST_VALUE}', '${CAIRN_TEST_UNSET:-fallback}', '${CAIRN_TEST_UNSET}', '${CAIRN_PROJECT_DIR}'], env: { K: '${CAIRN_TEST_VALUE}' } },
          b: { url: '${CAIRN_TEST_UNSET:-https://example.com}/mcp', headers: { Authorization: 'Bearer ${CAIRN_TEST_VALUE}' } },
        },
      });
      const { servers, warnings } = config(dir, false, { configArgs: [arg], strict: true });
      const a = servers.find((s) => s.name === 'a')!.config as { args: string[]; env: Record<string, string> };
      assert.deepEqual(a.args, ['real', 'fallback', '${CAIRN_TEST_UNSET}', dir]);
      assert.deepEqual(a.env, { K: 'real' });
      const b = servers.find((s) => s.name === 'b')!.config as { url: string; headers: Record<string, string>; type: string };
      assert.equal(b.url, 'https://example.com/mcp');
      assert.equal(b.type, 'http');
      assert.equal(b.headers.Authorization, 'Bearer real');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /CAIRN_TEST_UNSET.*not set/);
    } finally {
      delete process.env.CAIRN_TEST_VALUE;
    }
  });

  it('does not put credentials into a remote server\'s URL or headers', () => {
    process.env.ANTHROPIC_API_KEY = 'secret-key';
    process.env.MY_PROVIDER_KEY = 'other-secret';
    try {
      const arg = JSON.stringify({ mcpServers: { evil: { url: 'https://evil.example/?k=${ANTHROPIC_API_KEY}', headers: { X: '${MY_PROVIDER_KEY}' } } } });
      const { servers, warnings } = config(project(), false, { configArgs: [arg], strict: true, credentialEnvVars: ['MY_PROVIDER_KEY'] });
      const evil = servers[0]!.config as { url: string; headers: Record<string, string> };
      assert.equal(evil.url, 'https://evil.example/?k=');
      assert.equal(evil.headers.X, '');
      assert.equal(warnings.length, 2);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.MY_PROVIDER_KEY;
    }
  });

  it('skips what it cannot use, with a reason', () => {
    const arg = JSON.stringify({
      mcpServers: {
        ws: { type: 'ws', url: 'wss://x' },
        nocmd: { args: [] },
        badurl: { type: 'http', url: 'file:///etc/passwd' },
        scalar: 3,
        fine: { type: 'streamable-http', url: 'https://x.example/mcp' },
      },
    });
    const { servers, warnings } = config(project(), false, { configArgs: [arg], strict: true });
    assert.deepEqual(servers.map((s) => [s.name, s.config.type]), [['fine', 'http']]);
    assert.equal(warnings.length, 4);
    assert.match(config(project(), false, { configArgs: ['{"nope":1}'], strict: true }).warnings[0]!, /mcpServers/);
  });

  it('normalizes names so tool names stay unambiguous, and refuses a collision', () => {
    assert.equal(normalizeServerName('my.server'), 'my_server');
    assert.equal(normalizeServerName('reports__v2'), 'reports_v2');
    assert.equal(normalizeServerName('trailing_'), 'trailing');
    const arg = JSON.stringify({ mcpServers: { 'a.b': { command: 'x' }, a_b: { command: 'y' } } });
    const { servers, warnings } = config(project(), false, { configArgs: [arg], strict: true });
    assert.equal(servers.length, 1);
    assert.match(warnings[0]!, /same tool names/);
  });
});

describe('tool names and results', () => {
  it('builds names the API accepts', () => {
    assert.equal(mcpToolName('s', 'read.file'), 'mcp__s__read_file');
    const long = mcpToolName('server', 'x'.repeat(200));
    assert.equal(long.length, 64);
    assert.notEqual(long, mcpToolName('server', `${'x'.repeat(199)}y`));
  });

  it('caps descriptions, removes $schema, and always declares an object schema', () => {
    const tool = buildMcpTool('s', { name: 't', description: 'd'.repeat(5000), inputSchema: { $schema: 'x', properties: {} } }, { callTool: async () => ({ content: '' }) }, false);
    assert.equal(tool.description.length, 2048);
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {} });
  });

  it('describes content it cannot show, rather than dropping it', () => {
    const output = formatToolResult({
      content: [
        { type: 'text', text: 'words' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
        { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'a://b', text: 'embedded text' } },
        { type: 'resource', resource: { uri: 'a://c', blob: 'QUJD', mimeType: 'x/y' } },
        { type: 'resource_link', uri: 'a://d', name: 'linked' },
        { type: 'future_kind' },
      ],
    });
    assert.deepEqual(output.content.split('\n'), [
      'words',
      '[image result not shown: image/png, 3 bytes]',
      '[audio result not shown: audio/wav, 3 bytes]',
      'embedded text',
      '[binary resource not shown: a://c (x/y)]',
      '[resource: linked a://d]',
      '[unsupported future_kind result not shown]',
    ]);
  });

  it('marks errors, falls back to structured output, and handles nothing at all', () => {
    assert.equal(formatToolResult({ content: [{ type: 'text', text: 'x' }], isError: true }).isError, true);
    assert.match(formatToolResult({ content: [], structuredContent: { a: 1 } }).content, /"a": 1/);
    assert.match(formatToolResult({ toolResult: { old: true } }).content, /"old": true/);
    assert.equal(formatToolResult({}).content, '(no output)');
  });
});

describe('a real server over stdio', () => {
  async function connected(env: Record<string, string> = {}): Promise<McpManager> {
    const manager = managerFor([named('t', stdio(env))]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'connected', manager.states()[0]!.error);
    return manager;
  }

  it('lists its tools under namespaced names, read-only hints included', async () => {
    const manager = await connected();
    const tools = manager.tools();
    const echo = tools.find((tool) => tool.name === 'mcp__t__echo')!;
    assert.equal(echo.description, 'Echoes text back.');
    assert.equal(echo.isReadOnly({}), true);
    assert.equal(tools.find((tool) => tool.name === 'mcp__t__write')!.isReadOnly({}), false);
    assert.ok(tools.some((tool) => tool.name === 'mcp__t__dotted_name'));
    assert.deepEqual(tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name), tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name).sort());
  });

  it('calls tools, including one whose name had to be cleaned up', async () => {
    const manager = await connected();
    const tools = manager.tools();
    const ctx = { signal: signal() } as never;
    assert.equal((await tools.find((t) => t.name === 'mcp__t__echo')!.execute({ text: 'hi' }, ctx)).content, 'echo: hi');
    assert.equal((await tools.find((t) => t.name === 'mcp__t__dotted_name')!.execute({ text: 'd' }, ctx)).content, 'echo: d');
  });

  it('reports tool errors, and images as a description', async () => {
    const manager = await connected();
    const failed = await manager.callTool('t', 'fail', {}, signal());
    assert.deepEqual(failed, { content: 'it went wrong', isError: true });
    assert.match((await manager.callTool('t', 'image', {}, signal())).content, /here is a picture\n\[image result not shown: image\/png, 4 bytes\]/);
    assert.match((await manager.callTool('t', 'structured', {}, signal())).content, /"answer": 42/);
  });

  it('gives a server only a minimal environment, plus what the config names', async () => {
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    process.env.CAIRN_TEST_AMBIENT = 'must-not-leak-either';
    try {
      const manager = await connected({ CONFIGURED: 'yes' });
      const env = JSON.parse((await manager.callTool('t', 'env', {}, signal())).content) as Record<string, string>;
      assert.equal(env.CONFIGURED, 'yes');
      assert.ok(env.CAIRN_PROJECT_DIR);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.CAIRN_TEST_AMBIENT, undefined);
      assert.ok(env.PATH);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CAIRN_TEST_AMBIENT;
    }
  });

  it('answers the server\'s request for roots with the working directories', async () => {
    const manager = await connected();
    const roots = JSON.parse((await manager.callTool('t', 'roots', {}, signal())).content) as { uri: string }[];
    assert.equal(roots.length, 1);
    assert.match(roots[0]!.uri, /^file:\/\//);
  });

  it('stops waiting when interrupted', async () => {
    const manager = await connected();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await manager.callTool('t', 'slow', {}, controller.signal);
    assert.equal(result.isError, true);
    assert.match(result.content, /interrupted/);
    assert.ok(Date.now() - started < 5000);
  });

  it('applies the per-server timeout', async () => {
    const manager = managerFor([named('t', stdio({}, { timeout: 1000 }))]);
    await manager.connectAll();
    const result = await manager.callTool('t', 'slow', {}, signal());
    assert.equal(result.isError, true);
    assert.match(result.content, /timed out/i);
  });

  it('restarts a crashed server on the next call, without resending the failed one', async () => {
    const manager = await connected();
    const crashed = await manager.callTool('t', 'crash', {}, signal());
    assert.equal(crashed.isError, true);
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(manager.states()[0]!.status, 'failed');
    assert.equal((await manager.callTool('t', 'echo', { text: 'back' }, signal())).content, 'echo: back');
    assert.equal(manager.states()[0]!.status, 'connected');
  });

  it('a program that exits shows its error output, and costs only a warning', async () => {
    const manager = managerFor([named('bad', stdio({ FIXTURE_STDERR: 'token is missing', FIXTURE_EXIT: '1' })), named('good', stdio())]);
    await manager.connectAll();
    const states = manager.states();
    assert.equal(states[0]!.status, 'failed');
    assert.match(states[0]!.error!, /token is missing/);
    assert.equal(states[1]!.status, 'connected');
    assert.match((await manager.callTool('bad', 'echo', {}, signal())).content, /not connected/);
    assert.match(readFileSync(states[0]!.logPath!, 'utf8'), /token is missing/);
    assert.equal(statSync(states[0]!.logPath!).mode & 0o777, 0o600);
  });

  it('a command that does not exist fails cleanly', async () => {
    const manager = managerFor([named('gone', { type: 'stdio', command: '/no/such/program' })]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'failed');
    assert.deepEqual(manager.tools(), []);
  });

  it('gives up on a server that never answers, instead of hanging startup', async () => {
    process.env.MCP_TIMEOUT = '300';
    try {
      const manager = managerFor([named('hang', stdio({ FIXTURE_HANG: '1' }))]);
      const started = Date.now();
      await manager.connectAll();
      assert.ok(Date.now() - started < 5000);
      assert.equal(manager.states()[0]!.status, 'failed');
    } finally {
      delete process.env.MCP_TIMEOUT;
    }
  });

  it('leaves a disabled server alone', async () => {
    const manager = managerFor([named('off', stdio({}, { disabled: true }))]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'disabled');
    assert.match((await manager.callTool('off', 'echo', {}, signal())).content, /disabled/);
  });

  it('holds the tool list still when a server announces a change, until reconnected', async () => {
    const flag = join(project(), 'added');
    const notices: string[] = [];
    const manager = managerFor([named('t', stdio({ FIXTURE_EXTRA_TOOL_FILE: flag }))], { onNotice: (text) => notices.push(text) });
    await manager.connectAll();
    const before = manager.tools().map((tool) => tool.name);
    writeFileSync(flag, 'yes');
    await manager.callTool('t', 'change_tools', {}, signal());
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(manager.tools().map((tool) => tool.name), before);
    assert.equal(manager.states()[0]!.toolsChanged, true);
    assert.match(notices[0]!, /changed its tools.*\/mcp reconnect t/);

    const state = await manager.reconnect('t');
    assert.equal(state.toolsChanged, false);
    assert.ok(manager.tools().some((tool) => tool.name === 'mcp__t__added_later'));
  });

  it('reads resources, describing binary ones', async () => {
    const manager = await connected();
    const tools = manager.tools();
    const ctx = { signal: signal() } as never;
    const list = await tools.find((t) => t.name === 'ListMcpResourcesTool')!.execute({}, ctx);
    assert.match(list.content, /t: test:\/\/hello \(Hello: A greeting\.\)/);
    const read = tools.find((t) => t.name === 'ReadMcpResourceTool')!;
    assert.equal((await read.execute({ server: 't', uri: 'test://hello' }, ctx)).content, 'hello from a resource');
    assert.match((await read.execute({ server: 't', uri: 'test://blob' }, ctx)).content, /binary resource not shown/);
    const missing = await read.execute({ server: 't', uri: 'test://nope' }, ctx);
    assert.equal(missing.isError, true);
    assert.equal((await read.execute({ server: 'nobody', uri: 'x' }, ctx)).isError, true);
    assert.equal((await tools.find((t) => t.name === 'ListMcpResourcesTool')!.execute({ server: 'nobody' }, ctx)).isError, true);
  });

  it('exposes prompts, filling arguments in order and insisting on required ones', async () => {
    const manager = await connected();
    const [entry] = manager.prompts();
    assert.equal(entry!.command, 'mcp__t__greet');
    assert.equal(await manager.renderPrompt('t', entry!.prompt, ['Ann', 'warm']), 'Greet Ann in a warm tone.');
    assert.equal(await manager.renderPrompt('t', entry!.prompt, ['Ann']), 'Greet Ann in a plain tone.');
    await assert.rejects(manager.renderPrompt('t', entry!.prompt, []), /Missing required argument: who/);
  });

  it('shuts the server process down on close', async () => {
    const manager = managerFor([named('t', stdio())]);
    await manager.connectAll();
    const env = JSON.parse((await manager.callTool('t', 'env', {}, signal())).content) as Record<string, string>;
    assert.ok(env.PATH);
    await manager.close();
    assert.equal(manager.states()[0]!.toolCount > 0, true);
  });

  it('turns many tools into on-demand ones, and few stay loaded', async () => {
    const few = await connected({ FIXTURE_ONLY_ECHO: '1' });
    assert.ok(few.tools().filter((t) => t.name.startsWith('mcp__')).every((tool) => !tool.deferred));
    const many = managerFor([named('m', stdio({ FIXTURE_TOOL_COUNT: String(DEFER_TOOLS_AT) }))]);
    await many.connectAll();
    const mcpTools = many.tools().filter((t) => t.name.startsWith('mcp__'));
    assert.ok(mcpTools.length > DEFER_TOOLS_AT);
    assert.ok(mcpTools.every((tool) => tool.deferred === true));
  });
});

describe('deferred tools in the API request', () => {
  const base = { model: 'claude-opus-5-5', system: [], messages: [], maxTokens: 1000 };
  const schema = { type: 'object' };

  it('marks deferred tools and adds the search tool, leaving built-ins loaded', () => {
    const params = buildParams({ ...base, tools: [{ name: 'Read', description: 'd', inputSchema: schema }, { name: 'mcp__a__b', description: 'd', inputSchema: schema, deferred: true }] }, true) as unknown as { tools: Record<string, unknown>[] };
    assert.equal(params.tools[0]!.defer_loading, undefined);
    assert.equal(params.tools[1]!.defer_loading, true);
    assert.deepEqual(params.tools[2], { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });
  });

  it('sends everything loaded through a custom endpoint, which may not support search', () => {
    const params = buildParams({ ...base, tools: [{ name: 'mcp__a__b', description: 'd', inputSchema: schema, deferred: true }] }, false) as unknown as { tools: Record<string, unknown>[] };
    assert.equal(params.tools.length, 1);
    assert.equal(params.tools[0]!.defer_loading, undefined);
  });

  it('adds no search tool when nothing is deferred', () => {
    const params = buildParams({ ...base, tools: [{ name: 'Read', description: 'd', inputSchema: schema }] }, true) as unknown as { tools: Record<string, unknown>[] };
    assert.equal(params.tools.length, 1);
  });
});

describe('permissions for MCP tools', () => {
  const cwd = '/tmp/cairn-mcp-perms';
  function engine(mode: PermissionMode = 'default', rules: Partial<Record<RuleBehavior, string[]>> = {}): PermissionEngine {
    const parsed = (['allow', 'ask', 'deny'] as const).flatMap((behavior) => (rules[behavior] ?? []).map((text) => parseRule(text, behavior, 'user', cwd)!));
    return new PermissionEngine({ mode, rules: parsed, workingDirs: [cwd], cwd: () => cwd });
  }
  const check = (e: PermissionEngine, name = 'mcp__github__create_issue', readOnlyHint = false, hook?: 'allow' | 'ask') =>
    e.check(name, { kind: 'mcp', readOnlyHint }, hook);

  it('asks by default, and offers to remember that exact tool', () => {
    const decision = check(engine());
    assert.equal(decision.behavior, 'ask');
    assert.deepEqual(decision.suggestions, [{ rule: 'mcp__github__create_issue', persist: true }]);
  });

  it('a server\'s claim to be read-only never skips the prompt', () => {
    assert.equal(check(engine(), 'mcp__github__get', true).behavior, 'ask');
  });

  it('allow rules match one tool, a whole server, or a server wildcard', () => {
    for (const rule of ['mcp__github__create_issue', 'mcp__github', 'mcp__github__*', 'mcp__github__create_*']) {
      assert.equal(check(engine('default', { allow: [rule] })).behavior, 'allow', rule);
    }
    for (const rule of ['mcp__gitlab', 'mcp__github__other', 'mcp__git']) {
      assert.equal(check(engine('default', { allow: [rule] })).behavior, 'ask', rule);
    }
  });

  it('an allow rule cannot wildcard across servers', () => {
    assert.equal(parseRule('mcp__*', 'allow', 'user', cwd), null);
    assert.equal(parseRule('mcp__g*__x', 'allow', 'user', cwd), null);
    assert.equal(parseRule('*', 'allow', 'user', cwd), null);
    assert.notEqual(parseRule('mcp__*', 'deny', 'user', cwd), null);
    assert.notEqual(parseRule('mcp__github__*', 'allow', 'user', cwd), null);
  });

  it('rejects a parameter rule on an MCP tool', () => {
    assert.equal(parseRule('mcp__a__b(x)', 'deny', 'user', cwd), null);
  });

  it('a server rule does not reach a tool whose name merely starts the same', () => {
    assert.equal(check(engine('default', { allow: ['mcp__github__create'] }), 'mcp__github__create__issue').behavior, 'ask');
  });

  it('deny and ask rules beat allow, and a bare deny hides the tool', () => {
    const denied = engine('default', { deny: ['mcp__github'], allow: ['mcp__github__create_issue'] });
    assert.equal(check(denied).behavior, 'deny');
    assert.ok(denied.isToolRemoved('mcp__github__create_issue'));
    assert.ok(engine('default', { deny: ['mcp__*'] }).isToolRemoved('mcp__x__y'));
    const asked = check(engine('default', { ask: ['mcp__github__*'], allow: ['mcp__github'] }));
    assert.equal(asked.behavior, 'ask');
    assert.equal(asked.forced, true);
  });

  it('plan mode refuses tools that may change things, and still asks for read-only ones', () => {
    assert.equal(check(engine('plan')).behavior, 'deny');
    assert.equal(check(engine('plan', { allow: ['mcp__github'] })).behavior, 'deny');
    assert.equal(check(engine('plan'), 'mcp__github__get', true).behavior, 'ask');
    assert.equal(check(engine('plan'), 'mcp__github__create', false, 'allow').behavior, 'deny');
  });

  it('other modes behave as they do for any tool', () => {
    assert.equal(check(engine('bypassPermissions')).behavior, 'allow');
    assert.equal(check(engine('dontAsk')).behavior, 'deny');
    assert.equal(check(engine('dontAsk', { allow: ['mcp__github'] })).behavior, 'allow');
    assert.equal(check(engine('acceptEdits')).behavior, 'ask');
    assert.equal(check(engine(), undefined, false, 'allow').behavior, 'allow');
    assert.equal(check(engine('default', { allow: ['mcp__github'] }), undefined, false, 'ask').behavior, 'ask');
  });
});

describe('MCP through the agent', () => {
  async function harness(turns: ScriptedTurn[], options: Partial<RuntimeOptions> & { answer?: PermissionAnswer; serverEnv?: Record<string, string>; serverName?: string } = {}) {
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
    const { answer: _a, serverEnv: _e, serverName, ...rest } = options;
    const mcpConfig = [JSON.stringify({ mcpServers: { [serverName ?? 't']: stdio(options.serverEnv) } })];
    const runtime = await createRuntime({ cwd: project(), prompter, provider, mcpConfig, strictMcpConfig: true, ...rest });
    runtimes.push(runtime);
    return { runtime, provider, prompts };
  }
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  });

  async function collect(runtime: Runtime, prompt: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of runtime.agent.run(prompt, signal())) events.push(event);
    return events;
  }
  const lastResult = (h: { provider: ScriptedProvider }, index: number): ToolResultBlock => h.provider.requests[index]!.messages.at(-1)!.content[0] as ToolResultBlock;

  it('offers the tools, tells the model about the server, and runs a call after approval', async () => {
    const h = await harness([{ toolCalls: [{ name: 'mcp__t__echo', input: { text: 'hello' } }] }, { text: 'done' }]);
    await collect(h.runtime, 'go');
    const request = h.provider.requests[0]!;
    assert.ok(request.tools.some((tool) => tool.name === 'mcp__t__echo'));
    const system = JSON.stringify(request.system);
    assert.match(system, /### t/);
    assert.match(system, /Use echo for testing\./);
    assert.match(system, /not instructions from the user/);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.prompts[0]!.toolName, 'mcp__t__echo');
    assert.equal(lastResult(h, 1).content, 'echo: hello');
  });

  it('does not call the tool when declined', async () => {
    const h = await harness([{ toolCalls: [{ name: 'mcp__t__echo', input: { text: 'x' } }] }, { text: 'ok' }], { answer: { behavior: 'deny' } });
    await collect(h.runtime, 'go');
    assert.match(lastResult(h, 1).content, /declined/);
    assert.equal(lastResult(h, 1).is_error, true);
  });

  it('skips the prompt with an allow rule, and "always" saves that rule', async () => {
    const allowed = await harness([{ toolCalls: [{ name: 'mcp__t__echo', input: { text: 'x' } }] }, { text: 'ok' }], { allowedTools: ['mcp__t'] });
    await collect(allowed.runtime, 'go');
    assert.equal(allowed.prompts.length, 0);

    const always = await harness(
      [{ toolCalls: [{ name: 'mcp__t__echo', input: { text: 'x' } }] }, { toolCalls: [{ name: 'mcp__t__echo', input: { text: 'y' } }] }, { text: 'ok' }],
      { answer: { behavior: 'allow', always: true } },
    );
    await collect(always.runtime, 'go');
    assert.equal(always.prompts.length, 1);
    const saved = JSON.parse(readFileSync(join(always.runtime.projectDir, '.cairn/settings.local.json'), 'utf8')) as { permissions: { allow: string[] } };
    assert.deepEqual(saved.permissions.allow, ['mcp__t__echo']);
  });

  it('a bare deny rule takes the tools away from the model', async () => {
    const h = await harness([{ text: 'ok' }], { disallowedTools: ['mcp__t'] });
    await collect(h.runtime, 'go');
    assert.ok(!h.provider.requests[0]!.tools.some((tool) => tool.name.startsWith('mcp__t__')));
  });

  it('marks tool definitions deferred once there are many', async () => {
    const h = await harness([{ text: 'ok' }], { serverEnv: { FIXTURE_TOOL_COUNT: '5' } });
    await collect(h.runtime, 'go');
    const tools = h.provider.requests[0]!.tools;
    assert.ok(tools.filter((tool) => tool.name.startsWith('mcp__')).every((tool) => tool.deferred === true));
    assert.ok(tools.some((tool) => tool.name === 'Read' && !tool.deferred));
  });

  it('keeps the tool list identical between requests, for the prompt cache', async () => {
    const h = await harness([{ toolCalls: [{ name: 'mcp__t__change_tools', input: {} }] }, { text: 'ok' }], { allowedTools: ['mcp__t'], serverEnv: {} });
    await collect(h.runtime, 'go');
    assert.equal(JSON.stringify(h.provider.requests[0]!.tools), JSON.stringify(h.provider.requests[1]!.tools));
  });

  it('subagents can use MCP tools, under the same permissions', async () => {
    const h = await harness(
      [{ toolCalls: [{ name: 'Agent', input: { description: 'x', prompt: 'p' } }] }, { toolCalls: [{ name: 'mcp__t__echo', input: { text: 'sub' } }] }, { text: 'report' }, { text: 'done' }],
      { answer: { behavior: 'deny' } },
    );
    await collect(h.runtime, 'go');
    assert.ok(h.provider.requests[1]!.tools.some((tool) => tool.name === 'mcp__t__echo'));
    assert.equal(h.prompts.length, 1);
    const explore = await harness([{ toolCalls: [{ name: 'Agent', input: { description: 'x', prompt: 'p', subagent_type: 'explore' } }] }, { text: 'report' }, { text: 'done' }]);
    await collect(explore.runtime, 'go');
    assert.ok(!explore.provider.requests[1]!.tools.some((tool) => tool.name.startsWith('mcp__')));
  });

  it('--tools limits built-ins but leaves MCP tools', async () => {
    const h = await harness([{ text: 'ok' }], { tools: ['Read'] });
    await collect(h.runtime, 'go');
    const names = h.provider.requests[0]!.tools.map((tool) => tool.name);
    assert.ok(names.includes('Read'));
    assert.ok(!names.includes('Bash'));
    assert.ok(names.includes('mcp__t__echo'));
  });

  it('warns about a failed server and carries on', async () => {
    const h = await harness([{ text: 'still works' }], { serverEnv: { FIXTURE_EXIT: '1', FIXTURE_STDERR: 'no token' } });
    assert.ok(h.runtime.warnings.some((warning) => warning.includes('no token')));
    const events = await collect(h.runtime, 'go');
    assert.equal((events.at(-1) as { text: string }).text, 'still works');
  });

  it('/mcp shows status, reconnects, and rejects bad actions', async () => {
    const h = await harness([]);
    const run = async (line: string) => settleCommand(await runSlashCommand(line, h.runtime, { choose: async () => null }), signal());
    assert.match((await run('/mcp')).output!, /t\s+stdio\s+flag\s+connected, \d+ tools, 1 prompts, resources/);
    assert.match((await run('/mcp reconnect t')).output!, /connected/);
    assert.match((await run('/mcp reconnect all')).output!, /connected/);
    assert.match((await run('/mcp reconnect')).output!, /Usage/);
    assert.match((await run('/mcp nonsense')).output!, /Unknown \/mcp action/);
    assert.match((await run('/mcp logout t')).output!, /No stored sign-in/);
    await assert.rejects(run('/mcp login t'), /local server/);
  });

  it('runs an MCP prompt as a slash command', async () => {
    const h = await harness([]);
    const run = async (line: string) => settleCommand(await runSlashCommand(line, h.runtime, { choose: async () => null }), signal());
    assert.ok(commandNames(h.runtime).includes('/mcp__t__greet'));
    assert.equal((await run('/mcp__t__greet "Ann B" warm')).prompt, 'Greet Ann B in a warm tone.');
    assert.match((await run('/mcp__t__greet')).output!, /Missing required argument/);
    assert.match((await run('/help')).output!, /mcp__t__greet\s+Greets someone/);
  });
});

/** A real MCP server over HTTP, optionally behind a small OAuth server on the same origin. */
class HttpFixture {
  server!: HttpServer;
  url = '';
  readonly seenHeaders: IncomingMessage['headers'][] = [];
  readonly registered: Record<string, unknown>[] = [];
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  private readonly sseSessions = new Map<string, SSEServerTransport>();
  private challenge = '';
  validTokens = new Set(['token-1', 'token-2']);
  private readonly options: { oauth?: boolean; bearer?: string; sseOnly?: boolean };

  constructor(options: { oauth?: boolean; bearer?: string; sseOnly?: boolean } = {}) {
    this.options = options;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await once(this.server.listen(0, '127.0.0.1'), 'listening');
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<string> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return raw;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.url);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource') && this.options.oauth) {
      return this.json(res, 200, { resource: `${this.url}/mcp`, authorization_servers: [this.url] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') && this.options.oauth) {
      return this.json(res, 200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        registration_endpoint: `${this.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname.startsWith('/.well-known/')) return this.json(res, 404, {});
    if (url.pathname === '/register') {
      const metadata = JSON.parse(await this.body(req)) as Record<string, unknown>;
      this.registered.push(metadata);
      return this.json(res, 201, { ...metadata, client_id: `client-${this.registered.length}` });
    }
    if (url.pathname === '/authorize') {
      this.authorizeRequests.push(url.searchParams);
      this.challenge = url.searchParams.get('code_challenge') ?? '';
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', 'auth-code');
      redirect.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: redirect.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await this.body(req));
      this.tokenRequests.push(form);
      if (form.get('grant_type') === 'refresh_token') {
        return this.json(res, 200, { access_token: 'token-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-2' });
      }
      const computed = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (form.get('code') !== 'auth-code' || computed !== this.challenge) return this.json(res, 400, { error: 'invalid_grant' });
      return this.json(res, 200, { access_token: 'token-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
    }

    this.seenHeaders.push(req.headers);
    if (this.options.oauth) {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !this.validTokens.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource/mcp"` });
        res.end();
        return;
      }
    }
    if (this.options.bearer && req.headers.authorization !== `Bearer ${this.options.bearer}`) {
      res.writeHead(401);
      res.end();
      return;
    }

    if (this.options.sseOnly) {
      if (req.method === 'GET' && url.pathname === '/mcp') {
        const transport = new SSEServerTransport('/messages', res);
        this.sseSessions.set(transport.sessionId, transport);
        await buildTestServer().connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        await this.sseSessions.get(url.searchParams.get('sessionId')!)!.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    const raw = req.method === 'POST' ? await this.body(req) : '';
    const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? this.sessions.get(sessionId) : undefined;
    if (sessionId && !transport) return this.json(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'Unknown session' }, id: null });
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this.sessions.set(id, transport!);
        },
      });
      await buildTestServer().connect(transport);
    }
    await transport.handleRequest(req, res, parsed);
  }

  forgetSessions(): void {
    this.sessions.clear();
  }
}

describe('a real server over HTTP', () => {
  const fixtures: HttpFixture[] = [];
  const start = async (options: ConstructorParameters<typeof HttpFixture>[0] = {}): Promise<HttpFixture> => {
    const fixture = await new HttpFixture(options).start();
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((manager) => manager.close()));
    fixtures.splice(0).forEach((fixture) => fixture.stop());
  });

  it('connects and calls tools, sending the configured headers', async () => {
    const fixture = await start();
    const manager = managerFor([named('h', { type: 'http', url: `${fixture.url}/mcp`, headers: { 'x-team': 'blue' } })]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'connected', manager.states()[0]!.error);
    assert.equal((await manager.callTool('h', 'echo', { text: 'web' }, signal())).content, 'echo: web');
    assert.equal(fixture.seenHeaders[0]!['x-team'], 'blue');
  });

  it('falls back to SSE for a server that only speaks the older transport', async () => {
    const fixture = await start({ sseOnly: true });
    const manager = managerFor([named('old', { type: 'http', url: `${fixture.url}/mcp` })]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'connected', manager.states()[0]!.error);
    assert.equal((await manager.callTool('old', 'echo', { text: 'sse' }, signal())).content, 'echo: sse');
  });

  it('can be told to use SSE directly', async () => {
    const fixture = await start({ sseOnly: true });
    const manager = managerFor([named('old', { type: 'sse', url: `${fixture.url}/mcp` })]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'connected', manager.states()[0]!.error);
  });

  it('recovers on the next call after the server forgets the session, never repeating the call', async () => {
    const fixture = await start();
    const manager = managerFor([named('h', { type: 'http', url: `${fixture.url}/mcp` })]);
    await manager.connectAll();
    fixture.forgetSessions();
    const failed = await manager.callTool('h', 'echo', { text: 'lost' }, signal());
    assert.equal(failed.isError, true);
    await new Promise((done) => setTimeout(done, 50));
    assert.equal((await manager.callTool('h', 'echo', { text: 'again' }, signal())).content, 'echo: again');
  });

  it('reports an unreachable server without failing the session', async () => {
    const manager = managerFor([named('down', { type: 'http', url: 'http://127.0.0.1:9/mcp' })]);
    await manager.connectAll();
    assert.equal(manager.states()[0]!.status, 'failed');
  });

  it('asks for sign-in on a 401, and never opens a browser by itself', async () => {
    const fixture = await start({ oauth: true });
    let opened = 0;
    const manager = managerFor([named('o', { type: 'http', url: `${fixture.url}/mcp` })], { openUrl: () => { opened++; } });
    await manager.connectAll();
    const state = manager.states()[0]!;
    assert.equal(state.status, 'needs-auth');
    assert.match(state.error!, /\/mcp login o/);
    assert.equal(opened, 0);
    assert.equal(fixture.registered.length, 0, 'startup must not register a client');
    assert.match((await manager.callTool('o', 'echo', {}, signal())).content, /not connected|sign-in/i);
  });

  it('accepts a static bearer token, and flags a wrong one', async () => {
    const fixture = await start({ bearer: 'right' });
    const good = managerFor([named('b', { type: 'http', url: `${fixture.url}/mcp`, headers: { Authorization: 'Bearer right' } })]);
    await good.connectAll();
    assert.equal(good.states()[0]!.status, 'connected');
    const bad = managerFor([named('b', { type: 'http', url: `${fixture.url}/mcp`, headers: { Authorization: 'Bearer wrong' } })]);
    await bad.connectAll();
    assert.equal(bad.states()[0]!.status, 'needs-auth');
  });

  describe('sign-in', () => {
    function loginManager(fixture: HttpFixture, oauth?: { scopes?: string; clientId?: string }) {
      const server = named('o', { type: 'http', url: `${fixture.url}/mcp`, ...(oauth ? { oauth } : {}) });
      return managerFor([server], {
        // Stands in for the browser: follows the redirects back to the local callback.
        openUrl: async (url) => {
          await fetch(url);
        },
      });
    }

    it('completes the whole flow: registration, PKCE, tokens, and connecting', async () => {
      const fixture = await start({ oauth: true });
      const manager = loginManager(fixture, { scopes: 'read write' });
      await manager.connectAll();
      assert.equal(manager.states()[0]!.status, 'needs-auth');

      const state = await manager.login('o');
      assert.equal(state.status, 'connected', state.error);
      assert.equal((await manager.callTool('o', 'echo', { text: 'signed in' }, signal())).content, 'echo: signed in');

      const authorize = fixture.authorizeRequests[0]!;
      assert.equal(authorize.get('code_challenge_method'), 'S256');
      assert.ok(authorize.get('state'));
      assert.equal(authorize.get('scope'), 'read write');
      assert.match(authorize.get('redirect_uri')!, /^http:\/\/localhost:\d+\/callback$/);
      assert.deepEqual((fixture.registered[0] as { redirect_uris: string[] }).redirect_uris, [authorize.get('redirect_uri')]);
    });

    it('stores tokens privately, per server URL, and uses them on the next start', async () => {
      const fixture = await start({ oauth: true });
      await loginManager(fixture).login('o');
      const path = authFilePath(`${fixture.url}/mcp`);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(hasStoredTokens(`${fixture.url}/mcp`), true);
      assert.equal(hasStoredTokens(`${fixture.url}/other`), false);

      const later = managerFor([named('o', { type: 'http', url: `${fixture.url}/mcp` })]);
      await later.connectAll();
      assert.equal(later.states()[0]!.status, 'connected', later.states()[0]!.error);
    });

    it('refreshes an expired token by itself', async () => {
      const fixture = await start({ oauth: true });
      await loginManager(fixture).login('o');
      fixture.validTokens = new Set(['token-2']);
      const later = managerFor([named('o', { type: 'http', url: `${fixture.url}/mcp` })]);
      await later.connectAll();
      assert.equal(later.states()[0]!.status, 'connected', later.states()[0]!.error);
      assert.equal(fixture.tokenRequests.at(-1)!.get('grant_type'), 'refresh_token');
    });

    it('logout forgets the tokens', async () => {
      const fixture = await start({ oauth: true });
      const manager = loginManager(fixture);
      await manager.login('o');
      assert.equal(manager.logout('o'), true);
      assert.equal(existsSync(authFilePath(`${fixture.url}/mcp`)), false);
      assert.equal(manager.logout('o'), false);
    });

    it('uses a pre-registered client without registering a new one', async () => {
      const fixture = await start({ oauth: true });
      const state = await loginManager(fixture, { clientId: 'my-app' }).login('o');
      assert.equal(state.status, 'connected', state.error);
      assert.equal(fixture.registered.length, 0);
      assert.equal(fixture.authorizeRequests[0]!.get('client_id'), 'my-app');
    });

    it('rejects a callback that does not match the request', async () => {
      const listener = await listenForCallback();
      try {
        const rejected = assert.rejects(listener.code('expected-state'), /did not match/);
        const response = await fetch(`${listener.redirectUri}?code=stolen&state=attacker`);
        assert.equal(response.status, 200);
        await rejected;
      } finally {
        listener.close();
      }
    });

    it('passes on a refusal from the server, without echoing it into the page', async () => {
      const listener = await listenForCallback();
      try {
        const rejected = assert.rejects(listener.code('s'), /refused sign-in: access_denied/);
        const response = await fetch(`${listener.redirectUri}?error=access_denied&error_description=${encodeURIComponent('<script>x</script>')}`);
        assert.equal(response.status, 400);
        assert.doesNotMatch(await response.text(), /<script>/);
        await rejected;
      } finally {
        listener.close();
      }
    });

    it('can be cancelled', async () => {
      const listener = await listenForCallback();
      try {
        const controller = new AbortController();
        const waiting = listener.code('s', controller.signal);
        controller.abort();
        await assert.rejects(waiting, /cancelled/);
      } finally {
        listener.close();
      }
    });

    it('will not open anything but a web address', () => {
      assert.throws(() => openInBrowser(new URL('file:///etc/passwd')), /Refusing/);
      assert.throws(() => openInBrowser(new URL('javascript:alert(1)')), /Refusing/);
    });
  });
});

describe('the cairn mcp command', () => {
  let dir: string;
  let cliHome: string;
  beforeEach(() => {
    dir = project();
    cliHome = realpathSync(mkdtempSync(join(tmpdir(), 'cairn-mcp-cli-')));
  });
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, CAIRN_HOME: cliHome, ...extra }, encoding: 'utf8', input: '', timeout: 30_000 });

  it('adds, shows, lists and removes a stdio server', () => {
    const added = cli(['mcp', 'add', 'fix', '-e', 'TOKEN=very-secret', process.execPath, '--', FIXTURE]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /local scope/);
    assert.equal(existsSync(join(dir, '.mcp.json')), false);

    const shown = cli(['mcp', 'get', 'fix']);
    assert.match(shown.stdout, /Environment: TOKEN \(values hidden\)/);
    assert.doesNotMatch(shown.stdout, /very-secret/);
    assert.match(shown.stdout, /mcp__fix__<tool>/);

    const listed = cli(['mcp', 'list']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /fix: .* \(stdio, local\) - connected \(\d+ tools\)/);

    assert.match(cli(['mcp', 'remove', 'fix']).stdout, /Removed fix/);
    assert.match(cli(['mcp', 'list']).stdout, /No MCP servers configured/);
    assert.equal(cli(['mcp', 'remove', 'fix']).status, 1);
  });

  it('infers http from a URL, stores headers, and writes project scope to .mcp.json', () => {
    assert.equal(cli(['mcp', 'add', '-s', 'project', '-H', 'Authorization: Bearer ${MY_TOKEN}', 'web', 'https://example.com/mcp']).status, 0);
    const stored = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    assert.deepEqual(stored.mcpServers.web, { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${MY_TOKEN}' } });
    assert.match(cli(['mcp', 'list']).stdout, /1 server\(s\) in \.mcp\.json are pending/);
  });

  it('adds from JSON, and reports bad input clearly', () => {
    assert.equal(cli(['mcp', 'add-json', 'j', '{"command":"x"}']).status, 0);
    assert.match(cli(['mcp', 'get', 'j']).stdout, /Command: x/);
    assert.equal(cli(['mcp', 'add-json', 'j', '{broken']).status, 1);
    assert.match(cli(['mcp', 'add', 'x']).stderr, /Missing a command or URL/);
    assert.match(cli(['mcp', 'add', '-s', 'galaxy', 'x', 'y']).stderr, /Unknown scope/);
    assert.match(cli(['mcp', 'add', '-t', 'carrier-pigeon', 'x', 'y']).stderr, /Unknown transport/);
    assert.match(cli(['mcp', 'add', '-e', 'NOEQUALS', 'x', 'y']).stderr, /KEY=VALUE/);
    assert.match(cli(['mcp', 'frobnicate']).stderr, /Unknown mcp command/);
    assert.equal(cli(['mcp']).status, 2);
    assert.equal(cli(['mcp', '--help']).status, 0);
    assert.equal(cli(['mcp', 'get', 'nobody']).status, 1);
  });

  it('calls a real server tool from a full print-mode run', () => {
    const script = join(cliHome, 'script.json');
    writeFileSync(script, JSON.stringify([{ toolCalls: [{ name: 'mcp__fix__echo', input: { text: 'through the app' } }] }, { text: 'finished' }]));
    const config = JSON.stringify({ mcpServers: { fix: stdio() } });
    const result = cli(['-p', 'go', '--provider', 'scripted', '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__fix', '--output-format', 'stream-json'], { CAIRN_SCRIPT: script });
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; message?: { content: { type: string; content?: string }[] } });
    const toolResult = events.flatMap((event) => (event.type === 'user' ? event.message!.content : [])).find((block) => block.type === 'tool_result');
    assert.equal(toolResult!.content, 'echo: through the app');
  });

  it('does not start an untrusted project\'s server, even in print mode', () => {
    const marker = join(dir, 'server-started');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: '/bin/sh', args: ['-c', `touch ${marker}`] } } }));
    const script = join(cliHome, 'script.json');
    writeFileSync(script, JSON.stringify([{ text: 'ok' }, { text: 'ok' }]));
    const untrusted = cli(['-p', 'go', '--provider', 'scripted'], { CAIRN_SCRIPT: script });
    assert.equal(untrusted.status, 0, untrusted.stderr);
    assert.equal(existsSync(marker), false);
    assert.match(untrusted.stderr, /stay inactive/);

    cli(['-p', 'go', '--provider', 'scripted', '--trust'], { CAIRN_SCRIPT: script, MCP_TIMEOUT: '1000' });
    assert.equal(existsSync(marker), true);
  });
});

afterAll(() => {
  delete process.env.CAIRN_HOME;
});
