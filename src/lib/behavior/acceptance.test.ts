import assert from 'node:assert/strict';
import test from 'node:test';
import { runAcceptanceCheck, type AcceptanceBridge } from './acceptance';
import { describeEvidence } from './verification';
import type { PreviewRect, PreviewVerdict } from './types';

interface Harness {
  calls: Array<{ workspaceId: string; selectors: readonly string[] | undefined }>;
  bridge: AcceptanceBridge;
}

function harness(verdict: PreviewVerdict | (() => Promise<PreviewVerdict>), capture?: AcceptanceBridge['capturePreviewPage']): Harness {
  const calls: Harness['calls'] = [];
  const resolveVerdict = async (workspaceId: string, options?: { selectors?: readonly string[] }) => {
    calls.push({ workspaceId, selectors: options?.selectors });
    return typeof verdict === 'function' ? await verdict() : verdict;
  };
  const bridge: AcceptanceBridge = { assertPreview: resolveVerdict as AcceptanceBridge['assertPreview'] };
  if (capture) bridge.capturePreviewPage = capture;
  return { calls, bridge };
}

const clean: PreviewVerdict = { ok: true, status: 'ok', detail: null, errorCount: 0, assertedSelectors: ['#root'] };
const broken: PreviewVerdict = {
  ok: false,
  status: 'fatal',
  detail: null,
  errorCount: 1,
  consoleErrors: ['TypeError: cannot read x'],
  assertedSelectors: ['#root']
};
const neverPaints = async () => false;
const alwaysPaints = async () => true;
const noSettle = async () => {};
const pngOf = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

test('a phase without a workspace or a bridge is reported as not run', async () => {
  const missingBridge = await runAcceptanceCheck({
    bridge: null,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.equal(missingBridge.evidence, null);
  assert.match(missingBridge.message, /No preview bridge/);

  const missingWorkspace = await runAcceptanceCheck({
    bridge: harness(clean).bridge,
    workspaceId: null,
    phase: 'postPatch',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.match(missingWorkspace.message, /post-patch check cannot run/);
});

test('a stopped preview is not an unverified check, it is no check at all', async () => {
  const result = await runAcceptanceCheck({
    bridge: harness(clean).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: false,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.equal(result.evidence, null);
  assert.match(result.message, /preview is not running/);
});

// The harness drains the console-error buffer as part of asserting, so probing
// a page that predates the patch would spend the errors the patched page is
// about to produce. Skipping the call is the point of this test.
test('a preview that never repaints is not probed', async () => {
  const runner = harness(clean);
  const result = await runAcceptanceCheck({
    bridge: runner.bridge,
    workspaceId: 'ws',
    phase: 'postPatch',
    probeSelectors: ['#root'],
    previewReady: true,
    waitForPaint: neverPaints,
    settle: noSettle,
    paintTimeoutMs: 250
  });
  assert.equal(result.evidence, null);
  assert.equal(runner.calls.length, 0);
  assert.match(result.message, /did not repaint within 250ms/);
});

test('a passing verdict becomes passing evidence with the probe it ran', async () => {
  const runner = harness(clean);
  const result = await runAcceptanceCheck({
    bridge: runner.bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    probeSelectors: ['#root'],
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.deepEqual(runner.calls, [{ workspaceId: 'ws', selectors: ['#root'] }]);
  assert.ok(result.evidence);
  assert.equal(result.evidence.result, 'passed');
  assert.deepEqual(result.evidence.selectors, ['#root']);
  assert.equal(result.evidence.afterReload, true);
  assert.match(result.message, /baseline check — passed/);
});

test('a fatal verdict after the repaint is a failed baseline, not a shrug', async () => {
  const result = await runAcceptanceCheck({
    bridge: harness(broken).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.ok(result.evidence);
  assert.equal(result.evidence.result, 'failed');
  assert.equal(result.evidence.errorCount, 1);
  assert.deepEqual(result.evidence.failedSelectors, []);
});

test('the screenshot becomes a byte count and a digest, never pixels', async () => {
  const rects: Array<PreviewRect | null> = [];
  const runner = harness(clean, async (rect) => {
    rects.push(rect ?? null);
    return { ok: true, dataUrl: pngOf(1024) };
  });
  const result = await runAcceptanceCheck({
    bridge: runner.bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true,
    digest: async (bytes) => `sha:${bytes.length}`
  });
  assert.ok(result.evidence?.screenshot);
  assert.deepEqual(result.evidence.screenshot, {
    capturedAt: result.evidence.screenshot.capturedAt,
    bytes: 1024,
    sha256: 'sha:1024',
    region: 'window'
  });
  assert.equal(result.evidence.screenshotNote, null);
  // No box was known, so the grab is the whole window and the receipt says so.
  assert.deepEqual(rects, [null]);
  assert.match(describeEvidence(result.evidence), /png 1 KB \(whole window\)/);

  const cropped = await runAcceptanceCheck({
    bridge: harness(clean, async () => ({ ok: true, dataUrl: pngOf(2048) })).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true,
    captureRect: { x: 320, y: 48, width: 900, height: 600 },
    digest: async (bytes) => `sha:${bytes.length}`
  });
  assert.equal(cropped.evidence?.screenshot?.region, 'preview');
  assert.doesNotMatch(describeEvidence(cropped.evidence ?? null), /whole window/);
});

test('a screenshot that fails to arrive is recorded as a reason', async () => {
  const refused = await runAcceptanceCheck({
    bridge: harness(clean, async () => ({ ok: false, error: 'Nothing is painting in that area yet.' })).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true
  });
  assert.equal(refused.evidence?.screenshot, null);
  assert.equal(refused.evidence?.screenshotNote, 'Nothing is painting in that area yet.');
  // The missing png does not change what the probe proved.
  assert.equal(refused.evidence?.result, 'passed');

  const notPng = await runAcceptanceCheck({
    bridge: harness(clean, async () => ({ ok: true, dataUrl: 'data:image/jpeg;base64,/9j/' })).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true
  });
  assert.equal(notPng.evidence?.screenshotNote, 'the capture was not a PNG data URL');

  const empty = await runAcceptanceCheck({
    bridge: harness(clean, async () => ({ ok: true, dataUrl: pngOf(0) })).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true
  });
  assert.equal(empty.evidence?.screenshotNote, 'the captured image was empty');

  const captureThrew = await runAcceptanceCheck({
    bridge: harness(clean, async () => { throw new Error('capture rejected'); }).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true
  });
  assert.equal(captureThrew.evidence?.screenshotNote, 'capture rejected');
});

test('this build capturing nothing is stated instead of blamed on the app', async () => {
  const result = await runAcceptanceCheck({
    bridge: harness(clean).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle,
    captureScreenshot: true
  });
  assert.equal(result.evidence?.screenshot, null);
  assert.equal(result.evidence?.screenshotNote, 'this build cannot capture the preview');
});

test('an assertion that throws leaves the phase exactly as it was', async () => {
  const result = await runAcceptanceCheck({
    bridge: harness(async () => { throw new Error('frame detached'); }).bridge,
    workspaceId: 'ws',
    phase: 'postPatch',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.equal(result.evidence, null);
  assert.match(result.message, /could not run: frame detached/);
});

test('an observed verdict is evidence of nothing, with the reason kept', async () => {
  const result = await runAcceptanceCheck({
    bridge: harness({ ok: false, status: 'observed', detail: 'assertion-script-did-not-evaluate', errorCount: 0 }).bridge,
    workspaceId: 'ws',
    phase: 'baseline',
    previewReady: true,
    waitForPaint: alwaysPaints,
    settle: noSettle
  });
  assert.equal(result.evidence?.result, 'unverified');
  assert.equal(result.evidence?.detail, 'assertion-script-did-not-evaluate');
});
