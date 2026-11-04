/**
 * HTTP plumbing shared by the providers that talk to their API with plain fetch: one POST, and
 * readers for server-sent events and newline-delimited JSON streams. Retries are in retry.ts.
 */
import { ProviderError } from '../core/provider.ts';
import { retryAfterMs } from './retry.ts';

export interface PostOptions {
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  /** Turns an error response into a message that says what to do, and whether to try again. */
  describeError(status: number, body: string, headers: Headers): ProviderError;
  /** Turns a failure to connect into a message that says what to do. */
  describeNetworkError(error: Error): ProviderError;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error as Error)?.name === 'AbortError';
}

/** POSTs JSON once. A failure comes back as a `ProviderError` that says whether a retry may help. */
export async function postJson(url: string, options: PostOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isAbort(error, options.signal)) throw error;
    throw options.describeNetworkError(error as Error);
  }
  if (response.ok) return response;
  const text = await response.text().catch(() => '');
  const described = options.describeError(response.status, text, response.headers);
  const wait = retryAfterMs(response.headers);
  if (described.retryable && wait !== undefined) described.retryAfterMs = wait;
  throw described;
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
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        yield buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
      }
    }
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    // The response had started, so the server took the request: the connection broke under it.
    throw new ProviderError(`The connection dropped during the response (${(error as Error)?.message ?? String(error)}).`, { retryable: true, cause: error });
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
