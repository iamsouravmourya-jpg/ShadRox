import { Clock, FileCode, FolderOpen } from 'lucide-react';
import { DevoraLogo } from './Logo';
import type { RecentEntry } from '../lib/types';

interface Stage2HubProps {
  recents: RecentEntry[];
  isBusy: boolean;
  statusMessage: string | null;
  onOpenFolder: () => void;
  onOpenFiles: () => void;
  onDroppedFiles: (files: FileList) => void;
  onReopen: (kind: RecentEntry['kind']) => void;
}

function formatRelativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function Stage2Hub({
  recents,
  isBusy,
  statusMessage,
  onOpenFolder,
  onOpenFiles,
  onDroppedFiles,
  onReopen
}: Stage2HubProps) {
  return (
    <div className="w-full h-full flex flex-col bg-black text-white">
      <header className="h-14 shrink-0 border-b border-neutral-900 flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <DevoraLogo className="w-5 h-5 text-white" />
          <span className="text-sm font-bold tracking-wide">Devora</span>
          <span className="text-neutral-700 text-xs">/</span>
          <span className="text-xs text-neutral-400">Workspace hub</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <span className="hidden sm:inline">Local engine</span>
          <div className="w-7 h-7 rounded-full border border-neutral-800 bg-neutral-900 flex items-center justify-center text-[11px] font-semibold text-white">
            D
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-10 flex justify-center">
        <div className="w-full max-w-2xl">
          <h2 className="text-base font-semibold text-white">Open a project</h2>
          <p className="text-xs text-neutral-500 mt-1">
            Files tumhare computer par hi rehti hain. Kuch bhi hamare server par upload nahi hota.
          </p>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onOpenFolder}
              onDrop={(event) => {
                event.preventDefault();
                if (event.dataTransfer?.files?.length) onDroppedFiles(event.dataTransfer.files);
              }}
              onDragOver={(event) => event.preventDefault()}
              disabled={isBusy}
              className="group border border-neutral-800 hover:border-neutral-500 disabled:opacity-50 p-6 text-left transition-colors cursor-pointer"
            >
              <FolderOpen className="w-5 h-5 text-neutral-300 group-hover:text-white" />
              <div className="mt-3 text-xs font-semibold uppercase tracking-wider text-white">Open folder</div>
              <div className="mt-1 text-[11px] text-neutral-500">Poora project folder mount karo</div>
            </button>

            <button
              type="button"
              onClick={onOpenFiles}
              onDrop={(event) => {
                event.preventDefault();
                if (event.dataTransfer?.files?.length) onDroppedFiles(event.dataTransfer.files);
              }}
              onDragOver={(event) => event.preventDefault()}
              disabled={isBusy}
              className="group border border-neutral-800 hover:border-emerald-600/70 disabled:opacity-50 p-6 text-left transition-colors cursor-pointer"
            >
              <FileCode className="w-5 h-5 text-emerald-400" />
              <div className="mt-3 text-xs font-semibold uppercase tracking-wider text-white group-hover:text-emerald-400">
                Open files
              </div>
              <div className="mt-1 text-[11px] text-neutral-500">Ek ya zyada files — .tsx, .py, .html, .md</div>
            </button>
          </div>

          {statusMessage && (
            <div className="mt-4 border border-neutral-800 bg-neutral-950 px-4 py-3 text-xs text-neutral-300">
              {statusMessage}
            </div>
          )}

          {recents.length > 0 && (
            <div className="mt-8">
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 flex items-center gap-2">
                <Clock className="w-3 h-3" />
                Recently opened
              </div>
              <div className="mt-2 divide-y divide-neutral-900 border border-neutral-900">
                {recents.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => onReopen(entry.kind)}
                    className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-neutral-950 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {entry.kind === 'folder' ? (
                        <FolderOpen className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                      ) : (
                        <FileCode className="w-3.5 h-3.5 text-neutral-500 shrink-0" />
                      )}
                      <span className="text-xs text-neutral-200 truncate">{entry.name}</span>
                      <span className="text-[11px] text-neutral-600 shrink-0">{entry.fileCount} files</span>
                    </span>
                    <span className="text-[11px] text-neutral-600 shrink-0">{formatRelativeTime(entry.openedAt)}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-neutral-600">
                Browser security ki wajah se folder dobara pick karna padta hai — list sirf reference ke liye hai.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
