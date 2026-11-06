/**
 * Creates a project's workspace folder (see `workspaceDir`) and moves into it what earlier
 * versions kept elsewhere: memory under `~/.cairn/memory/<project>/`, and local MCP servers
 * next to the transcripts. A file already in the new place is never replaced.
 */
import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appHome, sessionsDir, workspaceDir, workspaceMcpPath, workspaceMemoryDir } from './paths.ts';

/** The folder name earlier versions used, which two different paths can share. */
function legacyName(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, '-');
}

export function legacyMemoryDir(projectDir: string): string {
  return join(appHome(), 'memory', legacyName(projectDir));
}

export function legacyMcpPath(projectDir: string): string {
  return join(sessionsDir(projectDir), 'mcp.json');
}

/** Renames when it can, and copies otherwise, leaving the original in place. */
function moveOnce(from: string, to: string, warnings: string[]): void {
  if (!existsSync(from) || existsSync(to)) return;
  try {
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    try {
      renameSync(from, to);
    } catch {
      cpSync(from, to, { recursive: true });
    }
  } catch (error) {
    warnings.push(`Could not move ${from} to ${to}: ${(error as Error).message}`);
  }
}

/**
 * Makes sure the folder exists, with a `workspace.json` that says which project it is for, since
 * its name alone does not. Safe to call often. Returns problems worth showing, if any.
 */
export function ensureWorkspaceDir(projectDir: string): string[] {
  const warnings: string[] = [];
  const dir = workspaceDir(projectDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = join(dir, 'workspace.json');
    if (!existsSync(info)) writeFileSync(info, `${JSON.stringify({ path: projectDir }, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    warnings.push(`Could not create ${dir}: ${(error as Error).message}`);
    return warnings;
  }
  moveOnce(legacyMemoryDir(projectDir), workspaceMemoryDir(projectDir), warnings);
  moveOnce(legacyMcpPath(projectDir), workspaceMcpPath(projectDir), warnings);
  return warnings;
}
