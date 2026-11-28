import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestVibeTarget, hashContent, matchVibeComponents, resolveTargetLock, type TargetHint } from './targetLock';

test('hashContent is deterministic and changes with content', () => {
  assert.equal(hashContent('const a = 1;'), hashContent('const a = 1;'));
  assert.notEqual(hashContent('const a = 1;'), hashContent('const a = 2;'));
  assert.match(hashContent('x'), /^[0-9a-f]{8}$/);
});

test('a precise DOM hint locks with high confidence', () => {
  const result = resolveTargetLock({
    hints: [{ layer: 'dom', path: 'src/App.tsx', line: 12, contentHash: hashContent('app') }],
    currentHashes: { 'src/App.tsx': hashContent('app') }
  });
  assert.ok(result.best);
  assert.equal(result.best!.path, 'src/App.tsx');
  assert.ok(result.best!.confidence >= 0.9, 'a pinned DOM hint is ~0.95');
  assert.equal(result.best!.stale, false);
});

test('agreement across layers raises confidence', () => {
  const single = resolveTargetLock({ hints: [{ layer: 'symbol', path: 'src/a.ts', line: 3 }] });
  const agreed = resolveTargetLock({
    hints: [
      { layer: 'symbol', path: 'src/a.ts', line: 3 },
      { layer: 'dom', path: 'src/a.ts', line: 3 }
    ]
  });
  assert.ok(agreed.best!.confidence > single.best!.confidence, 'two layers beat one');
  assert.deepEqual(agreed.best!.agreedBy.sort(), ['dom', 'symbol']);
});

test('a vague style hint is weak and loses to a precise symbol hint', () => {
  const result = resolveTargetLock({
    hints: [
      { layer: 'style', path: 'src/styles.css', selector: '.btn' },
      { layer: 'symbol', path: 'src/Button.tsx', line: 8, symbol: 'Button' }
    ]
  });
  assert.equal(result.best!.path, 'src/Button.tsx');
  assert.ok(result.best!.confidence >= 0.9);
});

test('a stale candidate (file hash moved) is demoted below the threshold', () => {
  const result = resolveTargetLock({
    hints: [{ layer: 'dom', path: 'src/App.tsx', line: 12, contentHash: 'deadbeef' }],
    currentHashes: { 'src/App.tsx': hashContent('new content') }
  });
  assert.equal(result.best, null, 'a stale hint cannot be the lock');
  assert.equal(result.stale.length, 1);
  assert.equal(result.stale[0].stale, true);
  assert.ok(result.stale[0].confidence <= 0.3);
});

test('a hint with no current hash to compare against is not marked stale', () => {
  const result = resolveTargetLock({
    hints: [{ layer: 'symbol', path: 'src/a.ts', line: 3, contentHash: 'whatever' }]
    // no currentHashes entry: cannot prove staleness, so it is left fresh
  });
  assert.equal(result.best!.stale, false);
});

test('staleness matches the current-hash key case-insensitively (no fail-open)', () => {
  // The hint carries mixed case; currentHashes is keyed lowercased, as the rest
  // of the pipeline (normalizeContextPath) does. A moved file must still demote.
  const result = resolveTargetLock({
    hints: [{ layer: 'dom', path: 'SRC/App.Tsx', line: 12, contentHash: 'deadbeef' }],
    currentHashes: { 'src/app.tsx': hashContent('new content') }
  });
  assert.equal(result.best, null, 'case difference must not hide staleness');
  assert.equal(result.stale[0].stale, true);
});

test('best respects a custom threshold', () => {
  const hints: TargetHint[] = [{ layer: 'style', path: 'src/x.css', selector: '.a' }];
  // A vague style hint scores ~0.40 (0.55 base − 0.15 vague penalty).
  assert.equal(resolveTargetLock({ hints, threshold: 0.3 }).best!.path, 'src/x.css');
  assert.equal(resolveTargetLock({ hints, threshold: 0.5 }).best, null, 'a weak style hint is below 0.5');
});

test('expanded vibe words match top-level page/component nouns', () => {
  const files = ['src/Dashboard.tsx', 'src/Settings.tsx', 'src/Profile.tsx', 'src/Auth.tsx', 'src/Checkout.tsx', 'src/Billing.tsx', 'src/DataTable.tsx', 'src/RevenueChart.tsx'];
  for (const [query, expected] of [
    ['polish the dashboard', 'src/Dashboard.tsx'],
    ['open settings', 'src/Settings.tsx'],
    ['edit profile', 'src/Profile.tsx'],
    ['fix auth', 'src/Auth.tsx'],
    ['checkout flow', 'src/Checkout.tsx'],
    ['billing page', 'src/Billing.tsx'],
    ['the table looks off', 'src/DataTable.tsx'],
    ['the chart is flat', 'src/RevenueChart.tsx']
  ] as const) {
    assert.equal(bestVibeTarget(query, files)?.path, expected, query);
  }
});

test('vibe matching abstains on a tie and ignores non-vibe nouns', () => {
  // Two files share the top score -> ambiguous -> null (no blind lock).
  assert.equal(bestVibeTarget('update the modal', ['src/Modal.tsx', 'src/ModalRoot.tsx']), null);
  // A noun that is not a vibe word yields no candidate at all.
  assert.deepEqual(matchVibeComponents('refactor the database migration', ['src/schema.ts']), []);
  assert.equal(bestVibeTarget('refactor the database migration', ['src/schema.ts']), null);
});

test('matchVibeComponents singularizes UI plurals and inspects parent directory for generic App Router filenames', () => {
  assert.equal(bestVibeTarget('fix all the modals', ['src/components/Modal.tsx'])?.path, 'src/components/Modal.tsx');
  assert.equal(bestVibeTarget('redesign the pricing cards', ['src/components/PricingCard.tsx'])?.path, 'src/components/PricingCard.tsx');
  assert.equal(bestVibeTarget('billing page looks off', ['src/app/billing/page.tsx'])?.path, 'src/app/billing/page.tsx');
});