/**
 * The statistics the calibrated router is allowed to use.
 *
 * Two failure modes are designed out here, because both were live in the first
 * version of this router:
 *
 * 1. Unverified turns counted as failures. A model that answered ten questions
 *    nobody graded scored a 0% pass rate next to one that happened to be
 *    verified once. Now a record with no check behind it is absent from both
 *    the numerator and the denominator — it is no data, not a loss.
 * 2. Small samples ranked. One lucky 1-for-1 run used to beat a model with a
 *    proven 80% over thirty runs. Estimates are shrunk toward the pool's own
 *    average, and a model below `MIN_VERIFIED_RUNS` is ranked after every model
 *    that has evidence, whatever its number says.
 */

/** Verified runs a model needs before it may lead the ranking. */
export const MIN_VERIFIED_RUNS = 5;
/** How many hypothetical pool-average runs each real run is worth against. */
export const PRIOR_WEIGHT = 3;
/** Used when the pool itself has no verified evidence to draw a prior from. */
export const NEUTRAL_PRIOR = 0.5;

export interface Sample {
  passes: number;
  runs: number;
}

/**
 * Additive (Bayes) shrinkage: `(passes + prior * weight) / (runs + weight)`.
 *
 * With many runs the estimate is the observed rate; with one run it is mostly
 * the prior, which is the whole point — a small sample is not allowed to be
 * confident.
 */
export function shrunkPassRate(passes: number, runs: number, prior: number, weight = PRIOR_WEIGHT): number | null {
  if (runs <= 0) return null;
  const clean = Math.max(0, Math.min(passes, runs));
  return (clean + prior * weight) / (runs + weight);
}

/** The pool average, or the neutral prior when nothing anywhere has been checked. */
export function poolPrior(samples: readonly Sample[]): number {
  const runs = samples.reduce((total, sample) => total + Math.max(0, sample.runs), 0);
  if (runs <= 0) return NEUTRAL_PRIOR;
  const passes = samples.reduce((total, sample) => total + Math.max(0, Math.min(sample.passes, sample.runs)), 0);
  return passes / runs;
}

export function isProven(runs: number, minimum = MIN_VERIFIED_RUNS): boolean {
  return runs >= minimum;
}

/** Plain observed rate, for display next to the shrunk one. */
export function observedPassRate(passes: number, runs: number): number | null {
  return runs > 0 ? Math.max(0, Math.min(passes, runs)) / runs : null;
}
