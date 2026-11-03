/** Debug logging for --debug and --debug-file. Off unless asked for, and never written to stdout. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface DebugConfig {
  /** Empty: every category. */
  include: Set<string>;
  exclude: Set<string>;
  file?: string;
}

let config: DebugConfig | undefined;

/** `hooks,mcp` shows only those; `!hooks,!mcp` shows everything else. */
export function configureDebug(filter: string | undefined, file?: string): void {
  const parts = (filter ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  config = {
    include: new Set(parts.filter((part) => !part.startsWith('!'))),
    exclude: new Set(parts.filter((part) => part.startsWith('!')).map((part) => part.slice(1))),
    ...(file ? { file } : {}),
  };
  if (file) mkdirSync(dirname(file), { recursive: true });
}

export function debug(category: string, message: string): void {
  if (!config) return;
  if (config.exclude.has(category)) return;
  if (config.include.size > 0 && !config.include.has(category)) return;
  const line = `[${new Date().toISOString()}] [${category}] ${message}\n`;
  if (config.file) appendFileSync(config.file, line, { mode: 0o600 });
  else process.stderr.write(line);
}
