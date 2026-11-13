import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { PAINT_TIMEOUT_MS, runAcceptanceCheck, type AcceptanceBridge, type AcceptanceRun } from '../lib/behavior/acceptance';
import { recordContractEvidence } from '../lib/behavior/verification';
import type { AcceptanceContract, PreviewRect } from '../lib/behavior/types';

interface UseAcceptanceOptions {
  /** The Electron bridge, or null in a browser build where no probe exists. */
  bridge: AcceptanceBridge | null;
  workspaceId: string | null;
  previewReady: boolean;
  contract: AcceptanceContract | null;
  setContract: Dispatch<SetStateAction<AcceptanceContract | null>>;
}

export interface AcceptancePhaseRun extends AcceptanceRun {
  /** The contract as it stands after this run; null when there was no contract. */
  contract: AcceptanceContract | null;
}

export interface UseAcceptance extends UseAcceptanceOptions {
  /** Records that the preview painted, and where its frame sits in the window. */
  onFramePaint: (rect?: PreviewRect | null) => void;
  paintToken: () => number;
  waitForPaint: (from: number, timeoutMs?: number) => Promise<boolean>;
  /** Runs one phase against the live preview and records only what it proved. */
  run: (phase: 'baseline' | 'postPatch', options?: { repaintFrom?: number }) => Promise<AcceptancePhaseRun>;
  busy: 'baseline' | 'postPatch' | null;
}

const settle = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/**
 * Owns the repaint bookkeeping an acceptance check needs.
 *
 * `waitForPaint` compares against a token captured before the write, so a
 * post-patch check cannot be satisfied by the page that was already on screen.
 * A preview that never reloads — dev-server HMR, or a patch that touched no
 * served file — times out and the run reports that it did not happen rather
 * than grading the old document.
 */
export function useAcceptance({
  bridge,
  workspaceId,
  previewReady,
  contract,
  setContract
}: UseAcceptanceOptions): UseAcceptance {
  const paintEpoch = useRef(0);
  /** The preview frame's box as of its last paint; null until one has happened. */
  const paintRect = useRef<PreviewRect | null>(null);
  const contractRef = useRef(contract);
  contractRef.current = contract;
  const [busy, setBusy] = useState<'baseline' | 'postPatch' | null>(null);

  const onFramePaint = useCallback((rect?: PreviewRect | null) => {
    paintEpoch.current += 1;
    if (rect) paintRect.current = rect;
  }, []);

  const paintToken = useCallback(() => paintEpoch.current, []);

  const waitForPaint = useCallback((from: number, timeoutMs = PAINT_TIMEOUT_MS) => new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: number | undefined;
    const poll = () => {
      if (paintEpoch.current !== from) {
        if (timer !== undefined) window.clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        if (timer !== undefined) window.clearInterval(timer);
        resolve(false);
      }
    };
    timer = window.setInterval(poll, 100);
    poll();
  }), []);

  const run = useCallback(async (
    phase: 'baseline' | 'postPatch',
    options: { repaintFrom?: number } = {}
  ): Promise<AcceptancePhaseRun> => {
    const current = contractRef.current;
    if (!current) {
      return {
        evidence: null,
        message: 'No acceptance contract yet — record the interaction and generate one first.',
        contract: null
      };
    }
    setBusy(phase);
    try {
      const result = await runAcceptanceCheck({
        bridge,
        workspaceId,
        phase,
        probeSelectors: current.probe.selectors,
        previewReady,
        // No token means "check the page as it stands", which is what a manual
        // run from the panel asks for; an apply waits for the patched paint.
        waitForPaint: options.repaintFrom === undefined
          ? () => Promise.resolve(true)
          : (timeoutMs) => waitForPaint(options.repaintFrom as number, timeoutMs),
        settle,
        captureScreenshot: true,
        // The box the frame reported when it last painted; without it main
        // grabs the whole window, which the evidence then says so.
        captureRect: paintRect.current
      });
      if (!result.evidence) return { ...result, contract: current };
      const evidence = result.evidence;
      setContract((previous) => (previous ? recordContractEvidence(previous, evidence) : previous));
      return { ...result, contract: recordContractEvidence(current, evidence) };
    } finally {
      setBusy(null);
    }
  }, [bridge, workspaceId, previewReady, setContract, waitForPaint]);

  // Callers put this object in their dependency arrays, so it must not be a new
  // identity on every render.
  return useMemo(
    () => ({ bridge, workspaceId, previewReady, contract, setContract, onFramePaint, paintToken, waitForPaint, run, busy }),
    [bridge, workspaceId, previewReady, contract, setContract, onFramePaint, paintToken, waitForPaint, run, busy]
  );
}
