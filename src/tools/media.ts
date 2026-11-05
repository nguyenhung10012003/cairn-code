/** Reading pictures and PDFs for the model. Both go to it as attachments on the tool result. */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment } from '../core/messages.ts';
import type { ToolOutput } from './types.ts';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const MAX_IMAGE_FILE_BYTES = 128 * 1024 * 1024;
/** The API's limit applies to the encoded image, which is a third larger than the file. */
const MAX_SENT_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
const SHRUNK_IMAGE_LONG_EDGE = 1568;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
export const WHOLE_PDF_PAGE_LIMIT = 10;
export const PDF_PAGES_PER_READ = 20;
const PDF_RENDER_DPI = 100;
const PDF_RENDER_TIMEOUT_MS = 120_000;

function failure(content: string): ToolOutput {
  return { content, isError: true };
}

/** By content, not by name: the API rejects an image whose declared type is wrong. */
export function imageMediaType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function run(file: string, args: string[], signal: AbortSignal): Promise<{ code: number | null; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: PDF_RENDER_TIMEOUT_MS });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => resolve({ code: null, stderr: error.message, missing: error.code === 'ENOENT' }));
    child.on('close', (code) => resolve({ code, stderr, missing: false }));
  });
}

/** `sips` comes with macOS. ImageMagick is the usual choice elsewhere, and may not be there. */
async function shrinkImage(path: string, signal: AbortSignal): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-image-'));
  const out = join(dir, 'shrunk.jpg');
  try {
    const attempts: [string, string[]][] = [
      ['sips', ['-s', 'format', 'jpeg', '-Z', String(SHRUNK_IMAGE_LONG_EDGE), path, '--out', out]],
      ['magick', [path, '-resize', `${SHRUNK_IMAGE_LONG_EDGE}x${SHRUNK_IMAGE_LONG_EDGE}>`, out]],
      ['convert', [path, '-resize', `${SHRUNK_IMAGE_LONG_EDGE}x${SHRUNK_IMAGE_LONG_EDGE}>`, out]],
    ];
    for (const [file, args] of attempts) {
      const result = await run(file, args, signal);
      if (result.code === 0) return await readFile(out);
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type PreparedImage =
  | {
      ok: true;
      mediaType: string;
      /** Base64, as the model takes it. */
      data: string;
      /** The size of the file, before any shrinking. */
      fileBytes: number;
      shrunk: boolean;
    }
  | { ok: false; problem: 'too-large' | 'not-an-image' | 'cannot-shrink' };

/** The image in a file as the model can take it, shrunk to a JPEG when it is over the size limit. */
export async function prepareImage(path: string, size: number, signal: AbortSignal): Promise<PreparedImage> {
  if (size > MAX_IMAGE_FILE_BYTES) return { ok: false, problem: 'too-large' };
  const bytes = await readFile(path);
  const mediaType = imageMediaType(bytes);
  if (!mediaType) return { ok: false, problem: 'not-an-image' };
  if (bytes.length <= MAX_SENT_IMAGE_BYTES) return { ok: true, mediaType, data: bytes.toString('base64'), fileBytes: bytes.length, shrunk: false };
  const shrunk = await shrinkImage(path, signal);
  if (!shrunk || shrunk.length > MAX_SENT_IMAGE_BYTES) return { ok: false, problem: 'cannot-shrink' };
  return { ok: true, mediaType: 'image/jpeg', data: Buffer.from(shrunk).toString('base64'), fileBytes: bytes.length, shrunk: true };
}

export async function readImage(path: string, size: number, signal: AbortSignal): Promise<ToolOutput> {
  const image = await prepareImage(path, size, signal);
  if (!image.ok) {
    const problems = {
      'too-large': `${path} is too large to read as an image. Resize it or export a smaller copy, then read that copy.`,
      'not-an-image': `${path} does not contain a PNG, JPEG, GIF or WebP image, whatever its name says.`,
      'cannot-shrink': `${path} is over the size limit for images and could not be shrunk here. Crop or resize it with a shell command, then read the result.`,
    };
    return failure(problems[image.problem]);
  }
  const note = image.shrunk ? ' It was shrunk to fit, so fine detail may be lost: crop a region and read that if you need it.' : '';
  return {
    content: `Image from ${path} (${image.mediaType}, ${image.fileBytes} bytes).${note}`,
    display: `image, ${Math.ceil(image.fileBytes / 1024)} KB`,
    attachments: [{ kind: 'image', mediaType: image.mediaType, data: image.data }],
  };
}

/** An estimate from the file's structure. Zero means it could not tell, as with compressed objects. */
export function countPdfPages(bytes: Buffer): number {
  return bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

export function parsePageRange(pages: string): { first: number; last: number } | null {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(pages);
  if (!match) return null;
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  return first >= 1 && last >= first ? { first, last } : null;
}

async function renderPdfPages(path: string, first: number, last: number, signal: AbortSignal): Promise<ToolOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-pdf-'));
  try {
    const result = await run('pdftoppm', ['-png', '-r', String(PDF_RENDER_DPI), '-f', String(first), '-l', String(last), path, join(dir, 'page')], signal);
    if (result.missing) {
      return failure('pdftoppm is not installed, so a page range cannot be read. Install poppler (brew install poppler, or apt-get install poppler-utils), or extract the text another way.');
    }
    if (result.code !== 0) return failure(`pdftoppm failed on ${path}: ${result.stderr.trim()}`);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.png')).sort();
    if (files.length === 0) return failure(`${path} has no pages in the range ${first}-${last}.`);
    const attachments: Attachment[] = [];
    for (const name of files) {
      attachments.push({ kind: 'image', mediaType: 'image/png', data: (await readFile(join(dir, name))).toString('base64') });
    }
    return {
      content: `Pages ${first}-${first + files.length - 1} of ${path}, as pictures.`,
      display: `${files.length} PDF pages`,
      attachments,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readPdf(path: string, size: number, pages: string | undefined, signal: AbortSignal): Promise<ToolOutput> {
  if (pages !== undefined) {
    const range = parsePageRange(pages);
    if (!range) return failure(`Could not read the page range "${pages}". Use a form such as "3" or "1-5".`);
    if (range.last - range.first + 1 > PDF_PAGES_PER_READ) return failure(`That is more than ${PDF_PAGES_PER_READ} pages. Read a smaller range.`);
    return renderPdfPages(path, range.first, range.last, signal);
  }
  if (size > MAX_PDF_BYTES) return failure(`${path} is ${size} bytes, over the ${MAX_PDF_BYTES} byte limit for a whole PDF. Use pages to read part of it.`);
  const bytes = await readFile(path);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return failure(`${path} is not a PDF, whatever its name says.`);
  const count = countPdfPages(bytes);
  if (count > WHOLE_PDF_PAGE_LIMIT) {
    return failure(`${path} has about ${count} pages. Read it in ranges with pages, such as "1-5", up to ${PDF_PAGES_PER_READ} at a time.`);
  }
  return {
    content: `PDF from ${path} (${bytes.length} bytes).`,
    display: count > 0 ? `PDF, ${count} pages` : 'PDF',
    attachments: [{ kind: 'document', mediaType: 'application/pdf', data: bytes.toString('base64') }],
  };
}
