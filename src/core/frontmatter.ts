/** YAML frontmatter, shared by skills, custom commands and subagent definitions. */
import { parse } from 'yaml';
import { splitRuleList } from '../permissions/rules.ts';

export interface Frontmatter {
  fields: Record<string, unknown>;
  body: string;
  /** Why the YAML could not be read, so the author can be told. */
  error?: string;
}

/** Bad YAML leaves the file usable with no fields set, rather than failing the whole load. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { fields: {}, body: text };
  const body = match[2]!;
  try {
    const parsed: unknown = parse(match[1] ?? '');
    const isRecord = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    return { fields: isRecord ? (parsed as Record<string, unknown>) : {}, body };
  } catch (error) {
    return { fields: {}, body, error: (error as Error).message.split('\n')[0]! };
  }
}

export function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** YAML 1.2 reads `yes` and `on` as strings, but people use them as booleans. */
export function booleanField(fields: Record<string, unknown>, key: string): boolean | undefined {
  const value = fields[key];
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(lowered)) return true;
  if (['false', 'no', 'off', '0'].includes(lowered)) return false;
  return undefined;
}

/** A YAML list, or one string of comma or space separated items such as `Bash(git *) Read`. */
export function listField(fields: Record<string, unknown>, key: string): string[] {
  const value = fields[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? splitRuleList([value]) : [];
}

/** Glob patterns: a list, or one comma-separated string. A brace group keeps its commas. */
export function pathList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/,(?![^{]*\})/) : [];
  return items.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}
