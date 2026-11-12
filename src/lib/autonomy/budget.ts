/**
 * Run budget: the numbers that stop an autonomous run before it costs anything.
 *
 * `estimateTurn` answers "what is the next turn likely to cost" so the loop can
 * refuse it while the cap is still intact, `createCreditTracker` is the only
 * thing that actually holds the running total, and `ceilingReached` is the one
 * tested rule for the non-monetary ceilings — turns, tool calls, wall clock —
 * that both drivers consult at the same boundaries.
 * Both are pure/in-memory: nothing here is a bill. ShadRox meters no account —
 * the running total only exists so a runaway autonomous loop stops before it
 * spends the user's own provider credit.
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

/** The ceilings that are not money. Spend has its own, older gate in the loop. */
export interface WorkCeilings {
  maxTurns: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

/** What the run has done so far, as the driver sees it. */
export interface WorkUsage {
  turns: number;
  /** Null until a host reports a real count — a guessed number must not trip a ceiling. */
  toolCalls: number | null;
  elapsedMs: number;
}

export interface CeilingStop {
  kind: 'turns' | 'tool-calls' | 'time';
  /** Written for the panel: names the ceiling and the number it stopped on. */
  message: string;
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}min`;
}

/**
 * The tool calls actually reported across these records, or null while none of
 * them carries a number. Guessing a count would stop a run on a figure nobody
 * measured, so an unreported run is bounded by its turn ceiling instead.
 */
export function toolCallsReported(records: ReadonlyArray<{ toolCalls?: number }>): number | null {
  const reported = records.filter((record) => typeof record.toolCalls === 'number');
  if (reported.length === 0) return null;
  return reported.reduce((sum, record) => sum + (record.toolCalls ?? 0), 0);
}

/**
 * What the run has already spent of its non-money ceilings, read off the
 * attempts it recorded rather than a counter the loop has to keep in sync.
 * That makes a resumed run honest: the attempts it made before the crash still
 * count against the ceiling.
 */
export function workUsageOf(attempts: ReadonlyArray<{ toolCalls?: number }>, elapsedMs: number): WorkUsage {
  return { turns: attempts.length, toolCalls: toolCallsReported(attempts), elapsedMs };
}

/**
 * The work ceiling the run has just reached, or null when it may start one more
 * turn. Checked at a boundary — before a turn is paid for — which is the only
 * point where stopping still costs nothing.
 *
 * A ceiling of zero, a negative number or `Infinity` means the caller did not
 * configure one: the loop must not stop on a number nobody chose.
 */
export function ceilingReached(ceilings: WorkCeilings, usage: WorkUsage): CeilingStop | null {
  if (ceilings.maxTurns > 0 && Number.isFinite(ceilings.maxTurns) && usage.turns >= ceilings.maxTurns) {
    return {
      kind: 'turns',
      message: `Stopped at the turn cap of ${ceilings.maxTurns} — the run has already made ${usage.turns} model turn(s), and more iterations are not what a cap is for.`
    };
  }
  if (
    usage.toolCalls !== null &&
    ceilings.maxToolCalls > 0 &&
    Number.isFinite(ceilings.maxToolCalls) &&
    usage.toolCalls >= ceilings.maxToolCalls
  ) {
    return {
      kind: 'tool-calls',
      message: `Stopped at the tool-call cap of ${ceilings.maxToolCalls} — the run has made ${usage.toolCalls} tool call(s).`
    };
  }
  if (
    ceilings.maxWallClockMs > 0 &&
    Number.isFinite(ceilings.maxWallClockMs) &&
    usage.elapsedMs >= ceilings.maxWallClockMs
  ) {
    return {
      kind: 'time',
      message: `Stopped after ${formatSeconds(usage.elapsedMs)} — the run's time limit is ${formatSeconds(ceilings.maxWallClockMs)}.`
    };
  }
  return null;
}
