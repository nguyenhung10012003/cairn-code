/**
 * Workspace trust. A cloned repo can ship settings that run commands (hooks) or pre-approve
 * tools (allow rules), so those parts of project config stay inert until the user says the
 * directory is trusted. Restrictive parts (deny and ask rules) always apply.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { trustFilePath } from './paths.ts';

function readTrusted(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(trustFilePath(), 'utf8'));
    const list = (parsed as { trusted?: unknown }).trusted;
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

export function isTrusted(cwd: string): boolean {
  return readTrusted().some((dir) => cwd === dir || cwd.startsWith(dir + sep));
}

export function markTrusted(cwd: string): void {
  const path = trustFilePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const trusted = new Set(readTrusted());
  trusted.add(cwd);
  writeFileSync(path, JSON.stringify({ trusted: [...trusted] }, null, 2) + '\n', { mode: 0o600 });
}
