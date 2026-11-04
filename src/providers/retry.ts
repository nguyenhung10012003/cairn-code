/**
 * Retries for one model response, shared by every provider. One budget covers a request that
 * fails before the response starts and a stream that fails partway, so a retry never nests
 * inside another. Each wait doubles from half a second, and none is longer than five minutes.
 */
import { ProviderError } from '../core/provider.ts';
import type { StreamEvent } from '../core/provider.ts';

export const DEFAULT_MAX_RETRIES = 10;
const FIRST_DELAY_MS = 500;
/** The longest single wait, even when the server asks for more. */
export const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** The wait before retry number `retry`, counting from 0: what the server asked for, or a doubling backoff. */
export function retryDelay(retry: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  // Jitter, so clients that failed together do not all come back at the same moment.
  return Math.min(MAX_RETRY_DELAY_MS, FIRST_DELAY_MS * 2 ** retry * (0.75 + Math.random() * 0.5));
}

/** The wait a response asks for in `retry-after-ms` or `retry-after` (seconds or a date). */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const ms = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const untilDate = Date.parse(value) - Date.now();
  return Number.isFinite(untilDate) && untilDate > 0 ? untilDate : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/**
 * Runs `attempt`, and runs it again after a retryable `ProviderError`, up to `maxRetries` more
 * times. Before each wait it yields a `retry` event: the next attempt starts the response over,
 * so the consumer must drop whatever the failed one streamed.
 */
export async function* withRetries(
  maxRetries: number,
  signal: AbortSignal | undefined,
  attempt: () => AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent> {
  for (let retry = 0; ; retry++) {
    try {
      yield* attempt();
      return;
    } catch (error) {
      if (signal?.aborted || !(error instanceof ProviderError) || !error.retryable) throw error;
      if (retry >= maxRetries) {
        if (retry === 0) throw error;
        throw new ProviderError(`${error.message} Gave up after ${retry} ${retry === 1 ? 'retry' : 'retries'}.`, {
          retryable: true,
          ...(error.status === undefined ? {} : { status: error.status }),
          cause: error,
        });
      }
      const delayMs = retryDelay(retry, error.retryAfterMs);
      yield { type: 'retry', attempt: retry + 1, maxRetries, delayMs, reason: error.message };
      await sleep(delayMs, signal);
    }
  }
}
