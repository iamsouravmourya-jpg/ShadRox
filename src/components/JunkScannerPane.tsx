import { useMemo, useState, useEffect } from 'react';
import { Trash2, Loader2, Play, Square, AlertTriangle, FileCode, FolderClosed, ShieldCheck } from 'lucide-react';
import type { ShadRoxDesktopAPI } from '../lib/desktop';

interface JunkScannerPaneProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  onClose: () => void;
}

type ConfidenceLevel = 'high' | 'review';
type ConfidenceFilter = 'all' | 'high' | 'review';

interface UnusedFile {
  path: string;
  size: number;
  mtime: number;
  confidence?: ConfidenceLevel;
}

interface ScanResult {
  unusedFiles: UnusedFile[];
  deadFolders: string[];
  stats: {
    total: number;
    unused: number;
    reclaimableBytes: number;
    highConfidenceCount?: number;
    reviewCount?: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getFileConfidence(file: UnusedFile): ConfidenceLevel {
  if (file.confidence === 'high' || file.confidence === 'review') return file.confidence;
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|css|scss|sass|less|vue|svelte)$/i.test(file.path)
    ? 'high'
    : 'review';
}

export function JunkScannerPane({ desktop, workspaceId, onClose }: JunkScannerPaneProps) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ step?: string; message?: string; current?: number; total?: number } | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);
  const [filter, setFilter] = useState<ConfidenceFilter>('all');

  useEffect(() => {
    if (!desktop || !workspaceId) return;
    const unsubscribe = desktop.onJunkScanProgress?.((event) => {
      if (event.workspaceId === workspaceId) {
        setProgress(event);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [desktop, workspaceId]);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    setProgress({ message: 'Starting junk scan...' });
    try {
      const res = await desktop.scanJunk?.(workspaceId);
      if (res) {
        setResult(res);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to complete junk scan.');
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const cancelScan = async () => {
    try {
      await desktop.cancelJunkScan?.(workspaceId);
    } catch {
      // ignore cancellation race
    }
    setScanning(false);
    setProgress(null);
  };

  const confirmDelete = async (targetPath: string) => {
    setTrashing(targetPath);
    try {
      await desktop.trashItem?.(workspaceId, targetPath);
      if (result) {
        const nextFiles = result.unusedFiles.filter((f) => f.path !== targetPath && !f.path.startsWith(`${targetPath}/`));
        const nextFolders = result.deadFolders.filter((d) => d !== targetPath && !d.startsWith(`${targetPath}/`));
        const reclaimableBytes = nextFiles.reduce((acc, f) => acc + f.size, 0);
        const highConfidenceCount = nextFiles.filter((f) => getFileConfidence(f) === 'high').length;
        const reviewCount = nextFiles.length - highConfidenceCount;
        setResult({
          ...result,
          unusedFiles: nextFiles,
          deadFolders: nextFolders,
          stats: {
            ...result.stats,
            unused: nextFiles.length,
            reclaimableBytes,
            highConfidenceCount,
            reviewCount
          }
        });
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to move ${targetPath} to Recycle Bin.`);
    } finally {
      setTrashing(null);
      setConfirmPath(null);
    }
  };

  const counts = useMemo(() => {
    if (!result) return { all: 0, high: 0, review: 0 };
    let high = 0;
    let review = 0;
    for (const file of result.unusedFiles) {
      if (getFileConfidence(file) === 'high') high += 1;
      else review += 1;
    }
    return { all: result.unusedFiles.length, high, review };
  }, [result]);

  const filteredFiles = useMemo(() => {
    if (!result) return [];
    if (filter === 'all') return result.unusedFiles;
    return result.unusedFiles.filter((file) => getFileConfidence(file) === filter);
  }, [result, filter]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-base text-ink select-none">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-2 min-w-0">
          <Trash2 className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-2">
            Junk Scanner
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {!scanning ? (
            <button
              type="button"
              onClick={() => void runScan()}
              className="flex items-center gap-1 rounded-md border border-accent-line bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:brightness-110 cursor-pointer"
            >
              <Play className="h-3 w-3" />
              Scan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void cancelScan()}
              className="flex items-center gap-1 rounded-md border border-danger/30 bg-danger/15 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/25 cursor-pointer"
            >
              <Square className="h-3 w-3" />
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-4 transition-colors hover:text-ink cursor-pointer"
            title="Close junk scanner"
            aria-label="Close junk scanner"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1 break-words">{error}</span>
        </div>
      )}

      {scanning && (
        <div className="border-b border-line bg-base-2 px-3 py-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-ink-3">
            <span className="truncate">{progress?.message || 'Scanning workspace...'}</span>
            {progress?.total ? (
              <span className="font-mono text-[11px] tabular-nums">
                {progress.current ?? 0} / {progress.total}
              </span>
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{
                width:
                  progress?.total && progress?.current
                    ? `${Math.min(100, (progress.current / progress.total) * 100)}%`
                    : '100%',
                opacity: progress?.total ? 1 : 0.6
              }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        {!result && !scanning && !error && (
          <div className="flex h-full flex-col items-center justify-center p-5 text-center text-ink-4">
            <div className="mb-3 grid size-11 place-items-center rounded-xl border border-line bg-surface">
              <ShieldCheck className="h-5 w-5 text-accent" strokeWidth={1.6} />
            </div>
            <p className="text-xs font-semibold text-ink-2">100% Offline Static Reachability Scan</p>
            <p className="mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-ink-4">
              Finds unreachable modules and assets while automatically preserving edge functions, workers, Prisma/Drizzle
              schemas, scripts, and quoted assets. Moves items safely to OS Trash.
            </p>
            <button
              type="button"
              onClick={() => void runScan()}
              className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent-strong px-4 py-2 text-xs font-semibold text-white transition-all hover:brightness-110 cursor-pointer"
            >
              <Play className="h-3.5 w-3.5" />
              Start Junk Scan
            </button>
          </div>
        )}

        {result && (
          <div>
            <div className="mb-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-line bg-surface p-2.5">
                <span className="text-[10px] uppercase tracking-wider text-ink-4">Unused Items</span>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-ink">
                  {result.stats.unused}{' '}
                  <span className="text-xs font-normal text-ink-4">/ {result.stats.total}</span>
                </p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-2.5">
                <span className="text-[10px] uppercase tracking-wider text-ink-4">Reclaimable</span>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-accent">
                  {formatBytes(result.stats.reclaimableBytes)}
                </p>
              </div>
            </div>

            {result.deadFolders.length > 0 && (
              <div className="mb-4">
                <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-3 tabular-nums">
                  Dead Folders ({result.deadFolders.length})
                </h3>
                <div className="space-y-1.5">
                  {result.deadFolders.map((folder) => (
                    <div
                      key={folder}
                      className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderClosed className="h-3.5 w-3.5 shrink-0 text-warn" />
                        <span className="truncate font-mono text-xs text-ink-2">{folder}/</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setConfirmPath(folder)}
                        disabled={trashing === folder}
                        className="flex shrink-0 items-center gap-1 rounded border border-danger/25 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-40 cursor-pointer"
                      >
                        {trashing === folder ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        Trash
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-3 tabular-nums">
                  Unused Files ({filteredFiles.length})
                </h3>
              </div>

              <div
                role="tablist"
                aria-label="Filter unused files by confidence"
                className="mb-2.5 grid grid-cols-3 gap-1 rounded-lg border border-line bg-base-2 p-0.5"
              >
                {(
                  [
                    { id: 'all', label: `All (${counts.all})` },
                    { id: 'high', label: `High (${counts.high})` },
                    { id: 'review', label: `Review (${counts.review})` }
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === tab.id}
                    onClick={() => setFilter(tab.id)}
                    className={`rounded-md px-1.5 py-1 text-[10px] font-medium tabular-nums transition-colors cursor-pointer ${
                      filter === tab.id
                        ? 'bg-surface text-ink shadow-xs'
                        : 'text-ink-4 hover:text-ink-2'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {filteredFiles.length === 0 ? (
                <p className="py-5 text-center text-xs text-ink-4">
                  {result.unusedFiles.length === 0
                    ? 'No unused files found — your project graph is clean.'
                    : 'No files match this confidence filter.'}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {filteredFiles.map((file) => {
                    const confidence = getFileConfidence(file);
                    return (
                      <div
                        key={file.path}
                        className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-2"
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          <FileCode className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cool" />
                          <div className="min-w-0">
                            <p className="truncate font-mono text-xs text-ink" title={file.path}>
                              {file.path}
                            </p>
                            <div className="mt-1 flex items-center gap-1.5">
                              <span
                                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${
                                  confidence === 'high'
                                    ? 'border border-ok/25 bg-ok/10 text-ok'
                                    : 'border border-warn/25 bg-warn/10 text-warn'
                                }`}
                              >
                                {confidence === 'high' ? 'High Confidence' : 'Needs Review'}
                              </span>
                              <span className="font-mono text-[10px] tabular-nums text-ink-4">
                                {formatBytes(file.size)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setConfirmPath(file.path)}
                          disabled={trashing === file.path}
                          className="flex shrink-0 items-center gap-1 rounded border border-danger/25 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger transition-colors hover:bg-danger/20 disabled:opacity-40 cursor-pointer"
                        >
                          {trashing === file.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          Trash
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {confirmPath && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-2xl">
            <h3 className="text-sm font-bold text-ink">Move to Recycle Bin?</h3>
            <p className="mt-2 break-all rounded border border-line bg-base p-2 font-mono text-xs text-ink-3">
              {confirmPath}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-ink-4">
              This safely moves the item to your OS Recycle Bin / Trash. You can restore it from your system trash if needed.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmPath(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:bg-overlay cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete(confirmPath)}
                className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-danger/90 cursor-pointer"
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
