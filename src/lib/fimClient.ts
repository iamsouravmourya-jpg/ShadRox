/**
 * Client side of tab completion: LRU-cached fetch of /api/ai/fim.
 * Kept separate from the CodeMirror extension so the cache can be tested.
 *
 * Three rules this module exists to enforce:
 *
 * 1. A cached completion belongs to the credential and model that produced it.
 *    The key therefore carries a one-way fingerprint of the API key — never the
 *    key itself — so switching keys or models can never serve another
 *    identity's result.
 * 2. Failures are not answers. A 401 used to be cached as an empty completion,
 *    which made Tab silently stop working for those contexts forever; now a
 *    failed request is not cached, and the failures are surfaced to the editor.
 *    A refusal that arrives wearing a 200 (the route's `warning` field) is the
 *    same thing.
 * 3. An endpoint that keeps refusing gets a growing pause instead of one request
 *    per keystroke. The pause belongs to the endpoint that earned it, so
 *    switching provider, base URL, model or key starts clean.
 */

import { scrubWorkspaceText } from './envSafety';

export interface FimRequestContext {
  provider: string;
  /** Base URL of a BYOK custom endpoint; ignored by the built-in providers. */
  baseUrl?: string;
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
  /** Wall-clock ms until which requests are withheld, or 0 when not paused. */
  cooldownUntil: number;
}

const CACHE_LIMIT = 64;
/** After this many failures in a row the editor stops being quiet about it. */
export const FIM_FAILURE_HINT_THRESHOLD = 3;
/** First pause after a failure streak, and the ceiling it grows to. */
export const FIM_COOLDOWN_BASE_MS = 30_000;
export const FIM_COOLDOWN_MAX_MS = 600_000;

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

/** Identity that changes the answer: provider + endpoint + model + credential. */
export function fimIdentity(context: FimRequestContext): string {
  return `${context.provider}|${context.baseUrl || ''}|${context.model}|${fingerprintSecret(context.apiKey)}`;
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

let health: FimHealth = { consecutiveFailures: 0, lastFailure: null, cooldownUntil: 0 };
const healthListeners = new Set<() => void>();

/**
 * Which endpoint the current failure streak belongs to. A pause is a statement
 * about one host, not about tab completion in general: it would be wrong to
 * withhold Gemini requests because a custom gateway answered 404, and the
 * streak would be meaningless the moment the user repointed Settings.
 */
let streakIdentity = '';

function setHealth(next: FimHealth): void {
  if (
    next.consecutiveFailures === health.consecutiveFailures &&
    next.lastFailure === health.lastFailure &&
    next.cooldownUntil === health.cooldownUntil
  ) return;
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
  setHealth({ consecutiveFailures: 0, lastFailure: null, cooldownUntil: 0 });
}

/**
 * Drops every cached completion. Called whenever the identity behind a
 * completion changes (key, model, provider) so a stale or foreign answer can
 * never be served, and when the user dismisses the failure hint.
 */
export function clearFimCache(): void {
  cache.clear();
  inFlight.clear();
  streakIdentity = '';
  clearFimHealth();
}

/** Test seam: current cache size. */
export function fimCacheSize(): number {
  return cache.size;
}

function recordFailure(kind: FimFailureKind): void {
  const consecutiveFailures = health.consecutiveFailures + 1;
  // A streak long enough to tell the user about is also long enough to stop
  // asking: each further failure was a keystroke spent against an endpoint that
  // already said no. The pause doubles per failure, capped.
  const cooling = consecutiveFailures >= FIM_FAILURE_HINT_THRESHOLD;
  const pause = cooling
    ? Math.min(FIM_COOLDOWN_BASE_MS * 2 ** (consecutiveFailures - FIM_FAILURE_HINT_THRESHOLD), FIM_COOLDOWN_MAX_MS)
    : 0;
  setHealth({ consecutiveFailures, lastFailure: kind, cooldownUntil: cooling ? Date.now() + pause : 0 });
}

/** True while failures have put tab completion on pause. */
export function isFimCoolingDown(now = Date.now()): boolean {
  return health.cooldownUntil > now;
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
  const safePrefix = scrubWorkspaceText(prefix);
  const safeSuffix = scrubWorkspaceText(suffix);
  const key = fimCacheKey(context, safePrefix, safeSuffix);
  const hit = cache.get(key);
  if (hit) return hit;

  // A new provider / endpoint / model / key is a different endpoint as far as
  // this module is concerned, so it starts with a clean sheet: no inherited
  // pause and no inherited streak. The streak is about one host refusing.
  const identity = fimIdentity(context);
  if (identity !== streakIdentity) {
    streakIdentity = identity;
    clearFimHealth();
  }

  if (isFimCoolingDown()) return EMPTY;

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
          baseUrl: context.baseUrl || undefined,
          model: context.model,
          apiKey: context.apiKey,
          language: context.language,
          prefix: safePrefix,
          suffix: safeSuffix
        })
      });
      if (!response.ok) {
        // Deliberately NOT cached: one 401 must not poison these contexts for
        // the rest of the session.
        recordFailure('request-failed');
        return EMPTY;
      }
      const data = await response.json();
      // The route reports an upstream refusal as a 200 with a `warning`,
      // because a keystroke path must never throw at the editor. It is still a
      // refusal: counting it as a success is how a host that answers 404 to
      // every request kept getting one per keystroke — the streak reset, the
      // pause never armed, and the empty body cached as if the model had
      // genuinely had nothing to add.
      if (typeof data?.warning === 'string' && data.warning) {
        recordFailure('request-failed');
        return EMPTY;
      }
      const text = typeof data?.text === 'string' ? data.text : '';
      setHealth({ consecutiveFailures: 0, lastFailure: null, cooldownUntil: 0 });
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
