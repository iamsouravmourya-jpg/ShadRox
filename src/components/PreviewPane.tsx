import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  FolderOpen,
  Laptop,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Play,
  Square,
  Smartphone,
  Tablet,
  Terminal,
  Trash2,
  X
} from 'lucide-react';
import type { ViewportSize } from '../lib/types';
import type { PreviewDocument } from '../lib/preview';
import { parseRevealMessage, type RevealSourceTarget } from '../lib/previewSource';
import { getDesktopBridge, type DesktopPreviewOutput, type DesktopPreviewState, type PreviewProjectCandidate } from '../lib/desktop';
import { globalRepairSession } from '../lib/repairSession';
import { BackendPreview } from './BackendPreview';
import type { BehaviorEvent, PreviewRect } from '../lib/behavior/types';
import { createBehaviorEvent } from '../lib/behavior/recorder';

interface PreviewPaneProps {
  document: PreviewDocument | null;
  capabilityMessage: string;
  viewport: ViewportSize;
  onViewportChange: (viewport: ViewportSize) => void;
  runtimeError: string | null;
  onDismissError: () => void;
  onRuntimeError: (message: string) => void;
  isBundling?: boolean;
  bundleError?: string | null;
  localPreviewAvailable?: boolean;
  localPreviewState?: DesktopPreviewState;
  localPreviewLogs?: DesktopPreviewOutput[];
  onStartLocalPreview?: () => void;
  onStopLocalPreview?: () => void;
  onClearLocalPreviewLogs?: () => void;
  previewProjects?: PreviewProjectCandidate[];
  onChoosePreviewProject?: (project: PreviewProjectCandidate) => void;
  onCancelProjectSelection?: () => void;
  /** Bumped externally when a watched file changes and the preview should reload. */
  reloadKey?: number;
  autoReload?: boolean;
  onToggleAutoReload?: () => void;
  lastReloadAt?: number | null;
  /**
   * Called when a click inside the static preview maps to an element in the
   * served HTML file, so the host can open it and reveal the line.
   */
  onRevealSource?: (target: RevealSourceTarget) => void;
  onBehaviorEvent?: (event: BehaviorEvent) => void;
  /** Browser console errors captured from the preview iframe — added to agent context. */
  onBrowserConsoleLog?: (entries: { type: string; message: string }[]) => void;
  /**
   * Fires when the preview frame finishes loading a document, with the frame's
   * box. An acceptance check waits on this so it never grades the page from
   * before a patch, and grabs only the preview instead of the whole window.
   */
  onFramePaint?: (rect?: PreviewRect | null) => void;
  /**
   * Enables the backend preview companion. Omit it to keep the original
   * single-preview layout untouched.
   */
  workspaceId?: string | null;
  /** Mount the backend companion; false keeps runtime detection asleep. */
  backendEnabled?: boolean;
  /** Current full-screen state, controlled by the host. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Always present so the pane can be closed without the keyboard. */
  onClose?: () => void;
}

interface ConsoleEntry {
  type: 'log' | 'error' | 'warn';
  message: string;
  timestamp: string;
}

const VIEWPORT_MAX_WIDTHS: Record<ViewportSize, number> = {
  desktop: Number.POSITIVE_INFINITY,
  tablet: 768,
  mobile: 390
};

const VIEWPORT_SIZES = Object.keys(VIEWPORT_MAX_WIDTHS) as ViewportSize[];

const VIEWPORT_ICONS: Record<ViewportSize, typeof Laptop> = {
  desktop: Laptop,
  tablet: Tablet,
  mobile: Smartphone
};

function splitPreviewAddress(url: string | null): { protocol: string; path: string } | null {
  if (!url) return null;
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i.exec(url);
  return match ? { protocol: match[1], path: match[2] } : null;
}

/**
 * The port the local server actually ended up on. When a port conflict moves
 * the preview, this is the one number the user needs to see without opening
 * the console; the main process reports it in the ready URL.
 */
function previewPortOf(url: string | null): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (port > 0) return port;
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return null;
  } catch {
    return null;
  }
}

interface PreviewIframeProps {
  mode: 'local' | 'static';
  reloadKey: string;
  url?: string | null;
  srcDocHtml?: string;
  frameRef: (node: HTMLIFrameElement | null) => void;
  onFramePaint?: (rect?: PreviewRect | null) => void;
}

const PreviewIframe = memo(
  function PreviewIframe({ mode, reloadKey, url, srcDocHtml, frameRef, onFramePaint }: PreviewIframeProps) {
    const localNodeRef = useRef<HTMLIFrameElement | null>(null);
    const paintCbRef = useRef(onFramePaint);
    paintCbRef.current = onFramePaint;

    const assignRef = useCallback(
      (node: HTMLIFrameElement | null) => {
        localNodeRef.current = node;
        frameRef(node);
      },
      [frameRef]
    );

    if (mode === 'local') {
      return (
        <iframe
          key={reloadKey}
          ref={assignRef}
          title="ShadRox Local Project Preview"
          src={url ?? undefined}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
          className="block shrink-0 border-0 bg-base shadow-2xl"
          style={{ width: '100%', height: '100%' }}
          onLoad={() => {
            const box = localNodeRef.current?.getBoundingClientRect();
            paintCbRef.current?.(
              box && box.width > 0 && box.height > 0
                ? { x: box.x, y: box.y, width: box.width, height: box.height }
                : null
            );
          }}
        />
      );
    }

    return (
      <iframe
        key={reloadKey}
        title="ShadRox Live Preview"
        srcDoc={srcDocHtml}
        ref={assignRef}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        className="block shrink-0 border-0 bg-base shadow-2xl"
        style={{ width: '100%', height: '100%' }}
      />
    );
  },
  (prev, next) =>
    prev.mode === next.mode &&
    prev.reloadKey === next.reloadKey &&
    prev.url === next.url &&
    prev.srcDocHtml === next.srcDocHtml
);

export const PreviewPane = memo(function PreviewPane({
  document,
  capabilityMessage,
  viewport,
  onViewportChange,
  runtimeError,
  onDismissError,
  onRuntimeError,
  isBundling = false,
  bundleError = null,
  localPreviewAvailable = false,
  localPreviewState = { status: 'idle', url: null },
  localPreviewLogs = [],
  onStartLocalPreview,
  onStopLocalPreview,
  onClearLocalPreviewLogs,
  previewProjects = [],
  onChoosePreviewProject,
  onCancelProjectSelection,
  reloadKey = 0,
  autoReload = true,
  onToggleAutoReload,
  lastReloadAt = null,
  onRevealSource,
  onBehaviorEvent,
  onBrowserConsoleLog,
  onFramePaint,
  workspaceId = null,
  backendEnabled = true,
  fullscreen = false,
  onToggleFullscreen,
  onClose
}: PreviewPaneProps) {
  const [manualReloadKey, setManualReloadKey] = useState(0);
  const effectiveReloadKey = `${reloadKey}:${manualReloadKey}`;
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const [previewAssert, setPreviewAssert] = useState<'ok' | 'warn' | 'fatal' | 'observed' | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewStageRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const setDocumentFrameRef = useCallback((node: HTMLIFrameElement | null) => {
    iframeRef.current = node;
    previewFrameRef.current = node;
  }, []);
  const setLocalFrameRef = useCallback((node: HTMLIFrameElement | null) => {
    previewFrameRef.current = node;
  }, []);
  const displayedLogs = localPreviewAvailable
    ? localPreviewLogs.map((entry) => ({
        type: entry.type === 'stderr' || entry.type === 'error' ? 'error' as const
          : 'log' as const,
        message: entry.message,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
      }))
    : logs;
  const previewStartMessage = [...localPreviewLogs].reverse().find((entry) => entry.type === 'status')?.message;
  // The assertion effect below must read the latest errors without re-running
  // on every console line, so the diagnostics live in a ref.
  const previewErrorLogRef = useRef<string[]>([]);
  previewErrorLogRef.current = displayedLogs
    .filter((entry) => entry.type === 'error')
    .slice(-10)
    .map((entry) => `[${entry.timestamp}] ${entry.message}`);

  // Drives the split layout. BackendPreview owns runtime detection and reports
  // whether a backend plan exists; the frontend preview stays full-width until
  // one is found.
  const [backendAvailable, setBackendAvailable] = useState(false);
  useEffect(() => {
    setBackendAvailable(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!bundleError) return;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs((previous) => [...previous.slice(-99), { type: 'error', message: bundleError, timestamp }]);
    setIsConsoleOpen(true);
  }, [bundleError]);

  useEffect(() => {
    if (localPreviewState.status === 'error') setIsConsoleOpen(true);
  }, [localPreviewState.status]);

  useEffect(() => {
    if (localPreviewState.status !== 'ready' || !workspaceId) {
      setPreviewAssert(null);
      return;
    }
    const desktop = getDesktopBridge();
    if (!desktop?.assertPreview) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void desktop.assertPreview(workspaceId).then((verdict) => {
        if (cancelled) return;
        setPreviewAssert(verdict.status);
        // The verdict contract is `ok` only when the load is proven; `fatal`
        // and `warn` are both failed verdicts. `observed` is neutral — the
        // assertion could not evaluate — so it is never a failure receipt.
        if (verdict.status !== 'fatal' && verdict.status !== 'warn') return;
        const consoleErrors = previewErrorLogRef.current;
        globalRepairSession.capture({
          source: 'preview',
          target: localPreviewState.url ?? `workspace:${workspaceId}`,
          errorMessage: verdict.detail
            || (verdict.errorCount > 0 ? consoleErrors[0] : undefined)
            || (verdict.status === 'fatal'
              ? 'Preview check failed: a source-derived selector did not match.'
              : 'Preview check warned: not every source-derived selector matched.'),
          consoleErrors
        });
      }).catch(() => {
        if (!cancelled) setPreviewAssert(null);
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [localPreviewState.status, localPreviewState.url, workspaceId, reloadKey]);

  // Listen to iframe error and console bridge
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      // Only the srcDoc preview registers through setDocumentFrameRef; the
      // local-server frame fills previewFrameRef alone, so checking one ref
      // dropped every console/reveal message from live previews.
      const frame = iframeRef.current ?? previewFrameRef.current;
      if (
        !frame ||
        event.source !== frame.contentWindow ||
        !data ||
        data.source !== 'shadrox-preview' ||
        typeof data.type !== 'string'
      ) return;
      if (data.type === 'reveal-source') {
        // Static-preview click-to-source: validate the payload shape/path here
        // and let the host resolve it against the open workspace.
        const target = parseRevealMessage(data);
        if (target) {
          onRevealSource?.(target);
          onBehaviorEvent?.(createBehaviorEvent('click', {
            target: `<${target.tag}${target.id ? `#${target.id}` : ''}>`,
            path: target.path
          }));
        }
        return;
      }
      const time = new Date().toLocaleTimeString('en-US', { hour12: false });
      if (data.type === 'console-log' || data.type === 'console-info') {
        const message = typeof data.message === 'string' ? data.message : String(data.message ?? '');
        setLogs((prev) => [...prev.slice(-99), { type: 'log', message, timestamp: time }]);
      } else if (data.type === 'console-warn') {
        const message = typeof data.message === 'string' ? data.message : String(data.message ?? '');
        setLogs((prev) => [...prev.slice(-99), { type: 'warn', message, timestamp: time }]);
      } else if (data.type === 'console-error' || data.type === 'error') {
        const message = typeof data.message === 'string' ? data.message : 'Runtime error';
        setLogs((prev) => [...prev.slice(-99), { type: 'error', message, timestamp: time }]);
        setIsConsoleOpen(true);
        onRuntimeError(message);
        onBehaviorEvent?.(createBehaviorEvent('error', { target: 'preview', message }));
        // Also forward browser console errors to the agent context via localRuntimeLogs.
        onBrowserConsoleLog?.([{ type: 'error', message }]);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onBehaviorEvent, onRuntimeError, onRevealSource]);

  // Percentages can go stale in Electron when the panel resizes or loses a
  // scrollbar, so mirror the panel's content box onto the active preview frame.
  useEffect(() => {
    const stage = previewStageRef.current;
    if (!stage) return;

    let animationFrame = 0;
    const syncFrameSize = () => {
      const frame = previewFrameRef.current;
      if (!frame) return;

      const { width, height } = stage.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;

      const maxWidth = VIEWPORT_MAX_WIDTHS[viewport];
      frame.style.width = `${Math.max(1, Math.round(Math.min(width, maxWidth)))}px`;
      frame.style.height = `${Math.max(1, Math.round(height))}px`;
    };

    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(syncFrameSize);
    });
    observer.observe(stage);
    syncFrameSize();

    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [document, localPreviewState.status, localPreviewState.url, effectiveReloadKey, viewport]);

  const previewAddress = splitPreviewAddress(
    localPreviewState.status === 'ready' ? localPreviewState.url : null
  );

  const previewSurface = (
    <div className="@container flex-1 min-h-0 flex flex-col bg-base">
      {/* Top Navigation & Controls Toolbar */}
      <div className={`h-10 shrink-0 flex items-center justify-between px-3 border-b border-line bg-base/50 gap-2 ${fullscreen ? 'pr-36 lg:pr-40' : ''}`}>
        {/* Left: Stack info and live address bar */}
        <div className="flex items-center gap-2 min-w-0 flex-1 max-w-lg">
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-ink-3 truncate shrink-0">
            {isBundling && <Loader2 className="w-3 h-3 animate-spin text-accent shrink-0" />}
            {document?.stackType && (
              <span className="hidden sm:inline rounded border border-accent-line bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">
                {document.stackType}
              </span>
            )}
            {previewAssert && (
              <span
                title="Structured preview check after load"
                className={`rounded-full border px-2 py-0.5 text-[10px] font-mono shrink-0 ${
                  previewAssert === 'ok'
                    ? 'border-ok/30 bg-ok/[.08] text-ok'
                    : previewAssert === 'fatal'
                      ? 'border-danger/30 bg-danger/[.08] text-danger'
                      : 'border-warn/30 bg-warn/[.08] text-warn'
                }`}
              >
                check {previewAssert}
              </span>
            )}
            {localPreviewState.status === 'ready' && (
              localPreviewState.mode === 'dev' && localPreviewState.hmr !== false ? (
                <span
                  title="The dev server provides hot module replacement"
                  className="flex items-center gap-1 rounded-full border border-ok/30 bg-ok/[.08] px-2 py-0.5 text-[10px] font-mono text-ok shrink-0"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse" />
                  HMR
                </span>
              ) : null
            )}
            {localPreviewState.status === 'ready' && (() => {
              const port = previewPortOf(localPreviewState.url);
              return port === null ? null : (
                <span
                  title={`The local server is listening on port ${port}`}
                  className="rounded-full border border-line bg-overlay px-1.5 py-0.5 text-[10px] font-mono text-ink-3 shrink-0"
                >
                  :{port}
                </span>
              );
            })()}
          </span>

          {/* Sandbox indicator. There is no server to navigate to, so this shows
              what is currently mounted instead of pretending to be a URL bar. */}
          <div className="hidden @md:flex items-center flex-1 min-w-0 rounded-lg border border-line bg-overlay px-2.5 py-1 text-[11px] font-mono text-ink-3">
            <span className="text-ink-5 mr-1 select-none whitespace-nowrap">
              {previewAddress?.protocol ?? 'shadrox://'}
            </span>
            <span className="truncate text-ink-3">
              {previewAddress?.path ?? document?.source ?? 'no-workspace'}
            </span>
          </div>
        </div>

        {/* Right: Viewport, Console toggle, Send Errors, and Reload */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsConsoleOpen((open) => !open)}
            title="Toggle Console DevTools"
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
              isConsoleOpen
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-line text-ink-3 hover:border-line-2 hover:text-ink'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span className="hidden @sm:inline">Console</span>
            {displayedLogs.length > 0 && (
              <span className="ml-0.5 text-[10px] text-ink-3">({displayedLogs.length})</span>
            )}
          </button>

          {/* Send console errors to the agent context */}
          {displayedLogs.some((log) => log.type === 'error') && (
            <button
              type="button"
              onClick={() => {
                const errorLogs = displayedLogs
                  .filter((log) => log.type === 'error')
                  .slice(-10)
                  .map((log) => `[${log.timestamp}] ${log.message}`);
                onRuntimeError(
                  `Browser console errors (${errorLogs.length}):\n${errorLogs.join('\n')}`
                );
              }}
              title="Send console errors to the agent so it can fix preview crashes"
              className="flex items-center gap-1 rounded-lg border border-danger/40 bg-danger/[.10] px-2 py-1 text-[11px] font-mono text-danger hover:border-danger/60 hover:bg-danger/[.20] cursor-pointer"
            >
              <AlertTriangle className="w-3 h-3" />
              <span className="hidden @sm:inline">Send errors</span>
              <span className="text-[10px]">({displayedLogs.filter((l) => l.type === 'error').length})</span>
            </button>
          )}

          {/* Viewport size buttons */}
          <div className="hidden @sm:flex items-center gap-0.5 rounded-lg border border-line bg-overlay p-0.5">
            {VIEWPORT_SIZES.map((size) => {
              const Icon = VIEWPORT_ICONS[size];
              const isActive = size === viewport;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => onViewportChange(size)}
                  title={`${size.charAt(0).toUpperCase() + size.slice(1)} Viewport`}
                  className={`rounded-md p-1.5 transition-colors cursor-pointer ${
                    isActive ? 'bg-accent-strong text-white' : 'text-ink-4 hover:text-ink'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              if (!localPreviewAvailable) {
                setManualReloadKey((key) => key + 1);
                onDismissError();
              } else if (localPreviewState.status === 'ready') {
                setManualReloadKey((key) => key + 1);
              } else {
                onStartLocalPreview?.();
              }
            }}
            title={!localPreviewAvailable || localPreviewState.status === 'ready' ? 'Reload Preview' : 'Run Local Project'}
            disabled={localPreviewAvailable && localPreviewState.status === 'starting'}
            className="rounded-lg border border-line p-1.5 text-ink-4 transition-colors hover:border-line-2 hover:text-ink cursor-pointer"
          >
            {!localPreviewAvailable || localPreviewState.status === 'ready'
              ? <RefreshCw className="w-3.5 h-3.5" />
              : <Play className="w-3.5 h-3.5" />}
          </button>
          {localPreviewAvailable && (localPreviewState.status === 'ready' || localPreviewState.status === 'starting') && (
            <button
              type="button"
              onClick={onStopLocalPreview}
              title={localPreviewState.status === 'starting' ? 'Cancel project startup' : 'Stop Local Project'}
              aria-label={localPreviewState.status === 'starting' ? 'Cancel project startup' : 'Stop local project'}
              className="rounded-lg border border-line p-1.5 text-ink-4 transition-colors hover:border-danger/40 hover:text-danger cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={onToggleFullscreen}
            title={fullscreen ? 'Exit full screen (Esc)' : 'Full screen preview'}
            aria-pressed={fullscreen}
            className="rounded-lg border border-line p-1.5 text-ink-4 transition-colors hover:border-line-2 hover:text-ink cursor-pointer"
          >
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Close preview"
              aria-label="Close preview"
              className="rounded-lg border border-line p-1.5 text-ink-4 transition-colors hover:border-line-2 hover:text-ink cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Runtime Error Bar */}
      {runtimeError && (
        <div className="shrink-0 flex items-start gap-2 border-b border-danger/30 bg-danger/[.08] px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-danger mt-0.5 shrink-0" />
          <code className="flex-1 text-[11px] text-danger font-mono break-all">{runtimeError}</code>
          <button
            type="button"
            onClick={onDismissError}
            className="text-danger hover:text-danger cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Preview Container */}
      <div
        ref={previewStageRef}
        className="relative flex-1 min-h-0 min-w-0 overflow-hidden flex justify-center bg-[repeating-linear-gradient(45deg,var(--bg)_0,var(--bg)_10px,var(--bg-2)_10px,var(--bg-2)_20px)]"
      >
        {localPreviewAvailable && localPreviewState.status === 'ready' ? (
          // `allow-same-origin` stays for the dev server: dropping it makes the frame an
          // opaque origin, whose `Origin: null` module requests Vite/HMR reject and whose
          // localStorage/IndexedDB access throws, breaking the previewed app itself.
          // Untrusted frames are locked out of the desktop bridge instead — see
          // electron/preload.cjs and assertTrustedRenderer in electron/main.cjs.
          <PreviewIframe
            mode="local"
            reloadKey={effectiveReloadKey}
            url={localPreviewState.url}
            frameRef={setLocalFrameRef}
            onFramePaint={onFramePaint}
          />
        ) : localPreviewAvailable && previewProjects.length > 0 ? (
          <div className="w-full max-w-xl self-center px-6 py-8">
            <div className="flex items-center gap-2 text-sm text-ink font-medium">
              <FolderOpen className="w-4 h-4 text-accent" />
              Choose a folder to preview
            </div>
            <p className="mt-2 text-xs text-ink-4">
              {previewProjects[0]?.kind === 'static'
                ? 'Choose the nested static website folder to serve through ShadRox.'
                : 'More than one runnable app was found in this workspace.'}
            </p>
            <div className="mt-4 space-y-2">
              {previewProjects.map((project) => (
                <button
                  key={`${project.kind}:${project.projectPath}`}
                  type="button"
                  onClick={() => onChoosePreviewProject?.(project)}
                  className="w-full rounded-xl border border-line bg-overlay p-3 text-left transition-colors hover:border-accent-line hover:bg-overlay cursor-pointer"
                >
                  <span className="block text-xs text-ink font-mono">{project.projectPath}</span>
                  {project.kind === 'node' ? (
                    <>
                      <span className="mt-1 block text-[11px] text-ink-3">
                        {project.packageManager} run {project.scriptName} · {project.scriptCommand}
                      </span>
                      <span className="mt-1 block text-[10px] text-ink-4">
                        {project.missingDependencies.length > 0
                          ? `${project.missingDependencies.length} dependency package(s) will be installed when it starts`
                          : 'Dependencies appear to be installed'}
                      </span>
                    </>
                  ) : (
                    <span className="mt-1 block text-[11px] text-ink-3">Static website · served locally without running a project script</span>
                  )}
                </button>
              ))}
            </div>
            <button type="button" onClick={onCancelProjectSelection} className="mt-3 text-[11px] text-ink-4 hover:text-ink">Cancel</button>
          </div>
        ) : localPreviewAvailable && localPreviewState.status === 'starting' ? (
          <div className="self-center px-6 py-8 text-center">
            <Loader2 className="w-6 h-6 text-accent mx-auto animate-spin" />
            <p className="mt-3 text-xs text-ink-3 font-medium">Starting project inside ShadRox...</p>
            <p className="mt-1 max-w-xl text-[11px] text-ink-4">
              {previewStartMessage || 'Installing dependencies if needed, then launching its local server'}
            </p>
          </div>
        ) : localPreviewAvailable ? (
          <div className="max-w-md self-center px-6 py-8 text-center">
            <Play className="w-5 h-5 text-accent mx-auto" />
            <p className="mt-3 text-xs text-ink-2 font-medium">
              {localPreviewState.status === 'error' ? 'Preview failed to start' : 'Run this project locally in ShadRox'}
            </p>
            <p className="mt-2 text-[11px] text-ink-4">
              {localPreviewState.status === 'error'
                ? 'The project server reported the error below. Fix it in the code and run the preview again.'
                : 'ShadRox starts the project server automatically and installs any missing dependencies before it runs.'}
            </p>
            {localPreviewState.status === 'error' && (
              <pre className="mt-3 rounded-xl border border-danger/30 bg-danger/[.06] p-3 text-left font-mono text-[11px] leading-relaxed text-danger whitespace-pre-wrap break-words">
                {localPreviewState.message}
              </pre>
            )}
            <button
              type="button"
              onClick={onStartLocalPreview}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-accent-line bg-accent-soft px-3 py-2 text-xs text-accent transition-colors hover:bg-accent-soft cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              Run project
            </button>
          </div>
        ) : bundleError ? (
          <div className="w-full max-w-2xl self-center px-6 py-8">
            <div className="flex items-center gap-2 text-danger">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-semibold">Build Error</span>
            </div>
            <pre className="mt-3 rounded-xl border border-danger/30 bg-danger/[.06] p-3 font-mono text-[11px] leading-relaxed text-danger whitespace-pre-wrap break-words">
              {bundleError}
            </pre>
            <p className="mt-3 text-[11px] text-ink-4">
              Fix the reported build issue in the code editor, then retry the preview.
            </p>
          </div>
        ) : document ? (
          <PreviewIframe
            mode="static"
            reloadKey={effectiveReloadKey}
            srcDocHtml={document.html}
            frameRef={setDocumentFrameRef}
          />
        ) : isBundling ? (
          <div className="self-center px-6 py-8 text-center">
            <Loader2 className="w-6 h-6 text-accent mx-auto animate-spin" />
            <p className="mt-3 text-xs text-ink-3 font-medium">Preparing one-click preview...</p>
            <p className="mt-1 text-[11px] text-ink-4">Compiling project & resolving browser dependencies</p>
          </div>
        ) : (
          <div className="max-w-sm self-center px-6 py-8 text-center">
            <AlertTriangle className="w-5 h-5 text-ink-5 mx-auto" />
            <p className="mt-3 text-xs text-ink-3 leading-relaxed">{capabilityMessage}</p>
          </div>
        )}
      </div>

      {/* Dockable Console Drawer */}
      {isConsoleOpen && (
        <div className="h-44 shrink-0 border-t border-line bg-base flex flex-col font-mono text-xs">
          <div className="h-7 shrink-0 px-3 bg-base border-b border-line flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-ink-4 flex items-center gap-1.5">
              <Terminal className="w-3 h-3 text-ink-3" />
              Console Logs ({displayedLogs.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => localPreviewAvailable ? onClearLocalPreviewLogs?.() : setLogs([])}
                title="Clear console"
                className="text-ink-4 hover:text-ink transition-colors cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => setIsConsoleOpen(false)}
                title="Close console"
                className="text-ink-4 hover:text-ink transition-colors cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {displayedLogs.length === 0 ? (
              <div className="text-[11px] text-ink-5 italic px-2 py-1">No console output yet.</div>
            ) : (
              displayedLogs.map((log, idx) => (
                <div
                  key={idx}
                  className={`px-2 py-0.5 text-[11px] flex items-start gap-2 ${
                    log.type === 'error'
                      ? 'text-danger bg-danger/10'
                      : log.type === 'warn'
                        ? 'text-warn bg-warn/10'
                        : 'text-ink-3 hover:bg-overlay'
                  }`}
                >
                  <span className="text-ink-5 text-[10px] shrink-0">{log.timestamp}</span>
                  <span className="font-mono break-all">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );

  // No workspace id means no backend companion exists: keep the original
  // single-preview tree exactly as it was. Runtime detection is also skipped
  // until a preview run is actually engaged; mounting it on every folder open
  // was a measurable part of the startup stall.
  if (!workspaceId || !backendEnabled) return previewSurface;

  return (
    <div
      className={`flex-1 min-h-0 bg-base ${
        backendAvailable
          ? 'grid grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-2 lg:grid-rows-1'
          : 'flex flex-col'
      }`}
    >
      <div className="flex-1 min-h-0 min-w-0 flex flex-col">
        {backendAvailable && (
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-base px-3 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
            <Laptop className="w-3 h-3" aria-hidden="true" />
            Frontend
          </div>
        )}
        {previewSurface}
      </div>
      {/* Kept mounted so runtime detection keeps running, but hidden until a
          backend plan exists — otherwise the empty placeholder bar eats space. */}
      <div
        className={`min-w-0 ${
          backendAvailable
            ? 'min-h-0 flex flex-col border-t border-line lg:border-l lg:border-t-0'
            : 'hidden'
        }`}
      >
        <BackendPreview
          key={workspaceId}
          workspaceId={workspaceId}
          onRevealSource={onRevealSource}
          onAvailabilityChange={setBackendAvailable}
        />
      </div>
    </div>
  );
});
