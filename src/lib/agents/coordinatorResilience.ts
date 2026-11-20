/**
 * Coordinator & Sub-Agent resilience helpers:
 * - Exponential backoff (`2s -> 4s -> 8s` with jitter) on HTTP 429 rate limits,
 *   quota/capacity spikes, and malformed JSON plan replies
 * - Deterministic auto-JSON repair fallback for fenced/partial coordinator outputs
 * - Rate-limit-aware sequential throttling for free-tier keys
 */

import { cleanJsonText, repairJsonValue } from '../agent/toolProtocol';

export const COORDINATOR_BACKOFF_BASE_MS = [2_000, 4_000, 8_000] as const;

export interface CoordinatorBackoffOptions<T> {
  /** Base delays in ms per retry; defaults to 2s -> 4s -> 8s. */
  delaysMs?: readonly number[];
  /** +/- jitter fraction (default 0.2 -> 80%..120%). */
  jitterFraction?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** Optional custom retry predicate; by default retries 429, transient network/server errors, and JSON/empty replies. */
  shouldRetryError?: (error: unknown) => boolean;
  /** Optional validator for resolved results (e.g. checking parsed coordinator JSON). Returning a reason retries! */
  validateResult?: (value: T) => string | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PERMANENT_AUTH_ERROR = /\b(401|403|invalid[_ ]api[_ ]key|unauthorized|permission[_ ]denied|billing)\b/i;
const RATE_LIMIT_OR_TRANSIENT =
  /\b(429|rate[_ -]?limit|too many requests|quota|resource[_ ]exhausted|overloaded|502|503|504|timeout|timed out|econnreset|network|fetch failed|empty|did not return|json)\b/i;

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isRateLimitError(error: unknown): boolean {
  const msg = extractErrorMessage(error);
  return /\b(429|rate[_ -]?limit|too many requests|quota|resource[_ ]exhausted)\b/i.test(msg);
}

export function isRetryableCoordinatorError(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
    return false;
  }
  const msg = extractErrorMessage(error);
  if (PERMANENT_AUTH_ERROR.test(msg)) return false;
  return RATE_LIMIT_OR_TRANSIENT.test(msg);
}

export function parseRetryAfterMs(error: unknown): number | null {
  const msg = extractErrorMessage(error);
  const secondsMatch = msg.match(/retry[- ]after[:\s]+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?/i)
    ?? msg.match(/try again in\s+(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)/i);
  if (secondsMatch) {
    const secs = Number.parseFloat(secondsMatch[1]);
    if (Number.isFinite(secs) && secs > 0) return Math.min(60_000, Math.round(secs * 1_000));
  }
  return null;
}

export function computeJitteredDelay(
  baseMs: number,
  jitterFraction = 0.2,
  rng: () => number = Math.random
): number {
  const clampedFraction = Math.max(0, Math.min(0.5, jitterFraction));
  const factor = 1 + (rng() * 2 - 1) * clampedFraction;
  return Math.max(0, Math.round(baseMs * factor));
}

/**
 * Executes an async coordinator or sub-agent call with exponential backoff
 * (`2s -> 4s -> 8s` + jitter) on rate limits / transient failures / invalid JSON.
 */
export async function withCoordinatorBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: CoordinatorBackoffOptions<T> = {}
): Promise<T> {
  const delays = options.delaysMs ?? COORDINATOR_BACKOFF_BASE_MS;
  const jitterFraction = options.jitterFraction ?? 0.2;
  const sleep = options.sleep ?? defaultSleep;
  const rng = options.rng ?? Math.random;
  const shouldRetryError = options.shouldRetryError ?? isRetryableCoordinatorError;
  const maxAttempts = delays.length + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    try {
      const value = await operation(attempt);
      if (options.validateResult) {
        const validationFailure = options.validateResult(value);
        if (validationFailure) {
          throw new Error(validationFailure);
        }
      }
      return value;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || options.signal?.aborted || !shouldRetryError(error)) {
        throw error;
      }
      const baseDelay = delays[attempt - 1];
      const jittered = computeJitteredDelay(baseDelay, jitterFraction, rng);
      const retryAfter = parseRetryAfterMs(error);
      const delayMs = retryAfter ? Math.max(jittered, retryAfter) : jittered;
      options.onRetry?.({
        attempt,
        delayMs,
        reason: extractErrorMessage(error)
      });
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(extractErrorMessage(lastError));
}

/**
 * Attempts to recover a parsed JSON value from malformed / fenced / wrapped
 * coordinator planner output before failing.
 */
export function repairCoordinatorPlanJson(raw: string): { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string } {
  const direct = repairJsonValue(raw);
  if (direct.ok) return direct;

  // Try stripping markdown code fences explicitly and locating the first array or wrapper object
  const stripped = cleanJsonText(raw);
  const arrayStart = stripped.indexOf('[');
  const arrayEnd = stripped.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    const slice = stripped.slice(arrayStart, arrayEnd + 1);
    const repairedSlice = repairJsonValue(slice);
    if (repairedSlice.ok) return { ok: true, value: repairedSlice.value, repaired: true };
  }

  // Handle truncated array missing closing bracket (e.g. cut off mid-tail or missing `]`)
  if (arrayStart !== -1 && arrayEnd <= arrayStart) {
    const partial = stripped.slice(arrayStart);
    const lastBrace = partial.lastIndexOf('}');
    if (lastBrace > 0) {
      const closed = `${partial.slice(0, lastBrace + 1)}]`;
      const repairedClosed = repairJsonValue(closed);
      if (repairedClosed.ok) return { ok: true, value: repairedClosed.value, repaired: true };
    }
  }

  const objStart = stripped.indexOf('{');
  const objEnd = stripped.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    const slice = stripped.slice(objStart, objEnd + 1);
    const repairedObj = repairJsonValue(slice);
    if (repairedObj.ok) return { ok: true, value: repairedObj.value, repaired: true };
  }

  return direct;
}

/** Sequential pacing delay between sub-agent turns on rate-limited / free-tier keys. */
export function rateLimitPacingDelayMs(input: {
  isFreeTier?: boolean;
  recentRateLimit?: boolean;
  provider?: string;
}): number {
  if (input.recentRateLimit) return 3_000;
  if (input.isFreeTier || input.provider === 'groq' || input.provider === 'gemini') return 1_200;
  return 0;
}
