/**
 * The outcome-calibrated ranking.
 *
 * Three rules hold this together, and each one exists because the first
 * version of this file broke without it:
 *
 * 1. Only verified turns are counted. A run nobody checked is absent from both
 *    the numerator and the denominator — no data, not a loss.
 * 2. A pass rate is shrunk toward the pool average, and a model with fewer
 *    than `MIN_VERIFIED_RUNS` verified runs sits behind every model that has
 *    them, even if its one lucky run scored 100%.
 * 3. The user's pin outranks the measurement. ShadRox may recommend; the key
 *    belongs to the user.
 *
 * The output is an ordering plus a sentence per model, because a router that
 * cannot say why it picked a model is a router the user has to trust blind.
 */

import { listOutcomes, routeProfiles } from './ledger';
import { preferredModel } from './preferences';
import { isProven, MIN_VERIFIED_RUNS, observedPassRate, poolPrior, shrunkPassRate } from './statistics';
import type { CalibratedRoute, CalibratedTaskType, ModelPerformance, OutcomeRecord, RouteProfile } from './types';

export interface CalibratedRouteChoice {
  route: CalibratedRoute;
  reason: string;
  profile: RouteProfile;
}

/** A ranked model with the arithmetic behind its position. */
export interface RankedModel extends ModelPerformance {
  rank: number;
  pinned: boolean;
  proven: boolean;
}

export interface RankInput {
  taskType: CalibratedTaskType;
  models: readonly string[];
  /** Injected in tests; defaults to the local ledger. */
  outcomes?: readonly OutcomeRecord[];
  /** Injected in tests; defaults to the stored pin for this task type. */
  pinned?: string | null;
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function tally(records: readonly OutcomeRecord[], model: string) {
  const entries = records.filter((record) => record.model === model);
  const verified = entries.filter((record) => record.verified);
  return {
    attempts: entries.length,
    verifiedAttempts: verified.length,
    provenPasses: verified.filter((record) => record.passed).length,
    averageRepairs: entries.length ? entries.reduce((sum, record) => sum + record.repairIterations, 0) / entries.length : 0
  };
}

/**
 * Rank by record, pin first.
 *
 * Models with no history at all are kept in their given order at the back, so
 * the caller can still fall through to price — dropping a model from the list
 * would remove a choice the user is entitled to make.
 */
export function rankModels(input: RankInput): RankedModel[] {
  const taskType = input.taskType;
  const models = [...new Set((input.models ?? []).filter((model) => typeof model === 'string' && model.length > 0))];
  const records = input.outcomes ?? listOutcomes();
  const scoped = records.filter((record) => record.taskType === taskType);
  const pin = input.pinned === undefined ? preferredModel(taskType) : input.pinned;

  const samples = models.map((model) => {
    const counts = tally(scoped, model);
    return { passes: counts.provenPasses, runs: counts.verifiedAttempts };
  });
  const prior = poolPrior(samples);

  const ranked = models.map((model, index) => {
    const counts = tally(scoped, model);
    const passRate = shrunkPassRate(counts.provenPasses, counts.verifiedAttempts, prior);
    const proven = isProven(counts.verifiedAttempts);
    const pinned = pin !== null && model === pin;
    const measured = `${counts.provenPasses}/${counts.verifiedAttempts} verified runs passed (${percent(observedPassRate(counts.provenPasses, counts.verifiedAttempts))}), shrunk to ${percent(passRate)} against the pool's ${percent(prior)}`;
    const reason = pinned
      ? `pinned by you for ${taskType} turns — your choice outranks the record (${counts.verifiedAttempts} verified run(s))`
      : counts.verifiedAttempts === 0
        ? 'no verified run yet, so price decides — this model has nothing to be ranked on'
        : proven
          ? measured
          : `${measured} — under the ${MIN_VERIFIED_RUNS} checked runs needed to lead the ranking`;
    return {
      model,
      taskType,
      verifiedAttempts: counts.verifiedAttempts,
      provenPasses: counts.provenPasses,
      passRate,
      averageRepairs: counts.averageRepairs,
      reason,
      pinned,
      proven,
      index
    };
  });

  ranked.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.proven !== b.proven) return a.proven ? -1 : 1;
    const rateA = a.passRate ?? -1;
    const rateB = b.passRate ?? -1;
    if (rateA !== rateB) return rateB - rateA;
    if (a.averageRepairs !== b.averageRepairs) return a.averageRepairs - b.averageRepairs;
    // Two models the ledger can speak for are ordered by name, so the ranking
    // does not depend on how the key happened to list them. Two it cannot
    // speak for keep the caller's order — that order is the price order, and
    // alphabetising them would hand the route to whichever name comes first.
    if (a.verifiedAttempts > 0 || b.verifiedAttempts > 0) {
      if (a.model !== b.model) return a.model.localeCompare(b.model);
    }
    return a.index - b.index;
  });

  return ranked.map((entry, rank) => ({
    model: entry.model,
    taskType: entry.taskType,
    verifiedAttempts: entry.verifiedAttempts,
    provenPasses: entry.provenPasses,
    passRate: entry.passRate,
    averageRepairs: entry.averageRepairs,
    reason: entry.reason,
    pinned: entry.pinned,
    proven: entry.proven,
    rank
  }));
}

/** The ordering `routeRequest` takes as its preference list. */
export function rankModelsByOutcome(taskType: CalibratedTaskType, models: readonly string[]): string[] {
  return rankModels({ taskType, models }).map((entry) => entry.model);
}

/** Why this model, in one sentence the answer header can show. */
export function explainModelChoice(input: RankInput, chosen: string): string {
  if (!chosen) return 'no model was chosen, so there is nothing to explain';
  const ranked = rankModels(input);
  const entry = ranked.find((candidate) => candidate.model === chosen);
  if (!entry) return `${chosen} is not among the models offered for this turn`;
  return `${chosen}: ${entry.reason}`;
}

/**
 * Which route a task type should take.
 *
 * A route with no verified evidence has no score, so it cannot win: the
 * default stands until measurement says otherwise, rather than an unproven
 * route beating a proven one on a tie of zeros.
 */
export function chooseCalibratedRoute(
  taskType: CalibratedTaskType,
  candidates: readonly CalibratedRoute[] = ['reader', 'writer', 'frontier']
): CalibratedRouteChoice {
  const all = routeProfiles(taskType);
  const defaultProfile = all[1] ?? { route: 'writer' as CalibratedRoute };
  const usable = all.filter((profile) => candidates.includes(profile.route) && profile.score !== null);
  const winner = [...usable].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.route.localeCompare(b.route))[0];

  if (!winner) {
    const unproven = all.filter((profile) => candidates.includes(profile.route));
    const fallback = unproven.find((profile) => profile.route === defaultProfile.route) ?? unproven[0];
    return {
      route: fallback.route,
      profile: fallback,
      reason: `no ${taskType} run has been verified on ${fallback.route} yet — ${fallback.attempts} turn(s) logged, ${fallback.unverifiedAttempts} unchecked — so the default stands`
    };
  }
  return {
    route: winner.route,
    profile: winner,
    reason: `${winner.verifiedAttempts} verified ${taskType} run(s) at ${percent(winner.passRate)} after shrinking, ${winner.averageRepairs.toFixed(1)} average repairs`
  };
}
