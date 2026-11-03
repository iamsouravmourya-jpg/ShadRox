import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  Play,
  RefreshCw,
  Server,
  ServerOff,
  Square,
  Terminal,
  Trash2,
  X
} from 'lucide-react';
import { getDesktopBridge } from '../lib/desktop';
import type { DesktopPreviewOutput, RuntimePreviewPlan, ShadRoxDesktopAPI } from '../lib/desktop';
import { parseRevealMessage, type RevealSourceTarget } from '../lib/previewSource';

/** Runtime detection is only possible when the desktop preload exposes every method. */
function getBackendBridge(): ShadRoxDesktopAPI | null {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  const candidate = bridge as Partial<ShadRoxDesktopAPI>;
  if (
    typeof candidate.detectRuntimes !== 'function' ||
    typeof candidate.startBackendPreview !== 'function' ||
    typeof candidate.stopBackendPreview !== 'function' ||
    typeof candidate.onBackendPreviewOutput !== 'function'
  ) {
    return null;
  }
  return bridge;
}

export interface BackendPreviewProps {
  workspaceId: string | null;
  /** Forwarded when the backend page posts a `reveal-source` bridge message. */
  onRevealSource?: (target: RevealSourceTarget) => void;
  /**
   * Lets the host choose between a compact row and a side-by-side column
   * without duplicating runtime detection.
   */
  onAvailabilityChange?: (available: boolean) => void;
}

type BackendPhase = 'idle' | 'detecting' | 'starting' | 'ready' | 'error';

interface BackendLogEntry {
  type: DesktopPreviewOutput['type'];
  message: string;
  timestamp: string;
}

const MAX_LOG_LINES = 200;
const BACKEND_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-same-origin';

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = typeof error === 'string' ? error : String(error ?? '');
  return text || 'The backend preview could not be started.';
}

function logTimestamp(timestamp?: number): string {
  const date = typeof timestamp === 'number' && Number.isFinite(timestamp) ? new Date(timestamp) : new Date();
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function extractHttpUrl(message: string): string | null {
  const match = /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\])(?::\d+)?(?:\/[^\s]*)?/i.exec(message);
  if (!match) return null;
  return match[0]
    .replace(/[),.;]+$/, '')
    .replace('://localhost', '://127.0.0.1')
    .replace('://0.0.0.0', '://127.0.0.1');
}

function plannedCommand(plan: RuntimePreviewPlan | null): string {
  if (!plan || !plan.command) return plan ? 'static files' : '';
  const args = plan.args.map((arg) => arg.replace(/\{port\}/g, String(plan.port)));
  return [plan.command, ...args].join(' ');
}

function portFromUrl(url: string | null): number | null {
  if (!url) return null;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

const START_BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-lg border border-violet-300/30 bg-violet-500/10 px-2 py-1 text-[11px] font-mono text-violet-200 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer';
const ICON_BUTTON_CLASS =
  'rounded-lg border border-white/[0.09] p-1.5 text-neutral-500 transition-colors hover:border-white/[0.15] hover:text-white disabled:opacity-40 cursor-pointer';
const STOP_BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-lg border border-red-500/25 bg-red-500/[.08] px-2 py-1 text-[11px] font-mono text-red-300 transition-colors hover:bg-red-500/[.14] cursor-pointer';

export function BackendPreview({ workspaceId, onRevealSource, onAvailabilityChange }: BackendPreviewProps) {
  const [plan, setPlan] = useState<RuntimePreviewPlan | null>(null);
  const [phase, setPhase] = useState<BackendPhase>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detectionErrors, setDetectionErrors] = useState<string[]>([]);
  const [logs, setLogs] = useState<BackendLogEntry[]>([]);
  const [isLogsOpen, setIsLogsOpen] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);
  const planRef = useRef<RuntimePreviewPlan | null>(null);
  /** Workspace whose backend this component started; stopped on teardown. */
  const runningRef = useRef<string | null>(null);

  useEffect(() => {
    planRef.current = plan;
    onAvailabilityChange?.(plan !== null);
  }, [plan, onAvailabilityChange]);

  // Detect backend runtimes whenever the workspace changes.
  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setDetectionErrors([]);
    setUrl(null);
    setError(null);
    setLogs([]);
    setReloadNonce(0);
    setPhase(workspaceId ? 'detecting' : 'idle');
    if (!workspaceId) return () => { cancelled = true; };

    const bridge = getBackendBridge();
    if (!bridge) {
      setPhase('error');
      setError('Backend preview is available in the ShadRox desktop app.');
      return () => { cancelled = true; };
    }

    void bridge
      .detectRuntimes(workspaceId)
      .then((result) => {
        if (cancelled) return;
        const backendPlan = result.plans.find((candidate) => candidate.kind === 'backend') ?? null;
        setPlan(backendPlan);
        setDetectionErrors(result.errors);
        setPhase('idle');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setError(describeError(caught));
      });

    return () => { cancelled = true; };
  }, [workspaceId]);

  // Stream stdout/stderr/status lines from the main process.
  useEffect(() => {
    if (!workspaceId) return undefined;
    const bridge = getBackendBridge();
    if (!bridge) return undefined;

    const unsubscribe = bridge.onBackendPreviewOutput((output) => {
      if (output.workspaceId !== workspaceId) return;
      const entry: BackendLogEntry = {
        type: output.type,
        message: output.message,
        timestamp: logTimestamp(output.timestamp)
      };
      setLogs((previous) => [...previous, entry].slice(-MAX_LOG_LINES));

      if (output.type === 'ready') {
        runningRef.current = workspaceId;
        setPhase('ready');
        const detectedUrl = extractHttpUrl(output.message);
        setUrl((current) => current ?? detectedUrl ?? (planRef.current ? `http://127.0.0.1:${planRef.current.port}/` : null));
      } else if (output.type === 'error') {
        runningRef.current = null;
        setPhase('error');
        setUrl(null);
        setError(output.message);
      } else if (output.type === 'stopped') {
        runningRef.current = null;
        setPhase('idle');
        setUrl(null);
      }
    });

    return unsubscribe;
  }, [workspaceId]);

  // Best-effort stop on unmount or workspace switch, even if the user never
  // pressed Stop. Sync cleanup cannot await, so failures are ignored.
  useEffect(() => {
    return () => {
      const runningWorkspace = runningRef.current;
      runningRef.current = null;
      const bridge = getBackendBridge();
      if (runningWorkspace && bridge) {
        void bridge.stopBackendPreview(runningWorkspace).catch(() => undefined);
      }
    };
  }, [workspaceId]);

  // Click-to-source bridge, mirroring the static preview listener.
  useEffect(() => {
    if (!onRevealSource) return undefined;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const target = parseRevealMessage(event.data);
      if (target) onRevealSource(target);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onRevealSource]);

  // Keep the newest line visible (cap is already applied when appending).
  useEffect(() => {
    if (!isLogsOpen) return;
    const container = logScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [logs, isLogsOpen]);

  const handleStart = async () => {
    if (!workspaceId) return;
    const bridge = getBackendBridge();
    if (!bridge) {
      setPhase('error');
      setError('Backend preview is not available in this desktop build.');
      return;
    }
    setError(null);
    setUrl(null);
    setPhase('starting');
    try {
      const result = await bridge.startBackendPreview(workspaceId, plan?.port);
      if (result.status === 'ready') {
        runningRef.current = workspaceId;
        setUrl(result.url);
        setPhase('ready');
        return;
      }
      if (result.status === 'approval-required') {
        // The main process owns the approval dialog; it resolves with ready
        // once approved, so a returned approval request just means "waiting".
        setPhase('idle');
        setError(
          `Approval required to run "${result.approval.scriptCommand}" in ${result.approval.projectPath}. ` +
          'Confirm the ShadRox approval dialog, then start the backend again.'
        );
        return;
      }
      setPhase('idle');
      setError(
        result.projects.length > 0
          ? `Choose one runnable project first: ${result.projects.map((project) => project.projectPath).join(', ')}`
          : 'No runnable backend project was found to start.'
      );
    } catch (caught) {
      setPhase('error');
      setUrl(null);
      setError(describeError(caught));
    }
  };

  const handleStop = async () => {
    if (!workspaceId) return;
    runningRef.current = null;
    setPhase('idle');
    setUrl(null);
    const bridge = getBackendBridge();
    if (!bridge) return;
    try {
      await bridge.stopBackendPreview(workspaceId);
    } catch {
      // Best-effort: the main process may have already exited the child.
    }
  };

  if (!plan) {
    const isDetecting = phase === 'detecting';
    const isFailure = phase === 'error';
    const label = isDetecting
      ? 'Detecting backend runtime...'
      : isFailure
        ? error ?? 'Backend preview unavailable.'
        : 'No backend runtime detected.';
    return (
      <div
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-[11px]"
        aria-live="polite"
        aria-label="Backend runtime status"
      >
        {isDetecting ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-300" aria-hidden="true" />
        ) : isFailure ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
        ) : (
          <ServerOff className="h-3.5 w-3.5 shrink-0 text-neutral-600" aria-hidden="true" />
        )}
        <span className={`truncate ${isFailure ? 'text-red-300' : 'text-neutral-500'}`}>{label}</span>
        {!isFailure && detectionErrors.length > 0 && (
          <span className="truncate text-neutral-600" title={detectionErrors[0]}>
            · {detectionErrors[0]}
          </span>
        )}
      </div>
    );
  }

  const displayPort = portFromUrl(url) ?? plan.port;
  const commandLabel = plannedCommand(plan);
  const effectiveUrl = url ?? (phase === 'ready' ? `http://127.0.0.1:${plan.port}/` : null);
  const isStarting = phase === 'starting';

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-ink-950">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-ink-950/60 px-3">
        <Server className="h-3.5 w-3.5 shrink-0 text-violet-300" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Backend</span>
        <span className="shrink-0 truncate rounded border border-violet-300/25 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-300">
          {plan.adapter}
        </span>
        <span className="hidden font-mono text-[10px] text-neutral-500 sm:inline">:{displayPort}</span>
        {phase === 'ready' && (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/[.08] px-2 py-0.5 font-mono text-[10px] text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running
          </span>
        )}
        {isStarting && (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-violet-300/25 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] text-violet-200">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            Starting
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsLogsOpen((open) => !open)}
            aria-label="Toggle backend logs"
            title="Toggle backend logs"
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors cursor-pointer ${
              isLogsOpen
                ? 'border-violet-300/30 bg-violet-500/10 text-violet-200'
                : 'border-white/[0.09] text-neutral-400 hover:border-white/[0.15] hover:text-white'
            }`}
          >
            <Terminal className="h-3.5 w-3.5" />
            {logs.length > 0 && <span className="text-[10px] text-neutral-400">({logs.length})</span>}
          </button>
          <button
            type="button"
            onClick={() => setReloadNonce((nonce) => nonce + 1)}
            disabled={!effectiveUrl}
            aria-label="Reload backend preview"
            title="Reload backend preview"
            className={ICON_BUTTON_CLASS}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          {phase === 'ready' ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              aria-label="Stop backend preview"
              title="Stop backend preview"
              className={STOP_BUTTON_CLASS}
            >
              <Square className="h-3 w-3" />
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={isStarting}
              aria-label="Start backend preview"
              title="Start backend preview"
              className={START_BUTTON_CLASS}
            >
              {isStarting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Start
            </button>
          )}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 font-mono text-[10px]">
        <span className="shrink-0 truncate text-neutral-400" title={plan.entry}>{plan.entry}</span>
        <span className="hidden min-w-0 truncate text-neutral-600 md:inline" title={`${commandLabel} (${plan.cwd})`}>
          {commandLabel}
        </span>
        {effectiveUrl && (
          <span className="ml-auto min-w-0 truncate text-neutral-300" title={effectiveUrl}>
            {effectiveUrl}
          </span>
        )}
      </div>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-500/25 bg-red-500/[.08] px-3 py-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
          <code className="flex-1 break-all font-mono text-[11px] text-red-300">{error}</code>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col bg-ink-950">
        {effectiveUrl ? (
          <iframe
            key={`${effectiveUrl}:${reloadNonce}`}
            ref={frameRef}
            title="ShadRox Backend Preview"
            src={effectiveUrl}
            sandbox={BACKEND_IFRAME_SANDBOX}
            className="block h-full w-full border-0 bg-ink-950"
          />
        ) : (
          <div className="max-w-sm flex-1 self-center px-6 py-6 text-center">
            {isStarting ? (
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-violet-300" aria-hidden="true" />
            ) : phase === 'error' ? (
              <AlertTriangle className="mx-auto h-5 w-5 text-red-400" aria-hidden="true" />
            ) : (
              <Play className="mx-auto h-5 w-5 text-violet-300" aria-hidden="true" />
            )}
            <p className="mt-2 text-xs font-medium text-neutral-200">
              {isStarting
                ? 'Starting backend preview...'
                : phase === 'error'
                  ? 'Backend preview failed'
                  : `${plan.adapter} backend detected`}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
              {isStarting
                ? `Launching ${plan.entry} on port ${plan.port}.`
                : phase === 'error'
                  ? 'Check the error above or the backend logs, then try again.'
                  : `Runs ${plan.entry} and loads it here next to the frontend preview.`}
            </p>
            {!isStarting && phase !== 'ready' && (
              <button
                type="button"
                onClick={() => void handleStart()}
                aria-label="Start backend preview"
                className={`${START_BUTTON_CLASS} mt-3`}
              >
                <Play className="h-3.5 w-3.5" />
                Start backend
              </button>
            )}
          </div>
        )}
      </div>

      {isLogsOpen && (
        <div className="flex h-40 shrink-0 flex-col border-t border-white/[0.06] bg-ink-950 font-mono text-xs">
          <div className="flex h-7 shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
              <Terminal className="h-3 w-3 text-neutral-400" aria-hidden="true" />
              Backend Logs ({logs.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLogs([])}
                aria-label="Clear backend logs"
                title="Clear backend logs"
                className="text-neutral-500 transition-colors hover:text-white cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => setIsLogsOpen(false)}
                aria-label="Close backend logs"
                title="Close backend logs"
                className="text-neutral-500 transition-colors hover:text-white cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div ref={logScrollRef} className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {logs.length === 0 ? (
              <div className="px-2 py-1 text-[11px] italic text-neutral-600">No backend output yet.</div>
            ) : (
              logs.map((entry, index) => (
                <div
                  key={`${entry.timestamp}:${index}`}
                  className={`flex items-start gap-2 px-2 py-0.5 text-[11px] ${
                    entry.type === 'stderr' || entry.type === 'error'
                      ? 'bg-red-950/20 text-red-400'
                      : entry.type === 'status' || entry.type === 'install'
                        ? 'bg-amber-950/20 text-amber-400'
                        : 'text-neutral-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="shrink-0 text-[10px] text-neutral-600">{entry.timestamp}</span>
                  <span className="break-all">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
