import { CREDIT_RATES, getPlanMeta, type CreditRate } from './plans';
import { SHARED_KEY_ENABLED, type ResolvedPayer } from './sharedKeyPolicy';
import { getUseSharedKey } from './storage';
import type { PlanTier } from './types';

export interface SettlementOptions {
  payer?: ResolvedPayer;
  idempotencyKey?: string;
}

export interface UsageState {
  /** Credits spent this month. */
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
  isCapReached: boolean;
  isUnlimited: boolean;
  monthKey: string;
  monthLabel: string;
}

const QUOTA_EVENT = 'shadrox:quota-updated';

function getMonthKey(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `shadrox.usage.${year}-${month}`;
}

function getMonthLabel(): string {
  const d = new Date();
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function getUsageCredits(): number {
  try {
    const val = localStorage.getItem(getMonthKey());
    return val ? Math.max(0, parseFloat(val) || 0) : 0;
  } catch {
    return 0;
  }
}

/**
 * Credits meter only what the ShadRox proxy pays for. A turn carried by the
 * user's own BYOK key costs their provider directly, so it is neither counted
 * nor capped, whichever plan the app is filed under. The stored flag is the
 * same one `useByok` initializes its state from, so the two cannot disagree.
 */
export function isMeteredPlan(plan: PlanTier): boolean {
  if (!Number.isFinite(getPlanMeta(plan).creditsPerMonth)) return false;
  return SHARED_KEY_ENABLED && getUseSharedKey();
}

export function getMonthlyUsage(plan: PlanTier): UsageState {
  const metered = isMeteredPlan(plan);
  const used = metered ? getUsageCredits() : 0;
  const limit = metered ? getPlanMeta(plan).creditsPerMonth : Infinity;
  const isUnlimited = !Number.isFinite(limit);
  const remaining = isUnlimited ? Infinity : Math.max(0, limit - used);
  const percentage = isUnlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const isCapReached = !isUnlimited && used >= limit;

  return {
    used,
    limit,
    remaining,
    percentage,
    isCapReached,
    isUnlimited,
    monthKey: getMonthKey(),
    monthLabel: getMonthLabel()
  };
}

export function addCreditSpend(credits: number): number {
  try {
    const next = Math.round((getUsageCredits() + credits) * 100) / 100;
    localStorage.setItem(getMonthKey(), String(next));
    window.dispatchEvent(new CustomEvent(QUOTA_EVENT, { detail: next }));
    return next;
  } catch {
    return 0;
  }
}

const SETTLED_KEY = 'shadrox.quota.settled.v1';
const SETTLED_VERSION = 1;
const MAX_SETTLED_ENTRIES = 1000;

interface SettledEntry {
  credits: number;
  at: number;
}

interface SettledLog {
  version: number;
  entries: Record<string, SettledEntry>;
}

function readSettledLog(): SettledLog | null {
  try {
    const raw = localStorage.getItem(SETTLED_KEY);
    if (!raw) return { version: SETTLED_VERSION, entries: {} };
    const parsed = JSON.parse(raw) as Partial<SettledLog> | null;
    if (!parsed || parsed.version !== SETTLED_VERSION || !parsed.entries || typeof parsed.entries !== 'object') return null;
    const entries: Record<string, SettledEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      const entry = value as Partial<SettledEntry> | null;
      if (entry && Number.isFinite(entry.credits) && Number.isFinite(entry.at)) {
        entries[key] = { credits: entry.credits as number, at: entry.at as number };
      }
    }
    return { version: SETTLED_VERSION, entries };
  } catch {
    return null;
  }
}

function chargeOnce(amount: number, idempotencyKey?: string): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!idempotencyKey) return addCreditSpend(amount);
  const log = readSettledLog();
  if (!log) return 0;
  if (log.entries[idempotencyKey]) return 0;
  log.entries[idempotencyKey] = { credits: amount, at: Date.now() };
  const keys = Object.keys(log.entries);
  if (keys.length > MAX_SETTLED_ENTRIES) {
    keys.sort((a, b) => log.entries[a].at - log.entries[b].at);
    for (const key of keys.slice(0, keys.length - MAX_SETTLED_ENTRIES)) delete log.entries[key];
  }
  try {
    localStorage.setItem(SETTLED_KEY, JSON.stringify(log));
  } catch {
    return 0;
  }
  return addCreditSpend(amount);
}

function isMeteredFor(plan: PlanTier, payer?: ResolvedPayer): boolean {
  if (payer === 'byok') return false;
  if (payer === 'shared') return SHARED_KEY_ENABLED && Number.isFinite(getPlanMeta(plan).creditsPerMonth);
  return isMeteredPlan(plan);
}

/**
 * Free/BYOK has no meter — the user pays their own provider, so nothing is
 * counted and nothing can run out.
 */
export function recordCreditSpend(plan: PlanTier, rate: CreditRate, options: SettlementOptions = {}): number {
  if (!isMeteredFor(plan, options.payer)) return 0;
  return chargeOnce(CREDIT_RATES[rate], options.idempotencyKey);
}

/**
 * Charge a turn for what it actually used, instead of the fixed per-role price.
 *
 * A null credit figure means the provider reported no token split, and then the
 * old flat rate is the honest ceiling — the alternative is a free ride on the
 * operator's key. Never both: charging real and flat together would double-bill
 * every turn that reports usage.
 */
export function settleTurnCredits(plan: PlanTier, credits: number | null, fallback: CreditRate, options: SettlementOptions = {}): number {
  if (!isMeteredFor(plan, options.payer)) return 0;
  return chargeOnce(credits === null ? CREDIT_RATES[fallback] : credits, options.idempotencyKey);
}

export function resetMonthlyUsage(): void {
  try {
    localStorage.setItem(getMonthKey(), '0');
    window.dispatchEvent(new CustomEvent(QUOTA_EVENT, { detail: 0 }));
  } catch {
    /* ignore */
  }
}

export function onQuotaChange(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(QUOTA_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(QUOTA_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
