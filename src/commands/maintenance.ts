/** `cairn doctor` and `cairn purge`: commands that look after the installation, with no session. */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { backgroundLogDir, credentialsPath, fileHistoryDir, sessionsDir, trustFilePath, VERSION } from '../config/paths.ts';
import { DEFAULT_PROVIDER, keySource, PROVIDER_TYPES, providerTypeName } from '../providers/index.ts';
import { loadSettings } from '../config/settings.ts';
import { isTrusted } from '../config/trust.ts';
import { loadMcpConfig } from '../mcp/config.ts';
import { loadPlugins } from '../plugins/plugins.ts';
import { sanitize } from '../ui/render.ts';

function commandVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status === 0) return result.stdout.split('\n')[0]!.trim();
  // pdftoppm prints its version to stderr, and only exits zero on some builds.
  return result.error ? null : result.stderr.split('\n')[0]!.trim() || null;
}

/** Reports what it finds without changing anything. Reads settings but runs nothing from them. */
export function runDoctor(cwd: string): number {
  const lines: string[] = [];
  let problems = 0;
  const check = (label: string, value: string, ok = true): void => {
    lines.push(`${ok ? 'ok ' : '!! '} ${label}: ${value}`);
    if (!ok) problems++;
  };

  check('Version', VERSION);
  check('Runtime', `${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`} on ${process.platform}`);
  const trusted = isTrusted(cwd);
  const settings = loadSettings({ cwd, trusted });

  const providerName = settings.provider ?? DEFAULT_PROVIDER;
  const providerConfig = settings.providers[providerName];
  const type = providerTypeName(providerName, providerConfig);
  check('Provider', type ? `${providerName}${type === providerName ? '' : ` (${type})`}` : `${providerName} is not configured`, type !== undefined);
  if (type) {
    const source = keySource(providerName, providerConfig);
    const value =
      source.kind === 'env' ? `${source.variable} is set`
      : source.kind === 'stored' ? `saved in ${credentialsPath()}`
      : source.kind === 'stored-elsewhere' ? `saved for ${sanitize(source.endpoint)} only, which is not where requests now go`
      : source.optional ? 'none needed' : 'not set';
    check(providerName === 'anthropic' ? 'Anthropic credentials' : `Credentials for ${providerName}`, value, source.kind === 'env' || source.kind === 'stored' || (source.kind === 'none' && source.optional));
    const endpoint = PROVIDER_TYPES[type]!.endpoint(providerConfig ?? {});
    if (providerConfig?.baseUrl || (type === 'anthropic' && process.env.ANTHROPIC_BASE_URL) || (type === 'openai' && process.env.OPENAI_BASE_URL)) {
      lines.push(`    Requests and the key go to ${sanitize(endpoint)}`);
    }
  }

  check('This directory', trusted ? 'trusted' : settings.needsTrust ? 'not trusted, and it has settings that wait for trust' : 'not trusted');
  check('Settings', settings.warnings.length === 0 ? 'no problems' : `${settings.warnings.length} problem(s)`, settings.warnings.length === 0);
  for (const warning of settings.warnings) lines.push(`    ${sanitize(warning)}`);

  const mcp = loadMcpConfig({ projectDir: cwd, trusted });
  check('MCP servers', `${mcp.servers.length} configured${mcp.projectServersPending > 0 ? `, ${mcp.projectServersPending} waiting for trust` : ''}`, mcp.warnings.length === 0);
  for (const warning of mcp.warnings) lines.push(`    ${sanitize(warning)}`);

  const plugins = loadPlugins({ includeInstalled: true, enabled: settings.enabledPlugins });
  check('Plugins', `${plugins.plugins.length} enabled`, plugins.warnings.length === 0);
  for (const warning of plugins.warnings) lines.push(`    ${sanitize(warning)}`);

  const sandboxTool = process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap';
  const hasSandbox = spawnSync('/bin/sh', ['-c', `command -v ${sandboxTool}`], { stdio: 'ignore' }).status === 0;
  check('Sandbox', `${settings.sandbox.enabled ? 'on' : 'off'}, ${sandboxTool} ${hasSandbox ? 'found' : 'not found'}`, hasSandbox || settings.sandbox.enabled !== true);
  const gitVersion = commandVersion('git');
  check('git', gitVersion ?? 'not found', gitVersion !== null);
  check('pdftoppm', commandVersion('pdftoppm') ?? 'not found, so reading PDF page ranges will not work');

  process.stdout.write(`${lines.join('\n')}\n`);
  return problems === 0 ? 0 : 1;
}

function pathsToPurge(project: string): string[] {
  const dir = sessionsDir(project);
  if (!existsSync(dir)) return [];
  const paths = [dir];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.replace(/\.jsonl$/, '');
    for (const path of [fileHistoryDir(id), backgroundLogDir(id)]) {
      if (existsSync(path)) paths.push(path);
    }
  }
  return paths;
}

const PURGE_USAGE = "Usage: cairn purge [path] [--dry-run] [--yes]\nDeletes this machine's transcripts, file history and logs for a project, and its trust entry. The project's own files are not touched.\n";

/** Deletes data that cannot be recovered, so it says exactly what first and needs --yes to act. */
export function runPurge(args: string[], cwd: string): number {
  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(PURGE_USAGE);
    return 0;
  }
  const unknown = args.find((arg) => arg.startsWith('-') && !['--dry-run', '--yes'].includes(arg));
  if (unknown) {
    process.stderr.write(`Unknown option: ${unknown}\n${PURGE_USAGE}`);
    return 2;
  }
  const given = args.find((arg) => !arg.startsWith('-'));
  const project = given ? resolve(cwd, given) : cwd;
  const canonical = existsSync(project) ? realpathSync(project) : project;
  const paths = pathsToPurge(canonical);
  const trusted = readTrustList().includes(canonical);
  if (paths.length === 0 && !trusted) {
    process.stdout.write(`No saved data for ${canonical}.\n`);
    return 0;
  }
  const lines = [...paths.map((path) => `  ${path}`), ...(trusted ? [`  the trust entry for ${canonical}, in ${trustFilePath()}`] : [])];
  process.stdout.write(`${dryRun || !yes ? 'Would delete' : 'Deleting'}:\n${lines.join('\n')}\n`);
  if (dryRun) return 0;
  if (!yes) {
    process.stdout.write('Run again with --yes to delete these.\n');
    return 1;
  }
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  if (trusted) writeFileSync(trustFilePath(), `${JSON.stringify({ trusted: readTrustList().filter((dir) => dir !== canonical) }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write('Done.\n');
  return 0;
}

function readTrustList(): string[] {
  try {
    return (JSON.parse(readFileSync(trustFilePath(), 'utf8')) as { trusted?: string[] }).trusted ?? [];
  } catch {
    return [];
  }
}
