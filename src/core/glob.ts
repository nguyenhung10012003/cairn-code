/**
 * Glob matching that runs the same under Bun and Node, for path-scoped rules and skills and for
 * the Glob tool. Supports `*`, `**`, `?`, `[...]` and `{a,b}` alternatives, and matches dotfiles,
 * as Bun.Glob does. Paths are relative and use `/`.
 */
import { globToRegExp } from '../permissions/rules.ts';

const MAX_ALTERNATIVES = 256;
const cache = new Map<string, RegExp[]>();

/** The index of the brace that closes the one at `open`, or -1. */
function closingBrace(pattern: string, open: number): number {
  let depth = 0;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') i++;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Splits a brace body on its top-level commas. */
function alternativesOf(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '\\') {
      current += c + (body[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

/** `src/*.{ts,tsx}` becomes `src/*.ts` and `src/*.tsx`. A brace with no comma stays literal. */
export function expandBraces(pattern: string): string[] {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      i++;
      continue;
    }
    if (pattern[i] !== '{') continue;
    const close = closingBrace(pattern, i);
    if (close === -1) return [pattern];
    const options = alternativesOf(pattern.slice(i + 1, close));
    if (options.length < 2) continue;
    const before = pattern.slice(0, i);
    const after = pattern.slice(close + 1);
    const expanded: string[] = [];
    for (const option of options) {
      for (const tail of expandBraces(`${option}${after}`)) {
        expanded.push(`${before}${tail}`);
        if (expanded.length > MAX_ALTERNATIVES) throw new Error(`The pattern ${pattern} expands to too many alternatives.`);
      }
    }
    return expanded;
  }
  return [pattern];
}

function compile(pattern: string): RegExp[] {
  let compiled = cache.get(pattern);
  if (!compiled) {
    compiled = expandBraces(pattern).map((alternative) => {
      const literal = alternative.replace(/\\([{},])/g, '$1');
      // For files, `src/**` means what is under src, not src itself, as in Bun.Glob.
      return globToRegExp(literal.endsWith('/**') ? `${literal}/*` : literal);
    });
    cache.set(pattern, compiled);
  }
  return compiled;
}

export function globMatch(pattern: string, path: string): boolean {
  return compile(pattern).some((regex) => regex.test(path));
}
