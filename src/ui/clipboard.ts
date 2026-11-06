/**
 * Pictures from the system clipboard, for the paste key: Cmd+V on macOS, Ctrl+V on Windows and
 * Linux. Terminals paste text only, so the picture is read with the platform's own tools:
 * osascript on macOS, PowerShell on Windows, and wl-paste (Wayland) or xclip (X11) on Linux. A
 * file copied in a file manager counts too, when it is a picture.
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_EXTENSIONS } from '../tools/media.ts';

const TIMEOUT_MS = 10_000;
/** The same ceiling as an image file that Read accepts. */
const MAX_CLIPBOARD_BYTES = 128 * 1024 * 1024;
/** Clipboard types a model takes, best first, with the extension to save each under. */
const LINUX_TYPES: [type: string, extension: string][] = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
];
/** What `clipboard info` calls each type, how AppleScript reads it, and whether sips must convert it. */
const MAC_TYPES: { listed: string; as: string; extension: string; convert?: boolean }[] = [
  { listed: '«class PNGf»', as: '«class PNGf»', extension: 'png' },
  { listed: 'JPEG picture', as: 'JPEG picture', extension: 'jpg' },
  { listed: 'GIF picture', as: 'GIF picture', extension: 'gif' },
  { listed: 'TIFF picture', as: 'TIFF picture', extension: 'tiff', convert: true },
];

/**
 * Lists the files copied in Explorer, one `file <base64 of the UTF-8 path>` line each, so a name
 * survives whatever code page the console has. Then saves the clipboard's picture as a PNG to the
 * file CAIRN_CLIPBOARD_OUT names and says `image`. Errors go to stderr as plain text, since
 * PowerShell would otherwise write them there as CLIXML.
 */
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '  if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
  '    foreach ($file in [System.Windows.Forms.Clipboard]::GetFileDropList()) {',
  "      'file ' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($file))",
  '    }',
  '  }',
  '  if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
  '    $image = [System.Windows.Forms.Clipboard]::GetImage()',
  '    try { $image.Save($env:CAIRN_CLIPBOARD_OUT, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }',
  "    'image'",
  '  }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

/** The key that pastes an image: Cmd+V on macOS, Ctrl+V elsewhere. */
export function pasteImageKey(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';
}

export type ClipboardImage =
  /** A file holding the picture. `cleanup` deletes it when it was written for this. */
  | { ok: true; path: string; cleanup: () => Promise<void> }
  /** `empty` when the clipboard holds no picture, so a paste of nothing can stay quiet. */
  | { ok: false; empty: boolean; message: string };

const noImage = (): ClipboardImage => ({ ok: false, empty: true, message: 'There is no image on the clipboard.' });
const failed = (message: string): ClipboardImage => ({ ok: false, empty: false, message });

interface Output {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The program is not installed. */
  missing: boolean;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Output> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env, timeout: TIMEOUT_MS });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_CLIPBOARD_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: error.message, missing: error.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      if (size > MAX_CLIPBOARD_BYTES) resolve({ code: null, stdout: Buffer.alloc(0), stderr: 'The clipboard image is too large.', missing: false });
      else resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim(), missing: false });
    });
  });
}

/** `path`, when it names a picture file that is there. */
function imageFile(path: string): string | null {
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return null;
  try {
    return statSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

async function scratchFile(extension: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-clipboard-'));
  return { path: join(dir, `clipboard.${extension}`), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes the clipboard, read as `type`, to the file named by the first argument. */
function macWriteScript(type: string): string[] {
  const lines = [
    'on run argv',
    'set f to open for access (POSIX file (item 1 of argv)) with write permission',
    'try',
    'set eof f to 0',
    `write (the clipboard as ${type}) to f`,
    'close access f',
    'on error message',
    'close access f',
    'error message',
    'end try',
    'end run',
  ];
  return lines.flatMap((line) => ['-e', line]);
}

async function macClipboard(env: NodeJS.ProcessEnv): Promise<ClipboardImage> {
  const info = await run('osascript', ['-e', 'clipboard info'], env);
  if (info.code !== 0) return failed(`Could not read the clipboard: ${info.stderr || 'osascript failed'}.`);
  const listed = info.stdout.toString();
  // A file copied in Finder: the picture itself, rather than the icon that comes with it.
  if (listed.includes('«class furl»')) {
    const path = await run('osascript', ['-e', 'POSIX path of (the clipboard as «class furl»)'], env);
    const file = path.code === 0 ? imageFile(path.stdout.toString().trim()) : null;
    if (file) return { ok: true, path: file, cleanup: async () => {} };
  }
  const type = MAC_TYPES.find((candidate) => listed.includes(candidate.listed));
  if (!type) return noImage();
  const raw = await scratchFile(type.extension);
  const written = await run('osascript', [...macWriteScript(type.as), raw.path], env);
  if (written.code !== 0) {
    await raw.cleanup();
    return failed(`Could not read the image from the clipboard: ${written.stderr || 'osascript failed'}.`);
  }
  if (!type.convert) return { ok: true, ...raw };
  // Models do not take TIFF, and sips comes with macOS.
  const png = join(dirname(raw.path), 'clipboard.png');
  const converted = await run('sips', ['-s', 'format', 'png', raw.path, '--out', png], env);
  if (converted.code !== 0) {
    await raw.cleanup();
    return failed(`Could not convert the clipboard image to PNG: ${converted.stderr || 'sips failed'}.`);
  }
  return { ok: true, path: png, cleanup: raw.cleanup };
}

interface LinuxTool {
  name: string;
  /** Lists the types on the clipboard, one per line. */
  list: string[];
  read: (type: string) => string[];
}

const WL_PASTE: LinuxTool = { name: 'wl-paste', list: ['--list-types'], read: (type) => ['--type', type] };
const XCLIP: LinuxTool = {
  name: 'xclip',
  list: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
  read: (type) => ['-selection', 'clipboard', '-t', type, '-o'],
};

async function linuxClipboard(env: NodeJS.ProcessEnv): Promise<ClipboardImage> {
  // XWayland sets DISPLAY too, but only wl-paste sees what Wayland programs copied.
  const tools = [...(env.WAYLAND_DISPLAY ? [WL_PASTE] : []), ...(env.DISPLAY ? [XCLIP] : [])];
  if (tools.length === 0) return failed('There is no display to read a clipboard from: neither WAYLAND_DISPLAY nor DISPLAY is set.');
  for (const tool of tools) {
    const listed = await run(tool.name, tool.list, env);
    if (listed.missing) continue;
    // Both tools fail when nothing has been copied.
    if (listed.code !== 0) return noImage();
    const types = listed.stdout.toString().split('\n').map((line) => line.trim()).filter(Boolean);
    const image = LINUX_TYPES.find(([type]) => types.includes(type));
    if (image) {
      const [type, extension] = image;
      const data = await run(tool.name, tool.read(type), env);
      if (data.code !== 0 || data.stdout.length === 0) {
        return failed(`Could not read the image from the clipboard: ${data.stderr || `${tool.name} failed`}.`);
      }
      const file = await scratchFile(extension);
      await writeFile(file.path, data.stdout, { mode: 0o600 });
      return { ok: true, ...file };
    }
    // Files copied in a file manager arrive as file:// URLs.
    if (types.includes('text/uri-list')) {
      const uris = await run(tool.name, tool.read('text/uri-list'), env);
      for (const line of uris.stdout.toString().split(/\r?\n/)) {
        if (!line.startsWith('file://')) continue;
        let path: string;
        try {
          path = fileURLToPath(line.trim());
        } catch {
          continue;
        }
        const file = imageFile(path);
        if (file) return { ok: true, path: file, cleanup: async () => {} };
      }
    }
    const other = types.find((type) => type.startsWith('image/'));
    if (other) return failed(`The clipboard holds ${other}, which models do not take. Copy it as PNG or JPEG instead.`);
    return noImage();
  }
  return failed('Pasting an image needs wl-clipboard on Wayland or xclip on X11. Install one, such as with sudo apt install wl-clipboard xclip.');
}

async function windowsClipboard(env: NodeJS.ProcessEnv): Promise<ClipboardImage> {
  const raw = await scratchFile('png');
  // An encoded script needs no quoting, and the file name goes in the environment for the same reason.
  const script = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script], { ...env, CAIRN_CLIPBOARD_OUT: raw.path });
  if (result.missing || result.code !== 0) {
    await raw.cleanup();
    if (result.missing) return failed('Pasting an image needs PowerShell (powershell.exe), which comes with Windows.');
    // .NET messages end with a full stop of their own.
    const reason = result.stderr.startsWith('#< CLIXML') ? '' : result.stderr.replace(/\.$/, '');
    return failed(`Could not read the clipboard: ${reason || 'PowerShell failed'}.`);
  }
  const lines = result.stdout.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // A file copied in Explorer: the picture itself.
  for (const line of lines) {
    const file = line.startsWith('file ') ? imageFile(Buffer.from(line.slice('file '.length), 'base64').toString('utf8')) : null;
    if (file) {
      await raw.cleanup();
      return { ok: true, path: file, cleanup: async () => {} };
    }
  }
  if (lines.includes('image')) return { ok: true, ...raw };
  await raw.cleanup();
  return noImage();
}

/** The picture on the clipboard, saved to a file. `platform` and `env` are for tests. */
export async function readClipboardImage(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<ClipboardImage> {
  if (platform === 'darwin') return macClipboard(env);
  if (platform === 'linux') return linuxClipboard(env);
  if (platform === 'win32') return windowsClipboard(env);
  return failed('Pasting an image works on macOS, Linux and Windows only. Save the image to a file and drop the file here instead.');
}
