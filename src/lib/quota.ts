import { getPlanMeta } from './plans';
import type { PlanTier } from './types';

export interface UsageState {
  count: number;
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

export function getUsageCount(): number {
  try {
    const key = getMonthKey();
    const val = localStorage.getItem(key);
    return val ? Math.max(0, parseInt(val, 10) || 0) : 0;
  } catch {
    return 0;
  }
}

export function getMonthlyUsage(plan: PlanTier): UsageState {
  const count = getUsageCount();
  const meta = getPlanMeta(plan);
  const limit = meta.monthlyCap;
  const isUnlimited = !Number.isFinite(limit);
  const remaining = isUnlimited ? Infinity : Math.max(0, limit - count);
  const percentage = isUnlimited ? 0 : Math.min(100, Math.round((count / limit) * 100));
  const isCapReached = !isUnlimited && count >= limit;

  return {
    count,
    limit,
    remaining,
    percentage,
    isCapReached,
    isUnlimited,
    monthKey: getMonthKey(),
    monthLabel: getMonthLabel()
  };
}

export function recordMessageSent(): number {
  try {
    const key = getMonthKey();
    const current = getUsageCount();
    const next = current + 1;
    localStorage.setItem(key, String(next));
    window.dispatchEvent(new CustomEvent(QUOTA_EVENT, { detail: next }));
    return next;
  } catch {
    return 0;
  }
}

export function resetMonthlyUsage(): void {
  try {
    const key = getMonthKey();
    localStorage.setItem(key, '0');
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
