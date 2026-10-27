import { Clock, FileCode, FolderOpen, KeyRound, X } from 'lucide-react';
import type { RecentEntry } from '../lib/types';

interface Stage2HubProps {
  recents: RecentEntry[];
  isBusy: boolean;
  statusMessage: string | null;
  hasKey: boolean;
  onOpenSettings: () => void;
  onOpenFolder: () => void;
  onOpenFiles: () => void;
  onDroppedFiles: (files: FileList) => void;
  onReopen: (entry: RecentEntry) => void;
  onRemoveRecent: (id: string) => void;
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
      <svg
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="size-7 shrink-0"
        aria-hidden="true"
      >
        <path
          d="M6 7L16 3L26 7V16C26 22.5 16 29 16 29C16 29 6 22.5 6 16V7Z"
          stroke="white"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20 11H13.5C12.1193 11 11 12.1193 11 13.5C11 14.8807 12.1193 16 13.5 16H18.5C19.8807 16 21 17.1193 21 18.5C21 19.8807 19.8807 21 18.5 21H11"
          stroke="#10b981"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="11" cy="11" r="1.5" fill="#34d399" />
        <circle cx="21" cy="21" r="1.5" fill="#34d399" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.03em] text-white">ShadRox</span>
    </div>
  );
}

export function Stage2Hub({
  recents,
  isBusy,
  statusMessage,
  hasKey,
  onOpenSettings,
  onOpenFolder,
  onOpenFiles,
  onDroppedFiles,
  onReopen,
  onRemoveRecent,
}: Stage2HubProps) {
  return (
    <div
      className="relative w-full h-screen overflow-hidden flex flex-col text-white"
      style={{ background: '#090a0d' }}
    >
      {/* Grid background */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgb(255 255 255 / .018) 1px, transparent 1px), linear-gradient(90deg, rgb(255 255 255 / .018) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
        }}
      />

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
            'radial-gradient(circle at 50% 30%, rgb(124 58 237 / .22), transparent 55%), radial-gradient(circle at 20% 60%, rgb(14 165 233 / .12), transparent 40%)',
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
          background: 'radial-gradient(circle at 70% 70%, rgb(124 58 237 / .12), transparent 50%)',
          filter: 'blur(24px)',
        }}
      />

      {/* Header */}
      <header
        className="titlebar window-controls-inset relative shrink-0 z-10 flex h-12 items-center justify-between px-6"
        style={{ borderBottom: '1px solid rgb(255 255 255 / .07)' }}
      >
        <ShadRoxWordmark />

        <div
          className="flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] text-zinc-400"
          style={{
            border: '1px solid rgb(255 255 255 / .1)',
            background: 'rgb(255 255 255 / .03)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-violet-300"
            style={{ boxShadow: '0 0 6px #c4b5fd' }}
          />
          Local — runs on this device
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-6 overflow-y-auto">
        <div className="w-full max-w-md flex flex-col items-center text-center py-12">

          {/* Pill badge */}
          <div
            className="mb-8 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.18em]"
            style={{
              border: '1px solid rgb(196 181 253 / .2)',
              background: 'rgb(196 181 253 / .06)',
              color: '#c4b5fd',
            }}
          >
            <span className="relative flex size-1.5">
              <span
                className="absolute inline-flex size-full rounded-full opacity-75"
                style={{
                  background: '#c4b5fd',
                  animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite',
                }}
              />
              <span
                className="relative inline-flex size-1.5 rounded-full"
                style={{ background: '#c4b5fd', boxShadow: '0 0 8px #c4b5fd' }}
              />
            </span>
            Desktop beta · Windows &amp; browser
          </div>

          {/* Heading */}
          <h1
            className="text-4xl sm:text-5xl font-semibold tracking-[-0.05em] leading-[1.1] text-white"
          >
            Open a project.{' '}
            <span
              style={{
                background: 'linear-gradient(120deg, #c4b5fd, #a78bfa 40%, #7dd3fc 75%, #c4b5fd)',
                backgroundSize: '220% 220%',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                animation: 'gradient-pan 6s ease infinite',
              }}
            >
              Start building.
            </span>
          </h1>

          <p className="mt-4 max-w-sm text-sm leading-relaxed" style={{ color: '#a1a1aa' }}>
            Your project stays on this device. AI chat sends only the prompt and code context you choose to your selected provider.
          </p>

          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-5 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[11px] transition-colors cursor-pointer"
            style={{
              border: `1px solid ${hasKey ? 'rgb(52 211 153 / .25)' : 'rgb(196 181 253 / .3)'}`,
              background: hasKey ? 'rgb(16 185 129 / .08)' : 'rgb(124 58 237 / .12)',
              color: hasKey ? '#6ee7b7' : '#ddd6fe',
            }}
          >
            <KeyRound className="w-3.5 h-3.5" />
            {hasKey ? 'API key saved — manage keys' : 'Add your API key to start chatting'}
          </button>

          {/* Action cards */}
          <div className="mt-10 grid grid-cols-2 gap-3 w-full">
            <button
              type="button"
              onClick={onOpenFolder}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer?.files?.length) onDroppedFiles(e.dataTransfer.files);
              }}
              onDragOver={(e) => e.preventDefault()}
              disabled={isBusy}
              className="group flex flex-col items-center justify-center gap-3 p-6 rounded-2xl text-center disabled:opacity-40 cursor-pointer transition-all duration-300"
              style={{
                border: '1px solid rgb(255 255 255 / .09)',
                background: 'rgb(255 255 255 / .04)',
                backdropFilter: 'blur(12px)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgb(196 181 253 / .35)';
                (e.currentTarget as HTMLButtonElement).style.background = 'rgb(196 181 253 / .07)';
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-4px)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 16px 40px rgb(0 0 0 / .25), 0 0 24px rgb(124 58 237 / .12)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgb(255 255 255 / .09)';
                (e.currentTarget as HTMLButtonElement).style.background = 'rgb(255 255 255 / .04)';
                (e.currentTarget as HTMLButtonElement).style.transform = 'none';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
              }}
            >
              <div
                className="flex items-center justify-center w-10 h-10 rounded-xl"
                style={{ background: 'rgb(124 58 237 / .15)', border: '1px solid rgb(196 181 253 / .2)' }}
              >
                <FolderOpen className="w-5 h-5" style={{ color: '#c4b5fd' }} />
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-white">Open Folder</div>
                <div className="mt-0.5 text-[11px]" style={{ color: '#71717a' }}>Mount workspace folder</div>
              </div>
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
              className="group flex flex-col items-center justify-center gap-3 p-6 rounded-2xl text-center disabled:opacity-40 cursor-pointer transition-all duration-300"
              style={{
                border: '1px solid rgb(255 255 255 / .09)',
                background: 'rgb(255 255 255 / .04)',
                backdropFilter: 'blur(12px)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgb(125 211 252 / .35)';
                (e.currentTarget as HTMLButtonElement).style.background = 'rgb(125 211 252 / .06)';
                (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-4px)';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 16px 40px rgb(0 0 0 / .25), 0 0 24px rgb(14 165 233 / .1)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgb(255 255 255 / .09)';
                (e.currentTarget as HTMLButtonElement).style.background = 'rgb(255 255 255 / .04)';
                (e.currentTarget as HTMLButtonElement).style.transform = 'none';
                (e.currentTarget as HTMLButtonElement).style.boxShadow = 'none';
              }}
            >
              <div
                className="flex items-center justify-center w-10 h-10 rounded-xl"
                style={{ background: 'rgb(14 165 233 / .12)', border: '1px solid rgb(125 211 252 / .2)' }}
              >
                <FileCode className="w-5 h-5" style={{ color: '#7dd3fc' }} />
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-white">Open Files</div>
                <div className="mt-0.5 text-[11px]" style={{ color: '#71717a' }}>Select any file formats</div>
              </div>
            </button>
          </div>

          {/* Status message */}
          {statusMessage && (
            <div
              className="mt-4 w-full rounded-xl px-4 py-3 text-xs text-left"
              style={{
                border: '1px solid rgb(196 181 253 / .15)',
                background: 'rgb(196 181 253 / .05)',
                color: '#d4d4d8',
              }}
            >
              {statusMessage}
            </div>
          )}

          {/* Recents */}
          {recents.length > 0 && (
            <div className="mt-10 w-full text-left">
              <div
                className="flex items-center justify-between mb-3 text-[10px] uppercase tracking-widest"
                style={{ color: '#52525b' }}
              >
                <span className="flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  Recently opened
                </span>
                <span className="normal-case tracking-normal" style={{ color: '#3f3f46' }}>
                  Click to reopen
                </span>
              </div>

              <div
                className="overflow-hidden rounded-2xl"
                style={{
                  border: '1px solid rgb(255 255 255 / .07)',
                  background: 'rgb(255 255 255 / .025)',
                }}
              >
                {recents.map((entry) => (
                  <div
                    key={entry.id}
                    className="group flex items-center gap-1 pr-2"
                    style={{ borderBottom: '1px solid rgb(255 255 255 / .05)' }}
                  >
                    <button
                      type="button"
                      onClick={() => onReopen(entry)}
                      disabled={isBusy}
                      className="flex flex-1 min-w-0 items-center justify-between px-4 py-3 text-left transition-colors hover:bg-white/[0.04] disabled:opacity-50 cursor-pointer"
                    >
                      <span className="flex items-center gap-2.5 min-w-0">
                        {entry.kind === 'folder' ? (
                          <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: '#a78bfa' }} />
                        ) : (
                          <FileCode className="w-3.5 h-3.5 shrink-0" style={{ color: '#7dd3fc' }} />
                        )}
                        <span className="min-w-0">
                          <span className="block text-xs text-zinc-200 truncate">{entry.name}</span>
                          <span
                            className="block text-[10px] font-mono truncate"
                            style={{ color: '#52525b' }}
                            title={entry.path}
                          >
                            {/[\\/]/.test(entry.path) ? entry.path : 'Location saved in an older version — reopen once to refresh'}
                          </span>
                        </span>
                        <span className="text-[11px] shrink-0" style={{ color: '#3f3f46' }}>
                          {entry.fileCount} files
                        </span>
                      </span>
                      <span className="text-[11px] shrink-0 ml-4" style={{ color: '#3f3f46' }}>
                        {formatRelativeTime(entry.openedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveRecent(entry.id)}
                      title="Remove from history"
                      className="shrink-0 rounded-md p-1 text-neutral-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom tagline */}
          <p className="mt-10 text-[11px]" style={{ color: '#3f3f46' }}>
            Free &amp; BYOK — unlimited messages, ₹0 · Paid plans locked during beta
          </p>
        </div>
      </main>

      {/* Keyframes injected once */}
      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
        @keyframes gradient-pan {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
      `}</style>
    </div>
  );
}
