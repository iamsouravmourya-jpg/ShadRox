import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  Laptop,
  Loader2,
  Maximize2,
  RefreshCw,
  Smartphone,
  Tablet,
  Terminal,
  Trash2,
  X
} from 'lucide-react';
import type { ViewportSize } from '../lib/types';
import type { PreviewDocument } from '../lib/preview';

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
}

interface ConsoleEntry {
  type: 'log' | 'error' | 'warn';
  message: string;
  timestamp: string;
}

const VIEWPORT_WIDTHS: Record<ViewportSize, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px'
};

const VIEWPORT_ICONS: Record<ViewportSize, typeof Laptop> = {
  desktop: Laptop,
  tablet: Tablet,
  mobile: Smartphone
};

export function PreviewPane({
  document,
  capabilityMessage,
  viewport,
  onViewportChange,
  runtimeError,
  onDismissError,
  onRuntimeError,
  isBundling = false,
  bundleError = null
}: PreviewPaneProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

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
        onRuntimeError(message);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onRuntimeError]);

  const handleOpenNewWindow = () => {
    if (!document) return;
    const blob = new Blob([document.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-neutral-950">
      {/* Top Navigation & Controls Toolbar */}
      <div className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900 bg-black/50 gap-2">
        {/* Left: Stack info and live address bar */}
        <div className="flex items-center gap-2 min-w-0 flex-1 max-w-lg">
          <span className="flex items-center gap-1.5 text-[11px] font-mono text-neutral-400 truncate shrink-0">
            {isBundling && <Loader2 className="w-3 h-3 animate-spin text-emerald-400 shrink-0" />}
            {document?.stackType && (
              <span className="hidden sm:inline px-1.5 py-0.5 border border-emerald-900/60 bg-emerald-950/30 text-emerald-400 text-[10px] uppercase font-semibold">
                {document.stackType}
              </span>
            )}
          </span>

          {/* Sandbox indicator. There is no server to navigate to, so this shows
              what is currently mounted instead of pretending to be a URL bar. */}
          <div className="hidden md:flex items-center flex-1 min-w-0 bg-neutral-900/70 border border-neutral-800 rounded px-2 py-0.5 text-[11px] text-neutral-400 font-mono">
            <span className="text-neutral-600 mr-1 select-none">shadrox://</span>
            <span className="truncate text-neutral-300">{document?.source || 'no-workspace'}</span>
          </div>
        </div>

        {/* Right: Viewport, Console toggle, and Reload */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setIsConsoleOpen((open) => !open)}
            title="Toggle Console DevTools"
            className={`flex items-center gap-1 px-2 py-1 border text-[11px] font-mono transition-colors cursor-pointer ${
              isConsoleOpen
                ? 'border-emerald-800/70 bg-emerald-950/30 text-emerald-300'
                : 'border-neutral-800 text-neutral-400 hover:text-white'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Console</span>
            {logs.length > 0 && (
              <span className="ml-0.5 text-[10px] text-neutral-400">({logs.length})</span>
            )}
          </button>

          {/* Viewport size buttons */}
          <div className="flex items-center border border-neutral-800">
            {(Object.keys(VIEWPORT_WIDTHS) as ViewportSize[]).map((size) => {
              const Icon = VIEWPORT_ICONS[size];
              const isActive = size === viewport;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => onViewportChange(size)}
                  title={`${size.charAt(0).toUpperCase() + size.slice(1)} Viewport`}
                  className={`p-1.5 transition-colors cursor-pointer ${
                    isActive ? 'bg-white text-black' : 'text-neutral-500 hover:text-white'
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
              setReloadKey((key) => key + 1);
              onDismissError();
            }}
            title="Reload Preview"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer border border-neutral-800"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={handleOpenNewWindow}
            title="Open in Full Window"
            disabled={!document}
            className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-40 transition-colors cursor-pointer border border-neutral-800"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Runtime Error Bar */}
      {runtimeError && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 bg-red-950/40 border-b border-red-900/60">
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
      <div className="flex-1 min-h-0 overflow-auto flex justify-center bg-[repeating-linear-gradient(45deg,#0a0a0a_0,#0a0a0a_10px,#0d0d0d_10px,#0d0d0d_20px)]">
        {bundleError ? (
          <div className="w-full max-w-2xl self-center px-6 py-8">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-semibold">Build Error</span>
            </div>
            <pre className="mt-3 border border-red-900/60 bg-red-950/20 p-3 text-[11px] leading-relaxed text-red-300 font-mono whitespace-pre-wrap break-words">
              {bundleError}
            </pre>
            <p className="mt-3 text-[11px] text-neutral-500">
              Fix the reported build issue in the code editor, then retry the preview.
            </p>
          </div>
        ) : document ? (
          <iframe
            key={reloadKey}
            title="ShadRox Live Preview"
            srcDoc={document.html}
            ref={iframeRef}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="h-full border-0 bg-black transition-all duration-200 shadow-2xl"
            style={{ width: VIEWPORT_WIDTHS[viewport] }}
          />
        ) : isBundling ? (
          <div className="self-center px-6 py-8 text-center">
            <Loader2 className="w-6 h-6 text-emerald-400 mx-auto animate-spin" />
            <p className="mt-3 text-xs text-neutral-300 font-medium">Bundling project with ShadRox VFS...</p>
            <p className="mt-1 text-[11px] text-neutral-500">Compiling TypeScript & resolving modules</p>
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
        <div className="h-44 shrink-0 border-t border-neutral-900 bg-black flex flex-col font-mono text-xs">
          <div className="h-7 shrink-0 px-3 bg-neutral-950 border-b border-neutral-900 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
              <Terminal className="w-3 h-3 text-neutral-400" />
              Console Logs ({logs.length})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLogs([])}
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
            {logs.length === 0 ? (
              <div className="text-[11px] text-neutral-600 italic px-2 py-1">No console output yet.</div>
            ) : (
              logs.map((log, idx) => (
                <div
                  key={idx}
                  className={`px-2 py-0.5 text-[11px] flex items-start gap-2 ${
                    log.type === 'error'
                      ? 'text-red-400 bg-red-950/20'
                      : log.type === 'warn'
                        ? 'text-amber-400 bg-amber-950/20'
                        : 'text-neutral-300 hover:bg-neutral-900/40'
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
