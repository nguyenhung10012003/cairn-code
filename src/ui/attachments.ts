/**
 * Images attached to messages typed at the prompt. Each stands in the text as a placeholder such
 * as [Image #1], which can be moved or deleted like any other text, and a message takes with it
 * the images whose placeholders it still has when it is sent.
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageBlock } from '../core/messages.ts';
import { IMAGE_EXTENSIONS, prepareImage } from '../tools/media.ts';

/** A placeholder that ends right at the cursor, which Backspace deletes whole. */
export const PLACEHOLDER_AT_END = /\[Image #\d+\]$/;
const PLACEHOLDERS = /\[Image #(\d+)\]/g;
/** A paste naming more files than this is not a drop of pictures. */
const MAX_DROPPED_FILES = 10;

export class AttachedImages {
  /** Kept for the whole session, so a message brought back with Up still has its images. */
  private readonly images = new Map<number, ImageBlock>();
  private next = 1;

  /** Keeps the image and returns its placeholder. */
  add(image: ImageBlock): string {
    const number = this.next++;
    this.images.set(number, image);
    return `[Image #${number}]`;
  }

  /** The images a message's placeholders name, in the order they first appear. */
  in(text: string): ImageBlock[] {
    const seen = new Set<number>();
    const found: ImageBlock[] = [];
    for (const match of text.matchAll(PLACEHOLDERS)) {
      const number = Number(match[1]);
      const image = this.images.get(number);
      if (!image || seen.has(number)) continue;
      seen.add(number);
      found.push(image);
    }
    return found;
  }
}

/** Styles each placeholder in text already sanitized for the screen. */
export function markPlaceholders(text: string, mark: (placeholder: string) => string): string {
  return text.replace(PLACEHOLDERS, (placeholder) => mark(placeholder));
}

/**
 * Splits a paste the way a shell would split file names: on spaces, tabs and line breaks, with
 * quotes and backslashes keeping a name together. Null when a quote is left open.
 */
function splitNames(text: string): string[] | null {
  const names: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < chars.length) current += chars[++i];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === '\\' && i + 1 < chars.length) {
      current += chars[++i];
      started = true;
    } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      // Only these: macOS puts a narrow no-break space in screenshot names, unescaped.
      if (started) names.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) names.push(current);
  return names;
}

/** An absolute path, from a path, a ~/ path or a file:// URL. Null for anything relative. */
function absolutePath(name: string): string | null {
  if (name.startsWith('file://')) {
    try {
      return fileURLToPath(name);
    } catch {
      return null;
    }
  }
  if (name.startsWith('~/')) return join(homedir(), name.slice(2));
  return isAbsolute(name) ? name : null;
}

function isImageFile(path: string): boolean {
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The picture files a paste names, when that is all it holds: what a terminal pastes for files
 * dropped on it, quoted or with escaped spaces. Null for anything else, which stays text. A
 * relative name stays text too, since it is more likely meant as a name than as an attachment.
 */
export function droppedImagePaths(text: string): string[] | null {
  const names = splitNames(text.trim());
  if (!names || names.length === 0 || names.length > MAX_DROPPED_FILES) return null;
  const paths = names.map(absolutePath);
  return paths.every((path): path is string => path !== null && isImageFile(path)) ? paths : null;
}

export type LoadedImage = { ok: true; image: ImageBlock; shrunk: boolean } | { ok: false; message: string };

/** Reads a picture for a message, shrunk the way Read shrinks one when it is over the size limit. */
export async function loadImage(path: string, label: string, signal: AbortSignal): Promise<LoadedImage> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (error) {
    return { ok: false, message: `Could not read ${label}: ${(error as Error).message}` };
  }
  const prepared = await prepareImage(path, size, signal);
  if (prepared.ok) return { ok: true, image: { type: 'image', mediaType: prepared.mediaType, data: prepared.data }, shrunk: prepared.shrunk };
  const problems = {
    'too-large': `${label} is too large to attach. Export a smaller copy and attach that.`,
    'not-an-image': `${label} is not a PNG, JPEG, GIF or WebP image, so it cannot be attached.`,
    'cannot-shrink': `${label} is over the 5 MB limit for images and could not be shrunk here${process.platform === 'darwin' ? '' : ' (that needs ImageMagick)'}. Attach a smaller copy.`,
  };
  return { ok: false, message: problems[prepared.problem] };
}
