import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FileCode2, Loader2, Search, X } from 'lucide-react';
import type { DirectoryPage, ShadRoxDesktopAPI, WorkspaceSearchHit } from '../lib/desktop';
import type { WorkspaceFile } from '../lib/types';

interface QuickOpenProps {
  mode: 'files' | 'content';
  files: WorkspaceFile[];
  directoryPages?: Record<string, DirectoryPage>;
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  onOpenFile: (index: number) => void;
  onOpenPath: (path: string, line?: number, column?: number) => void;
  onClose: () => void;
}

interface FileCandidate {
  path: string;
  index: number;
}

function score(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return direct + haystack.lastIndexOf('/') * 0.01;
  let cursor = 0;
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor);
    if (cursor < 0) return Number.POSITIVE_INFINITY;
    cursor += 1;
  }
  return 500;
}

export function QuickOpen({
  mode,
  files,
  directoryPages,
  desktop,
  nativeWorkspaceId,
  onOpenFile,
  onOpenPath,
  onClose
}: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [hits, setHits] = useState<WorkspaceSearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const candidates = useMemo(() => {
    const seen = new Map<string, FileCandidate>();
    files.forEach((file, index) => seen.set(file.name, { path: file.name, index }));
    for (const page of Object.values(directoryPages ?? {})) {
      for (const entry of page.entries) {
        if (entry.kind === 'file' && !seen.has(entry.path)) seen.set(entry.path, { path: entry.path, index: -1 });
      }
    }
    const list = [...seen.values()];
    if (!query.trim()) {
      return list.sort((a, b) => Number(b.path.includes('/')) - Number(a.path.includes('/')) || a.path.localeCompare(b.path)).slice(0, 60);
    }
    return list
      .map((candidate) => ({ candidate, rank: score(candidate.path, query.trim()) }))
      .filter((entry) => Number.isFinite(entry.rank))
      .sort((a, b) => a.rank - b.rank || a.candidate.path.localeCompare(b.candidate.path))
      .slice(0, 60)
      .map((entry) => entry.candidate);
  }, [files, directoryPages, query]);

  const localHits = useMemo<WorkspaceSearchHit[]>(() => {
    const needle = query.trim().toLowerCase();
    if (mode !== 'content' || needle.length < 2) return [];
    const results: WorkspaceSearchHit[] = [];
    for (const file of files) {
      const lines = file.content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < 80; index += 1) {
        const column = lines[index].toLowerCase().indexOf(needle);
        if (column < 0) continue;
        results.push({
          name: file.name,
          line: index + 1,
          column: column + 1,
          preview: lines[index].trim().slice(0, 200)
        });
      }
      if (results.length >= 80) break;
    }
    return results;
  }, [mode, query, files]);

  useEffect(() => {
    if (mode !== 'content') return;
    const needle = query.trim();
    if (needle.length < 2) {
      setHits([]);
      setSearchError(null);
      return;
    }
    if (!desktop || !nativeWorkspaceId) {
      setHits(localHits);
      return;
    }
    let cancelled = false;
    setIsSearching(true);
    const timer = window.setTimeout(() => {
      void desktop.searchFiles(nativeWorkspaceId, needle, 80)
        .then((results) => {
          if (cancelled) return;
          setHits(results);
          setSearchError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          setSearchError(error instanceof Error ? error.message : String(error));
          setHits(localHits);
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, query, desktop, nativeWorkspaceId, localHits]);

  const resultCount = mode === 'content' ? hits.length : candidates.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mode]);

  const choose = (index: number) => {
    if (mode === 'content') {
      const hit = hits[index];
      if (!hit) return;
      onOpenPath(hit.name, hit.line, hit.column);
      return;
    }
    const candidate = candidates[index];
    if (!candidate) return;
    if (candidate.index >= 0) onOpenFile(candidate.index);
    else onOpenPath(candidate.path);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(resultCount - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-20 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-label={mode === 'content' ? 'Search workspace text' : 'Quick open file'}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-white/[0.1] bg-ink-950 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'content' ? 'Search text across the workspace…' : 'Search files by name…'}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
          />
          {isSearching && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300" />}
          <kbd className="hidden rounded border border-white/[0.1] px-1.5 py-0.5 text-[10px] font-mono text-neutral-500 sm:inline">
            Esc
          </kbd>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-white cursor-pointer"
            title="Close"
            aria-label="Close search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {mode === 'content' && query.trim().length > 0 && query.trim().length < 2 && (
            <p className="px-4 py-6 text-center text-[11px] text-neutral-500">Type at least 2 characters.</p>
          )}
          {searchError && (
            <p className="px-4 py-6 text-center text-[11px] text-amber-300">{searchError}</p>
          )}
          {!searchError && resultCount === 0 && (
            <p className="px-4 py-6 text-center text-[11px] text-neutral-500">
              {mode === 'content'
                ? (isSearching ? 'Searching…' : 'No matches found.')
                : (query.trim() ? 'No files match that name.' : 'No files in this workspace yet.')}
            </p>
          )}

          {mode === 'files' && candidates.map((candidate, index) => (
            <button
              key={candidate.path}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                index === activeIndex ? 'bg-violet-500/[.14] text-white' : 'text-neutral-300 hover:bg-white/[0.04]'
              }`}
            >
              <FileCode2 className="h-3 w-3 shrink-0 text-neutral-500" />
              <span className="truncate font-mono text-[11px]">{candidate.path}</span>
              {candidate.index < 0 && (
                <span className="ml-auto shrink-0 text-[10px] text-amber-300/80">on disk</span>
              )}
            </button>
          ))}

          {mode === 'content' && hits.map((hit, index) => (
            <button
              key={`${hit.name}-${hit.line}-${index}`}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                index === activeIndex ? 'bg-violet-500/[.14]' : 'hover:bg-white/[0.04]'
              }`}
            >
              <span className="flex items-center gap-2 font-mono text-[10px] text-neutral-400">
                <span className="truncate">{hit.name}</span>
                <span className="shrink-0 text-neutral-600">:{hit.line}</span>
              </span>
              <span className="truncate text-[11px] text-neutral-300">{hit.preview || '(empty line)'}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-white/[0.07] px-3 py-1.5 text-[10px] text-neutral-600">
          <span>{mode === 'content' ? 'Workspace content search' : 'Quick open'} · ↑↓ to move, Enter to open</span>
          <span className="font-mono">{mode === 'content' ? 'Ctrl+Shift+F' : 'Ctrl+P'}</span>
        </div>
      </div>
    </div>
  );
}
