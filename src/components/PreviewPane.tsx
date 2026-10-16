import { useState } from 'react';
import { AlertTriangle, Laptop, Loader2, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';
import type { ViewportSize } from '../lib/types';
import type { PreviewDocument } from '../lib/preview';

interface PreviewPaneProps {
  document: PreviewDocument | null;
  capabilityMessage: string;
  viewport: ViewportSize;
  onViewportChange: (viewport: ViewportSize) => void;
  runtimeError: string | null;
  onDismissError: () => void;
  /** True while esbuild-wasm is compiling the project. */
  isBundling?: boolean;
  /** Compile failure for the workspace, shown instead of an empty frame. */
  bundleError?: string | null;
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
  isBundling = false,
  bundleError = null
}: PreviewPaneProps) {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-neutral-950">
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
        <span className="flex items-center gap-2 text-[11px] text-neutral-500 truncate max-w-[50%]">
          {isBundling && <Loader2 className="w-3 h-3 animate-spin shrink-0" />}
          {document ? document.label : isBundling ? 'Project bundle ho raha hai...' : 'Preview unavailable'}
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center border border-neutral-800">
            {(Object.keys(VIEWPORT_WIDTHS) as ViewportSize[]).map((size) => {
              const Icon = VIEWPORT_ICONS[size];
              const isActive = size === viewport;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => onViewportChange(size)}
                  title={size}
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
            onClick={() => setReloadKey((key) => key + 1)}
            title="Reload preview"
            className="text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

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

      <div className="flex-1 min-h-0 overflow-auto flex justify-center bg-[repeating-linear-gradient(45deg,#0a0a0a_0,#0a0a0a_10px,#0d0d0d_10px,#0d0d0d_20px)]">
        {bundleError ? (
          <div className="w-full max-w-2xl self-center px-6 py-8">
            <div className="flex items-center gap-2 text-red-400">
              <AlertTriangle className="w-4 h-4" />
              <span className="text-xs font-semibold">Build fail hua</span>
            </div>
            <pre className="mt-3 border border-red-900/60 bg-red-950/20 p-3 text-[11px] leading-relaxed text-red-300 font-mono whitespace-pre-wrap break-words">
              {bundleError}
            </pre>
            <p className="mt-3 text-[11px] text-neutral-500">
              Code editor me file theek karo ya chat me error bhejo — Devora fix kar dega.
            </p>
          </div>
        ) : document ? (
          <iframe
            key={reloadKey}
            title="Devora preview"
            srcDoc={document.html}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="h-full border-0 bg-black"
            style={{ width: VIEWPORT_WIDTHS[viewport] }}
          />
        ) : isBundling ? (
          <div className="self-center px-6 py-8 text-center">
            <Loader2 className="w-5 h-5 text-neutral-500 mx-auto animate-spin" />
            <p className="mt-3 text-xs text-neutral-400">Project bundle ho raha hai...</p>
          </div>
        ) : (
          <div className="max-w-sm self-center px-6 py-8 text-center">
            <AlertTriangle className="w-5 h-5 text-neutral-600 mx-auto" />
            <p className="mt-3 text-xs text-neutral-400 leading-relaxed">{capabilityMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}
