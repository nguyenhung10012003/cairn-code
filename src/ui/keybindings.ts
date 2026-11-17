/**
 * Keyboard shortcuts for the prompt, from `~/.karst/keybindings.json`, in Claude Code's format:
 *
 *   { "bindings": [ { "context": "Chat", "bindings": { "ctrl+g": "chat:submit", "ctrl+s": null } } ] }
 *
 * The `Global` and `Chat` contexts apply at the prompt; other contexts are skipped with a warning.
 * A key bound to null does nothing, which takes a built-in key away. Keys are single keystrokes
 * such as `ctrl+e`, `meta+p` (or `alt+p`), `shift+tab`, `enter` or `f5`. The file is read again
 * when it changes, at most once a second. Only the user's file is read, since a binding can run
 * a command.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Key } from 'node:readline';
import { appHome } from '../config/paths.ts';

export const KEYBINDING_ACTIONS = [
  'app:interrupt',
  'app:exit',
  'app:redraw',
  'history:previous',
  'history:next',
  'chat:cancel',
  'chat:cycleMode',
  'chat:submit',
  'chat:newline',
  'chat:imagePaste',
  'chat:clearInput',
] as const;

export type KeyAction = (typeof KEYBINDING_ACTIONS)[number] | `command:${string}`;

const CONTEXTS = new Set(['Global', 'Chat']);
const KEY_NAMES: Record<string, string> = { enter: 'return', return: 'return', esc: 'escape', escape: 'escape', space: 'space', del: 'delete', pageup: 'pageup', pagedown: 'pagedown' };
const MODIFIERS: Record<string, 'ctrl' | 'meta' | 'shift'> = { ctrl: 'ctrl', control: 'ctrl', meta: 'meta', alt: 'meta', option: 'meta', shift: 'shift' };
const RELOAD_CHECK_MS = 1_000;

export function keybindingsPath(): string {
  return join(appHome(), 'keybindings.json');
}

/** `ctrl+shift+a` as one canonical string, or null when it is not a key this can tell apart. */
export function parseKeystroke(text: string): string | null {
  const parts = text.toLowerCase().split('+').map((part) => part.trim());
  const name = parts.pop();
  if (!name) return null;
  const mods = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (!modifier) return null;
    mods.add(modifier);
  }
  const key = KEY_NAMES[name] ?? name;
  if (!/^([a-z0-9]|f([1-9]|1[0-2])|return|escape|tab|space|backspace|delete|up|down|left|right|home|end|pageup|pagedown|[-=[\];',./`\\])$/.test(key)) return null;
  return [...['ctrl', 'meta', 'shift'].filter((modifier) => mods.has(modifier)), key].join('+');
}

/** The same canonical string for a key as it arrives. */
export function keystrokeOf(text: string | undefined, key: Key | undefined): string | null {
  let name = key?.name;
  if (!name && text && [...text].length === 1) name = text.toLowerCase();
  if (name === 'enter') name = 'return';
  if (!name) return null;
  return [...(key?.ctrl ? ['ctrl'] : []), ...(key?.meta ? ['meta'] : []), ...(key?.shift ? ['shift'] : []), name].join('+');
}

export interface LoadedKeybindings {
  bindings: Map<string, KeyAction | null>;
  warnings: string[];
}

export function parseKeybindings(text: string): LoadedKeybindings {
  const bindings = new Map<string, KeyAction | null>();
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { bindings, warnings: [`keybindings.json is not valid JSON: ${(error as Error).message}`] };
  }
  const blocks = (parsed as { bindings?: unknown } | null)?.bindings;
  if (!Array.isArray(blocks)) return { bindings, warnings: ['keybindings.json needs a "bindings" list.'] };
  for (const block of blocks as { context?: unknown; bindings?: unknown }[]) {
    const context = typeof block?.context === 'string' ? block.context : '';
    if (!CONTEXTS.has(context)) {
      warnings.push(`keybindings.json: the "${context}" context is not supported yet, so its bindings are skipped. Use Global or Chat.`);
      continue;
    }
    for (const [keys, action] of Object.entries((block.bindings ?? {}) as Record<string, unknown>)) {
      if (/\s/.test(keys.trim())) {
        warnings.push(`keybindings.json: "${keys}" is a sequence of keys, which is not supported yet.`);
        continue;
      }
      const stroke = parseKeystroke(keys);
      if (!stroke) {
        warnings.push(`keybindings.json: "${keys}" is not a key Karst can read.`);
        continue;
      }
      if (action === null) bindings.set(stroke, null);
      else if (typeof action === 'string' && ((KEYBINDING_ACTIONS as readonly string[]).includes(action) || /^command:[\w:-]+$/.test(action))) bindings.set(stroke, action as KeyAction);
      else warnings.push(`keybindings.json: "${String(action)}" for ${keys} is not an action Karst has.`);
    }
  }
  return { bindings, warnings };
}

/** The user's bindings, read again when the file changes. */
export class Keybindings {
  private readonly path: string;
  private loaded: LoadedKeybindings = { bindings: new Map(), warnings: [] };
  private mtime = -1;
  private checkedAt = 0;
  onWarning?: (text: string) => void;

  constructor(path = keybindingsPath()) {
    this.path = path;
    this.reload(true);
  }

  get warnings(): string[] {
    return this.loaded.warnings;
  }

  /** What `stroke` is bound to: an action, null to do nothing, or undefined for the built-in behavior. */
  lookup(stroke: string | null): KeyAction | null | undefined {
    if (stroke === null) return undefined;
    this.reload();
    return this.loaded.bindings.has(stroke) ? this.loaded.bindings.get(stroke)! : undefined;
  }

  private reload(force = false): void {
    const now = Date.now();
    if (!force && now - this.checkedAt < RELOAD_CHECK_MS) return;
    this.checkedAt = now;
    const mtime = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    this.loaded = mtime === 0 ? { bindings: new Map(), warnings: [] } : parseKeybindings(readFileSync(this.path, 'utf8'));
    if (!force) for (const warning of this.loaded.warnings) this.onWarning?.(warning);
  }
}

export const KEYBINDINGS_TEMPLATE = `${JSON.stringify(
  {
    $docs: 'Karst reads the Global and Chat contexts. Actions: app:interrupt, app:exit, app:redraw, history:previous, history:next, chat:cancel, chat:cycleMode, chat:submit, chat:newline, chat:imagePaste, chat:clearInput, and command:<name> to run /<name>. null takes a key away.',
    bindings: [{ context: 'Chat', bindings: { 'ctrl+j': 'chat:newline' } }],
  },
  null,
  2,
)}\n`;
