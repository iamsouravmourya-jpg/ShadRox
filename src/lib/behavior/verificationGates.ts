/**
 * Brutal Honesty Verification Pipeline — Gates 0–6.
 *
 * A turn may only claim "verified" when the checks actually ran and passed.
 * This module is the gate evaluator: it turns the evidence a turn collected
 * (a pre-task baseline, post-task diagnostics, and which checks ran) into a
 * per-gate verdict in a closed set — PASS / FAIL / NOT_RUN / SKIPPED_BY_POLICY
 * — and an overall verdict that can never promote a skipped or unrun check to a
 * pass.
 *
 * The honesty rules, in order:
 *   - a check the policy forbade is SKIPPED_BY_POLICY (reported, never a pass);
 *   - a check that did not run is NOT_RUN (never a pass);
 *   - a check that ran and failed is FAIL;
 *   - Gate 6 (regression) compares post-task errors against the pre-task
 *     baseline and fails on any NEW error in a touched file. With no baseline it
 *     is NOT_RUN — "no new errors" is unprovable without a before picture, and
 *     unprovable is never reported as proven.
 *
 * Overall: any FAIL ⇒ FAIL; else any NOT_RUN ⇒ NOT_RUN; else PASS. A
 * SKIPPED_BY_POLICY gate is reported as skipped and does not by itself block a
 * PASS, but it is never counted as a pass.
 */

import type { DiagnosticLine } from '../autonomy/types';

export type GateState = 'PASS' | 'FAIL' | 'NOT_RUN' | 'SKIPPED_BY_POLICY';
export type GateId = 'baseline' | 'typecheck' | 'build' | 'test' | 'lint' | 'behavior' | 'regression';
export type CheckId = Exclude<GateId, 'baseline' | 'regression'>;

export interface GateResult {
  id: GateId;
  label: string;
  state: GateState;
  detail: string;
}

export interface CheckOutcome {
  ran: boolean;
  ok: boolean;
  detail?: string;
}

export interface GateInput {
  /** Pre-task diagnostics, or null when no baseline was captured. */
  baseline: readonly DiagnosticLine[] | null;
  /** Post-task diagnostics, or null when none were collected. */
  post: readonly DiagnosticLine[] | null;
  /** Which runnable checks ran and whether they passed. */
  checks: Partial<Record<CheckId, CheckOutcome>>;
  /** Gates the policy forbade (e.g. a read-only turn may not run build). */
  policySkips?: readonly GateId[];
  /** Files the turn touched; regression is scoped to these when present. */
  touchedFiles?: readonly string[];
}

export interface GateReport {
  gates: GateResult[];
  verdict: 'PASS' | 'FAIL' | 'NOT_RUN';
}

const GATE_LABELS: Record<GateId, string> = {
  baseline: 'Gate 0 · pre-task baseline captured',
  typecheck: 'Gate 1 · typecheck',
  build: 'Gate 2 · build',
  test: 'Gate 3 · tests',
  lint: 'Gate 4 · lint',
  behavior: 'Gate 5 · behavior acceptance',
  regression: 'Gate 6 · no new errors vs baseline'
};

const CHECK_GATES: CheckId[] = ['typecheck', 'build', 'test', 'lint', 'behavior'];
const ALL_GATES: GateId[] = ['baseline', ...CHECK_GATES, 'regression'];

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function errorKey(diag: DiagnosticLine): string {
  return `${normalizePath(diag.path)}:${diag.line}:${diag.message.trim()}`;
}

function isError(diag: DiagnosticLine): boolean {
  return diag.severity === 'error';
}

/** New errors in `post` that were not present in `baseline`, scoped to touched files. */
export function newErrorsVsBaseline(
  baseline: readonly DiagnosticLine[],
  post: readonly DiagnosticLine[],
  touchedFiles?: readonly string[]
): DiagnosticLine[] {
  const seen = new Set(baseline.filter(isError).map(errorKey));
  const touched = touchedFiles && touchedFiles.length > 0
    ? new Set(touchedFiles.map(normalizePath))
    : null;
  const fresh: DiagnosticLine[] = [];
  for (const diag of post) {
    if (!isError(diag)) continue;
    const key = errorKey(diag);
    if (seen.has(key)) continue;
    if (touched && !touched.has(normalizePath(diag.path))) continue;
    fresh.push(diag);
  }
  return fresh;
}

export function evaluateVerificationGates(input: GateInput): GateReport {
  const skips = new Set(input.policySkips ?? []);
  const gates: GateResult[] = [];

  for (const id of ALL_GATES) {
    if (skips.has(id)) {
      gates.push({ id, label: GATE_LABELS[id], state: 'SKIPPED_BY_POLICY', detail: 'forbidden by the turn policy' });
      continue;
    }

    if (id === 'baseline') {
      const count = input.baseline?.length ?? 0;
      gates.push({
        id,
        label: GATE_LABELS[id],
        state: input.baseline === null ? 'NOT_RUN' : 'PASS',
        detail: input.baseline === null ? 'no baseline was captured' : `${count} diagnostic(s) recorded`
      });
      continue;
    }

    if (id === 'regression') {
      if (input.baseline === null || input.post === null) {
        gates.push({ id, label: GATE_LABELS[id], state: 'NOT_RUN', detail: 'a baseline and post diagnostics are both required to prove no regression' });
        continue;
      }
      const fresh = newErrorsVsBaseline(input.baseline, input.post, input.touchedFiles);
      gates.push({
        id,
        label: GATE_LABELS[id],
        state: fresh.length === 0 ? 'PASS' : 'FAIL',
        detail: fresh.length === 0 ? 'no new errors versus baseline' : `${fresh.length} new error(s) versus baseline`
      });
      continue;
    }

    const check = input.checks[id];
    if (!check || !check.ran) {
      gates.push({ id, label: GATE_LABELS[id], state: 'NOT_RUN', detail: 'the check did not run' });
      continue;
    }
    gates.push({
      id,
      label: GATE_LABELS[id],
      state: check.ok ? 'PASS' : 'FAIL',
      detail: check.detail ?? (check.ok ? 'passed' : 'failed')
    });
  }

  // A SKIPPED_BY_POLICY gate is never counted as a pass, so a report with no
  // PASS at all (everything skipped) is NOT_RUN — unproven, not proven.
  const verdict = gates.some((gate) => gate.state === 'FAIL')
    ? 'FAIL'
    : gates.some((gate) => gate.state === 'NOT_RUN')
      ? 'NOT_RUN'
      : gates.some((gate) => gate.state === 'PASS')
        ? 'PASS'
        : 'NOT_RUN';

  return { gates, verdict };
}