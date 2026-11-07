import type { PromptCacheReport } from './_promptCache.js';
import type { StreamResult } from './_types.js';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Hard cap on provider hits for ONE logical call (one adapter stream), shared
 * across every fallback resend and every fetch-level retry inside it. Without
 * it, a ladder of feature-dropping resends each carrying its own retry budget
 * could multiply a single user turn into many billed attempts.
 */
export const MAX_LOGICAL_CALL_ATTEMPTS = 6;

export class AttemptCounter {
  private used = 0;
  private readonly limit: number;

  constructor(limit: number = MAX_LOGICAL_CALL_ATTEMPTS) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get count(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  take(): void {
    this.used += 1;
  }
}

/**
 * Additive provenance an adapter may report alongside the billing fields.
 * Every part stays optional: an adapter that cannot observe a value omits it
 * rather than inventing one, and old clients keep reading the base fields.
 */
export interface StreamResultMeta {
  /** 'provider' only when the tokens total came from provider-reported usage. */
  usageSource?: 'provider' | 'estimated';
  /** Model identity the provider itself reported on the response, never the request echo. */
  servedModel?: string;
  /** Provider hits spent by this logical call, including fallback resends. */
  attempts?: number;
  /** Request features a fallback ladder had to drop to get the call through. */
  droppedFeatures?: string[];
  /** Cache posture of the FINAL wire payload, after any fallback downgrade. */
  promptCache?: PromptCacheReport;
}

export type MeteredStreamResult = StreamResult & StreamResultMeta;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_000, Math.round(seconds * 1_000));
  return Math.min(800, 250 * (attempt + 1) + Math.round(Math.random() * 100));
}

/**
 * Fetch wrapper for upstream model providers. Retries only before the response
 * body is consumed, so a stream that already started is never replayed. Pass
 * one AttemptCounter per logical call to bound the TOTAL number of provider
 * hits across all of its resends and retries.
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  attempts = 2,
  counter?: AttemptCounter
): Promise<Response> {
  let lastError: unknown = null;
  const maxAttempts = counter ? Math.min(attempts, counter.remaining) : attempts;
  if (maxAttempts <= 0) {
    throw new Error('Provider attempt budget exhausted for this request.');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    counter?.take();
    try {
      const response = await fetch(url, { ...init, signal });
      // A consumed body means the stream already reached the caller: replaying
      // it would duplicate output (and spend), so it is never retryable.
      const retryable = RETRYABLE_STATUS.has(response.status) && !response.bodyUsed;
      if (!retryable || attempt === maxAttempts - 1 || counter?.exhausted) return response;

      await response.body?.cancel().catch(() => undefined);
      await wait(retryDelayMs(response, attempt), signal);
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === maxAttempts - 1 || counter?.exhausted) break;
      await wait(retryDelayMs(null, attempt), signal);
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Upstream provider request failed.');
}