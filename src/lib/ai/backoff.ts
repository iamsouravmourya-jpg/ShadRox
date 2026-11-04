/**
 * Retry pacing for the AI request path, ported from aider's retry loops:
 *
 *   - aider/models.py `simple_send_with_retries` (retry_delay = 0.125,
 *     `retry_delay *= 2`, bail when the delay exceeds RETRY_TIMEOUT = 60)
 *   - aider/coders/base_coder.py `send_messages` (the same doubling around the
 *     streaming send, plus the "Retrying in X seconds..." notice)
 *   - aider/models.py `RETRY_TIMEOUT = 60`
 *
 * Copyright (c) Aider LLC, https://aider.chat, used under the Apache License,
 * Version 2.0: https://github.com/Aider-AI/aider/blob/main/LICENSE
 *
 * Aider discipline kept 1:1: double the delay from 125 ms on every retry, and
 * a 60 s ceiling past which aider stops retrying outright.
 *
 * ShadRox adaptations (NOT in aider, deliberate):
 *   - equal jitter on the exponential delay, so a room full of ShadRox clients
 *     reconnecting after a Groq incident do not stampede in lockstep;
 *   - a max-elapsed deadline for the whole retry sequence (a chat turn must not
 *     outlive the user's patience; aider's 60 s cap bounds the *delay*, this
 *     bounds the *turn*);
 *   - a hard retry count, because each attempt re-spends a BYOK request;
 *   - honouring Retry-After: the wait is never shorter than the number the
 *     provider itself asked for.
 */

export interface RetrySettings {
  /** Aider's first `retry_delay *= 2` result is 0.25 s; the seed is 0.125 s. */
  initialDelayMs: number;
  /** Aider: `retry_delay *= 2`. */
  backoffFactor: number;
  /** Aider's RETRY_TIMEOUT = 60 (seconds). */
  maxDelayMs: number;
  /** ADAPTATION: cap on whole attempts (first try included). */
  maxAttempts: number;
  /** ADAPTATION: wall-clock budget for the failed attempt + all sleeps. */
  maxElapsedMs: number;
  /** ADAPTATION: no bytes for this long ends the attempt as a Timeout. 0 disables. */
  idleTimeoutMs: number;
}

export const AIDER_INITIAL_RETRY_DELAY_MS = 125;
export const AIDER_RETRY_TIMEOUT_MS = 60_000;

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  initialDelayMs: AIDER_INITIAL_RETRY_DELAY_MS,
  backoffFactor: 2,
  maxDelayMs: AIDER_RETRY_TIMEOUT_MS,
  maxAttempts: 4,
  maxElapsedMs: 30_000,
  idleTimeoutMs: 90_000
};

/** Injectable timing seams: production uses the defaults, tests use fakes. */
export interface RetryClockDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  rng: () => number;
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
}

export const REAL_RETRY_DEPS: RetryClockDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  rng: () => Math.random(),
  setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimer: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>)
};

export type ExhaustedReason = 'max-delay' | 'attempts' | 'deadline';

export type RetryPlan =
  | { kind: 'retry'; delayMs: number; nextDelayMs: number }
  | { kind: 'exhausted'; reason: ExhaustedReason };

export interface RetryPlanInput {
  /** The un-jittered delay carried between attempts (aider's `retry_delay`). */
  previousDelayMs: number;
  /** 1-based count of the attempt that just failed. */
  failedAttempt: number;
  /** Milliseconds since the first attempt started. */
  elapsedMs: number;
  /** Parsed `Retry-After` header of the failed response, when present. */
  retryAfterSeconds?: number | null;
  settings: RetrySettings;
  rng?: () => number;
}

/**
 * One tick of aider's backoff loop, ported:
 *
 * ```python
 * retry_delay *= 2
 * if retry_delay > RETRY_TIMEOUT:
 *     should_retry = False
 * ```
 *
 * plus the adaptations listed in the header. Returns the delay to sleep before
 * the next attempt, or the reason retries are exhausted. The jittered value is
 * what we sleep; the *un*-jittered doubling is what carries forward, exactly
 * like aider's `retry_delay`.
 */
export function planRetry(input: RetryPlanInput): RetryPlan {
  const { settings } = input;
  const rng = input.rng ?? Math.random;

  if (input.failedAttempt >= settings.maxAttempts) {
    return { kind: 'exhausted', reason: 'attempts' };
  }

  // aider: retry_delay *= 2; if retry_delay > RETRY_TIMEOUT: should_retry = False
  const doubled = input.previousDelayMs * settings.backoffFactor;
  if (doubled > settings.maxDelayMs) {
    return { kind: 'exhausted', reason: 'max-delay' };
  }

  // ADAPTATION: equal jitter — half the delay fixed, half random. rng() is
  // injectable so tests can prove jitter is applied without randomness.
  const jittered = Math.round(doubled / 2 + rng() * (doubled / 2));

  // ADAPTATION: never sleep less than an explicit Retry-After asked for.
  const forced =
    input.retryAfterSeconds != null && input.retryAfterSeconds > 0
      ? input.retryAfterSeconds * 1000
      : 0;
  const delayMs = Math.max(jittered, forced);

  // ADAPTATION: the whole retry sequence, not just this sleep, fits the budget.
  if (input.elapsedMs + delayMs > settings.maxElapsedMs) {
    return { kind: 'exhausted', reason: 'deadline' };
  }

  return { kind: 'retry', delayMs, nextDelayMs: doubled };
}

/**
 * The aider notice, ported: `print(f"Retrying in {retry_delay:.1f} seconds...")`
 * from models.py/base_coder.py, with the ExInfo description aider prints next
 * to it (io.tool_warning(err_msg) + io.tool_error(ex_info.description)).
 */
export function aiderRetryMessage(
  description: string | null,
  delayMs: number,
  attempt: number,
  maxAttempts: number
): string {
  const seconds = (delayMs / 1000).toFixed(1);
  const reason = description ? `${description} ` : '';
  return `${reason}Retrying in ${seconds} seconds... (attempt ${attempt + 1} of ${maxAttempts})`;
}
