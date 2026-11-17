/**
 * One language server, spoken to over stdio with JSON-RPC as LSP frames it. Karst only opens
 * documents, sends their new text after an edit, and collects the diagnostics the server
 * publishes for them.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  /** File extensions, with the dot, and the LSP language id of each. */
  extensionToLanguage: Record<string, string>;
  env?: Record<string, string>;
  initializationOptions?: unknown;
}

export interface Diagnostic {
  /** 1-based, as editors show them. */
  line: number;
  column: number;
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface RawDiagnostic {
  range?: { start?: { line?: number; character?: number } };
  severity?: number;
  message?: string;
  source?: string;
  code?: string | number;
}

const START_TIMEOUT_MS = 30_000;
/** A server may publish more than once for one change, such as syntax first and types after. */
const SETTLE_MS = 250;
const MAX_FRAME_BYTES = 50 * 1024 * 1024;

export class LspClient {
  readonly config: LspServerConfig;
  private readonly rootDir: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly versions = new Map<string, number>();
  private readonly latest = new Map<string, RawDiagnostic[]>();
  private readonly listeners = new Map<string, () => void>();
  private starting: Promise<void> | undefined;
  private exited: Error | undefined;

  constructor(config: LspServerConfig, rootDir: string) {
    this.config = config;
    this.rootDir = rootDir;
  }

  /** Starts the server once; later calls wait for the same start. */
  start(): Promise<void> {
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<void> {
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.rootDir,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    // A language server never keeps a finished session running.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr] as unknown as { unref?: () => void }[]) stream.unref?.();
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // What a server logs is not for the conversation.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const failed = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        this.fail(new Error(`${this.config.command} could not start: ${error.message}`));
        reject(this.exited!);
      });
      child.once('exit', (code, signal) => {
        this.fail(new Error(`${this.config.name} exited (${signal ?? `code ${code}`})`));
        reject(this.exited!);
      });
    });
    failed.catch(() => {});
    const root = pathToFileURL(this.rootDir).href;
    const initialize = this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'karst' },
      rootUri: root,
      rootPath: this.rootDir,
      workspaceFolders: [{ uri: root, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
      ...(this.config.initializationOptions !== undefined ? { initializationOptions: this.config.initializationOptions } : {}),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${this.config.name} did not start within ${START_TIMEOUT_MS / 1000} seconds`)), START_TIMEOUT_MS);
    });
    try {
      await Promise.race([initialize, failed, timeout]);
    } catch (error) {
      this.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.notify('initialized', {});
  }

  private fail(error: Error): void {
    this.exited ??= error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const wake of this.listeners.values()) wake();
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child || this.exited) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      if (!Number.isFinite(length) || length > MAX_FRAME_BYTES) {
        this.fail(new Error(`${this.config.name} sent a message Karst cannot read`));
        this.kill();
        return;
      }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      try {
        this.handle(JSON.parse(body) as Record<string, unknown>);
      } catch {
        // One unreadable message does not stop the rest.
      }
    }
  }

  private handle(message: Record<string, unknown>): void {
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    if (method === undefined && typeof id === 'number') {
      const waiting = this.pending.get(id);
      this.pending.delete(id);
      if (!waiting) return;
      if (message.error) waiting.reject(new Error((message.error as { message?: string }).message ?? 'request failed'));
      else waiting.resolve(message.result);
      return;
    }
    if (method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri?: string; diagnostics?: RawDiagnostic[] };
      if (!params?.uri) return;
      this.latest.set(params.uri, params.diagnostics ?? []);
      this.listeners.get(params.uri)?.();
      return;
    }
    // A request from the server waits for an answer; some servers stall without one.
    if (id !== undefined && method !== undefined) {
      const items = (message.params as { items?: unknown[] } | undefined)?.items;
      this.send({ id, result: method === 'workspace/configuration' ? (items ?? []).map(() => null) : null });
    }
  }

  /**
   * Sends the file's current text and waits for the diagnostics published after it, up to
   * `timeoutMs`. Null when none came in time, which says nothing about whether there are errors.
   */
  async diagnostics(path: string, text: string, languageId: string, timeoutMs: number): Promise<Diagnostic[] | null> {
    await this.start();
    if (this.exited) throw this.exited;
    const uri = pathToFileURL(path).href;
    const settled = new Promise<RawDiagnostic[] | null>((resolve) => {
      let settle: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => finish(null), timeoutMs);
      const finish = (value: RawDiagnostic[] | null): void => {
        clearTimeout(deadline);
        clearTimeout(settle);
        this.listeners.delete(uri);
        resolve(value);
      };
      this.listeners.set(uri, () => {
        if (this.exited) return finish(null);
        clearTimeout(settle);
        settle = setTimeout(() => finish(this.latest.get(uri) ?? []), SETTLE_MS);
      });
    });
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    // Some servers check only on save, as rust-analyzer does.
    this.notify('textDocument/didSave', { textDocument: { uri }, text });
    const raw = await settled;
    if (raw === null) return null;
    return raw.map((item) => ({
      line: (item.range?.start?.line ?? 0) + 1,
      column: (item.range?.start?.character ?? 0) + 1,
      severity: item.severity ?? 1,
      message: item.message ?? '',
      ...(item.source ? { source: item.source } : {}),
      ...(item.code !== undefined ? { code: item.code } : {}),
    }));
  }

  private kill(): void {
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    const child = this.child;
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      await Promise.race([this.request('shutdown', null), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      this.notify('exit', null);
    } catch {
      // It is stopped below either way.
    }
    const timer = setTimeout(() => this.kill(), 1_000);
    await gone;
    clearTimeout(timer);
  }
}
