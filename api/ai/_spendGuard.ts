import type { ApiRequest } from '../_http.js';

/**
 * A stateless abuse brake for the requests that spend ShadRox's shared key.
 *
 * WHAT IT PROTECTS: there is no account system yet, so the only thing standing
 * between an anonymous caller on the public Vercel deployment and the operator's
 * paid key is (a) the Pro-tier gate in `ai/_access.ts` and (b) the two ceilings
 * in this file — a per-IP request rate and a hard per-request output size.
 *
 * WHAT IT DOES NOT DO: it never throttles BYOK traffic. A caller who brings
 * their own key spends their own money, so `checkSharedKeySpend` is only called
 * on the shared-key branch and `outputCeiling` returns Infinity for BYOK.
 *
 * LIMITS OF THIS DESIGN (deliberate, not a bug):
 * - The bucket lives in process memory, so it is per warm container. Vercel
 *   scales out, and each new region/cold start resets the counters. It is a
 *   best-effort brake, not a quota. A real quota needs the session + store that
 *   phase 3 (Supabase) will bring.
 * - The client IP comes from `x-forwarded-for`, which a caller can forge when
 *   the route is NOT behind Vercel's proxy (local `npm run dev`). Behind Vercel
 *   the first hop is trustworthy; anywhere else it is only a soft signal.
 */

export type SpendScope = 'chat' | 'completion' | 'refine';

/** Requests per minute per IP, shared-key traffic only. */
export const SHARED_KEY_RATE_LIMITS: Record<SpendScope, { perMinute: number; burst: number }> = {
  // Longest, most expensive calls — a handful per minute is already a busy human.
  chat: { perMinute: 10, burst: 4 },
  // Tab completion / commit messages are short, high-frequency and already
  // output-capped, so they get a wider bucket.
  completion: { perMinute: 40, burst: 12 },
  refine: { perMinute: 12, burst: 5 }
};

/**
 * Hard ceiling on characters a shared-key request may produce. Bounds the cost
 * of one request even when the model rambles; BYOK requests are uncapped because
 * they cost ShadRox nothing.
 */
export const SHARED_KEY_OUTPUT_CHAR_CEILINGS: Record<SpendScope, number> = {
  chat: 24_000,
  completion: 600,
  refine: 4_000
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
/** Memory guard for a long-lived local server: drop the coldest buckets first. */
const MAX_BUCKETS = 5_000;
const REFILL_WINDOW_MS = 60_000;

function prune(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > REFILL_WINDOW_MS) buckets.delete(key);
  }
  // Still full of hot entries: evict in insertion order (oldest refilled first).
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (oldest.done) break;
    buckets.delete(oldest.value);
  }
}

/**
 * Best-effort caller identity. `x-forwarded-for` is set by Vercel's edge; a
 * direct socket peer is what the local dev server sees.
 */
export function clientIp(req: ApiRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = (first || '').split(',')[0].trim();
  return candidate || req.socket?.remoteAddress || 'unknown';
}

export type SpendDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Token bucket: `burst` immediate requests, then refills at `perMinute`.
 * Returns `allowed` without touching state for BYOK traffic.
 */
export function checkSharedKeySpend(scope: SpendScope, ip: string, byok: boolean): SpendDecision {
  if (byok) return { allowed: true };

  const { perMinute, burst } = SHARED_KEY_RATE_LIMITS[scope];
  const now = Date.now();
  const key = `${scope}|${ip}`;
  const bucket = buckets.get(key);
  const refillPerMs = perMinute / REFILL_WINDOW_MS;

  if (!bucket) {
    prune(now);
    buckets.set(key, { tokens: burst - 1, updatedAt: now });
    return { allowed: true };
  }

  const tokens = Math.min(burst, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
  if (tokens < 1) {
    bucket.tokens = tokens;
    bucket.updatedAt = now;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) };
  }

  bucket.tokens = tokens - 1;
  bucket.updatedAt = now;
  return { allowed: true };
}

export function rateLimitedMessage(retryAfterSeconds: number): string {
  return `ShadRox ki shared key par limit pahunch gayi (thoda load protect). ${retryAfterSeconds}s baad try karo, ya Settings → BYOK me apni key add karo — BYOK requests kabhi throttle nahi hoti.`;
}

/** Output ceiling for one request; BYOK traffic is never capped. */
export function outputCeiling(scope: SpendScope, byok: boolean): number {
  return byok ? Number.POSITIVE_INFINITY : SHARED_KEY_OUTPUT_CHAR_CEILINGS[scope];
}

export interface ChunkFit {
  /** The part of the chunk that still fits under the ceiling. */
  head: string;
  /** True once the ceiling has been reached — stop reading the model. */
  capped: boolean;
}

/**
 * Fits one streamed chunk under the ceiling. `sent` is what the client already
 * got (visible deltas and reasoning both bill, so both count here).
 */
export function fitChunk(sent: number, ceiling: number, text: string): ChunkFit {
  const room = ceiling - sent;
  if (text.length <= room) return { head: text, capped: false };
  return { head: room > 0 ? text.slice(0, room) : '', capped: true };
}

/** Test seam: the bucket map is module state, so tests must be able to reset it. */
export function resetSpendBuckets(): void {
  buckets.clear();
}
