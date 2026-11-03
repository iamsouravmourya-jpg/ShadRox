import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Command as CommandIcon, FileCode2, Loader2, Replace, ReplaceAll, Search, X } from 'lucide-react';
import type {
  DirectoryPage,
  OutlineSymbol,
  ShadRoxDesktopAPI,
  TsFileOverride,
  WorkspaceSearchHit,
  WorkspaceSymbol
} from '../lib/desktop';
import { normalizeSlashes, relativeToRoot } from '../lib/diagnostics';
import {
  mergeSearchableFiles,
  planReplaceAll,
  searchInFiles,
  totalMatches,
  type FileSearchMatch,
  type FileSearchResult,
  type ReplacePlan,
  type SearchableFile
} from '../lib/editor/searchReplace';
import type { WorkspaceFile } from '../lib/types';
import { rankCommands, type Command } from '../lib/commands';

interface QuickOpenProps {
  mode: 'files' | 'content' | 'commands';
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
  /** Actions offered in command mode; each carries its own `run`. */
  commands?: Command[];
  onOpenFile: (index: number) => void;
  onOpenPath: (path: string, line?: number, column?: number) => void;
  /**
   * Applies planned replacements and reports back. Absent for read-only
   * workspaces, which also hides the replace controls entirely.
   */
  onReplaceAll?: (plans: ReplacePlan[]) => Promise<string>;
  onClose: () => void;
  /**
   * Rendered inside the sidebar column instead of as a centred overlay: no
   * backdrop, no fixed positioning, and it fills its parent's height.
   */
  docked?: boolean;
}

interface FileCandidate {
  path: string;
  index: number;
}

/** One row of the replace preview: a match plus the file it came from. */
interface ReplaceRow {
  file: string;
  match: FileSearchMatch;
}

type PanelMode = 'files' | 'content' | 'outline' | 'symbols' | 'commands';

const NO_OVERRIDES: TsFileOverride[] = [];
const NO_COMMANDS: Command[] = [];

/** Replace always runs case-insensitively over the workspace. */
const REPLACE_OPTIONS = { caseSensitive: false };
const REPLACE_ROW_HEIGHT = 36;

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
  commands = NO_COMMANDS,
  onOpenFile,
  onOpenPath,
  onReplaceAll,
  onClose,
  docked = false
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
  const [showReplace, setShowReplace] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [replaceFiles, setReplaceFiles] = useState<SearchableFile[]>(files);
  const [isSearchingReplace, setIsSearchingReplace] = useState(false);
  const [replaceSearchError, setReplaceSearchError] = useState<string | null>(null);
  const [replaceSearchTruncated, setReplaceSearchTruncated] = useState(false);
  const [replaceScrollTop, setReplaceScrollTop] = useState(0);
  const [replaceViewportHeight, setReplaceViewportHeight] = useState(320);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null);
  const [isReplacing, setIsReplacing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const outlineRequestRef = useRef(0);
  const symbolsRequestRef = useRef(0);
  const replaceScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  // `@`/`#` only take over in file mode so content search keeps its exact
  // existing semantics (a query may legitimately start with `#`).
  const prefix = mode === 'files' && query.length > 0 ? query[0] : '';
  const panelMode: PanelMode =
    mode === 'content'
      ? 'content'
      : mode === 'commands'
        ? 'commands'
        : prefix === '@'
          ? 'outline'
          : prefix === '#' ? 'symbols' : 'files';
  const filterText = panelMode === 'outline' || panelMode === 'symbols' ? query.slice(1) : query;

  const commandResults = useMemo(
    () => (panelMode === 'commands' ? rankCommands(commands, query) : []),
    [panelMode, commands, query]
  );

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
    // Replace mode lists the open buffers directly (via the pure search
    // library) so the find list and the replace plan can never disagree.
    if (mode !== 'content' || showReplace) {
      setIsSearching(false);
      setSearchError(null);
      return;
    }
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
  }, [mode, query, showReplace, desktop, nativeWorkspaceId, localHits]);

  useEffect(() => {
    if (mode !== 'content' || !showReplace) {
      setIsSearchingReplace(false);
      setReplaceSearchError(null);
      setReplaceSearchTruncated(false);
      setReplaceFiles(files);
      return;
    }

    const needle = query.trim();
    setReplaceFiles(files);
    setReplaceSearchError(null);
    setReplaceSearchTruncated(false);
    setReplaceScrollTop(0);
    if (replaceScrollRef.current) replaceScrollRef.current.scrollTop = 0;
    if (needle.length < 2 || !desktop || !nativeWorkspaceId) {
      setIsSearchingReplace(false);
      return;
    }
    if (/[\r\n]/.test(needle)) {
      setIsSearchingReplace(false);
      setReplaceSearchError('Multi-line replace is currently limited to open buffers.');
      return;
    }

    let cancelled = false;
    setIsSearchingReplace(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const search = await desktop.searchContent(nativeWorkspaceId, {
            query: needle,
            limit: 200
          });
          if (cancelled) return;
          if (search.error) throw new Error(search.error);
          if (search.truncated) {
            setReplaceSearchTruncated(true);
            return;
          }

          const openPaths = new Set(files.map((file) => file.name.replace(/\\/g, '/').toLowerCase()));
          const diskPaths = [...new Set(search.matches.map((match) => match.path))]
            .filter((path) => !openPaths.has(path.replace(/\\/g, '/').toLowerCase()));
          const loaded = diskPaths.length > 0
            ? await desktop.loadFiles(nativeWorkspaceId, diskPaths, {
                maxBytesPerFile: 2 * 1024 * 1024,
                maxTotalBytes: 32 * 1024 * 1024
              })
            : { files: [], missing: [] };
          if (cancelled) return;
          if (loaded.missing.length > 0) {
            const first = loaded.missing[0];
            throw new Error(`${loaded.missing.length} matching file(s) could not be read (${first.path}: ${first.reason}).`);
          }
          setReplaceFiles(mergeSearchableFiles(files, loaded.files));
        } catch (error) {
          if (cancelled) return;
          setReplaceSearchError(error instanceof Error ? error.message : String(error));
        } finally {
          if (!cancelled) setIsSearchingReplace(false);
        }
      })();
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mode, showReplace, query, files, desktop, nativeWorkspaceId]);

  const replaceSearchOutcome = useMemo(
    () => (mode === 'content' && showReplace
      ? searchInFiles(replaceFiles, query.trim(), REPLACE_OPTIONS)
      : { results: [], truncated: false }),
    [mode, showReplace, replaceFiles, query]
  );
  const replaceResults: FileSearchResult[] =
    'error' in replaceSearchOutcome ? [] : replaceSearchOutcome.results;
  const replacePlanOutcome = useMemo(
    () => (mode === 'content' && showReplace
      ? planReplaceAll(replaceFiles, query.trim(), replacement, REPLACE_OPTIONS)
      : { plans: [], truncated: false }),
    [mode, showReplace, replaceFiles, query, replacement]
  );
  const replaceIncomplete = replaceSearchTruncated ||
    ('truncated' in replaceSearchOutcome && replaceSearchOutcome.truncated) ||
    ('truncated' in replacePlanOutcome && replacePlanOutcome.truncated);

  const replaceRows = useMemo<ReplaceRow[]>(() => {
    const rows: ReplaceRow[] = [];
    for (const result of replaceResults) {
      result.matches.forEach((match) => {
        rows.push({ file: result.file, match });
      });
    }
    return rows;
  }, [replaceResults]);

  const replaceMatchCount = useMemo(() => totalMatches(replaceResults), [replaceResults]);
  const canRunReplaceAll = Boolean(onReplaceAll) &&
    !isSearchingReplace &&
    !replaceSearchError &&
    !replaceIncomplete &&
    replaceMatchCount > 0;
  const replaceStartIndex = Math.max(0, Math.floor(replaceScrollTop / REPLACE_ROW_HEIGHT) - 6);
  const replaceEndIndex = Math.min(
    replaceRows.length,
    replaceStartIndex + Math.ceil(replaceViewportHeight / REPLACE_ROW_HEIGHT) + 12
  );

  // A new query invalidates the previous outcome, so the confirmation and its
  // status line are cleared rather than left describing the old search.
  useEffect(() => {
    setConfirmReplace(false);
    setReplaceStatus(null);
  }, [query, replacement]);

  const runReplaceAll = async () => {
    if (!onReplaceAll || !canRunReplaceAll) return;
    const outcome = replacePlanOutcome;
    setConfirmReplace(false);
    if ('error' in outcome) {
      setReplaceStatus(outcome.error);
      return;
    }
    if (outcome.truncated) {
      setReplaceStatus('The replace limit was reached. Narrow the search before replacing.');
      return;
    }
    if (outcome.plans.length === 0) {
      setReplaceStatus('Nothing to replace.');
      return;
    }
    setIsReplacing(true);
    try {
      setReplaceStatus(await onReplaceAll(outcome.plans));
    } catch (error) {
      setReplaceStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsReplacing(false);
    }
  };

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
      ? showReplace
        ? replaceRows.length
        : hits.length
      : panelMode === 'outline'
        ? filteredOutline.length
        : panelMode === 'symbols'
          ? symbolHits.length
          : panelMode === 'commands'
            ? commandResults.length
            : candidates.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mode]);

  const choose = (index: number) => {
    if (panelMode === 'commands') {
      const command = commandResults[index];
      if (!command) return;
      // Close first so a command that opens another overlay wins the state
      // update (React batches both into the later value).
      onClose();
      command.run();
      return;
    }
    if (panelMode === 'content') {
      if (showReplace) {
        const row = replaceRows[index];
        if (!row) return;
        onOpenPath(row.file, row.match.line + 1, row.match.character + 1);
        return;
      }
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
    panelMode === 'commands'
      ? 'Type a command…'
      : panelMode === 'content'
        ? 'Search text across the workspace…'
        : panelMode === 'outline'
          ? 'Filter symbols in the current file…'
          : panelMode === 'symbols'
            ? 'Search workspace symbols…'
            : 'Search files by name… (@ symbols, # workspace)';

  const ariaLabel =
    panelMode === 'commands'
      ? 'Command palette'
      : panelMode === 'content'
        ? 'Search workspace text'
        : panelMode === 'outline'
          ? 'Search symbols in the current file'
          : panelMode === 'symbols'
            ? 'Search workspace symbols'
            : 'Quick open file';

  const footerLabel =
    panelMode === 'commands'
      ? 'Commands'
      : panelMode === 'content'
        ? showReplace
          ? 'Replace across workspace'
          : 'Workspace content search'
        : panelMode === 'outline'
          ? 'Symbols in current file'
          : panelMode === 'symbols'
            ? 'Workspace symbols'
            : 'Quick open';

  return (
    <div
      className={
        docked
          ? 'flex h-full min-h-0 flex-col bg-ink-950'
          : 'fixed inset-0 z-[60] flex items-start justify-center bg-black/50 px-4 pt-20 backdrop-blur-sm'
      }
      onMouseDown={docked ? undefined : onClose}
      role="dialog"
      aria-label={ariaLabel}
    >
      <div
        className={
          docked
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
            : 'w-full max-w-xl overflow-hidden rounded-xl border border-white/[0.1] bg-ink-950 shadow-2xl'
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
          {panelMode === 'commands' ? (
            <CommandIcon className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
          ) : (
            <Search className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
          />
          {(isSearching || isSearchingReplace || isLoadingSymbols) && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-300" />}
          {panelMode === 'content' && onReplaceAll && (
            <button
              type="button"
              onClick={() => {
                setShowReplace((value) => !value);
                setConfirmReplace(false);
                setReplaceStatus(null);
              }}
              className={`p-1 cursor-pointer transition-colors ${
                showReplace ? 'text-violet-300' : 'text-neutral-500 hover:text-white'
              }`}
              title={showReplace ? 'Hide replace' : 'Show replace'}
              aria-label="Toggle replace"
              aria-pressed={showReplace}
            >
              <ReplaceAll className="h-3.5 w-3.5" />
            </button>
          )}
          {!docked && (
            <kbd className="hidden rounded border border-white/[0.1] px-1.5 py-0.5 text-[10px] font-mono text-neutral-500 sm:inline">
              Esc
            </kbd>
          )}
          {!docked && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-neutral-500 hover:text-white cursor-pointer"
              title="Close"
              aria-label="Close search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {panelMode === 'content' && showReplace && (
          <>
            <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
              <Replace className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
              <input
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                    return;
                  }
                  if (event.key === 'Enter' && canRunReplaceAll && !isReplacing) {
                    event.preventDefault();
                    setConfirmReplace(true);
                  }
                }}
                placeholder="Replace with…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
              />
              <button
                type="button"
                disabled={!canRunReplaceAll || isReplacing}
                onClick={() => setConfirmReplace(true)}
                className="shrink-0 rounded border border-white/[0.12] px-2 py-1 text-[10px] text-neutral-200 transition-colors hover:border-violet-300/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
              >
                Replace all
              </button>
            </div>
            {confirmReplace && (
              <div className="flex items-center justify-between gap-2 border-b border-amber-400/20 bg-amber-500/[.08] px-3 py-2 text-[11px] text-amber-200">
                <span>
                  Replace {replaceMatchCount} {replaceMatchCount === 1 ? 'match' : 'matches'} across{' '}
                  {replaceResults.length} {replaceResults.length === 1 ? 'file' : 'files'}?
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void runReplaceAll()}
                    disabled={isReplacing}
                    className="rounded bg-amber-400/90 px-2 py-1 text-[10px] font-medium text-ink-950 transition-colors hover:bg-amber-300 disabled:opacity-50 cursor-pointer"
                  >
                    {isReplacing ? 'Replacing…' : 'Replace'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmReplace(false)}
                    className="rounded border border-white/[0.14] px-2 py-1 text-[10px] text-neutral-200 transition-colors hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {replaceStatus && (
              <p className="border-b border-white/[0.07] bg-white/[0.03] px-3 py-1.5 text-[11px] text-neutral-300">
                {replaceStatus}
              </p>
            )}
          </>
        )}
        {panelMode === 'content' && showReplace && (
          <>
            {isSearchingReplace && (
              <p className="border-b border-white/[0.07] px-3 py-1.5 text-[11px] text-neutral-500">
                Searching workspace files…
              </p>
            )}
            {replaceSearchError && (
              <p className="border-b border-amber-400/20 bg-amber-500/[.08] px-3 py-1.5 text-[11px] text-amber-200">
                Replace preview unavailable: {replaceSearchError}
              </p>
            )}
            {replaceSearchTruncated && (
              <p className="border-b border-amber-400/20 bg-amber-500/[.08] px-3 py-1.5 text-[11px] text-amber-200">
                Workspace search reached its safety limit. Narrow the query; replacing a partial result is disabled.
              </p>
            )}
            {!replaceSearchError && !replaceSearchTruncated && replaceIncomplete && (
              <p className="border-b border-amber-400/20 bg-amber-500/[.08] px-3 py-1.5 text-[11px] text-amber-200">
                More than 2,000 matches found. Narrow the query before replacing all.
              </p>
            )}
          </>
        )}

        <div
          ref={replaceScrollRef}
          onScroll={(event) => {
            setReplaceScrollTop(event.currentTarget.scrollTop);
            setReplaceViewportHeight(event.currentTarget.clientHeight);
          }}
          className={docked ? 'min-h-0 flex-1 overflow-y-auto py-1' : 'max-h-80 overflow-y-auto py-1'}
        >
          {panelMode === 'content' && query.trim().length > 0 && query.trim().length < 2 && (
            <p className="px-4 py-6 text-center text-[11px] text-neutral-500">Type at least 2 characters.</p>
          )}
          {searchError && (
            <p className="px-4 py-6 text-center text-[11px] text-amber-300">{searchError}</p>
          )}
          {symbolError && (
            <p className="px-4 py-6 text-center text-[11px] text-amber-300">{symbolError}</p>
          )}
          {!searchError && !symbolError &&
            !(panelMode === 'content' && showReplace && (isSearchingReplace || replaceSearchError || replaceSearchTruncated)) &&
            resultCount === 0 && (
            <p className="px-4 py-6 text-center text-[11px] text-neutral-500">
              {panelMode === 'commands'
                ? (query.trim() ? 'No commands match.' : 'No commands available.')
                : panelMode === 'content'
                  ? (showReplace ? 'No matches to replace.' : isSearching ? 'Searching…' : 'No matches found.')
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

          {panelMode === 'commands' && commandResults.map((command, index) => (
            <button
              key={command.id}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                index === activeIndex ? 'bg-violet-500/[.14] text-white' : 'text-neutral-300 hover:bg-white/[0.04]'
              }`}
            >
              <CommandIcon className="h-3 w-3 shrink-0 text-violet-300/80" />
              <span className="truncate text-[11px]">{command.title}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <span className="text-[10px] text-neutral-600">{command.category}</span>
                {command.shortcut && (
                  <kbd className="rounded border border-white/[0.1] px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
                    {command.shortcut}
                  </kbd>
                )}
              </span>
            </button>
          ))}

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

          {panelMode === 'content' && !showReplace && hits.map((hit, index) => (
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

          {panelMode === 'content' && showReplace && replaceRows.length > 0 && (
            <div style={{ height: replaceStartIndex * REPLACE_ROW_HEIGHT }} aria-hidden="true" />
          )}
          {panelMode === 'content' && showReplace && replaceRows.slice(replaceStartIndex, replaceEndIndex).map((row, offset) => {
            const index = replaceStartIndex + offset;
            const leading = row.match.text.slice(0, row.match.character);
            const matched = row.match.text.slice(row.match.character, row.match.endCharacter);
            const trailing = row.match.text.slice(row.match.endCharacter);
            return (
              <div key={`${row.file}-${row.match.line}-${row.match.character}-${index}`} className="h-9">
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  className={`flex h-9 w-full items-center gap-2 px-3 text-left transition-colors cursor-pointer ${
                    index === activeIndex ? 'bg-violet-500/[.14]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="w-24 shrink-0 truncate font-mono text-[10px] text-neutral-500" title={row.file}>
                    {row.file}
                  </span>
                  <span className="w-6 shrink-0 text-right font-mono text-[10px] text-neutral-600">
                    {row.match.line + 1}
                  </span>
                  <span className="truncate text-[11px] text-neutral-400">
                    {leading}
                    <span className="rounded bg-violet-500/30 text-violet-100">{matched || '(empty)'}</span>
                    {trailing}
                  </span>
                </button>
              </div>
            );
          })}
          {panelMode === 'content' && showReplace && replaceRows.length > replaceEndIndex && (
            <div style={{ height: (replaceRows.length - replaceEndIndex) * REPLACE_ROW_HEIGHT }} aria-hidden="true" />
          )}

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
            {footerLabel} · ↑↓ to move, Enter to {panelMode === 'commands' ? 'run' : 'open'}
            {mode === 'files' && ' · @ symbols · # workspace'}
          </span>
          <span className="font-mono">
            {mode === 'content' ? 'Ctrl+Shift+F' : mode === 'commands' ? 'Ctrl+Shift+P' : 'Ctrl+P'}
          </span>
        </div>
      </div>
    </div>
  );
}
