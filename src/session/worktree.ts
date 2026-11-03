/** `--worktree`, EnterWorktree: run in a git worktree so parallel work cannot collide. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_DIR } from '../config/paths.ts';

export interface Worktree {
  path: string;
  branch: string;
  repoRoot: string;
  /** Where HEAD was when it was made, to tell later whether anything happened here. */
  startCommit: string;
  /** What the branch was based on, for the model's report. */
  base?: string;
  created: boolean;
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, out: result.stdout?.trim() ?? '', err: result.stderr?.trim() ?? '' };
}

function defaultBranch(root: string): string | null {
  const head = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.ok) return head.out.replace(/^origin\//, '');
  for (const candidate of ['main', 'master']) {
    if (git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`).ok) return candidate;
  }
  return null;
}

/** Keeps the main checkout from listing the worktrees directory as untracked files. */
function excludeWorktreeDir(root: string): void {
  const common = git(root, 'rev-parse', '--git-common-dir');
  if (!common.ok) return;
  const infoDir = join(resolve(root, common.out), 'info');
  const exclude = join(infoDir, 'exclude');
  const line = `${PROJECT_DIR}/worktrees/`;
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (current.split('\n').includes(line)) return;
  mkdirSync(infoDir, { recursive: true });
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/**
 * `baseRef` is `fresh` to branch from origin's default branch (or it, fetched), or `head` to
 * branch from the current local HEAD.
 */
export function createWorktree(cwd: string, requestedName: string, baseRef: 'fresh' | 'head' = 'fresh'): Worktree {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  if (!root.ok) throw new Error('A worktree needs a git repository.');
  const name = requestedName || `session-${randomBytes(3).toString('hex')}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.length > 64) {
    throw new Error(`Invalid worktree name: ${name}. Use letters, digits, dots, dashes, underscores and slashes, up to 64 characters.`);
  }
  const path = join(root.out, PROJECT_DIR, 'worktrees', name);
  const branch = `worktree-${name.replace(/\//g, '-')}`;
  const head = git(root.out, 'rev-parse', 'HEAD');
  if (!head.ok) throw new Error('A worktree needs at least one commit to start from.');
  if (existsSync(path)) {
    return { path: realpathSync(path), branch, repoRoot: root.out, startCommit: git(path, 'rev-parse', 'HEAD').out, created: false };
  }

  let base = 'HEAD';
  if (baseRef === 'fresh') {
    const main = defaultBranch(root.out);
    if (main) {
      const remote = `origin/${main}`;
      base = git(root.out, 'rev-parse', '--verify', '--quiet', remote).ok ? remote : main;
    }
  }
  mkdirSync(join(root.out, PROJECT_DIR, 'worktrees'), { recursive: true });
  const added = git(root.out, 'worktree', 'add', '-b', branch, path, base);
  if (!added.ok) throw new Error(`Could not create the worktree: ${added.err}`);
  excludeWorktreeDir(root.out);
  return { path: realpathSync(path), branch, repoRoot: root.out, startCommit: git(path, 'rev-parse', 'HEAD').out, base, created: true };
}

/** Whether `path` is a worktree of the repository that contains `cwd`. */
export function isListedWorktree(cwd: string, path: string): boolean {
  const listed = git(cwd, 'worktree', 'list', '--porcelain');
  if (!listed.ok) return false;
  const target = realpathSync(path);
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      const entry = line.slice('worktree '.length);
      if (existsSync(entry) && realpathSync(entry) === target) return true;
    }
  }
  return false;
}

/** A description of uncommitted or unmerged work in a worktree, or null when it is clean. */
export function worktreeChanges(worktree: Worktree): string | null {
  const dirty = git(worktree.path, 'status', '--porcelain');
  const commit = git(worktree.path, 'rev-parse', 'HEAD');
  const parts: string[] = [];
  if (dirty.ok && dirty.out) parts.push(`uncommitted changes:\n${dirty.out}`);
  if (commit.ok && commit.out !== worktree.startCommit) parts.push(`commits not on the original branch (HEAD is now ${commit.out.slice(0, 8)})`);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Removes a worktree and its branch. Refuses nothing: the caller decides about unsaved work. */
export function removeWorktree(worktree: Worktree): string {
  const removed = git(worktree.repoRoot, 'worktree', 'remove', '--force', worktree.path);
  if (!removed.ok) return `Could not remove the worktree at ${worktree.path}: ${removed.err}`;
  git(worktree.repoRoot, 'branch', '-D', worktree.branch);
  return `Removed the worktree at ${worktree.path}.`;
}

/** Removes a worktree nothing happened in. Any change or commit keeps it, so no work is lost. */
export function finishWorktree(worktree: Worktree): string {
  if (worktreeChanges(worktree) !== null) {
    return `Kept the worktree at ${worktree.path} (branch ${worktree.branch}), which has changes.`;
  }
  return removeWorktree(worktree);
}
