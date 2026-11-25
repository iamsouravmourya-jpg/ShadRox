import { useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown, ChevronRight, FileCode2, FilePlus2, Loader2, X } from 'lucide-react';
import {
  acceptAllPendingChanges,
  acceptPendingChange,
  getPendingSnapshot,
  rejectAllPendingChanges,
  rejectPendingChange,
  subscribePendingChanges
} from '../../lib/agent/pendingChanges';

interface PendingChangesBarProps {
  workspaceId: string | null;
  onOpenFile?: (path: string) => void;
  onNotify?: (message: string) => void;
}

export function PendingChangesBar({ workspaceId, onOpenFile, onNotify }: PendingChangesBarProps) {
  const snapshot = useSyncExternalStore(
    subscribePendingChanges,
    () => getPendingSnapshot(workspaceId),
    () => getPendingSnapshot(workspaceId)
  );
  const [expanded, setExpanded] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [busyAll, setBusyAll] = useState(false);

  if (snapshot.entries.length === 0) return null;

  const handleAcceptAll = async () => {
    if (busyAll) return;
    setBusyAll(true);
    try {
      const result = await acceptAllPendingChanges(workspaceId);
      if (!result.ok && result.errors.length > 0) {
        onNotify?.(`Could not save all changes: ${result.errors[0]}`);
      } else if (result.savedPaths.length > 0) {
        onNotify?.(`Accepted ${result.savedPaths.length} pending file edit${result.savedPaths.length === 1 ? '' : 's'}.`);
      }
    } finally {
      setBusyAll(false);
    }
  };

  const handleRejectAll = () => {
    if (busyAll) return;
    const result = rejectAllPendingChanges(workspaceId);
    if (result.revertedPaths.length > 0) {
      onNotify?.(`Reverted ${result.revertedPaths.length} staged edit${result.revertedPaths.length === 1 ? '' : 's'}.`);
    }
  };

  const handleAcceptOne = async (path: string) => {
    if (busyAll || busyPath) return;
    setBusyPath(path);
    try {
      const result = await acceptPendingChange(workspaceId, path);
      if (!result.ok && result.error) {
        onNotify?.(result.error);
      }
    } finally {
      setBusyPath(null);
    }
  };

  const handleRejectOne = (path: string) => {
    if (busyAll || busyPath) return;
    rejectPendingChange(workspaceId, path);
  };

  return (
    <div
      data-testid="pending-changes-bar"
      className="mb-2 overflow-hidden rounded-xl border border-line-2 bg-surface/95 shadow-[var(--shadow-panel)]"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-2/60">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex min-w-0 items-center gap-1.5 text-left text-[11px] font-medium text-ink hover:text-accent transition-colors cursor-pointer"
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          )}
          <span className="truncate">
            {snapshot.entries.length} pending {snapshot.entries.length === 1 ? 'change' : 'changes'}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-ok">+{snapshot.totalAdded}</span>
          <span className="font-mono text-[10px] tabular-nums text-danger">-{snapshot.totalRemoved}</span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={busyAll || Boolean(busyPath)}
            onClick={handleRejectAll}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-base px-2 py-0.5 text-[10.5px] font-medium text-ink-2 transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40 cursor-pointer"
          >
            <X className="h-3 w-3" />
            Reject All
          </button>
          <button
            type="button"
            disabled={busyAll || Boolean(busyPath)}
            onClick={() => void handleAcceptAll()}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-0.5 text-[10.5px] font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-40 cursor-pointer"
          >
            {busyAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Accept All
          </button>
        </div>
      </div>

      {expanded && (
        <ul className="max-h-36 divide-y divide-line/60 overflow-y-auto border-t border-line/70">
          {snapshot.entries.map((entry) => {
            const isBusy = busyAll || busyPath === entry.path;
            return (
              <li
                key={entry.path}
                className="flex items-center justify-between gap-2 px-3 py-1 text-[11px] hover:bg-surface-2/40 transition-colors"
              >
                <button
                  type="button"
                  onClick={() => onOpenFile?.(entry.path)}
                  title={`Open ${entry.path}`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-[10.5px] text-ink-2 hover:text-ink cursor-pointer"
                >
                  {entry.created ? (
                    <FilePlus2 className="h-3 w-3 shrink-0 text-ok" />
                  ) : (
                    <FileCode2 className="h-3 w-3 shrink-0 text-accent" />
                  )}
                  <span className="truncate">{entry.path}</span>
                  {entry.created && (
                    <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-ok">New</span>
                  )}
                </button>

                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[10px] tabular-nums text-ok">+{entry.addedLines}</span>
                  <span className="font-mono text-[10px] tabular-nums text-danger">-{entry.removedLines}</span>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleRejectOne(entry.path)}
                    aria-label={`Reject ${entry.path}`}
                    title={`Reject ${entry.path}`}
                    className="rounded border border-line bg-base p-0.5 text-ink-3 transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-40 cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleAcceptOne(entry.path)}
                    aria-label={`Accept ${entry.path}`}
                    title={`Accept ${entry.path}`}
                    className="rounded border border-accent-line bg-accent-soft p-0.5 text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-40 cursor-pointer"
                  >
                    {busyPath === entry.path ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
