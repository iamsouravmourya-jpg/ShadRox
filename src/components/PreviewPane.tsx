import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  Laptop,
  Loader2,
  Maximize2,
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
import type { DesktopPreviewOutput, DesktopPreviewState, PreviewProjectCandidate } from '../lib/desktop';

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

export function PreviewPane({
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
  lastReloadAt = null
}: PreviewPaneProps) {
  const [manualReloadKey, setManualReloadKey] = useState(0);
  const effectiveReloadKey = `${reloadKey}:${manualReloadKey}`;
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewStageRef = useRef<HTMLDivElement>(null);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const setDocumentFrameRef = useCallback((node: HTMLIFrameElement | null) => {
    iframeRef.current = node;
    previewFrameRef.current = node;
  }, []);
  const displayedLogs = localPreviewAvailable
    ? localPreviewLogs.map((entry) => ({
        type: entry.type === 'stderr' || entry.type === 'error' ? 'error' as const
          : entry.type === 'status' ? 'warn' as const
            : 'log' as const,
        message: entry.message,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false })
      }))
    : logs;

  useEffect(() => {
    if (!bundleError) return;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    setLogs((previous) => [...previous.slice(-99), { type: 'error', message: bundleError, timestamp }]);
    setIsConsoleOpen(true);
  }, [bundleError]);

  useEffect(() => {
    if (localPreviewState.status === 'error' || localPreviewState.status === 'starting') {
      setIsConsoleOpen(true);
    }
  }, [localPreviewState]);

  // Listen to iframe error and console bridge
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== iframeRef.current?.contentWindow ||
        !data ||
        data.source !== 'shadrox-preview' ||
        typeof data.type !== 'string'
      ) return;
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
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onRuntimeError]);

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

  const handleOpenNewWindow = () => {
    if (!document) return;
    const blob = new Blob([document.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  const previewAddress = splitPreviewAddress(
    localPreviewState.status === 'ready' ? localPreviewState.url : null
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ink-950">
      {/* Top Navigation & Controls Toolbar */}
      <div className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-white/[0.07] bg-ink-950/50 gap-2">
        {/* Left: Stack info and live address bar */}
        <div className="flex items-center gap-2 min-w-0 flex-1 max-w-lg">
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-neutral-400 truncate shrink-0">
            {isBundling && <Loader2 className="w-3 h-3 animate-spin text-violet-300 shrink-0" />}
            {document?.stackType && (
              <span className="hidden sm:inline rounded border border-violet-300/25 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-violet-300">
                {document.stackType}
              </span>
            )}
            {localPreviewState.status === 'ready' && (
              localPreviewState.mode === 'dev' && localPreviewState.hmr !== false ? (
                <span
                  title="The dev server provides hot module replacement"
                  className="flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/[.08] px-2 py-0.5 text-[10px] font-mono text-emerald-300 shrink-0"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  HMR
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onToggleAutoReload}
                  title={
                    autoReload
                      ? `Auto-reloading on file changes${lastReloadAt ? ` · last ${new Date(lastReloadAt).toLocaleTimeString()}` : ''} — click to pause`
                      : 'Auto reload paused — click to enable'
                  }
                  className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono transition-colors cursor-pointer shrink-0 ${
                    autoReload
                      ? 'border-emerald-500/25 bg-emerald-500/[.08] text-emerald-300 hover:bg-emerald-500/[.14]'
                      : 'border-white/[0.09] text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${autoReload ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-600'}`} />
                  {autoReload ? 'Live' : 'Manual'}
                </button>
              )
            )}
          </span>

          {/* Sandbox indicator. There is no server to navigate to, so this shows
              what is currently mounted instead of pretending to be a URL bar. */}
          <div className="hidden md:flex items-center flex-1 min-w-0 rounded-lg border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[11px] font-mono text-neutral-400">
            <span className="text-neutral-600 mr-1 select-none">
              {previewAddress?.protocol ?? 'shadrox://'}
            </span>
            <span className="truncate text-neutral-300">
              {previewAddress?.path ?? document?.source ?? 'no-workspace'}
            </span>
          </div>
        </div>

        {/* Right: Viewport, Console toggle, and Reload */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsConsoleOpen((open) => !open)}
            title="Toggle Console DevTools"
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors cursor-pointer ${
              isConsoleOpen
                ? 'border-violet-300/30 bg-violet-500/10 text-violet-200'
                : 'border-white/[0.09] text-neutral-400 hover:border-white/[0.15] hover:text-white'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Console</span>
            {displayedLogs.length > 0 && (
              <span className="ml-0.5 text-[10px] text-neutral-400">({displayedLogs.length})</span>
            )}
          </button>

          {/* Viewport size buttons */}
          <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.09] bg-white/[0.02] p-0.5">
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
                    isActive ? 'bg-violet-300 text-[#16121f]' : 'text-neutral-500 hover:text-white'
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
            className="rounded-lg border border-white/[0.09] p-1.5 text-neutral-500 transition-colors hover:border-white/[0.15] hover:text-white cursor-pointer"
          >
            {!localPreviewAvailable || localPreviewState.status === 'ready'
              ? <RefreshCw className="w-3.5 h-3.5" />
              : <Play className="w-3.5 h-3.5" />}
          </button>
          {localPreviewAvailable && localPreviewState.status === 'ready' && (
            <button
              type="button"
              onClick={onStopLocalPreview}
              title="Stop Local Project"
              className="rounded-lg border border-white/[0.09] p-1.5 text-neutral-500 transition-colors hover:border-red-500/40 hover:text-red-400 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            type="button"
            onClick={handleOpenNewWindow}
            title="Open in Full Window"
            disabled={!document || localPreviewAvailable}
            className="rounded-lg border border-white/[0.09] p-1.5 text-neutral-500 transition-colors hover:border-white/[0.15] hover:text-white disabled:opacity-40 cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Runtime Error Bar */}
      {runtimeError && (
        <div className="shrink-0 flex items-start gap-2 border-b border-red-500/25 bg-red-500/[.08] px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
          <code className="flex-1 text-[11px] text-red-300 font-mono break-all">{runtimeError}</code>
          <button
            type="button"
            onClick={onDismissError}
            className="text-red-400 hover:text-red-200 cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Preview Container */}
      <div
        ref={previewStageRef}
        className="relative flex-1 min-h-0 min-w-0 overflow-hidden flex justify-center bg-[repeating-linear-gradient(45deg,#0a0a0a_0,#0a0a0a_10px,#0d0d0d_10px,#0d0d0d_20px)]"
      >
        {localPreviewAvailable && localPreviewState.status === 'ready' ? (
          // `allow-same-origin` stays for the dev server: dropping it makes the frame an
          // opaque origin, whose `Origin: null` module requests Vite/HMR reject and whose
          // localStorage/IndexedDB access throws, breaking the previewed app itself.
          // Untrusted frames are locked out of the desktop bridge instead — see
          // electron/preload.cjs and assertTrustedRenderer in electron/main.cjs.
          <iframe
            key={effectiveReloadKey}
            ref={previewFrameRef}
            title="ShadRox Local Project Preview"
            src={localPreviewState.url}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
            className="block shrink-0 border-0 bg-ink-950 shadow-2xl"
            style={{ width: '100%', height: '100%' }}
          />
        ) : localPreviewAvailable && previewProjects.length > 0 ? (
          <div className="w-full max-w-xl self-center px-6 py-8">
            <div className="flex items-center gap-2 text-sm text-neutral-100 font-medium">
              <FolderOpen className="w-4 h-4 text-violet-300" />
              Choose a folder to preview
            </div>
            <p className="mt-2 text-xs text-neutral-500">
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
                  className="w-full rounded-xl border border-white/[0.09] bg-white/[0.03] p-3 text-left transition-colors hover:border-violet-300/45 hover:bg-white/[0.05] cursor-pointer"
                >
                  <span className="block text-xs text-neutral-100 font-mono">{project.projectPath}</span>
                  {project.kind === 'node' ? (
                    <>
                      <span className="mt-1 block text-[11px] text-neutral-400">
                        {project.packageManager} run {project.scriptName} · {project.scriptCommand}
                      </span>
                      <span className="mt-1 block text-[10px] text-neutral-500">
                        {project.missingDependencies.length > 0
                          ? `${project.missingDependencies.length} dependency package(s) need installation after approval`
                          : 'Dependencies appear to be installed'}
                      </span>
                    </>
                  ) : (
                    <span className="mt-1 block text-[11px] text-neutral-400">Static website · served locally without running a project script</span>
                  )}
                </button>
              ))}
            </div>
            <button type="button" onClick={onCancelProjectSelection} className="mt-3 text-[11px] text-neutral-500 hover:text-white">Cancel</button>
          </div>
        ) : localPreviewAvailable && localPreviewState.status === 'starting' ? (
          <div className="self-center px-6 py-8 text-center">
            <Loader2 className="w-6 h-6 text-violet-300 mx-auto animate-spin" />
            <p className="mt-3 text-xs text-neutral-300 font-medium">Starting project inside ShadRox...</p>
            <p className="mt-1 text-[11px] text-neutral-500">Installing dependencies if needed, then launching its local server</p>
          </div>
        ) : localPreviewAvailable ? (
          <div className="max-w-md self-center px-6 py-8 text-center">
            <Play className="w-5 h-5 text-violet-300 mx-auto" />
            <p className="mt-3 text-xs text-neutral-200 font-medium">Run this project locally in ShadRox</p>
            <p className="mt-2 text-[11px] text-neutral-500">
              ShadRox will start the project server here. If dependencies are missing, it can install them after you approve the run.
            </p>
            {localPreviewState.status === 'error' && (
              <pre className="mt-3 rounded-xl border border-red-500/25 bg-red-500/[.06] p-3 text-left font-mono text-[11px] leading-relaxed text-red-300 whitespace-pre-wrap break-words">
                {localPreviewState.message}
              </pre>
            )}
            <button
              type="button"
              onClick={onStartLocalPreview}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-violet-300/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-200 transition-colors hover:bg-violet-500/20 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              Run project
            </button>
          </div>
        ) : bundleError ? (
          <div className="w-full max-w-2xl self-center px-6 py-8">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-semibold">Build Error</span>
            </div>
            <pre className="mt-3 rounded-xl border border-red-500/25 bg-red-500/[.06] p-3 font-mono text-[11px] leading-relaxed text-red-300 whitespace-pre-wrap break-words">
              {bundleError}
            </pre>
            <p className="mt-3 text-[11px] text-neutral-500">
              Fix the reported build issue in the code editor, then retry the preview.
            </p>
          </div>
        ) : document ? (
          <iframe
            key={effectiveReloadKey}
            title="ShadRox Live Preview"
            srcDoc={document.html}
            ref={setDocumentFrameRef}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="block shrink-0 border-0 bg-ink-950 shadow-2xl"
            style={{ width: '100%', height: '100%' }}
          />
        ) : isBundling ? (
          <div className="self-center px-6 py-8 text-center">
            <Loader2 className="w-6 h-6 text-violet-300 mx-auto animate-spin" />
            <p className="mt-3 text-xs text-neutral-300 font-medium">Preparing one-click preview...</p>
            <p className="mt-1 text-[11px] text-neutral-500">Compiling project & resolving browser dependencies</p>
          </div>
        ) : (
          <div className="max-w-sm self-center px-6 py-8 text-center">
            <AlertTriangle className="w-5 h-5 text-neutral-600 mx-auto" />
            <p className="mt-3 text-xs text-neutral-400 leading-relaxed">{capabilityMessage}</p>
          </div>
        )}
      </div>

      {/* Dockable Console Drawer */}
      {isConsoleOpen && (
        <div className="h-44 shrink-0 border-t border-white/[0.07] bg-ink-950 flex flex-col font-mono text-xs">
          <div className="h-7 shrink-0 px-3 bg-ink-950 border-b border-white/[0.07] flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
              <Terminal className="w-3 h-3 text-neutral-400" />
              Console Logs ({displayedLogs.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => localPreviewAvailable ? onClearLocalPreviewLogs?.() : setLogs([])}
                title="Clear console"
                className="text-neutral-500 hover:text-white transition-colors cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => setIsConsoleOpen(false)}
                title="Close console"
                className="text-neutral-500 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {displayedLogs.length === 0 ? (
              <div className="text-[11px] text-neutral-600 italic px-2 py-1">No console output yet.</div>
            ) : (
              displayedLogs.map((log, idx) => (
                <div
                  key={idx}
                  className={`px-2 py-0.5 text-[11px] flex items-start gap-2 ${
                    log.type === 'error'
                      ? 'text-red-400 bg-red-950/20'
                      : log.type === 'warn'
                        ? 'text-amber-400 bg-amber-950/20'
                        : 'text-neutral-300 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="text-neutral-600 text-[10px] shrink-0">{log.timestamp}</span>
                  <span className="font-mono break-all">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
