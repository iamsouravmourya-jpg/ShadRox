import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptanceOutcome,
  describeEvidence,
  evidenceFromVerdict,
  recordContractEvidence,
  resultOfVerdict
} from './verification';
import { generateAcceptanceContract } from './contract';
import { createBehaviorEvent } from './recorder';
import type { AcceptanceContract, AcceptanceEvidence, PreviewVerdict } from './types';

function verdict(overrides: Partial<PreviewVerdict> = {}): PreviewVerdict {
  return { ok: true, status: 'ok', detail: null, errorCount: 0, ...overrides };
}

function evidenceFor(overrides: Partial<AcceptanceEvidence> = {}): AcceptanceEvidence {
  return {
    ranAt: 1,
    phase: 'baseline',
    status: 'ok',
    detail: null,
    errorCount: 0,
    failedSelectors: [],
    warningSelectors: [],
    consoleErrors: [],
    selectors: ['#root'],
    screenshot: null,
    screenshotNote: null,
    afterReload: true,
    result: 'passed',
    ...overrides
  };
}

function contract(baseline: AcceptanceEvidence | null, postPatch: AcceptanceEvidence | null): AcceptanceContract {
  const generated = generateAcceptanceContract([
    createBehaviorEvent('click', { target: '#save', path: 'src/App.tsx', line: 12 })
  ]);
  if (!generated) throw new Error('a contract should generate from a recorded click');
  let next = generated;
  if (baseline) next = recordContractEvidence(next, baseline);
  if (postPatch) next = recordContractEvidence(next, evidenceFor({ ...postPatch, phase: 'postPatch' }));
  return next;
}

test('a contract starts with both phases unverified and no evidence', () => {
  const generated = generateAcceptanceContract([
    createBehaviorEvent('error', { target: '#save', message: 'TypeError: cannot read x' })
  ]);
  assert.ok(generated);
  assert.deepEqual(generated.baseline, { result: 'unverified', evidence: null });
  assert.deepEqual(generated.postPatch, { result: 'unverified', evidence: null });
  assert.deepEqual(generated.probe.selectors, []);
  // The recorded error is a lead for the human, not a verdict on the app.
  assert.equal(generated.observedFailure, 'TypeError: cannot read x');
});

test('the harness ladder decides the result, and only the harness', () => {
  assert.equal(resultOfVerdict(verdict()), 'passed');
  assert.equal(resultOfVerdict(verdict({ status: 'fatal', ok: false })), 'failed');
  assert.equal(resultOfVerdict(verdict({ status: 'ok', ok: true, errorCount: 2, consoleErrors: ['boom'] })), 'failed');
  assert.equal(resultOfVerdict(verdict({ status: 'warn', ok: false })), 'unverified');
  assert.equal(resultOfVerdict(verdict({ status: 'observed', ok: false })), 'unverified');
});

test('an ok verdict whose probe did not evaluate cannot pass', () => {
  // Guards the one field main could get wrong: `ok` true with `observed`.
  const evidence = evidenceFromVerdict({
    phase: 'baseline',
    verdict: { ok: true, status: 'observed', detail: 'no-source-derived-assertion', errorCount: 0 },
    afterReload: true
  });
  assert.equal(evidence.result, 'unverified');
  assert.equal(evidence.status, 'observed');
});

test('a check that ran before the preview repainted cannot be a pass', () => {
  const evidence = evidenceFromVerdict({
    phase: 'postPatch',
    verdict: verdict(),
    requestedSelectors: ['#root'],
    afterReload: false
  });
  assert.equal(evidence.result, 'unverified');
  // The harness really did say ok — about the old page — so the receipt keeps
  // that status and says plainly why it does not count.
  assert.equal(evidence.status, 'ok');
  assert.equal(evidence.afterReload, false);
  assert.equal(describeEvidence(evidence), 'unverified · checked the page from before the patch');
});

test('evidence records what the harness asserted, not what was requested', () => {
  const evidence = evidenceFromVerdict({
    phase: 'baseline',
    // The caller asked for a stale probe; main reports the list it ran.
    verdict: verdict({ assertedSelectors: ['#app', '#nav'] }),
    requestedSelectors: ['#root'],
    afterReload: true
  });
  assert.deepEqual(evidence.selectors, ['#app', '#nav']);
});

test('oversized evidence lists are bounded before they reach the receipt', () => {
  const evidence = evidenceFromVerdict({
    phase: 'baseline',
    verdict: verdict({
      status: 'fatal',
      ok: false,
      errorCount: 9,
      consoleErrors: Array.from({ length: 20 }, (_, index) => `error ${index}`),
      failedSelectors: Array.from({ length: 20 }, (_, index) => `#missing${index}`),
      detail: 'x'.repeat(4000)
    }),
    afterReload: true
  });
  assert.equal(evidence.consoleErrors.length, 5);
  assert.equal(evidence.failedSelectors.length, 8);
  assert.equal(evidence.detail.length, 160);
  assert.equal(evidence.result, 'failed');
});

test('recording one phase leaves the other phase untouched', () => {
  const generated = generateAcceptanceContract([
    createBehaviorEvent('click', { target: '#save', path: 'src/App.tsx' })
  ]);
  if (!generated) throw new Error('contract should generate');
  const withBaseline = recordContractEvidence(generated, evidenceFor({ result: 'failed', status: 'fatal' }));
  assert.equal(withBaseline.baseline.result, 'failed');
  assert.equal(withBaseline.postPatch.result, 'unverified');
  assert.equal(withBaseline.postPatch.evidence, null);
  assert.equal(withBaseline.probe.selectors.length, 1);
  // The input contract is never mutated, because it may be in React state.
  assert.equal(generated.baseline.result, 'unverified');
});

test('the post-patch run re-asserts the baseline probe instead of a new one', () => {
  const generated = generateAcceptanceContract([createBehaviorEvent('click', { target: '#save' })]);
  if (!generated) throw new Error('contract should generate');
  const withBaseline = recordContractEvidence(generated, evidenceFor({ selectors: ['#root', '#nav'] }));
  const withPost = recordContractEvidence(withBaseline, evidenceFor({
    phase: 'postPatch',
    selectors: ['#root', '#nav']
  }));
  assert.deepEqual(withPost.probe.selectors, ['#root', '#nav']);
});

test('a fix needs a proven baseline failure and a proven post-patch pass', () => {
  assert.deepEqual(
    acceptanceOutcome(contract(evidenceFor({ result: 'failed', status: 'fatal' }), evidenceFor({ result: 'passed' }))),
    { state: 'fixed', summary: 'The recorded failure is gone after the patch.' }
  );
  // Both halves present, but the baseline never proved a break: not a fix.
  const soft = acceptanceOutcome(contract(evidenceFor({ result: 'unverified', status: 'observed' }), evidenceFor({ result: 'passed' })));
  assert.equal(soft.state, 'unverified');
  assert.match(soft.summary, /baseline was unverified/);
});

test('a regression is reported as a regression, not a fix', () => {
  const result = acceptanceOutcome(contract(evidenceFor({ result: 'passed' }), evidenceFor({ result: 'failed', status: 'fatal' })));
  assert.equal(result.state, 'regressed');
  assert.match(result.summary, /before the patch and fails after/);
});

test('no post-patch run is never summarised as still-broken', () => {
  const result = acceptanceOutcome(contract(evidenceFor({ result: 'failed', status: 'fatal' }), null));
  assert.equal(result.state, 'unverified');
  assert.equal(result.summary, 'No post-patch check has run.');
});

test('the receipt line names every limit it hit', () => {
  const line = describeEvidence(evidenceFor({
    result: 'failed',
    status: 'fatal',
    errorCount: 2,
    consoleErrors: ['TypeError: x'],
    failedSelectors: ['#root'],
    screenshot: { capturedAt: 5, bytes: 421_000, sha256: 'abc', region: 'preview' }
  }));
  assert.equal(line, 'failed · fatal · 2 console errors · missing #root · png 411 KB');
  assert.equal(describeEvidence(null), 'not run');
  assert.match(describeEvidence(evidenceFor({ screenshot: null, screenshotNote: 'user cancelled' })), /no png: user cancelled/);
});
