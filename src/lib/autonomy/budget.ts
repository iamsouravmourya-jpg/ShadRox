/**
 * Run budget: the two numbers that stop an autonomous run before it spends.
 *
 * `estimateTurn` answers "what is the next turn likely to cost" so the loop can
 * refuse it while the cap is still intact, and `createCreditTracker` is the only
 * thing that actually holds the running total. Both are pure/in-memory: nothing
 * here is a bill. ShadRox meters no account — the running total only exists so a
 * runaway autonomous loop stops before it spends the user's own provider credit.
 */

import type { CreditTracker } from './run-loop';
import { CREDIT_RATES } from '../plans';

/** One extra touched file adds half an edit. */
const EXTRA_FILE_COST = CREDIT_RATES.codeEdit / 2;
/** Extra files stop counting once the estimate would reach the premium ceiling. */
const EXTRA_FILE_CAP = Math.ceil((CREDIT_RATES.premiumRefactor - CREDIT_RATES.codeEdit) / EXTRA_FILE_COST);

/**
 * Estimate of one more turn for a unit of work. A single-file edit is the base
 * `codeEdit` rate; each additional expected file adds half of it, up to the
 * premium ceiling, so a milestone that names forty files cannot reserve the
 * whole run's budget before it has started. Only `expectedFiles` is read, so a
 * milestone and a team task are both accepted.
 */
export function estimateTurn(unit: { expectedFiles: string[] }): number {
  const extraFiles = Math.max(0, unit.expectedFiles.length - 1);
  const estimate = CREDIT_RATES.codeEdit + Math.min(extraFiles, EXTRA_FILE_CAP) * EXTRA_FILE_COST;
  return Math.min(estimate, CREDIT_RATES.premiumRefactor);
}

export interface CreditTrackerOptions {
  /** Hard ceiling for the run, in credits. */
  maxCredits: number;
  /** Credits already spent before this run (e.g. resumed from a persisted run). */
  startingSpend?: number;
}

/**
 * In-memory credit tracker for one run. `credit()` clamps negatives to zero and
 * rounds to the meter's 0.1 precision so the panel can never show a total the
 * persisted meter would round differently.
 */
export function createCreditTracker({ maxCredits, startingSpend = 0 }: CreditTrackerOptions): CreditTracker {
  let spent = Math.round(Math.max(0, startingSpend) * 10) / 10;
  return {
    credit(cost: number): { allowed: boolean; spent: number } {
      spent = Math.round((spent + Math.max(0, cost)) * 10) / 10;
      return { allowed: spent <= maxCredits, spent };
    },
    spent: () => spent,
    exhausted: () => spent >= maxCredits
  };
}
