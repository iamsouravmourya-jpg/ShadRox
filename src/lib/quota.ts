import { CREDIT_RATES, getPlanMeta, type CreditRate } from './plans';
import type { PlanTier } from './types';

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

export function getMonthlyUsage(plan: PlanTier): UsageState {
  const used = getUsageCredits();
  const limit = getPlanMeta(plan).creditsPerMonth;
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

/**
 * Free/BYOK has no meter — the user pays their own provider, so nothing is
 * counted and nothing can run out.
 */
export function recordCreditSpend(plan: PlanTier, rate: CreditRate): number {
  if (!Number.isFinite(getPlanMeta(plan).creditsPerMonth)) return 0;
  return addCreditSpend(CREDIT_RATES[rate]);
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
