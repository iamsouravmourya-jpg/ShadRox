import { useState } from 'react';
import { AlertTriangle, Laptop, RefreshCw, Smartphone, Tablet, X } from 'lucide-react';
import type { ViewportSize } from '../lib/types';
import type { PreviewDocument } from '../lib/preview';

interface PreviewPaneProps {
  document: PreviewDocument | null;
  capabilityMessage: string;
  viewport: ViewportSize;
  onViewportChange: (viewport: ViewportSize) => void;
  runtimeError: string | null;
  onDismissError: () => void;
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
  onDismissError
}: PreviewPaneProps) {
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-neutral-950">
      <div className="h-9 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
        <span className="text-[11px] text-neutral-500 truncate max-w-[50%]">
          {document ? document.label : 'Preview unavailable'}
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
        {document ? (
          <iframe
            key={reloadKey}
            title="Devora preview"
            srcDoc={document.html}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className="h-full border-0 bg-black"
            style={{ width: VIEWPORT_WIDTHS[viewport] }}
          />
        ) : (
          <div className="max-w-sm self-center px-6 py-8 text-center">
            <AlertTriangle className="w-5 h-5 text-neutral-600 mx-auto" />
            <p className="mt-3 text-xs text-neutral-400 leading-relaxed">{capabilityMessage}</p>
            <p className="mt-3 text-[11px] text-neutral-600 leading-relaxed">
              Live React/TSX bundling next phase me aayega. Tab tak .html aur .md files ka real preview milega.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
