import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FileCode2, Loader2, Search, X } from 'lucide-react';
import type {
  DirectoryPage,
  OutlineSymbol,
  ShadRoxDesktopAPI,
  TsFileOverride,
  WorkspaceSearchHit,
  WorkspaceSymbol
} from '../lib/desktop';
import { normalizeSlashes, relativeToRoot } from '../lib/diagnostics';
import type { WorkspaceFile } from '../lib/types';

interface QuickOpenProps {
  mode: 'files' | 'content';
  files: WorkspaceFile[];
  directoryPages?: Record<string, DirectoryPage>;
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  /** Workspace-relative path of the active file, used by the `@` mode. */
  activeFilePath?: string | null;
  /** Absolute workspace root, used to display workspace symbols relatively. */
  workspaceRootPath?: string | null;
  /** Unsaved buffers sent with symbol requests. */
  overrides?: TsFileOverride[];
  onOpenFile: (index: number) => void;
  onOpenPath: (path: string, line?: number, column?: number) => void;
  onClose: () => void;
}

interface FileCandidate {
  path: string;
  index: number;
}

type PanelMode = 'files' | 'content' | 'outline' | 'symbols';

const NO_OVERRIDES: TsFileOverride[] = [];

const SYMBOL_KIND_LABELS: Record<string, string> = {
  class: 'C',
  interface: 'I',
  function: 'ƒ',
  method: 'm',
  property: 'p',
  const: 'k',
  let: 'v',
  var: 'v',
  variable: 'v',
  enum: 'E',
  type: 'T',
  module: 'M',
  namespace: 'N',
  constructor: 'c',
  field: 'f'
};

function kindLabel(kind: string): string {
  return SYMBOL_KIND_LABELS[kind?.toLowerCase()] ?? '·';
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

/**
 * Ctrl+P quick open. File search behaves exactly as before; a leading `@`
 * switches to the active file's outline and `#` to workspace symbol search,
 * both backed by the main-process TypeScript service.
 */
export function QuickOpen({
  mode,
  files,
  directoryPages,
  desktop,
  nativeWorkspaceId,
  activeFilePath,
  workspaceRootPath,
  overrides = NO_OVERRIDES,
  onOpenFile,
  onOpenPath,
  onClose
}: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [hits, setHits] = useState<WorkspaceSearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [outlineSymbols, setOutlineSymbols] = useState<OutlineSymbol[]>([]);
  const [symbolHits, setSymbolHits] = useState<WorkspaceSymbol[]>([]);
  const [isLoadingSymbols, setIsLoadingSymbols] = useState(false);
  const [symbolError, setSymbolError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outlineRequestRef = useRef(0);
  const symbolsRequestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  // `@`/`#` only take over in file mode so content search keeps its exact
  // existing semantics (a query may legitimately start with `#`).
  const prefix = mode === 'files' && query.length > 0 ? query[0] : '';
  const panelMode: PanelMode =
    mode === 'content' ? 'content' : prefix === '@' ? 'outline' : prefix === '#' ? 'symbols' : 'files';
  const filterText = panelMode === 'outline' || panelMode === 'symbols' ? query.slice(1) : query;

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

  // `@` — outline of the active file.
  useEffect(() => {
    if (panelMode !== 'outline') {
      outlineRequestRef.current += 1;
      setOutlineSymbols([]);
      setSymbolError(null);
      setIsLoadingSymbols(false);
      return;
    }
    if (!desktop || !nativeWorkspaceId || !activeFilePath) {
      setOutlineSymbols([]);
      setIsLoadingSymbols(false);
      return;
    }
    let cancelled = false;
    const id = ++outlineRequestRef.current;
    setIsLoadingSymbols(true);
    setSymbolError(null);
    const timer = window.setTimeout(() => {
      void desktop.outline(nativeWorkspaceId, activeFilePath, overrides)
        .then((symbols) => {
          if (cancelled || id !== outlineRequestRef.current) return;
          setOutlineSymbols(symbols ?? []);
          setSymbolError(null);
        })
        .catch((error) => {
          if (cancelled || id !== outlineRequestRef.current) return;
          setOutlineSymbols([]);
          setSymbolError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled && id === outlineRequestRef.current) setIsLoadingSymbols(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [panelMode, desktop, nativeWorkspaceId, activeFilePath, overrides]);

  // `#` — workspace symbols, debounced 200 ms.
  useEffect(() => {
    if (panelMode !== 'symbols') {
      symbolsRequestRef.current += 1;
      setSymbolHits([]);
      setSymbolError(null);
      return;
    }
    const needle = filterText.trim();
    if (!desktop || !nativeWorkspaceId || !needle) {
      setSymbolHits([]);
      setSymbolError(null);
      setIsLoadingSymbols(false);
      return;
    }
    let cancelled = false;
    const id = ++symbolsRequestRef.current;
    setIsLoadingSymbols(true);
    setSymbolError(null);
    const timer = window.setTimeout(() => {
      void desktop.workspaceSymbols(nativeWorkspaceId, needle, overrides)
        .then((symbols) => {
          if (cancelled || id !== symbolsRequestRef.current) return;
          setSymbolHits(symbols ?? []);
          setSymbolError(null);
        })
        .catch((error) => {
          if (cancelled || id !== symbolsRequestRef.current) return;
          setSymbolHits([]);
          setSymbolError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled && id === symbolsRequestRef.current) setIsLoadingSymbols(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [panelMode, filterText, desktop, nativeWorkspaceId, overrides]);

  const filteredOutline = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    if (!needle) return outlineSymbols;
    return outlineSymbols.filter(
      (symbol) =>
        symbol.name.toLowerCase().includes(needle) || symbol.kind.toLowerCase().includes(needle)
    );
  }, [outlineSymbols, filterText]);

  const resultCount =
    panelMode === 'content'
      ? hits.length
      : panelMode === 'outline'
        ? filteredOutline.length
        : panelMode === 'symbols'
          ? symbolHits.length
          : candidates.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mode]);

  const choose = (index: number) => {
    if (panelMode === 'content') {
      const hit = hits[index];
      if (!hit) return;
      onOpenPath(hit.name, hit.line, hit.column);
      return;
    }
    if (panelMode === 'outline') {
      const symbol = filteredOutline[index];
      if (!symbol || !activeFilePath) return;
      onOpenPath(activeFilePath, symbol.line + 1, symbol.character + 1);
      return;
    }
    if (panelMode === 'symbols') {
      const symbol = symbolHits[index];
      if (!symbol) return;
      const relative = relativeToRoot(workspaceRootPath ?? null, symbol.file) ?? normalizeSlashes(symbol.file);
      onOpenPath(relative, symbol.line + 1, symbol.character + 1);
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

  const placeholder =
    panelMode === 'content'
      ? 'Search text across the workspace…'
      : panelMode === 'outline'
        ? 'Filter symbols in the current file…'
        : panelMode === 'symbols'
          ? 'Search workspace symbols…'
          : 'Search files by name… (@ symbols, # workspace)';

  const ariaLabel =
    panelMode === 'content'
      ? 'Search workspace text'
      : panelMode === 'outline'
        ? 'Search symbols in the current file'
        : panelMode === 'symbols'
          ? 'Search workspace symbols'
          : 'Quick open file';

  const footerLabel =
    panelMode === 'content'
      ? 'Workspace content search'
      : panelMode === 'outline'
        ? 'Symbols in current file'
        : panelMode === 'symbols'
          ? 'Workspace symbols'
          : 'Quick open';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-20 backdrop-blur-sm"
      onMouseDown={onClose}
      role="dialog"
      aria-label={ariaLabel}
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
            placeholder={placeholder}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
          />
          {(isSearching || isLoadingSymbols) && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300" />}
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
          {panelMode === 'content' && query.trim().length > 0 && query.trim().length < 2 && (
            <p className="px-4 py-6 text-center text-[11px] text-neutral-500">Type at least 2 characters.</p>
          )}
          {searchError && (
            <p className="px-4 py-6 text-center text-[11px] text-amber-300">{searchError}</p>
          )}
          {symbolError && (
            <p className="px-4 py-6 text-center text-[11px] text-amber-300">{symbolError}</p>
          )}
          {!searchError && !symbolError && resultCount === 0 && (
            <p className="px-4 py-6 text-center text-[11px] text-neutral-500">
              {panelMode === 'content'
                ? (isSearching ? 'Searching…' : 'No matches found.')
                : panelMode === 'outline'
                  ? (!activeFilePath
                    ? 'Open a file to list its symbols.'
                    : !desktop || !nativeWorkspaceId
                      ? 'Symbol search needs the desktop app.'
                      : isLoadingSymbols
                        ? 'Reading symbols…'
                        : filterText.trim()
                          ? 'No symbols match that filter.'
                          : 'No symbols in this file.')
                  : panelMode === 'symbols'
                    ? (!desktop || !nativeWorkspaceId
                      ? 'Symbol search needs the desktop app.'
                      : !filterText.trim()
                        ? 'Type a symbol name after #.'
                        : isLoadingSymbols
                          ? 'Searching…'
                          : 'No workspace symbols match.')
                    : (query.trim() ? 'No files match that name.' : 'No files in this workspace yet.')}
            </p>
          )}

          {panelMode === 'files' && candidates.map((candidate, index) => (
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

          {panelMode === 'content' && hits.map((hit, index) => (
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

          {panelMode === 'outline' && filteredOutline.map((symbol, index) => (
            <button
              key={`${symbol.name}-${symbol.line}-${symbol.character}-${index}`}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                index === activeIndex ? 'bg-violet-500/[.14] text-white' : 'text-neutral-300 hover:bg-white/[0.04]'
              }`}
              style={{ paddingLeft: `${12 + Math.max(0, symbol.depth) * 12}px` }}
            >
              <span className="w-3 shrink-0 font-mono text-[10px] text-violet-300/80">{kindLabel(symbol.kind)}</span>
              <span className="truncate font-mono text-[11px]">{symbol.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-600">
                {symbol.kind} · {symbol.line + 1}
              </span>
            </button>
          ))}

          {panelMode === 'symbols' && symbolHits.map((symbol, index) => {
            const relative = relativeToRoot(workspaceRootPath ?? null, symbol.file) ?? normalizeSlashes(symbol.file);
            return (
              <button
                key={`${relative}-${symbol.line}-${symbol.character}-${index}`}
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                  index === activeIndex ? 'bg-violet-500/[.14] text-white' : 'text-neutral-300 hover:bg-white/[0.04]'
                }`}
              >
                <span className="w-3 shrink-0 font-mono text-[10px] text-violet-300/80">{kindLabel(symbol.kind)}</span>
                <span className="shrink-0 font-mono text-[11px]">{symbol.name}</span>
                {symbol.container && (
                  <span className="truncate text-[10px] text-neutral-500">{symbol.container}</span>
                )}
                <span className="ml-auto truncate font-mono text-[10px] text-neutral-600">{relative}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-white/[0.07] px-3 py-1.5 text-[10px] text-neutral-600">
          <span>
            {footerLabel} · ↑↓ to move, Enter to open
            {mode === 'files' && ' · @ symbols · # workspace'}
          </span>
          <span className="font-mono">{mode === 'content' ? 'Ctrl+Shift+F' : 'Ctrl+P'}</span>
        </div>
      </div>
    </div>
  );
}
