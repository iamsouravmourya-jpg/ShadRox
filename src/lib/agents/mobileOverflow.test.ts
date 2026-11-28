import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMobileOverflow, formatMobileOverflow } from './mobileOverflow';

test('evaluateMobileOverflow passes when content fits the viewport', () => {
  const r = evaluateMobileOverflow({ scrollWidth: 375, clientWidth: 375, offendingSelectors: ['body'] });
  assert.equal(r.ok, true);
  assert.equal(r.scrollWidth, 375);
  assert.equal(r.clientWidth, 375);
  assert.deepEqual(r.offendingSelectors, []);
});

test('evaluateMobileOverflow allows 1px sub-pixel tolerance', () => {
  assert.equal(evaluateMobileOverflow({ scrollWidth: 376, clientWidth: 375 }).ok, true);
  assert.equal(evaluateMobileOverflow({ scrollWidth: 377, clientWidth: 375 }).ok, false);
});

test('evaluateMobileOverflow fails on horizontal overflow and keeps offenders', () => {
  const r = evaluateMobileOverflow({ scrollWidth: 820, clientWidth: 375, offendingSelectors: ['div.hero', 'img#banner'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.offendingSelectors, ['div.hero', 'img#banner']);
});

test('evaluateMobileOverflow drops offenders on pass and caps the list', () => {
  const many = Array.from({ length: 20 }, (_, i) => `.el${i}`);
  const r = evaluateMobileOverflow({ scrollWidth: 900, clientWidth: 375, offendingSelectors: many });
  assert.equal(r.ok, false);
  assert.equal(r.offendingSelectors.length, 10);
});

test('evaluateMobileOverflow tolerates missing/!finite geometry', () => {
  assert.equal(evaluateMobileOverflow(null).ok, true);
  assert.equal(evaluateMobileOverflow({ scrollWidth: NaN, clientWidth: 0 }).ok, true);
  assert.equal(evaluateMobileOverflow({ scrollWidth: 500 }).ok, false);
});

test('formatMobileOverflow reports fit and overflow distinctly', () => {
  const ok = formatMobileOverflow(evaluateMobileOverflow({ scrollWidth: 360, clientWidth: 375 }));
  assert.match(ok, /Mobile layout OK/);
  assert.match(ok, /375px viewport/);
  const bad = formatMobileOverflow(evaluateMobileOverflow({ scrollWidth: 820, clientWidth: 375, offendingSelectors: ['div.hero'] }));
  assert.match(bad, /Mobile overflow/);
  assert.match(bad, /820px exceeds the 375px viewport/);
  assert.match(bad, /div\.hero/);
});