import { useCallback, useEffect, useMemo, useState } from 'react';
import { betaLogger, type BetaLogEntry, type BetaLogLevel } from '../lib/betaLogger';

export interface BetaDebugLogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type LevelFilter = 'all' | BetaLogLevel;

const LEVEL_BADGE_CLASSES: Record<BetaLogLevel, string> = {
  info: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-300'
};

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return String(timestamp);
  }
}

export function BetaDebugLogModal({ isOpen, onClose }: BetaDebugLogModalProps) {
  const [entries, setEntries] = useState<BetaLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const recent = await betaLogger.getMergedRecent(500);
      setEntries(recent);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setCopied(false);
    void loadEntries();
  }, [isOpen, loadEntries]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const sources = useMemo(() => {
    const distinct = new Set<string>();
    for (const entry of entries) {
      if (entry.source) distinct.add(entry.source);
    }
    return ['all', ...[...distinct].sort()];
  }, [entries]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (levelFilter !== 'all' && entry.level !== levelFilter) return false;
      if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false;
      if (!q) return true;
      const metaText = entry.meta ? JSON.stringify(entry.meta).toLowerCase() : '';
      return (
        entry.event.toLowerCase().includes(q) ||
        entry.source.toLowerCase().includes(q) ||
        entry.message.toLowerCase().includes(q) ||
        metaText.includes(q)
      );
    });
  }, [entries, levelFilter, sourceFilter, searchQuery]);

  const handleCopyDiagnostics = useCallback(async () => {
    const bundle = betaLogger.formatClipboardBundle(filtered.length > 0 ? filtered : entries);
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(bundle);
      } else {
        const area = document.createElement('textarea');
        area.value = bundle;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard failure is non-fatal */
    }
  }, [filtered, entries]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="beta-debug-logs-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[82vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <div>
            <h2 id="beta-debug-logs-title" className="text-sm font-semibold text-ink">
              ShadRox Beta Diagnostics Log
            </h2>
            <p className="mt-0.5 text-[11px] text-ink-3">
              Redacted local telemetry buffer (API keys and user home paths stripped). Shortcut: Ctrl+Shift+L
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadEntries()}
              disabled={loading}
              className="rounded-lg border border-line bg-base px-2.5 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-line-2 hover:text-ink disabled:opacity-50"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyDiagnostics()}
              className="rounded-lg border border-accent-line bg-accent/15 px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-accent/25"
            >
              {copied ? 'Copied Diagnostics' : 'Copy Diagnostics'}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close diagnostics log"
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-base/50 px-5 py-2.5">
          <div className="flex items-center gap-1 rounded-lg border border-line bg-base p-0.5">
            {(['all', 'error', 'warn', 'info'] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setLevelFilter(level)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                  levelFilter === level
                    ? 'bg-surface text-ink shadow-sm'
                    : 'text-ink-3 hover:text-ink-2'
                }`}
              >
                {level}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by source"
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
            className="rounded-lg border border-line bg-base px-2.5 py-1 text-xs text-ink-2 outline-none focus:border-accent-line"
          >
            {sources.map((source) => (
              <option key={source} value={source}>
                {source === 'all' ? 'All sources' : source}
              </option>
            ))}
          </select>

          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Filter by event, message, or metadata..."
            className="min-w-[200px] flex-1 rounded-lg border border-line bg-base px-3 py-1 text-xs text-ink placeholder:text-ink-3 outline-none focus:border-accent-line"
          />

          <span className="text-[11px] tabular-nums text-ink-3">
            {filtered.length} / {entries.length} events
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 font-mono text-[11px]">
          {filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center text-ink-3">
              <p className="text-xs font-medium text-ink-2">No diagnostic events match the current filter.</p>
              <p className="max-w-md text-[11px]">
                Autonomous runs, checkpoint restores, and runtime IPC diagnostics are recorded here automatically.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-xl border border-line bg-base/60 px-3.5 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums text-ink-3">{formatTime(entry.timestamp)}</span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LEVEL_BADGE_CLASSES[entry.level]}`}
                    >
                      {entry.level}
                    </span>
                    <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] text-ink-2">
                      {entry.source}
                    </span>
                    <span className="font-semibold text-ink">{entry.event}</span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-ink-2">{entry.message}</p>
                  {entry.meta && Object.keys(entry.meta).length > 0 && (
                    <pre className="mt-1.5 overflow-x-auto rounded-lg border border-line/70 bg-surface/60 px-2.5 py-1.5 text-[10px] text-ink-3">
                      {JSON.stringify(entry.meta)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
