/**
 * Client side of tab completion: LRU-cached fetch of /api/ai/fim.
 * Kept separate from the CodeMirror extension so the cache can be tested.
 *
 * Two rules this module exists to enforce:
 *
 * 1. A cached completion belongs to the credential and model that produced it.
 *    The key therefore carries a one-way fingerprint of the API key — never the
 *    key itself — so switching keys or models can never serve another
 *    identity's result.
 * 2. Failures are not answers. A 401 used to be cached as an empty completion,
 *    which made Tab silently stop working for those contexts forever; now a
 *    failed request is not cached, and the failures are surfaced to the editor.
 */

export interface FimRequestContext {
  provider: string;
  model: string;
  apiKey?: string;
  language?: string;
}

export interface FimResult {
  text: string;
  tokens: number;
}

export type FimFailureKind = 'request-failed';

export interface FimHealth {
  /** Consecutive failed requests since the last success (or cache reset). */
  consecutiveFailures: number;
  lastFailure: FimFailureKind | null;
}

const CACHE_LIMIT = 64;
/** After this many failures in a row the editor stops being quiet about it. */
export const FIM_FAILURE_HINT_THRESHOLD = 3;

const EMPTY: FimResult = { text: '', tokens: 0 };

const cache = new Map<string, FimResult>();
const inFlight = new Map<string, Promise<FimResult>>();

/**
 * FNV-1a over the key, rendered as hex. A fingerprint is enough to partition
 * the cache; storing the raw key here would put the secret in a plain Map that
 * outlives the request.
 */
export function fingerprintSecret(value: string | undefined): string {
  if (!value) return 'shared';
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Identity that changes the answer: provider + model + credential. */
export function fimIdentity(context: FimRequestContext): string {
  return `${context.provider}|${context.model}|${fingerprintSecret(context.apiKey)}`;
}

export function fimCacheKey(context: FimRequestContext, prefix: string, suffix: string): string {
  return `${fimIdentity(context)}|${prefix.slice(-1200)}|${suffix.slice(0, 400)}`;
}

function remember(key: string, value: FimResult): FimResult {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

let health: FimHealth = { consecutiveFailures: 0, lastFailure: null };
const healthListeners = new Set<() => void>();

function setHealth(next: FimHealth): void {
  if (next.consecutiveFailures === health.consecutiveFailures && next.lastFailure === health.lastFailure) return;
  health = next;
  healthListeners.forEach((listener) => listener());
}

export function getFimHealth(): FimHealth {
  return health;
}

/** Editor hook for the dismissible hint. */
export function subscribeFimHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => healthListeners.delete(listener);
}

export function clearFimHealth(): void {
  setHealth({ consecutiveFailures: 0, lastFailure: null });
}

/**
 * Drops every cached completion. Called whenever the identity behind a
 * completion changes (key, model, provider) so a stale or foreign answer can
 * never be served, and when the user dismisses the failure hint.
 */
export function clearFimCache(): void {
  cache.clear();
  inFlight.clear();
  clearFimHealth();
}

/** Test seam: current cache size. */
export function fimCacheSize(): number {
  return cache.size;
}

function recordFailure(kind: FimFailureKind): void {
  setHealth({ consecutiveFailures: health.consecutiveFailures + 1, lastFailure: kind });
}

/**
 * Requests a completion, reusing an identical request that is already running
 * and serving recent hits straight from memory. A dropped request resolves to
 * an empty completion instead of throwing, so the editor never shows an error —
 * but it is counted, so the editor can say that completion is not working.
 */
export async function requestFimCompletion(
  context: FimRequestContext,
  prefix: string,
  suffix: string,
  signal?: AbortSignal
): Promise<FimResult> {
  const key = fimCacheKey(context, prefix, suffix);
  const hit = cache.get(key);
  if (hit) return hit;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const call: Promise<FimResult> = (async () => {
    try {
      const response = await fetch('/api/ai/fim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          provider: context.provider,
          model: context.model,
          apiKey: context.apiKey,
          language: context.language,
          prefix,
          suffix
        })
      });
      if (!response.ok) {
        // Deliberately NOT cached: one 401 must not poison these contexts for
        // the rest of the session.
        recordFailure('request-failed');
        return EMPTY;
      }
      const data = await response.json();
      const text = typeof data?.text === 'string' ? data.text : '';
      setHealth({ consecutiveFailures: 0, lastFailure: null });
      return remember(key, { text, tokens: typeof data?.tokens === 'number' ? data.tokens : 0 });
    } catch {
      if (!signal?.aborted) recordFailure('request-failed');
      return EMPTY;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, call);
  return call;
}
