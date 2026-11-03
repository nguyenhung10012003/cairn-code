import { homedir } from 'node:os';
import { join } from 'node:path';

/** Rename the product by changing these constants. */
export const APP_NAME = 'cairn';
export const APP_DISPLAY_NAME = 'Cairn';
export const PROJECT_DIR = '.cairn';
export const INSTRUCTION_FILE = 'CAIRN.md';
export const LOCAL_INSTRUCTION_FILE = 'CAIRN.local.md';
/** Checked in order when a directory has no INSTRUCTION_FILE, so existing repos work unchanged. */
export const FALLBACK_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
export const VERSION = '0.1.0';

export function appHome(): string {
  return process.env.CAIRN_HOME ?? join(homedir(), PROJECT_DIR);
}

export function userSettingsPath(): string {
  return join(appHome(), 'settings.json');
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_DIR, 'settings.json');
}

export function localSettingsPath(cwd: string): string {
  return join(cwd, PROJECT_DIR, 'settings.local.json');
}

export function trustFilePath(): string {
  return join(appHome(), 'trust.json');
}

export function credentialsPath(): string {
  return join(appHome(), 'credentials.json');
}

export function sessionsDir(cwd: string): string {
  return join(appHome(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function fileHistoryDir(sessionId: string): string {
  return join(appHome(), 'file-history', sessionId);
}

export function backgroundLogDir(sessionId: string): string {
  return join(appHome(), 'background', sessionId);
}
