/**
 * Structured Preview Assertions Engine (Phase 3B / T11)
 * Evaluates route integrity, selector presence, bounding boxes, and console errors
 * without requiring expensive vision models.
 */

export interface PreviewAssertionSpec {
  route: string;
  selector?: string;
  expectedText?: string;
  requireNonZeroBoundingBox?: boolean;
  failOnConsoleErrors?: boolean;
}

export interface PreviewAssertionResult {
  ok: boolean;
  route: string;
  checkedAt: number;
  selectorFound: boolean;
  textMatched: boolean;
  boundingBoxValid: boolean;
  consoleErrors: string[];
  failureReason?: string;
  durationMs: number;
}

export interface DomProbeTarget {
  url: string;
  querySelector(selector: string): {
    textContent?: string | null;
    getBoundingClientRect?(): { width: number; height: number };
  } | null;
  consoleErrors?: string[];
}

export function evaluatePreviewAssertion(
  probe: DomProbeTarget,
  spec: PreviewAssertionSpec,
  startedAt: number = Date.now()
): PreviewAssertionResult {
  const errors: string[] = probe.consoleErrors ? [...probe.consoleErrors] : [];
  let selectorFound = true;
  let textMatched = true;
  let boundingBoxValid = true;
  let failureReason: string | undefined;

  // Check 1: Route matching
  if (spec.route && !probe.url.includes(spec.route)) {
    failureReason = `Expected route ${spec.route} but preview is on ${probe.url}`;
    return {
      ok: false,
      route: probe.url,
      checkedAt: Date.now(),
      selectorFound: false,
      textMatched: false,
      boundingBoxValid: false,
      consoleErrors: errors,
      failureReason,
      durationMs: Date.now() - startedAt
    };
  }

  // Check 2: Selector existence
  if (spec.selector) {
    const el = probe.querySelector(spec.selector);
    if (!el) {
      selectorFound = false;
      failureReason = `Selector "${spec.selector}" not found in preview DOM`;
    } else {
      // Check 3: Text content match
      if (spec.expectedText) {
        const text = el.textContent || '';
        if (!text.includes(spec.expectedText)) {
          textMatched = false;
          failureReason = `Element "${spec.selector}" did not contain expected text "${spec.expectedText}"`;
        }
      }

      // Check 4: Non-zero bounding box
      if (spec.requireNonZeroBoundingBox && typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          boundingBoxValid = false;
          failureReason = `Element "${spec.selector}" has zero dimensions (${rect.width}x${rect.height})`;
        }
      }
    }
  }

  // Check 5: Console error presence
  if (spec.failOnConsoleErrors && errors.length > 0) {
    failureReason = `Fatal console error in preview: ${errors[0]}`;
  }

  const ok = selectorFound && textMatched && boundingBoxValid && (!spec.failOnConsoleErrors || errors.length === 0);

  return {
    ok,
    route: probe.url,
    checkedAt: Date.now(),
    selectorFound,
    textMatched,
    boundingBoxValid,
    consoleErrors: errors,
    failureReason,
    durationMs: Date.now() - startedAt
  };
}
