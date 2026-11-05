/**
 * Newer versions. Each interactive session asks npm for the latest version as it starts and says
 * when there is one. `cairn update` installs it, with the package manager Cairn was installed
 * with. With `autoUpdates` in the user settings, the session installs it in the background.
 */
import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_DISPLAY_NAME, APP_NAME, appHome, NPM_PACKAGE, VERSION } from '../config/paths.ts';

const CHECK_TIMEOUT_MS = 3_000;
/** An install that started longer ago than this has died, so its lock no longer counts. */
const LOCK_STALE_MS = 10 * 60_000;

export const UPDATE_HELP = `Usage: ${APP_NAME} update

Installs the latest version of ${APP_DISPLAY_NAME} from npm, with the package manager it was installed with.

Each interactive session also checks for a newer version as it starts. In ~/.cairn/settings.json,
"updateCheck": false turns that off, and "autoUpdates": true installs a newer version in the
background instead of only saying there is one. The check is skipped when CI is set.
`;

interface Version {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
}

/** Positive when `a` is newer than `b`, as semver orders them: a prerelease comes before its release. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The registry npm itself would use when told through the environment, else the public one. */
function registry(): string {
  return (process.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

/** The version npm calls latest. Null when it cannot be told, such as offline. */
export async function latestVersion(timeoutMs = CHECK_TIMEOUT_MS, signal?: AbortSignal): Promise<string | null> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${registry()}/${NPM_PACKAGE}/latest`, {
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' && parseVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

export type Installation =
  /** Installed globally by a package manager, which `install` reinstalls at another version. */
  | { kind: 'global'; manager: string; packageDir: string; install: (version: string) => string[] }
  /** Anything Cairn cannot update by itself, with what to do instead. */
  | { kind: 'other'; advice: string };

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('error', () => resolve({ code: null, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout: stdout.trim() }));
  });
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * How this copy of Cairn was installed, from where its code runs. `entry` is for tests. In the
 * npm package everything is one file, so this module's own path is the package's.
 */
export async function detectInstallation(entry = fileURLToPath(import.meta.url)): Promise<Installation> {
  // Bun's standalone binaries run their code from a virtual file system.
  if (entry.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(entry)) {
    return { kind: 'other', advice: `This is a standalone binary. Build it again from the new source, or install the npm package with npm install -g ${NPM_PACKAGE}.` };
  }
  const real = realPath(entry);
  const marker = `${sep}node_modules${sep}${NPM_PACKAGE}${sep}`;
  const at = real.lastIndexOf(marker);
  if (at < 0) return { kind: 'other', advice: `This copy runs from ${dirname(real)}, not from an installed package. Update it where it came from, such as with git pull.` };
  const packageDir = real.slice(0, at + marker.length - 1);
  const has = (part: string): boolean => real.includes(part.split('/').join(sep));
  const spec = (version: string): string => `${NPM_PACKAGE}@${version}`;
  if (has('/_npx/')) return { kind: 'other', advice: `This copy runs through npx, which fetches what you ask for: npx ${NPM_PACKAGE}@latest.` };
  if (has('/.bun/install/global/')) return { kind: 'global', manager: 'bun', packageDir, install: (v) => ['bun', 'add', '-g', spec(v)] };
  if (has('/pnpm/global/')) return { kind: 'global', manager: 'pnpm', packageDir, install: (v) => ['pnpm', 'add', '-g', spec(v)] };
  if (has('/yarn/global/')) return { kind: 'global', manager: 'yarn', packageDir, install: (v) => ['yarn', 'global', 'add', spec(v)] };
  // npm: only the global folder is npm install -g's to change. Elsewhere it is a project's dependency.
  const root = await run('npm', ['root', '-g']);
  if (root.code === 0 && realPath(root.stdout) === dirname(packageDir)) {
    return { kind: 'global', manager: 'npm', packageDir, install: (v) => ['npm', 'install', '-g', spec(v)] };
  }
  const project = dirname(dirname(packageDir));
  return { kind: 'other', advice: `This copy is a dependency of ${project}. Update it there, with npm install ${NPM_PACKAGE}@latest.` };
}

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function lockPath(): string {
  return join(appHome(), 'update.lock');
}

/** True when this process may install: no other session started an install in the last few minutes. */
function takeLock(): boolean {
  const path = lockPath();
  try {
    const held = JSON.parse(readFileSync(path, 'utf8')) as { startedAt?: number };
    if (typeof held.startedAt === 'number' && Date.now() - held.startedAt < LOCK_STALE_MS) return false;
  } catch {
    // No lock, or a broken one, which counts as none.
  }
  mkdirSync(appHome(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  return true;
}

/**
 * Installs `version` in the background. The installer is detached and writes to a log, so it
 * finishes even when the session ends first. `report` hears how it went while the session lasts.
 */
function installInBackground(installation: Extract<Installation, { kind: 'global' }>, version: string, report: (text: string) => void): void {
  const log = join(appHome(), 'update.log');
  const fd = openSync(log, 'w', 0o600);
  const [command, ...args] = installation.install(version);
  const child = spawn(command!, args, { detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  let finished = false;
  const done = (ok: boolean, detail: string): void => {
    if (finished) return;
    finished = true;
    rmSync(lockPath(), { force: true });
    report(
      ok
        ? `Updated ${APP_DISPLAY_NAME} to ${version}. It runs from the next start.`
        : `Could not update ${APP_DISPLAY_NAME} to ${version} (${detail}). ${log} has the details, and ${APP_NAME} update tries again.`,
    );
  };
  child.on('error', (error) => done(false, error.message));
  child.on('exit', (code, signal) => done(code === 0, signal ? `stopped by ${signal}` : `exit code ${code}`));
}

export interface UpdateCheckOptions {
  updateCheck: boolean;
  autoUpdates: boolean;
  /** A line for the user. */
  report: (text: string) => void;
  /** Aborted when the session ends, so a slow answer does not keep the process alive. */
  signal?: AbortSignal;
}

/**
 * Runs in the background as a session starts, and says nothing unless there is a newer version.
 * Offline, or with npm unreachable, it stays quiet.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<void> {
  if (!options.updateCheck || process.env.CI) return;
  const latest = await latestVersion(CHECK_TIMEOUT_MS, options.signal);
  if (!latest || compareVersions(latest, VERSION) <= 0 || options.signal?.aborted) return;
  const installation = await detectInstallation();
  if (options.signal?.aborted) return;
  const available = `${APP_DISPLAY_NAME} ${latest} is available (you have ${VERSION}).`;
  if (installation.kind === 'other') {
    options.report(`${available} ${installation.advice}`);
    return;
  }
  if (!options.autoUpdates) {
    options.report(`${available} Run ${APP_NAME} update to install it.`);
    return;
  }
  const folder = dirname(installation.packageDir);
  if (!canWrite(folder)) {
    options.report(`${available} autoUpdates is on, but ${folder} is not writable, so run ${APP_NAME} update with the permissions it needs.`);
    return;
  }
  if (!takeLock()) return;
  options.report(`${available} Installing it in the background with ${installation.manager}.`);
  installInBackground(installation, latest, options.report);
}

/** `cairn update`. */
export async function runUpdateCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(UPDATE_HELP);
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown argument: ${argv[0]}\n\n${UPDATE_HELP}`);
    return 2;
  }
  const latest = await latestVersion(15_000);
  if (!latest) {
    process.stderr.write(`Could not ask ${registry()} for the latest version of ${NPM_PACKAGE}. Check the connection and try again.\n`);
    return 1;
  }
  if (compareVersions(latest, VERSION) <= 0) {
    process.stdout.write(`${APP_DISPLAY_NAME} ${VERSION} is the latest version.\n`);
    return 0;
  }
  const installation = await detectInstallation();
  if (installation.kind === 'other') {
    process.stdout.write(`${APP_DISPLAY_NAME} ${latest} is available (you have ${VERSION}). ${installation.advice}\n`);
    return 1;
  }
  const [command, ...args] = installation.install(latest);
  process.stdout.write(`Updating ${APP_DISPLAY_NAME} from ${VERSION} to ${latest}: ${[command, ...args].join(' ')}\n`);
  const code = await new Promise<number>((resolve) => {
    const child = spawn(command!, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`Could not run ${command}: ${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (exit) => resolve(exit ?? 1));
  });
  if (code !== 0) {
    const permissions = canWrite(dirname(installation.packageDir))
      ? ''
      : ` ${dirname(installation.packageDir)} is not writable by you: fix the folder's permissions, or use a Node version manager, rather than running the update with sudo.`;
    process.stderr.write(`The update did not finish.${permissions}\n`);
    return code;
  }
  process.stdout.write(`Updated to ${latest}.\n`);
  return 0;
}
