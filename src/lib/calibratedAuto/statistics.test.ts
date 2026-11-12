import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isProven,
  MIN_VERIFIED_RUNS,
  NEUTRAL_PRIOR,
  observedPassRate,
  poolPrior,
  PRIOR_WEIGHT,
  shrunkPassRate
} from './statistics';

describe('shrunkPassRate', () => {
  it('says nothing when nothing ran', () => {
    assert.equal(shrunkPassRate(0, 0, 0.5), null);
    assert.equal(shrunkPassRate(3, -1, 0.5), null);
  });

  it('will not let one lucky run be confident', () => {
    const lucky = shrunkPassRate(1, 1, 0.5);
    assert.ok(lucky !== null);
    // (1 + 0.5*3) / (1 + 3) = 0.625 — pulled hard toward the pool, not 100%.
    assert.equal(lucky, 0.625);
    assert.ok(lucky < 0.7, 'a single pass must not clear the pool average by much');
  });

  it('converges on the observed rate as the sample grows', () => {
    const proven = shrunkPassRate(80, 100, 0.5);
    assert.ok(proven !== null);
    assert.ok(Math.abs(proven - 0.8) < 0.01, `expected ~0.8, got ${proven}`);
  });

  it('treats a perfect record and an empty one as the same opinion', () => {
    // One pass in one run and zero passes in one run both land near the prior:
    // the difference between them is one coin flip, not a measurement.
    assert.equal(shrunkPassRate(1, 1, 0.5), 0.625);
    assert.equal(shrunkPassRate(0, 1, 0.5), 0.375);
  });

  it('clamps a record that claims more passes than runs', () => {
    assert.equal(shrunkPassRate(9, 3, 0.5), shrunkPassRate(3, 3, 0.5));
  });

  it('honours a caller-supplied weight', () => {
    assert.equal(shrunkPassRate(1, 1, 0.5, 0), 1);
  });
});

describe('poolPrior', () => {
  it('falls back to the neutral prior when nothing anywhere has been checked', () => {
    assert.equal(poolPrior([]), NEUTRAL_PRIOR);
    assert.equal(poolPrior([{ passes: 0, runs: 0 }, { passes: 0, runs: 0 }]), NEUTRAL_PRIOR);
  });

  it('weights by runs, not by averaging the model opinions', () => {
    const prior = poolPrior([{ passes: 9, runs: 10 }, { passes: 0, runs: 1 }]);
    assert.equal(prior, 9 / 11);
  });

  it('ignores a malformed sample that reports negative runs', () => {
    assert.equal(poolPrior([{ passes: 2, runs: -5 }, { passes: 1, runs: 2 }]), 0.5);
  });
});

describe('isProven', () => {
  it('needs the full minimum, not one short of it', () => {
    assert.equal(isProven(MIN_VERIFIED_RUNS - 1), false);
    assert.equal(isProven(MIN_VERIFIED_RUNS), true);
    assert.equal(isProven(0), false);
  });
});

describe('observedPassRate', () => {
  it('is the plain number, shown next to the shrunk one', () => {
    assert.equal(observedPassRate(3, 4), 0.75);
    assert.equal(observedPassRate(0, 0), null);
  });
});

describe('the constants the panel quotes', () => {
  it('keep shrinkage strong enough to matter at the minimum sample', () => {
    // At exactly MIN_VERIFIED_RUNS a perfect record is quoted as (5+1.5)/8 =
    // 81.25%, not 100%: the threshold to lead the ranking still costs real
    // evidence, so five lucky runs cannot outrank thirty honest ones.
    assert.equal(shrunkPassRate(MIN_VERIFIED_RUNS, MIN_VERIFIED_RUNS, NEUTRAL_PRIOR), 0.8125);
    assert.equal(
      shrunkPassRate(MIN_VERIFIED_RUNS, MIN_VERIFIED_RUNS, NEUTRAL_PRIOR),
      (MIN_VERIFIED_RUNS + NEUTRAL_PRIOR * PRIOR_WEIGHT) / (MIN_VERIFIED_RUNS + PRIOR_WEIGHT)
    );
  });
});
