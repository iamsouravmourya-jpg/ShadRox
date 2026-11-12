/**
 * Behavior-to-code verification: the acceptance contract is checked, not voted.
 *
 * The preview already has a real harness — `electron/preview-assert.cjs` runs a
 * bounded structural probe inside the preview frame, folds in the console-error
 * buffer the window collected, and returns `ok | warn | fatal | observed`. This
 * module turns that verdict into contract evidence and is the only way a phase
 * can reach `passed`. The old flow let the user click "Post-patch passed", which
 * recorded a receipt for something nobody had run; the same click is now a
 * request to run the check.
 *
 * The ladder is the harness's own: `fatal` is a failure, `ok` is a pass, and
 * `warn`/`observed` are neither. A probe that could not evaluate, a preview that
 * is not running, and a check that ran before the reload landed are all
 * `unverified` — never quietly promoted to a pass.
 */

import type {
  AcceptanceContract,
  AcceptanceEvidence,
  AcceptanceResult,
  PreviewVerdict,
  ScreenshotEvidence
} from './types';

const MAX_EVIDENCE_SELECTORS = 8;
const MAX_EVIDENCE_ERRORS = 5;

function bounded(values: readonly string[] | undefined, limit: number): string[] {
  return (values ?? [])
    .filter((value) => typeof value === 'string' && value.length > 0)
    .slice(0, limit);
}

/**
 * `ok` means the harness derived mount selectors from the served source, found
 * every one of them visible, and saw no console error. Anything weaker — a
 * selector with a zero-size box (`warn`), a frame it could not evaluate
 * (`observed`) — proves nothing in either direction.
 */
export function resultOfVerdict(verdict: PreviewVerdict): AcceptanceResult {
  if (verdict.status === 'fatal' || verdict.errorCount > 0) return 'failed';
  if (verdict.status === 'ok' && verdict.ok) return 'passed';
  return 'unverified';
}

export interface EvidenceInput {
  phase: 'baseline' | 'postPatch';
  verdict: PreviewVerdict;
  /** Selectors the caller asked to pin, used only if the harness ran none. */
  requestedSelectors?: readonly string[];
  screenshot?: ScreenshotEvidence | null;
  screenshotNote?: string | null;
  /** False when the check ran against a DOM that had not reloaded since the patch. */
  afterReload: boolean;
  ranAt?: number;
}

export function evidenceFromVerdict(input: EvidenceInput): AcceptanceEvidence {
  const verdict = input.verdict;
  const evidence = {
    ranAt: input.ranAt ?? Date.now(),
    phase: input.phase,
    status: verdict.status,
    detail: typeof verdict.detail === 'string' ? verdict.detail.slice(0, 160) : null,
    errorCount: Math.max(0, Math.floor(verdict.errorCount) || 0),
    failedSelectors: bounded(verdict.failedSelectors, MAX_EVIDENCE_SELECTORS),
    warningSelectors: bounded(verdict.warningSelectors, MAX_EVIDENCE_SELECTORS),
    consoleErrors: bounded(verdict.consoleErrors, MAX_EVIDENCE_ERRORS),
    // What the harness says it evaluated, not what the caller hoped it would.
    selectors: bounded(
      verdict.assertedSelectors && verdict.assertedSelectors.length > 0
        ? verdict.assertedSelectors
        : input.requestedSelectors,
      MAX_EVIDENCE_SELECTORS
    ),
    screenshot: input.screenshot ?? null,
    screenshotNote: input.screenshotNote ?? null,
    afterReload: input.afterReload
  } satisfies Omit<AcceptanceEvidence, 'result'>;
  // A check that ran before the preview reloaded looked at the old page, so it
  // cannot be a receipt about the patched one whatever the probe said. The raw
  // status stays on the evidence for auditing; only `result` is demoted.
  const effective = evidence.afterReload ? verdict : { ...verdict, status: 'observed' as const };
  return { ...evidence, result: resultOfVerdict(effective) };
}

/**
 * Attach evidence to its phase and nothing else.
 *
 * The baseline run also fixes the probe list, so the post-patch run re-asserts
 * the same mount points instead of whatever the new HTML happens to declare.
 */
export function recordContractEvidence(
  contract: AcceptanceContract,
  evidence: AcceptanceEvidence
): AcceptanceContract {
  const phase = { result: evidence.result, evidence };
  const selectors = evidence.phase === 'baseline' && evidence.selectors.length > 0
    ? evidence.selectors
    : contract.probe.selectors;
  return {
    ...contract,
    probe: { selectors },
    baseline: evidence.phase === 'baseline' ? phase : contract.baseline,
    postPatch: evidence.phase === 'postPatch' ? phase : contract.postPatch
  };
}

export type AcceptanceOutcome = 'fixed' | 'still-broken' | 'regressed' | 'unverified';

/**
 * What the two receipts say together, for the turn that just applied a patch.
 *
 * `fixed` needs both: a baseline that proved the failure and a post-patch run
 * that proved it gone. Anything else is reported as unverified with the missing
 * half named, because "the patch probably worked" is not something the app
 * should be able to record as a pass.
 */
export function acceptanceOutcome(contract: AcceptanceContract): { state: AcceptanceOutcome; summary: string } {
  const { baseline, postPatch } = contract;
  if (baseline.result === 'failed' && postPatch.result === 'passed') return { state: 'fixed', summary: 'The recorded failure is gone after the patch.' };
  if (baseline.result === 'passed' && postPatch.result === 'failed') return { state: 'regressed', summary: 'The preview worked before the patch and fails after it.' };
  if (postPatch.result === 'failed') return { state: 'still-broken', summary: 'The preview still fails after the patch.' };
  if (!postPatch.evidence) return { state: 'unverified', summary: 'No post-patch check has run.' };
  if (!baseline.evidence) return { state: 'unverified', summary: 'The post-patch check proved nothing, and there is no baseline to compare with.' };
  if (baseline.result !== 'failed') {
    return {
      state: 'unverified',
      summary: `The baseline was ${baseline.result}, not a proven failure, so a passing post-patch check cannot be called a fix.`
    };
  }
  return { state: 'unverified', summary: `The post-patch check returned ${postPatch.result}, which proves neither a fix nor a break.` };
}

/** One line of receipt text for the panel, e.g. `fatal · 2 console errors · missing #root`. */
export function describeEvidence(evidence: AcceptanceEvidence | null): string {
  if (!evidence) return 'not run';
  const parts: string[] = [evidence.result];
  // `status` is what the harness returned, kept verbatim so a run can be
  // audited; when the paint was stale that is the whole story, so the raw
  // status is not shown next to it — `unverified · ok` reads like a pass.
  if (!evidence.afterReload) parts.push('checked the page from before the patch');
  else if (evidence.status === 'observed' && evidence.detail) parts.push(evidence.detail);
  else parts.push(evidence.status);
  if (evidence.errorCount > 0) parts.push(`${evidence.errorCount} console error${evidence.errorCount === 1 ? '' : 's'}`);
  if (evidence.failedSelectors.length > 0) parts.push(`missing ${evidence.failedSelectors.join(', ')}`);
  if (evidence.warningSelectors.length > 0) parts.push(`empty box ${evidence.warningSelectors.join(', ')}`);
  if (evidence.screenshot) {
    parts.push(`png ${Math.round(evidence.screenshot.bytes / 1024)} KB${evidence.screenshot.region === 'window' ? ' (whole window)' : ''}`);
  } else if (evidence.screenshotNote) parts.push(`no png: ${evidence.screenshotNote}`);
  return parts.join(' · ');
}
