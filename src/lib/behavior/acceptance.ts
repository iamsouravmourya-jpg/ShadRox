/**
 * Runs one acceptance check against the live preview and turns the harness
 * verdict into contract evidence.
 *
 * This is the only path that can mark a phase `passed`, and it never takes a
 * result from the caller: the verdict comes from `preview:assert`, which main
 * process derives by executing the bounded probe inside the preview frame.
 *
 * Two rules here are about honesty rather than features:
 *
 * 1. The check is not run until the frame has repainted. `preview:assert`
 *    DRAINS the console-error buffer, so asserting a stale document would
 *    consume the errors that belong to the patched one and make the next run
 *    look clean. A preview that never repaints yields no evidence at all.
 * 2. Screenshot pixels are reduced to a byte count and a digest. The data URL
 *    is dropped when this function returns, so no page image is ever written
 *    into localStorage or sent anywhere.
 */

import { sha256Hex } from '../proof/ledger';
import { describeEvidence, evidenceFromVerdict } from './verification';
import type { AcceptanceEvidence, PreviewRect, PreviewVerdict, ScreenshotEvidence } from './types';

/** How long to wait for the preview to paint a document newer than the patch. */
export const PAINT_TIMEOUT_MS = 6000;
/** Matches the renderer's own settle delay before a preview probe. */
export const PAINT_SETTLE_MS = 600;
/** A screenshot is evidence of a frame, not an archive; anything huge is a bug. */
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/**
 * The `error?: undefined` arms are not decoration: without them this union does
 * not narrow under the repo's `strictNullChecks: false` setting.
 */
export type ScreenshotCapture =
  | { ok: true; dataUrl: string; error?: undefined }
  | { ok: false; error: string; dataUrl?: undefined };

export interface AcceptanceBridge {
  assertPreview: (workspaceId: string, options?: { selectors?: readonly string[] }) => Promise<PreviewVerdict>;
  capturePreviewPage?: (rect?: PreviewRect) => Promise<ScreenshotCapture>;
}

export interface AcceptanceRunInput {
  bridge: AcceptanceBridge | null;
  workspaceId: string | null;
  phase: 'baseline' | 'postPatch';
  /** Selectors pinned by the baseline run, so this one is the same check. */
  probeSelectors?: readonly string[];
  previewReady: boolean;
  /** Resolves true once the preview has painted a document newer than the patch. */
  waitForPaint: (timeoutMs: number) => Promise<boolean>;
  settle?: (ms: number) => Promise<void>;
  captureScreenshot?: boolean;
  /** The preview frame's box, so the grab is the app and not the whole window. */
  captureRect?: PreviewRect | null;
  digest?: (bytes: Uint8Array) => Promise<string>;
  paintTimeoutMs?: number;
}

export interface AcceptanceRun {
  /** Null whenever nothing was proven — the phase keeps its previous state. */
  evidence: AcceptanceEvidence | null;
  /** One line for the panel/toast; never claims a result the evidence lacks. */
  message: string;
}

function base64Payload(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) return null;
  return dataUrl.slice(comma + 1);
}

async function screenshotOf(
  capture: (rect?: PreviewRect) => Promise<ScreenshotCapture>,
  rect: PreviewRect | null,
  digest: (bytes: Uint8Array) => Promise<string>
): Promise<{ screenshot: ScreenshotEvidence | null; note: string | null }> {
  let result: ScreenshotCapture;
  try {
    result = await capture(rect ?? undefined);
  } catch (error) {
    return { screenshot: null, note: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) return { screenshot: null, note: result.error };
  const payload = base64Payload(result.dataUrl);
  if (payload === null) return { screenshot: null, note: 'the capture was not a PNG data URL' };
  let bytes: Uint8Array;
  try {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return { screenshot: null, note: 'the captured image could not be decoded' };
  }
  if (bytes.length === 0) return { screenshot: null, note: 'the captured image was empty' };
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    return { screenshot: null, note: `the captured image was ${(bytes.length / 1024 / 1024).toFixed(1)} MB` };
  }
  return {
    screenshot: {
      capturedAt: Date.now(),
      bytes: bytes.length,
      sha256: await digest(bytes),
      region: rect ? 'preview' : 'window'
    },
    note: null
  };
}

/** `6000 -> '6s'`, `250 -> '250ms'` — the budget the caller actually gave. */
function formatBudget(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export async function runAcceptanceCheck(input: AcceptanceRunInput): Promise<AcceptanceRun> {
  const label = input.phase === 'baseline' ? 'baseline' : 'post-patch';
  if (!input.workspaceId || !input.bridge?.assertPreview) {
    return { evidence: null, message: `No preview bridge for this workspace, so the ${label} check cannot run.` };
  }
  if (!input.previewReady) {
    return { evidence: null, message: `The preview is not running — start it, then re-run the ${label} check.` };
  }
  const timeout = input.paintTimeoutMs ?? PAINT_TIMEOUT_MS;
  const painted = await input.waitForPaint(timeout);
  if (!painted) {
    return {
      evidence: null,
      message: `The preview did not repaint within ${formatBudget(timeout)}, so the ${label} check was not run.`
    };
  }
  if (input.settle) await input.settle(PAINT_SETTLE_MS);
  let verdict: PreviewVerdict;
  try {
    verdict = await input.bridge.assertPreview(input.workspaceId, { selectors: input.probeSelectors ?? [] });
  } catch (error) {
    return {
      evidence: null,
      message: `The ${label} check could not run: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const capture = input.captureScreenshot && input.bridge.capturePreviewPage
    ? input.bridge.capturePreviewPage
    : null;
  const image = capture
    ? await screenshotOf(
      (rect) => capture(rect),
      input.captureRect ?? null,
      input.digest ?? ((bytes) => sha256Hex(bytes))
    )
    : { screenshot: null, note: input.captureScreenshot ? 'this build cannot capture the preview' : null };
  const evidence = evidenceFromVerdict({
    phase: input.phase,
    verdict,
    requestedSelectors: input.probeSelectors,
    screenshot: image.screenshot,
    screenshotNote: image.note,
    afterReload: painted
  });
  return { evidence, message: `${label} check — ${describeEvidence(evidence)}.` };
}
