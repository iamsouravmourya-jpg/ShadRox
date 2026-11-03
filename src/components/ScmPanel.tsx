import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import type { GitChange, GitScmResult, ShadRoxDesktopAPI } from '../lib/desktop';

interface ScmPanelProps {
  desktop: ShadRoxDesktopAPI | null;
  workspaceId: string | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onGenerateCommitMessage?: () => Promise<string>;
  isWritingCommitMessage?: boolean;
}

interface DiffSelection {
  path: string;
  staged: boolean;
}

function changeLabel(change: GitChange): string {
  return change.status === '??' ? 'U' : change.status.trim() || 'M';
}

function HunkDiffViewer({ diffText }: { diffText: string }) {
  const lines = useMemo(() => diffText.split('\n'), [diffText]);
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
      if (l.startsWith('+') && !l.startsWith('+++')) added++;
      else if (l.startsWith('-') && !l.startsWith('---')) removed++;
    }
    return { added, removed };
  }, [lines]);

  return (
    <div className="font-mono text-[9.5px] leading-relaxed">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-black/40 px-2.5 py-1 text-[9px] text-neutral-400">
        <span>Unified Diff</span>
        <div className="flex items-center gap-1.5 font-bold">
          <span className="text-emerald-400">+{stats.added}</span>
          <span className="text-rose-400">-{stats.removed}</span>
        </div>
      </div>
      <div className="max-h-64 overflow-y-auto p-1.5 space-y-0.5">
        {lines.map((line, idx) => {
          if (line.startsWith('@@')) {
            return (
              <div key={idx} className="my-1 rounded bg-violet-950/30 px-2 py-0.5 font-semibold text-violet-300 border border-violet-500/20">
                {line}
              </div>
            );
          }
          if (line.startsWith('+') && !line.startsWith('+++')) {
            return (
              <div key={idx} className="bg-emerald-500/10 text-emerald-300 border-l-2 border-emerald-500 pl-1.5 whitespace-pre-wrap break-all">
                {line}
              </div>
            );
          }
          if (line.startsWith('-') && !line.startsWith('---')) {
            return (
              <div key={idx} className="bg-rose-500/10 text-rose-300 border-l-2 border-rose-500 pl-1.5 whitespace-pre-wrap break-all">
                {line}
              </div>
            );
          }
          if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
            return (
              <div key={idx} className="text-neutral-500 truncate text-[9px]">
                {line}
              </div>
            );
          }
          return (
            <div key={idx} className="text-neutral-400 pl-2 whitespace-pre-wrap break-all">
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ScmPanel({
  desktop,
  workspaceId,
  onClose,
  onOpenFile,
  onGenerateCommitMessage,
  isWritingCommitMessage = false
}: ScmPanelProps) {
  const [snapshot, setSnapshot] = useState<GitScmResult | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const [diff, setDiff] = useState('');
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  const refresh = useCallback(async () => {
    if (!desktop || !workspaceId) return;
    setIsRefreshing(true);
    try {
      const result = await desktop.gitScmRead(workspaceId);
      setSnapshot(result);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsRefreshing(false);
    }
  }, [desktop, workspaceId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    setNotice(null);
    setSelectedDiff(null);
    setDiff('');
    setCommitMessage('');
    void refresh();
    const timer = window.setInterval(() => void refresh(), 7000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const stagedChanges = useMemo(
    () => snapshot?.changes.filter((change) => change.staged) ?? [],
    [snapshot]
  );
  const unstagedChanges = useMemo(
    () => snapshot?.changes.filter((change) => change.unstaged) ?? [],
    [snapshot]
  );

  const perform = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setWorking('Working…');
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(label);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(null);
    }
  }, [refresh]);

  const toggleStage = useCallback((path: string, staged: boolean) => {
    if (!desktop || !workspaceId) return;
    void perform(
      staged ? 'Changes unstaged.' : 'Changes staged.',
      () => staged
        ? desktop.gitUnstage(workspaceId, [path])
        : desktop.gitStage(workspaceId, [path])
    );
  }, [desktop, workspaceId, perform]);

  const showDiff = useCallback(async (path: string, staged: boolean) => {
    if (!desktop || !workspaceId) return;
    if (selectedDiff?.path === path && selectedDiff.staged === staged) {
      setSelectedDiff(null);
      setDiff('');
      return;
    }
    setSelectedDiff({ path, staged });
    setDiff('');
    setIsLoadingDiff(true);
    setError(null);
    try {
      setDiff(await desktop.gitFileDiff(workspaceId, path, staged));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsLoadingDiff(false);
    }
  }, [desktop, workspaceId, selectedDiff]);

  const commit = async () => {
    if (!desktop || !workspaceId || !commitMessage.trim() || stagedChanges.length === 0) return;
    await perform('Commit created.', async () => {
      await desktop.gitCommit(workspaceId, commitMessage);
      setCommitMessage('');
    });
  };

  const generateMessage = async () => {
    if (!onGenerateCommitMessage) return;
    try {
      const message = await onGenerateCommitMessage();
      if (message) setCommitMessage(message.slice(0, 500));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const renderChange = (change: GitChange, staged: boolean) => (
    <div key={`${staged ? 'staged' : 'working'}:${change.path}`} className="border-b border-white/[0.04]">
      <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-white/[0.03]">
        <span className="w-5 shrink-0 text-center font-mono text-[10px] text-neutral-500" title={change.status}>
          {changeLabel(change)}
        </span>
        <button
          type="button"
          onClick={() => onOpenFile(change.path)}
          className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-neutral-300 hover:text-white cursor-pointer"
          title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
        >
          {change.oldPath ? `${change.oldPath} → ` : ''}{change.path}
        </button>
        <button
          type="button"
          onClick={() => void showDiff(change.path, staged)}
          className="rounded px-1.5 py-1 text-[9px] text-neutral-500 hover:bg-white/[0.06] hover:text-white cursor-pointer"
          title={`Show ${staged ? 'staged' : 'working'} diff`}
        >
          Diff
        </button>
        <button
          type="button"
          onClick={() => toggleStage(change.path, staged)}
          disabled={Boolean(working)}
          className="rounded p-1 text-neutral-500 hover:bg-white/[0.06] hover:text-violet-200 disabled:opacity-40 cursor-pointer"
          title={staged ? 'Unstage changes' : 'Stage changes'}
          aria-label={staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
        >
          {staged
            ? <ArrowDownToLine className="h-3 w-3" />
            : <ArrowUpFromLine className="h-3 w-3" />}
        </button>
      </div>
      {selectedDiff?.path === change.path && selectedDiff.staged === staged && (
        <div className="border-t border-white/[0.08] bg-ink-950/90">
          {isLoadingDiff ? (
            <p className="px-3 py-2 text-[10px] text-neutral-500 font-mono">Loading diff…</p>
          ) : diff ? (
            <HunkDiffViewer diffText={diff} />
          ) : (
            <p className="px-3 py-2 text-[10px] text-neutral-500 font-mono">No diff available.</p>
          )}
        </div>
      )}
    </div>
  );

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#07080b]" aria-label="Source control">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/[0.07] bg-ink-950 px-3">
        <div className="flex min-w-0 items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-neutral-400">
          <GitBranch className="h-3.5 w-3.5 text-violet-300" />
          <span>Source Control</span>
          {snapshot && <span className="text-neutral-600">{snapshot.changes.length}</span>}
          {isRefreshing && <Loader2 className="h-3 w-3 animate-spin text-violet-300" />}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-neutral-500 hover:text-white cursor-pointer"
            title="Refresh source control"
            aria-label="Refresh source control"
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:text-white cursor-pointer"
            title="Close source control"
            aria-label="Close source control"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {error && <p role="alert" className="border-b border-rose-400/20 bg-rose-500/[.08] px-3 py-2 text-[10px] text-rose-200">{error}</p>}
      {notice && <p role="status" className="border-b border-white/[0.06] px-3 py-1.5 text-[10px] text-emerald-300">{notice}</p>}

      {!desktop || !workspaceId ? (
        <p className="px-4 py-6 text-center text-[11px] text-neutral-500">Source control needs the desktop app and an opened folder.</p>
      ) : !snapshot ? (
        <p className="px-4 py-6 text-center text-[11px] text-neutral-500">
          {isRefreshing ? 'Loading Git status…' : 'Git status is unavailable for this folder.'}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {snapshot?.branches.length ? (
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
              <GitBranch className="h-3 w-3 shrink-0 text-neutral-500" />
              <select
                value={snapshot.branches.find((branch) => branch.current)?.name ?? ''}
                onChange={(event) => {
                  const branch = event.target.value;
                  if (branch) void perform('Branch switched.', () => desktop.gitCheckout(workspaceId, branch));
                }}
                disabled={Boolean(working)}
                className="min-w-0 flex-1 bg-ink-950 text-[10px] text-neutral-300 outline-none cursor-pointer"
                aria-label="Current Git branch"
              >
                {snapshot.branches.map((branch) => (
                  <option key={branch.name} value={branch.name}>{branch.name}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="border-b border-white/[0.07] px-3 py-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-500">Commit</span>
              {onGenerateCommitMessage && (
                <button
                  type="button"
                  onClick={() => void generateMessage()}
                  disabled={isWritingCommitMessage || Boolean(working)}
                  className="flex items-center gap-1 text-[9px] text-violet-300 hover:text-violet-200 disabled:opacity-40 cursor-pointer"
                  title="Generate a commit message from the changes"
                >
                  {isWritingCommitMessage ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Generate
                </button>
              )}
            </div>
            <textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value.slice(0, 500))}
              placeholder="Commit message"
              rows={2}
              maxLength={500}
              className="w-full resize-y rounded border border-white/[0.08] bg-black/20 px-2 py-1.5 text-[10px] text-neutral-200 outline-none focus:border-violet-300/30"
            />
            <button
              type="button"
              onClick={() => void commit()}
              disabled={!commitMessage.trim() || stagedChanges.length === 0 || Boolean(working)}
              className="mt-1 w-full rounded bg-violet-500/15 px-2 py-1.5 text-[10px] text-violet-200 hover:bg-violet-500/25 disabled:opacity-40 cursor-pointer"
            >
              {working || 'Commit staged'}
            </button>
          </div>

          <div>
            <div className="px-3 pb-1 pt-3 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
              Staged Changes <span className="text-neutral-600">{stagedChanges.length}</span>
            </div>
            {stagedChanges.map((change) => renderChange(change, true))}
            {stagedChanges.length === 0 && <p className="px-3 pb-2 text-[10px] text-neutral-600">No staged changes.</p>}
          </div>

          <div>
            <div className="px-3 pb-1 pt-3 text-[10px] font-mono uppercase tracking-wider text-neutral-500">
              Changes <span className="text-neutral-600">{unstagedChanges.length}</span>
            </div>
            {unstagedChanges.map((change) => renderChange(change, false))}
            {unstagedChanges.length === 0 && <p className="px-3 pb-2 text-[10px] text-neutral-600">No unstaged changes.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
