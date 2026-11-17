/**
 * Where an installed plugin came from, so `karst plugin update` can fetch it again: a local
 * directory or archive, a git repository pinned to the commit it was installed at, or an archive
 * URL pinned to the SHA-256 of what was downloaded.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { appHome } from '../config/paths.ts';

export type PluginSource =
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; ref?: string; path?: string; commit: string }
  | { type: 'archive'; url: string; path?: string; sha256: string };

/** What was asked for, before anything is fetched. */
export type SourceSpec =
  | { type: 'local'; path: string }
  | { type: 'git'; url: string; ref?: string; path?: string }
  | { type: 'archive'; url: string; path?: string };

const ARCHIVE = /\.(zip|tar\.gz|tgz|tar)$/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const GIT_HOSTS = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[^/]+\/[^/#]+\/?$/i;

export function sourcesPath(): string {
  return join(appHome(), 'plugin-sources.json');
}

export function readSources(): Record<string, PluginSource> {
  try {
    const parsed = JSON.parse(readFileSync(sourcesPath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, PluginSource>) : {};
  } catch {
    return {};
  }
}

export function writeSource(name: string, source: PluginSource | null): void {
  const all = readSources();
  if (source) all[name] = source;
  else delete all[name];
  mkdirSync(appHome(), { recursive: true, mode: 0o700 });
  const temporary = `${sourcesPath()}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, sourcesPath());
}

/**
 * Reads what the user typed: a path, `github:owner/repo`, a git URL (`.git`, `git@`, `ssh://`,
 * `git+https://`, or a repository on a known host), or an archive URL. `#ref` picks a branch, tag
 * or commit. Null when it is none of these.
 */
export function parseSource(given: string, options: { ref?: string; path?: string } = {}): SourceSpec | null {
  const hash = given.indexOf('#');
  const target = hash >= 0 && !given.startsWith('/') && !given.startsWith('.') ? given.slice(0, hash) : given;
  const ref = options.ref ?? (hash >= 0 && target !== given ? given.slice(hash + 1) || undefined : undefined);
  const extra = { ...(options.path ? { path: options.path } : {}) };
  if (/^github:[\w.-]+\/[\w.-]+$/.test(target)) return { type: 'git', url: `https://github.com/${target.slice(7)}.git`, ...(ref ? { ref } : {}), ...extra };
  if (/^(git@|ssh:\/\/|git:\/\/)/.test(target) || target.startsWith('git+https://') || /^(https?|file):\/\/\S+\.git\/?$/.test(target) || GIT_HOSTS.test(target)) {
    return { type: 'git', url: target.replace(/^git\+/, ''), ...(ref ? { ref } : {}), ...extra };
  }
  if (/^https?:\/\//.test(target)) return ARCHIVE.test(new URL(target).pathname) ? { type: 'archive', url: target, ...extra } : null;
  return { type: 'local', path: resolve(target) };
}

export function describeSource(source: PluginSource | SourceSpec): string {
  switch (source.type) {
    case 'local':
      return source.path;
    case 'git': {
      const at = 'commit' in source ? ` at commit ${source.commit.slice(0, 12)}` : '';
      return `${source.url}${source.ref ? ` (${source.ref})` : ''}${source.path ? `, ${source.path}` : ''}${at}`;
    }
    case 'archive':
      return `${source.url}${source.path ? `, ${source.path}` : ''}${'sha256' in source ? ` (sha256 ${source.sha256.slice(0, 12)})` : ''}`;
  }
}

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // Without a terminal, a private repository fails at once rather than waiting for a password.
    env: { ...process.env, ...(process.stdin.isTTY ? {} : { GIT_TERMINAL_PROMPT: '0' }) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`git could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export interface Fetched {
  /** The directory holding the plugin, inside `cleanup`'s directory. */
  root: string;
  source: PluginSource;
  cleanup(): void;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'karst-plugin-'));
}

/** An archive often holds one folder with everything in it, as GitHub's do. */
function unwrap(dir: string): string {
  const entries = readdirSync(dir).filter((name) => name !== '__MACOSX');
  if (entries.length === 1 && statSync(join(dir, entries[0]!)).isDirectory()) return join(dir, entries[0]!);
  return dir;
}

function within(root: string, path: string | undefined): string {
  if (!path) return root;
  const inside = resolve(root, path);
  if (inside !== root && !inside.startsWith(`${root}/`)) throw new Error(`--path ${path} leaves the plugin's source.`);
  if (!existsSync(inside)) throw new Error(`--path ${path} is not in the source.`);
  return inside;
}

function extract(archive: string, name: string, into: string): void {
  // Both tools refuse members with absolute paths or `..` by default.
  const result = /\.zip$/i.test(name)
    ? spawnSync('unzip', ['-q', archive, '-d', into], { encoding: 'utf8' })
    : spawnSync('tar', [/\.tar$/i.test(name) ? '-xf' : '-xzf', archive, '-C', into], { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not extract ${name}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Could not extract ${name}: ${(result.stderr || '').trim()}`);
}

/** Brings the plugin's files into a temporary directory, and says exactly what was fetched. */
export async function fetchSource(spec: SourceSpec): Promise<Fetched> {
  const dir = tempDir();
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    if (spec.type === 'local') {
      if (statSync(spec.path).isDirectory()) return { root: spec.path, source: { type: 'local', path: spec.path }, cleanup };
      if (!ARCHIVE.test(spec.path)) throw new Error(`${spec.path} is neither a directory nor an archive (.zip, .tar.gz, .tgz, .tar).`);
      const into = join(dir, 'extracted');
      mkdirSync(into);
      extract(spec.path, basename(spec.path), into);
      return { root: unwrap(into), source: { type: 'local', path: spec.path }, cleanup };
    }
    if (spec.type === 'git') {
      const checkout = join(dir, 'repo');
      // Submodules are not fetched: they would be code from yet another place.
      if (spec.ref && FULL_SHA.test(spec.ref)) {
        git(['clone', '--quiet', '--no-checkout', '--', spec.url, checkout]);
        git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', spec.ref], checkout);
      } else {
        git(['clone', '--quiet', '--depth', '1', ...(spec.ref ? ['--branch', spec.ref] : []), '--', spec.url, checkout]);
      }
      const commit = git(['rev-parse', 'HEAD'], checkout);
      rmSync(join(checkout, '.git'), { recursive: true, force: true });
      return {
        root: within(checkout, spec.path),
        source: { type: 'git', url: spec.url, commit, ...(spec.ref ? { ref: spec.ref } : {}), ...(spec.path ? { path: spec.path } : {}) },
        cleanup,
      };
    }
    const response = await fetch(spec.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Downloading ${spec.url} failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_ARCHIVE_BYTES) throw new Error(`${spec.url} is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`${spec.url} is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB.`);
    const name = basename(new URL(spec.url).pathname);
    const archive = join(dir, name);
    writeFileSync(archive, bytes);
    const into = join(dir, 'extracted');
    mkdirSync(into);
    extract(archive, name, into);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { root: within(unwrap(into), spec.path), source: { type: 'archive', url: spec.url, sha256, ...(spec.path ? { path: spec.path } : {}) }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The spec that fetches the newest version of what a recorded source follows. */
export function specToUpdate(source: PluginSource): SourceSpec {
  switch (source.type) {
    case 'local':
      return { type: 'local', path: source.path };
    case 'git':
      return { type: 'git', url: source.url, ...(source.ref ? { ref: source.ref } : {}), ...(source.path ? { path: source.path } : {}) };
    case 'archive':
      return { type: 'archive', url: source.url, ...(source.path ? { path: source.path } : {}) };
  }
}

/** True when a fresh fetch brought exactly what is installed. */
export function sameVersion(a: PluginSource, b: PluginSource): boolean {
  if (a.type === 'git' && b.type === 'git') return a.commit === b.commit;
  if (a.type === 'archive' && b.type === 'archive') return a.sha256 === b.sha256;
  return false;
}

/** A source pinned to a full commit id has nothing newer to move to. */
export function isPinnedCommit(source: PluginSource): boolean {
  return source.type === 'git' && source.ref !== undefined && FULL_SHA.test(source.ref);
}
