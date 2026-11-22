import { ArrowRight, Clock, FileCode, FilePlus2, FolderOpen, FolderPlus, KeyRound, Loader2, LogOut, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { RecentEntry } from '../lib/types';
import { ShadRoxLogo } from './Logo';
import { ThemeToggle } from './ThemeToggle';

interface Stage2HubProps {
  recents: RecentEntry[];
  isBusy: boolean;
  statusMessage: string | null;
  hasKey: boolean;
  onOpenSettings: () => void;
  onOpenFolder: () => void;
  onOpenFiles: () => void;
  onNewFile: () => void;
  onNewProject: (name: string) => void;
  onDroppedFiles: (files: FileList) => void;
  onReopen: (entry: RecentEntry) => void;
  onRemoveRecent: (id: string) => void;
  account: { email: string; avatarUrl: string } | null;
  onSignOut: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ShadRoxWordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <ShadRoxLogo className="size-7 shrink-0" />
      <span className="text-[15px] font-semibold tracking-[-0.03em] text-ink">ShadRox</span>
    </div>
  );
}

/* One surface language for the secondary actions: compact ghost tiles that
   lift a hair on hover. The primary action gets its own accent variant. */
const SECONDARY_ACTION =
  'hub-action group flex h-14 items-center gap-2.5 rounded-xl px-3 text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed';

const SECONDARY_ICON =
  'flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-overlay-2 text-ink-3 transition-colors duration-150 group-hover:border-accent-line group-hover:text-accent';

export function Stage2Hub({
  recents,
  isBusy,
  statusMessage,
  hasKey,
  onOpenSettings,
  onOpenFolder,
  onOpenFiles,
  onNewFile,
  onNewProject,
  onDroppedFiles,
  onReopen,
  onRemoveRecent,
  account,
  onSignOut,
}: Stage2HubProps) {
  const [naming, setNaming] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave fire for every child element, so count depth instead
  // of toggling a boolean or the highlight flickers while moving inside.
  const dragDepth = useRef(0);

  const submitProject = () => {
    const name = projectName.trim();
    if (!name) return;
    setNaming(false);
    setProjectName('');
    onNewProject(name);
  };

  const primaryDropProps = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      dragDepth.current += 1;
      setIsDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => e.preventDefault(),
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setIsDragging(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      if (e.dataTransfer?.files?.length) onDroppedFiles(e.dataTransfer.files);
    },
  };

  return (
    <div className="relative w-full h-screen overflow-hidden flex flex-col text-ink bg-base">
      {/* Grid background */}
      <div className="grid-bg pointer-events-none absolute inset-0" />

      {/* Aurora glow blobs */}
      <div
        className="pointer-events-none absolute"
        style={{
          top: '-80px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '700px',
          height: '500px',
          background:
            'radial-gradient(circle at 50% 30%, var(--glow), transparent 55%), radial-gradient(circle at 20% 60%, var(--cool-soft), transparent 40%)',
          filter: 'blur(12px)',
        }}
      />
      <div
        className="pointer-events-none absolute"
        style={{
          bottom: '-120px',
          right: '-100px',
          width: '500px',
          height: '400px',
          background: 'radial-gradient(circle at 70% 70%, var(--glow), transparent 50%)',
          filter: 'blur(24px)',
        }}
      />

      {/* Header */}
      <header className="titlebar window-controls-inset relative shrink-0 z-10 flex h-12 items-center justify-between px-6 border-b border-line">
        <ShadRoxWordmark />

        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-[11px] font-medium text-ink-4">
            Runs locally on this device
          </span>

          <ThemeToggle />

          {account && (
            <div className="flex items-center gap-2 rounded-full border border-line bg-overlay py-1 pl-1 pr-1.5">
              {account.avatarUrl ? (
                <img
                  src={account.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-6 w-6 rounded-full object-cover"
                />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent">
                  {account.email.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="max-w-[170px] truncate text-[11px] text-ink-2">{account.email}</span>
              <button
                type="button"
                onClick={onSignOut}
                title="Sign out"
                aria-label="Sign out"
                className="rounded-full p-1 text-ink-4 transition-colors hover:bg-overlay-2 hover:text-ink active:scale-[0.96] cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 flex-1 flex px-6 overflow-y-auto">
        {/* m-auto centers when there is spare room but collapses to 0 when the
            content overflows, keeping the heading reachable by scroll. */}
        <div className="m-auto w-full max-w-xl flex flex-col items-center text-center py-10">

          {/* Unboxed release metadata */}
          <p className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent tabular-nums">
            Desktop beta · v0.1.4 · Windows &amp; Browser
          </p>

          {/* Heading */}
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-[-0.045em] leading-[1.1] text-ink">
            Open a project. <span className="text-gradient">Start building.</span>
          </h1>

          <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-ink-3">
            Your project stays on this device. AI chat sends only the prompt and code context you choose to your selected provider.
          </p>

          <button
            type="button"
            onClick={onOpenSettings}
            className={`mt-4 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 rounded-full px-3.5 py-1.5 text-[11px] font-medium transition-all duration-150 cursor-pointer border hover:brightness-110 active:scale-[0.98] ${
              hasKey
                ? 'border-ok/30 bg-ok/10 text-ok'
                : 'border-accent-line bg-accent-soft text-accent'
            }`}
          >
            <KeyRound className="w-3.5 h-3.5" />
            {hasKey ? 'API key saved — manage keys' : 'Add your API key to start chatting'}
          </button>

          {/* Primary action — the whole card is the button and the drop target */}
          <button
            type="button"
            onClick={onOpenFolder}
            disabled={isBusy}
            {...primaryDropProps}
            className={`hub-primary group mt-6 flex h-20 w-full items-center gap-4 rounded-2xl px-5 text-left cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              isDragging ? 'border-accent-line bg-accent-soft' : ''
            }`}
          >
            <span
              className={`flex size-11 shrink-0 items-center justify-center rounded-xl border transition-colors duration-150 ${
                isDragging
                  ? 'border-accent-line bg-accent text-white'
                  : 'border-accent-line bg-accent-soft text-accent'
              }`}
            >
              <FolderOpen className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold tracking-[-0.01em] text-ink">
                {isDragging ? 'Drop to open this folder' : 'Open a folder'}
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-ink-4">
                Your project files live here — drag a folder in or click to browse
              </span>
            </span>
            <ArrowRight
              className={`size-4 shrink-0 transition-all duration-200 ${
                isDragging ? 'translate-x-0 text-accent' : 'text-ink-5 group-hover:translate-x-0.5 group-hover:text-accent'
              }`}
            />
          </button>

          {/* Secondary actions — one compact row, not a grid of chunky cards */}
          <div className="mt-2.5 grid w-full grid-cols-3 gap-2.5">
            <button type="button" onClick={onNewFile} disabled={isBusy} className={SECONDARY_ACTION}>
              <span className={SECONDARY_ICON}>
                <FilePlus2 className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-ink">New file</span>
                <span className="block truncate text-[10px] text-ink-5">Blank file</span>
              </span>
            </button>

            <button type="button" onClick={() => setNaming(true)} disabled={isBusy} className={SECONDARY_ACTION}>
              <span className={SECONDARY_ICON}>
                <FolderPlus className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-ink">New project</span>
                <span className="block truncate text-[10px] text-ink-5">Empty folder</span>
              </span>
            </button>

            <button
              type="button"
              onClick={onOpenFiles}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer?.files?.length) onDroppedFiles(e.dataTransfer.files);
              }}
              onDragOver={(e) => e.preventDefault()}
              disabled={isBusy}
              className={SECONDARY_ACTION}
            >
              <span className={SECONDARY_ICON}>
                <FileCode className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-ink">Open files</span>
                <span className="block truncate text-[10px] text-ink-5">Any format</span>
              </span>
            </button>
          </div>

          {/* Inline project naming — docked under the actions, never a modal */}
          {naming && (
            <form
              className="mt-2.5 w-full rounded-xl border border-accent-line bg-surface p-3.5 text-left shadow-[var(--shadow-panel)]"
              onSubmit={(e) => {
                e.preventDefault();
                submitProject();
              }}
            >
              <label htmlFor="new-project-name" className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-4">
                Name your project
              </label>
              <div className="mt-2 flex items-center gap-2">
                <input
                  id="new-project-name"
                  autoFocus
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNaming(false);
                  }}
                  placeholder="my-project"
                  maxLength={64}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-base-2 px-3 py-1.5 text-[13px] text-ink placeholder:text-ink-5 outline-none transition-colors focus:border-accent-line"
                />
                <button
                  type="submit"
                  disabled={!projectName.trim() || isBusy}
                  className="shrink-0 rounded-full bg-accent-strong px-4 py-1.5 text-xs font-semibold text-white shadow-[0_8px_20px_-12px_var(--glow)] transition-all duration-150 hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:hover:brightness-100 cursor-pointer"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setNaming(false)}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs text-ink-3 transition-colors hover:bg-overlay-2 hover:text-ink active:scale-[0.98] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              <p className="mt-2 text-[11px] leading-4 text-ink-4">
                ShadRox creates an empty folder here and opens it. Nothing is added, nothing is overwritten.
              </p>
            </form>
          )}

          {/* Status message */}
          {statusMessage && (
            <div className="mt-3 flex w-full items-center gap-2 rounded-lg px-3.5 py-2.5 text-[11px] text-left border border-accent-line bg-accent-soft text-ink-2">
              {isBusy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />}
              {statusMessage}
            </div>
          )}

          {/* Recents */}
          {recents.length > 0 && (
            <div className="mt-6 w-full text-left">
              <div className="flex items-center justify-between mb-2 text-[10px] uppercase tracking-widest text-ink-5">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3" />
                  Recently opened
                </span>
                <span className="normal-case tracking-normal text-ink-5">
                  Click to reopen
                </span>
              </div>

              <div className="overflow-hidden rounded-xl border border-line bg-overlay">
                {recents.map((entry) => (
                  <div
                    key={entry.id}
                    className="group flex items-center gap-1 pr-2 border-b border-line last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => onReopen(entry)}
                      disabled={isBusy}
                      className="flex flex-1 min-w-0 items-center justify-between px-3.5 py-2 text-left transition-colors hover:bg-overlay-2 disabled:opacity-50 cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        {entry.kind === 'folder' ? (
                          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-accent" />
                        ) : (
                          <FileCode className="w-3.5 h-3.5 shrink-0 text-cool" />
                        )}
                        <span className="min-w-0">
                          <span className="block text-xs text-ink-2 truncate">{entry.name}</span>
                          <span
                            className="block text-[10px] font-mono truncate text-ink-5"
                            title={entry.path}
                          >
                            {/[\\/]/.test(entry.path) ? entry.path : 'Location saved in an older version — reopen once to refresh'}
                          </span>
                        </span>
                        <span className="text-[11px] shrink-0 text-ink-4 tabular-nums">
                          {entry.kind === 'folder'
                            ? entry.fileCount > 0 ? `${entry.fileCount} files` : 'Folder'
                            : `${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'}`}
                        </span>
                      </span>
                      <span className="text-[11px] shrink-0 ml-4 text-ink-4 tabular-nums">
                        {formatRelativeTime(entry.openedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveRecent(entry.id)}
                      title="Remove from history"
                      aria-label={`Remove ${entry.name} from history`}
                      className="shrink-0 rounded-md p-1 text-ink-4 opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom tagline */}
          <p className="mt-6 text-[11px] leading-5 text-ink-5">
            Free &amp; BYOK — no plan, no cap, nothing billed by ShadRox. Your files stay on this machine;
            only the prompt and the context you attach go to the provider key you choose.
          </p>
        </div>
      </main>
    </div>
  );
}
