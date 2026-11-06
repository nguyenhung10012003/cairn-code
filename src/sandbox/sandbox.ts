/**
 * An OS-enforced boundary around the shell commands the model runs: Seatbelt on macOS, bubblewrap
 * on Linux. Writes stay in the working directories and the temp directory, and the network is
 * reachable only through a proxy that checks hostnames. File tools, hooks and MCP servers run
 * outside it, under the permission rules.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { appHome, INSTRUCTION_FILE, PROJECT_DIR } from '../config/paths.ts';
import { analyzeShell } from '../permissions/shell.ts';
import { matchBashPattern } from '../permissions/rules.ts';
import { startProxy } from './proxy.ts';
import type { RunningProxy } from './proxy.ts';

export interface SandboxSettings {
  enabled?: boolean;
  /** Refuse to start when the sandbox cannot run, rather than running without it. */
  failIfUnavailable?: boolean;
  /** False: `dangerouslyDisableSandbox` is ignored, and every command stays inside. */
  allowUnsandboxedCommands?: boolean;
  /** Run sandboxed commands without a prompt, since the OS is enforcing the limits. */
  autoAllowBashIfSandboxed?: boolean;
  /** Patterns, as in Bash rules, for commands that run outside under normal permissions. */
  excludedCommands?: string[];
  filesystem?: {
    allowWrite?: string[];
    denyWrite?: string[];
    denyRead?: string[];
    allowRead?: string[];
  };
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    /** Let commands listen on and connect to local ports. */
    allowLocalBinding?: boolean;
  };
}

export type CommandWrapper = (
  file: string,
  args: string[],
  options: { command: string; unsandboxed: boolean },
) => { file: string; args: string[]; env?: Record<string, string> };

export interface Sandbox {
  wrap: CommandWrapper;
  /** Should this command skip the prompt for running inside? False when it would run outside. */
  autoAllows(command: string, unsandboxed: boolean): boolean;
  describe(): string[];
  close(): Promise<void>;
}

export interface CreatedSandbox {
  sandbox: Sandbox | null;
  warnings: string[];
}

/** Lists from every layer add up, so no layer can remove a deny another one set. */
export function mergeSandboxSettings(base: SandboxSettings, next: SandboxSettings): SandboxSettings {
  const list = (a?: string[], b?: string[]): string[] | undefined => (a || b ? [...(a ?? []), ...(b ?? [])] : undefined);
  const merged: SandboxSettings = { ...base, ...next };
  const excluded = list(base.excludedCommands, next.excludedCommands);
  if (excluded) merged.excludedCommands = excluded;
  const filesystem = { ...base.filesystem, ...next.filesystem };
  for (const key of ['allowWrite', 'denyWrite', 'denyRead', 'allowRead'] as const) {
    const items = list(base.filesystem?.[key], next.filesystem?.[key]);
    if (items) filesystem[key] = items;
  }
  if (base.filesystem || next.filesystem) merged.filesystem = filesystem;
  const network = { ...base.network, ...next.network };
  for (const key of ['allowedDomains', 'deniedDomains'] as const) {
    const items = list(base.network?.[key], next.network?.[key]);
    if (items) network[key] = items;
  }
  if (base.network || next.network) merged.network = network;
  return merged;
}

/** Seatbelt sees real paths. A path that does not exist yet can still sit under a symlink. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

function expandPath(path: string, cwd: string): string {
  const expanded = path === '~' || path === '~/' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : resolve(cwd, path);
  if (!hasGlob(expanded)) return real(expanded);
  const firstGlob = expanded.search(/[*?[]/);
  const fixed = expanded.slice(0, expanded.lastIndexOf('/', firstGlob));
  return real(fixed || '/') + expanded.slice(fixed.length);
}

function hasGlob(path: string): boolean {
  return /[*?[]/.test(path);
}

function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function globToSeatbeltRegex(path: string): string {
  let out = '^';
  for (let i = 0; i < path.length; i++) {
    const char = path[i]!;
    if (char === '*' && path[i + 1] === '*') {
      out += '.*';
      i += path[i + 2] === '/' ? 2 : 1;
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += regexEscape(char);
    }
  }
  return `${out}$`;
}

function sbString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sbPath(path: string): string {
  return hasGlob(path) ? `(regex ${sbString(globToSeatbeltRegex(path))})` : `(subpath ${sbString(path)})`;
}

/** Writing to these changes what later commands or sessions run, so a sandboxed command may not. */
const PROTECTED_RELATIVE_PATHS = [
  `${PROJECT_DIR}/settings.json`,
  `${PROJECT_DIR}/settings.local.json`,
  `${PROJECT_DIR}/hooks`,
  `${PROJECT_DIR}/agents`,
  `${PROJECT_DIR}/skills`,
  `${PROJECT_DIR}/commands`,
  `${PROJECT_DIR}/${INSTRUCTION_FILE}`,
  INSTRUCTION_FILE,
  '.mcp.json',
  '.git/hooks',
  '.git/config',
];

const HOME_RC_FILES = ['.bashrc', '.bash_profile', '.profile', '.zshrc', '.zprofile', '.zshenv', '.gitconfig'];

export interface PolicyInput {
  writable: string[];
  denyWrite: string[];
  denyRead: string[];
  allowRead: string[];
  proxyPort: number | null;
  allowLocalBinding: boolean;
}

/** Seatbelt applies the last matching rule, so the order here is the policy. */
export function seatbeltProfile(policy: PolicyInput): string {
  const lines = ['(version 1)', '(allow default)', '(deny network*)'];
  if (policy.proxyPort !== null) lines.push(`(allow network-outbound (remote ip ${sbString(`localhost:${policy.proxyPort}`)}))`);
  if (policy.allowLocalBinding) {
    lines.push('(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))');
  }
  lines.push('(deny file-write*)');
  lines.push(`(allow file-write* ${policy.writable.map((path) => `(subpath ${sbString(path)})`).join(' ')})`);
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/[0-9]+$"))');
  for (const dir of policy.writable) {
    // Nested too: `packages/a/.git/hooks` matters as much as the one at the root.
    for (const relative of PROTECTED_RELATIVE_PATHS) {
      lines.push(`(deny file-write* (regex ${sbString(`^${regexEscape(dir)}(/.*)?/${regexEscape(relative)}(/.*)?$`)}))`);
    }
  }
  for (const name of HOME_RC_FILES) lines.push(`(deny file-write* (literal ${sbString(join(real(homedir()), name))}))`);
  if (policy.denyWrite.length > 0) lines.push(`(deny file-write* ${policy.denyWrite.map(sbPath).join(' ')})`);
  if (policy.denyRead.length > 0) lines.push(`(deny file-read* ${policy.denyRead.map(sbPath).join(' ')})`);
  // Narrower overrides broader, so a carve-out from a denied directory has to come after it.
  if (policy.allowRead.length > 0) lines.push(`(allow file-read* ${policy.allowRead.map(sbPath).join(' ')})`);
  return lines.join('\n');
}

export function bubblewrapArgs(policy: PolicyInput, file: string, args: string[]): string[] {
  const out = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session'];
  for (const dir of policy.writable) {
    if (existsSync(dir)) out.push('--bind', dir, dir);
  }
  for (const dir of policy.writable) {
    for (const relative of PROTECTED_RELATIVE_PATHS) {
      const path = join(dir, relative);
      if (existsSync(path)) out.push('--ro-bind', path, path);
    }
  }
  for (const path of policy.denyWrite) {
    if (!hasGlob(path) && existsSync(path)) out.push('--ro-bind', path, path);
  }
  for (const path of policy.denyRead) {
    if (hasGlob(path) || !existsSync(path)) continue;
    out.push('--tmpfs', path);
  }
  for (const path of policy.allowRead) {
    if (!hasGlob(path) && existsSync(path)) out.push('--ro-bind', path, path);
  }
  return [...out, '--', file, ...args];
}

function commandExists(name: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

function isExcluded(command: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const analysis = analyzeShell(command);
  // A whole-line pattern like `docker *` must not carry `docker ps; rm -rf ~` out of the sandbox.
  if (!analysis.parseable || analysis.commands.length === 0) return false;
  return analysis.commands.every((cmd) => {
    const text = cmd.words.map((word) => word.value).join(' ');
    return patterns.some((pattern) => matchBashPattern(pattern, text));
  });
}

/** `FOO=bar npm test` changes what a program does, so it still goes through the normal flow. */
function setsEnvironment(command: string): boolean {
  const analysis = analyzeShell(command);
  return !analysis.parseable || analysis.commands.some((cmd) => cmd.assignments.length > 0);
}

export interface SandboxOptions {
  cwd: string;
  workingDirs: () => string[];
  platform?: NodeJS.Platform;
}

export async function createSandbox(settings: SandboxSettings, options: SandboxOptions): Promise<CreatedSandbox> {
  if (settings.enabled !== true) return { sandbox: null, warnings: [] };
  const platform = options.platform ?? process.platform;
  const warnings: string[] = [];
  const tool = platform === 'darwin' ? 'sandbox-exec' : platform === 'linux' ? 'bwrap' : null;
  if (!tool || !commandExists(tool)) {
    const missing = tool ? `${tool} was not found` : `the sandbox is not supported on ${platform}`;
    if (settings.failIfUnavailable) throw new Error(`sandbox.failIfUnavailable is set, but ${missing}.`);
    return { sandbox: null, warnings: [`The sandbox is on in settings, but ${missing}, so commands run without it.`] };
  }

  const allowedDomains = settings.network?.allowedDomains ?? [];
  const deniedDomains = settings.network?.deniedDomains ?? [];
  // bubblewrap gives the command its own network namespace, where the host's proxy is unreachable.
  let proxy: RunningProxy | null = null;
  if (allowedDomains.length > 0) {
    if (platform === 'linux') warnings.push('sandbox.network.allowedDomains is not supported on Linux yet, so sandboxed commands have no network.');
    else proxy = await startProxy({ allowedDomains, deniedDomains });
  }

  const excluded = settings.excludedCommands ?? [];
  const tempDirs = [real(tmpdir()), real('/tmp'), real(process.env.TMPDIR ?? tmpdir())];
  const policy = (): PolicyInput => ({
    writable: [...new Set([...options.workingDirs().map(real), ...tempDirs, ...(settings.filesystem?.allowWrite ?? []).map((path) => expandPath(path, options.cwd))])],
    // Settings there apply without trust, so a command must not write them even from a working directory above them.
    denyWrite: [real(join(appHome(), 'workspaces')), ...(settings.filesystem?.denyWrite ?? []).map((path) => expandPath(path, options.cwd))],
    denyRead: (settings.filesystem?.denyRead ?? []).map((path) => expandPath(path, options.cwd)),
    allowRead: (settings.filesystem?.allowRead ?? []).map((path) => expandPath(path, options.cwd)),
    proxyPort: proxy?.port ?? null,
    allowLocalBinding: settings.network?.allowLocalBinding === true,
  });
  const unsandboxedAllowed = settings.allowUnsandboxedCommands !== false;

  const proxyEnv = (): Record<string, string> => {
    if (!proxy) return {};
    const url = `http://127.0.0.1:${proxy.port}`;
    return { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, http_proxy: url, https_proxy: url, all_proxy: url, NO_PROXY: '', no_proxy: '' };
  };

  const sandbox: Sandbox = {
    wrap(file, args, { command, unsandboxed }) {
      if ((unsandboxed && unsandboxedAllowed) || isExcluded(command, excluded)) return { file, args };
      if (platform === 'darwin') {
        return { file: 'sandbox-exec', args: ['-p', seatbeltProfile(policy()), file, ...args], env: proxyEnv() };
      }
      return { file: 'bwrap', args: bubblewrapArgs(policy(), file, args) };
    },
    autoAllows(command, unsandboxed) {
      if (settings.autoAllowBashIfSandboxed === false) return false;
      if (unsandboxed && unsandboxedAllowed) return false;
      return !isExcluded(command, excluded) && !setsEnvironment(command);
    },
    describe() {
      const current = policy();
      return [
        `Sandbox: on (${tool})`,
        `Prompts: ${settings.autoAllowBashIfSandboxed === false ? 'regular permissions' : 'sandboxed commands run without asking'}`,
        `Commands may leave the sandbox with approval: ${unsandboxedAllowed ? 'yes' : 'no'}`,
        `Writable: ${current.writable.join(', ')}`,
        ...(current.denyRead.length > 0 ? [`Unreadable: ${current.denyRead.join(', ')}`] : []),
        `Network: ${proxy ? `through a proxy, to ${allowedDomains.join(', ')}` : 'none'}`,
        ...(excluded.length > 0 ? [`Excluded commands: ${excluded.join(', ')}`] : []),
      ];
    },
    close: async () => {
      await proxy?.close();
    },
  };
  return { sandbox, warnings };
}
