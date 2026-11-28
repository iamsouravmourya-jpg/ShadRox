import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiagnosticLine } from '../autonomy/types';
import { evaluateVerificationGates, newErrorsVsBaseline, type CheckOutcome } from './verificationGates';

const diag = (path: string, line: number, message: string, severity = 'error'): DiagnosticLine => ({
  path,
  line,
  column: 1,
  message,
  severity
} as DiagnosticLine);

const allPass: Record<string, CheckOutcome> = {
  typecheck: { ran: true, ok: true },
  build: { ran: true, ok: true },
  test: { ran: true, ok: true },
  lint: { ran: true, ok: true },
  behavior: { ran: true, ok: true }
};

test('all checks ran and passed with a clean baseline ⇒ PASS', () => {
  const report = evaluateVerificationGates({
    baseline: [],
    post: [],
    checks: allPass
  });
  assert.equal(report.verdict, 'PASS');
  assert.ok(report.gates.every((gate) => gate.state === 'PASS'));
});

test('a skipped gate is reported SKIPPED_BY_POLICY, never PASS', () => {
  const report = evaluateVerificationGates({
    baseline: [],
    post: [],
    checks: allPass,
    policySkips: ['build']
  });
  const build = report.gates.find((gate) => gate.id === 'build')!;
  assert.equal(build.state, 'SKIPPED_BY_POLICY');
  // Everything else passed and the skip is policy, so overall can still be PASS —
  // but the skipped gate itself is never counted as a pass.
  assert.equal(report.verdict, 'PASS');
});

test('a check that did not run is NOT_RUN and blocks a PASS', () => {
  const checks = { ...allPass, test: { ran: false, ok: false } };
  const report = evaluateVerificationGates({ baseline: [], post: [], checks });
  assert.equal(report.gates.find((gate) => gate.id === 'test')!.state, 'NOT_RUN');
  assert.equal(report.verdict, 'NOT_RUN');
});

test('every gate skipped by policy is NOT_RUN, never a false PASS', () => {
  const policySkips = ['baseline', 'typecheck', 'build', 'test', 'lint', 'behavior', 'regression'] as const;
  const report = evaluateVerificationGates({ baseline: null, post: null, checks: {}, policySkips: [...policySkips] });
  assert.ok(report.gates.every((gate) => gate.state === 'SKIPPED_BY_POLICY'));
  assert.equal(report.verdict, 'NOT_RUN');
});

test('a failed check is FAIL and fails the whole pipeline', () => {
  const checks = { ...allPass, lint: { ran: true, ok: false, detail: '3 errors' } };
  const report = evaluateVerificationGates({ baseline: [], post: [], checks });
  assert.equal(report.gates.find((gate) => gate.id === 'lint')!.state, 'FAIL');
  assert.equal(report.verdict, 'FAIL');
});

test('regression is NOT_RUN without a baseline (unprovable is never a pass)', () => {
  const report = evaluateVerificationGates({ baseline: null, post: [], checks: allPass });
  assert.equal(report.gates.find((gate) => gate.id === 'regression')!.state, 'NOT_RUN');
  assert.equal(report.gates.find((gate) => gate.id === 'baseline')!.state, 'NOT_RUN');
  assert.equal(report.verdict, 'NOT_RUN');
});

test('newErrorsVsBaseline ignores pre-existing errors and scopes to touched files', () => {
  const baseline = [diag('src/a.ts', 3, 'old'), diag('src/b.ts', 9, 'legacy')];
  const post = [diag('src/a.ts', 3, 'old'), diag('src/a.ts', 5, 'new'), diag('src/c.ts', 1, 'elsewhere')];
  const fresh = newErrorsVsBaseline(baseline, post, ['src/a.ts']);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].message, 'new');
});

test('regression FAILs on a new error in a touched file, PASSes when clean', () => {
  const baseline = [diag('src/a.ts', 3, 'old')];
  const regressed = evaluateVerificationGates({
    baseline,
    post: [diag('src/a.ts', 3, 'old'), diag('src/a.ts', 7, 'broke it')],
    checks: allPass,
    touchedFiles: ['src/a.ts']
  });
  assert.equal(regressed.gates.find((gate) => gate.id === 'regression')!.state, 'FAIL');
  assert.equal(regressed.verdict, 'FAIL');

  const clean = evaluateVerificationGates({
    baseline,
    post: [diag('src/a.ts', 3, 'old')],
    checks: allPass,
    touchedFiles: ['src/a.ts']
  });
  assert.equal(clean.gates.find((gate) => gate.id === 'regression')!.state, 'PASS');
  assert.equal(clean.verdict, 'PASS');
});