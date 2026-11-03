/**
 * HTTP plumbing shared by the providers that talk to their API with plain fetch: retries with
 * backoff, and readers for server-sent events and newline-delimited JSON streams.
 */
import { ProviderError } from '../core/provider.ts';

const MAX_BACKOFF_MS = 8_000;
/** Worth another try: the request may well succeed a moment later. */
const RETRYABLE_STATUSES = new Set([408, 409, 429]);

export interface PostOptions {
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  maxRetries: number;
  /** Turns an error response into a message that says what to do. */
  describeError(status: number, body: string, headers: Headers): ProviderError;
  /** Turns a failure to connect into a message that says what to do. */
  describeNetworkError(error: Error): ProviderError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryDelay(attempt: number, headers?: Headers): number {
  const ms = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_BACKOFF_MS * 4);
  const seconds = Number(headers?.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS * 4);
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error as Error)?.name === 'AbortError';
}

/** POSTs JSON, retrying connection failures, rate limits and server errors. */
export async function postJson(url: string, options: PostOptions): Promise<Response> {
  const body = JSON.stringify(options.body);
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      if (attempt < options.maxRetries) {
        await sleep(retryDelay(attempt), options.signal);
        continue;
      }
      throw options.describeNetworkError(error as Error);
    }
    if (response.ok) return response;
    const text = await response.text().catch(() => '');
    const retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500;
    const described = options.describeError(response.status, text, response.headers);
    if (retryable && described.retryable && attempt < options.maxRetries) {
      await sleep(retryDelay(attempt, response.headers), options.signal);
      continue;
    }
    throw described;
  }
}

/** The `message` of a JSON error body such as `{"error": {"message": ...}}` or `{"error": "..."}`. */
export function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    const nested = (parsed.error as { message?: unknown } | undefined)?.message;
    if (typeof nested === 'string') return nested;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.trim().slice(0, 500) || 'no details given';
}

async function* lines(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      yield buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
    }
  }
  buffered += decoder.decode();
  if (buffered) yield buffered;
}

export interface ServerSentEvent {
  event: string;
  data: string;
}

/** Server-sent events, one per blank-line-terminated record. */
export async function* serverSentEvents(response: Response): AsyncGenerator<ServerSentEvent> {
  let event = '';
  let data: string[] = [];
  for await (const line of lines(response)) {
    if (line === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      event = '';
      data = [];
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length > 0) yield { event, data: data.join('\n') };
}

/** Newline-delimited JSON objects. A line that is not JSON is an error, not something to skip. */
export async function* jsonLines(response: Response): AsyncGenerator<Record<string, unknown>> {
  for await (const line of lines(response)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ProviderError(`The server sent a line that is not JSON: ${line.slice(0, 200)}`);
    }
  }
}
