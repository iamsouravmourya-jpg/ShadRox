export type BehaviorEventType = 'click' | 'input' | 'route' | 'error';

export interface BehaviorEvent {
  id: string;
  type: BehaviorEventType;
  timestamp: number;
  target: string;
  path: string | null;
  line: number | null;
  value: string | null;
  message: string | null;
}

/**
 * What one acceptance run proved.
 *
 * `passed` is only ever derived from a verdict the preview harness returned;
 * nothing in this module accepts a caller-claimed pass. `unverified` is the
 * honest default and the answer whenever the preview was not running, the probe
 * could not evaluate, or it warned instead of proving — it is never rewritten
 * into `passed` later.
 */
export type AcceptanceResult = 'unverified' | 'failed' | 'passed';

/** The verdict DTO `electron/preview-assert.cjs` merges and hands over IPC. */
export interface PreviewVerdict {
  ok: boolean;
  status: 'ok' | 'warn' | 'fatal' | 'observed';
  detail: string | null;
  errorCount: number;
  failedSelectors?: string[];
  warningSelectors?: string[];
  consoleErrors?: string[];
  /** Which checks actually ran; empty means only the generic body fallback. */
  assertedSelectors?: string[];
}

/** Screenshot facts only: the pixels are hashed and dropped, never stored. */
export interface ScreenshotEvidence {
  capturedAt: number;
  bytes: number;
  sha256: string;
  /**
   * What the grab covered. `window` means the frame's box was not known, so
   * the image includes ShadRox's own chrome and is weaker evidence.
   */
  region: 'preview' | 'window';
}

/** The preview frame's box in window coordinates, measured when it painted. */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AcceptanceEvidence {
  ranAt: number;
  phase: 'baseline' | 'postPatch';
  status: PreviewVerdict['status'];
  detail: string | null;
  errorCount: number;
  failedSelectors: string[];
  warningSelectors: string[];
  consoleErrors: string[];
  /** The selectors the probe actually asserted, so the next run is the same check. */
  selectors: string[];
  screenshot: ScreenshotEvidence | null;
  /** Why no screenshot was kept, when that happened. */
  screenshotNote: string | null;
  /** The preview had reloaded before this run, so the DOM is the patched one. */
  afterReload: boolean;
  result: AcceptanceResult;
}

export interface AcceptancePhase {
  result: AcceptanceResult;
  evidence: AcceptanceEvidence | null;
}

export interface AcceptanceContract {
  id: string;
  createdAt: number;
  target: { path: string | null; line: number | null; label: string };
  observedFailure: string;
  expectedBehavior: string;
  steps: string[];
  /**
   * The state the interaction left behind, asserted rather than replayed: the
   * gesture itself is not re-driven, the DOM it produced is re-checked.
   */
  probe: { selectors: string[] };
  baseline: AcceptancePhase;
  postPatch: AcceptancePhase;
  events: BehaviorEvent[];
}
