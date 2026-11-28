/**
 * Mobile overflow probe — pure evaluator + formatter.
 *
 * The main-process inspector (electron/preview-inspect.cjs) measures raw
 * geometry inside the preview frame and returns it; this module is the single
 * source of truth that turns that geometry into a pass/fail verdict and the
 * human string the agent reads. Keeping it pure (no DOM, no IPC) makes the
 * responsive check unit-testable and lets both the renderer tool handler and
 * the verify/finish gate agree on one definition of "fits".
 *
 * A layout fits when the document's scrollWidth does not exceed the viewport
 * width (1px tolerance for sub-pixel rounding). Offending elements are the
 * ones whose right edge crosses the viewport.
 */

export interface MobileOverflowInput {
  scrollWidth?: number;
  clientWidth?: number;
  offendingSelectors?: readonly string[];
}

export interface MobileOverflowResult {
  ok: boolean;
  scrollWidth: number;
  clientWidth: number;
  offendingSelectors: string[];
}

const TOLERANCE_PX = 1;
const MAX_OFFENDERS = 10;

function toFiniteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function evaluateMobileOverflow(input: MobileOverflowInput | null | undefined): MobileOverflowResult {
  const scrollWidth = Math.max(0, Math.round(toFiniteNumber(input?.scrollWidth)));
  const clientWidth = Math.max(0, Math.round(toFiniteNumber(input?.clientWidth)));
  const offenders = Array.isArray(input?.offendingSelectors)
    ? input!.offendingSelectors!.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, MAX_OFFENDERS)
    : [];
  const ok = scrollWidth <= clientWidth + TOLERANCE_PX;
  return { ok, scrollWidth, clientWidth, offendingSelectors: ok ? [] : offenders };
}

export function formatMobileOverflow(result: MobileOverflowResult): string {
  if (result.ok) {
    return `Mobile layout OK: content ${result.scrollWidth}px fits the ${result.clientWidth}px viewport (target 375x812). No horizontal overflow.`;
  }
  const offenders = result.offendingSelectors.length > 0
    ? ` Offending element(s): ${result.offendingSelectors.join(', ')}.`
    : ' No single offending element could be isolated.';
  return `Mobile overflow: content ${result.scrollWidth}px exceeds the ${result.clientWidth}px viewport.${offenders}`;
}