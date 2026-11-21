import { useState, useEffect, useCallback } from 'react';
import { Trash2, Loader2, Play, Square, AlertTriangle, FileCode, FolderClosed, RefreshCw } from 'lucide-react';
import type { ShadRoxDesktopAPI } from '../lib/desktop';

interface JunkScannerPaneProps {
  desktop: ShadRoxDesktopAPI;
  workspaceId: string;
  onClose: () => void;
}

interface UnusedFile {
  path: string;
  size: number;
  mtime: number;
}

interface ScanResult {
  unusedFiles: UnusedFile[];
  deadFolders: string[];
  stats: {
    total: number;
    unused: number;
    reclaimableBytes: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function JunkScannerPane({ desktop, workspaceId, onClose }: JunkScannerPaneProps) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ step?: string; message?: string; current?: number; total?: number } | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<string | null>(null);

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
    } catch (err: any) {
      setError(err?.message || 'Failed to complete junk scan.');
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const cancelScan = async () => {
    try {
      await desktop.cancelJunkScan?.(workspaceId);
    } catch {
      // ignore
    }
    setScanning(false);
    setProgress(null);
  };

  const confirmDelete = async (targetPath: string) => {
    setTrashing(targetPath);
    try {
      await desktop.trashItem(workspaceId, targetPath);
      // Update local result state
      if (result) {
        const nextFiles = result.unusedFiles.filter((f) => f.path !== targetPath);
        const nextFolders = result.deadFolders.filter((d) => d !== targetPath);
        const removed = result.unusedFiles.find((f) => f.path === targetPath);
        const removedBytes = removed ? removed.size : 0;
        setResult({
          ...result,
          unusedFiles: nextFiles,
          deadFolders: nextFolders,
          stats: {
            ...result.stats,
            unused: nextFiles.length,
            reclaimableBytes: Math.max(0, result.stats.reclaimableBytes - removedBytes)
          }
        });
      }
    } catch (err: any) {
      setError(err?.message || `Failed to move ${targetPath} to Recycle Bin.`);
    } finally {
      setTrashing(null);
      setConfirmPath(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base text-ink select-none">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-2">Junk &amp; Dead-Code Scanner</span>
        </div>
        <div className="flex items-center gap-1.5">
          {!scanning ? (
            <button
              type="button"
              onClick={() => void runScan()}
              className="flex items-center gap-1 rounded bg-accent/20 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/30 cursor-pointer"
            >
              <Play className="h-3 w-3" />
              Run Scan
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void cancelScan()}
              className="flex items-center gap-1 rounded bg-danger/20 px-2.5 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger/30 cursor-pointer"
            >
              <Square className="h-3 w-3" />
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-4 transition-colors hover:text-ink cursor-pointer"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {scanning && (
        <div className="border-b border-line bg-base-2 px-3 py-3">
          <div className="flex items-center justify-between text-xs text-ink-3 mb-1.5">
            <span className="truncate">{progress?.message || 'Scanning workspace...'}</span>
            {progress?.total ? (
              <span>{progress.current} / {progress.total}</span>
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay">
            <div
              className="h-full bg-accent transition-all duration-300"
              style={{
                width: progress?.total && progress?.current ? `${Math.min(100, (progress.current / progress.total) * 100)}%` : '100%',
                opacity: progress?.total ? 1 : 0.6
              }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        {!result && !scanning && !error && (
          <div className="flex h-full flex-col items-center justify-center text-center p-6 text-ink-4">
            <Trash2 className="h-10 w-10 mb-3 text-ink-5 stroke-1" />
            <p className="text-xs font-medium text-ink-2">Analyze your project for dead code and orphaned assets.</p>
            <p className="text-[11px] text-ink-4 mt-1 max-w-[260px]">
              Finds unused files and empty/dead folders with 100% offline static analysis. Safely move items to Recycle Bin.
            </p>
            <button
              type="button"
              onClick={() => void runScan()}
              className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white shadow hover:bg-accent-strong cursor-pointer"
            >
              <Play className="h-3.5 w-3.5" />
              Start Junk Scan
            </button>
          </div>
        )}

        {result && (
          <div>
            <div className="mb-4 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-line bg-surface p-2.5">
                <span className="text-[10px] uppercase tracking-wider text-ink-4">Unused Items</span>
                <p className="text-lg font-bold text-ink mt-0.5">{result.stats.unused} <span className="text-xs font-normal text-ink-4">files</span></p>
              </div>
              <div className="rounded-xl border border-line bg-surface p-2.5">
                <span className="text-[10px] uppercase tracking-wider text-ink-4">Reclaimable Space</span>
                <p className="text-lg font-bold text-accent mt-0.5">{formatBytes(result.stats.reclaimableBytes)}</p>
              </div>
            </div>

            {result.deadFolders.length > 0 && (
              <div className="mb-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">Dead Folders ({result.deadFolders.length})</h3>
                <div className="space-y-1.5">
                  {result.deadFolders.map((folder) => (
                    <div key={folder} className="flex items-center justify-between rounded-lg border border-line bg-surface px-2.5 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FolderClosed className="h-4 w-4 shrink-0 text-warn" />
                        <span className="truncate font-mono text-xs text-ink-2">{folder}/</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setConfirmPath(folder)}
                        disabled={trashing === folder}
                        className="flex items-center gap-1 rounded bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/20 disabled:opacity-40 cursor-pointer"
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
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-2">Unused Files ({result.unusedFiles.length})</h3>
              {result.unusedFiles.length === 0 ? (
                <p className="text-xs italic text-ink-4 py-4 text-center">No unused files found! Your project is squeaky clean.</p>
              ) : (
                <div className="space-y-1.5">
                  {result.unusedFiles.map((file) => (
                    <div key={file.path} className="flex items-center justify-between rounded-lg border border-line bg-surface px-2.5 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileCode className="h-4 w-4 shrink-0 text-cool" />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs text-ink">{file.path}</p>
                          <span className="text-[10px] text-ink-4">{formatBytes(file.size)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setConfirmPath(file.path)}
                        disabled={trashing === file.path}
                        className="flex items-center gap-1 rounded bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger hover:bg-danger/20 disabled:opacity-40 cursor-pointer"
                      >
                        {trashing === file.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        Trash
                      </button>
                    </div>
                  ))}
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
            <p className="mt-2 font-mono text-xs text-ink-3 break-all bg-base p-2 rounded border border-line">
              {confirmPath}
            </p>
            <p className="mt-2 text-xs text-ink-4">
              This will safely move the item to your OS Recycle Bin / Trash. You can restore it from your system trash if needed.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmPath(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-overlay cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete(confirmPath)}
                className="rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger/90 cursor-pointer"
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
