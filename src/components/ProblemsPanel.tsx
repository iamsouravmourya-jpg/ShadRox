import { useCallback, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CircleCheck, Info, Lightbulb, Loader2, RefreshCw, X } from 'lucide-react';
import type { CodeAction, DesktopDiagnostic } from '../lib/desktop';
import { baseName, compareDiagnostics, normalizeSlashes, relativeToRoot } from '../lib/diagnostics';

export interface ProblemsPanelProps {
  diagnostics: DesktopDiagnostic[];
  /** Absolute workspace root; diagnostic `file` values are absolute. */
  rootPath: string | null;
  truncated: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
  onOpenProblem: (
    relativePath: string,
    line: number,
    character: number,
    endLine: number,
    endCharacter: number
  ) => void;
  /**
   * Language-service quick fixes for one problem, keyed by workspace-relative
   * path. Absent in the browser build, which is what hides the fix affordance.
   */
  onRequestFixes?: (
    relativePath: string,
    line: number,
    character: number,
    endLine: number,
    endCharacter: number
  ) => Promise<CodeAction[]>;
  onApplyFix?: (action: CodeAction) => Promise<string>;
}

interface ProblemFileGroup {
  key: string;
  relativePath: string;
  fileName: string;
  diagnostics: DesktopDiagnostic[];
  errors: number;
  warnings: number;
}

/** Which row has its fix list expanded, and what it currently holds. */
interface FixMenuState {
  key: string;
  loading: boolean;
  error: string | null;
  actions: CodeAction[];
}

function severityIcon(severity: DesktopDiagnostic['severity']) {
  if (severity === 'error') return <AlertCircle className="h-3 w-3 shrink-0 text-rose-400" />;
  if (severity === 'warning') return <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />;
  return <Info className="h-3 w-3 shrink-0 text-sky-400" />;
}

/**
 * Bottom-dock problems list. It groups by file (errors first), keeps the TS
 * code visible, and clicking a row asks App to open the file and reveal the
 * exact range — the same navigation path quick open uses.
 */
export function ProblemsPanel({
  diagnostics,
  rootPath,
  truncated,
  isRefreshing,
  onRefresh,
  onClose,
  onOpenProblem,
  onRequestFixes,
  onApplyFix
}: ProblemsPanelProps) {
  const [fixMenu, setFixMenu] = useState<FixMenuState | null>(null);
  // Guards against a slow fix response landing on a row the user already left.
  const fixRequestId = useRef(0);

  const toggleFixes = useCallback(
    async (key: string, relativePath: string, diagnostic: DesktopDiagnostic) => {
      if (!onRequestFixes) return;
      // Clicking the same row again collapses the list instead of refetching.
      if (fixMenu?.key === key) {
        fixRequestId.current += 1;
        setFixMenu(null);
        return;
      }
      const requestId = ++fixRequestId.current;
      setFixMenu({ key, loading: true, error: null, actions: [] });
      try {
        const actions = await onRequestFixes(
          relativePath,
          diagnostic.line,
          diagnostic.character,
          diagnostic.endLine ?? diagnostic.line,
          diagnostic.endCharacter ?? diagnostic.character
        );
        if (requestId !== fixRequestId.current) return;
        setFixMenu({ key, loading: false, error: null, actions });
      } catch (error) {
        if (requestId !== fixRequestId.current) return;
        setFixMenu({
          key,
          loading: false,
          error: error instanceof Error ? error.message : 'Quick fixes failed.',
          actions: []
        });
      }
    },
    [fixMenu?.key, onRequestFixes]
  );

  const applyFix = useCallback(
    async (action: CodeAction) => {
      if (!onApplyFix) return;
      fixRequestId.current += 1;
      setFixMenu(null);
      try {
        await onApplyFix(action);
      } catch {
        // The caller owns the message; the row simply collapses again.
      }
    },
    [onApplyFix]
  );

  const groups = useMemo<ProblemFileGroup[]>(() => {
    const byFile = new Map<string, ProblemFileGroup>();
    for (const diagnostic of diagnostics) {
      const absolute = normalizeSlashes(diagnostic.file);
      const relative = relativeToRoot(rootPath, absolute);
      const key = (relative ?? absolute).toLowerCase();
      let group = byFile.get(key);
      if (!group) {
        const relativePath = relative ?? absolute;
        group = {
          key,
          relativePath,
          fileName: baseName(relativePath),
          diagnostics: [],
          errors: 0,
          warnings: 0
        };
        byFile.set(key, group);
      }
      group.diagnostics.push(diagnostic);
      if (diagnostic.severity === 'error') group.errors += 1;
      else if (diagnostic.severity === 'warning') group.warnings += 1;
    }

    const list = [...byFile.values()];
    for (const group of list) group.diagnostics.sort(compareDiagnostics);
    return list.sort(
      (a, b) =>
        Number(b.errors > 0) - Number(a.errors > 0) ||
        b.errors - a.errors ||
        b.warnings - a.warnings ||
        a.relativePath.localeCompare(b.relativePath)
    );
  }, [diagnostics, rootPath]);

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length;

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#07080b]" aria-label="Problems">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/[0.07] bg-ink-950 px-3">
        <div className="flex min-w-0 items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-neutral-400">
          <AlertCircle className={`h-3 w-3 ${errors > 0 ? 'text-rose-400' : 'text-neutral-600'}`} />
          <span>Problems</span>
          <span className="text-neutral-600">
            {errors} error{errors === 1 ? '' : 's'}, {warnings} warning{warnings === 1 ? '' : 's'}
          </span>
          {truncated && <span className="normal-case tracking-normal text-amber-300/80">results truncated</span>}
          {isRefreshing && <Loader2 className="h-3 w-3 animate-spin text-violet-300" />}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="flex items-center gap-1 rounded p-1 text-[10px] text-neutral-500 hover:text-white cursor-pointer"
            title="Re-run TypeScript diagnostics"
            aria-label="Refresh problems"
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-white cursor-pointer"
            title="Close problems"
            aria-label="Close problems"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <CircleCheck className="h-5 w-5 text-emerald-400/80" />
            <p className="text-[11px] text-neutral-400">
              {isRefreshing ? 'Checking the project…' : 'No problems — this project is clean.'}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-white/[0.05] bg-ink-950/95 px-3 py-1">
                <span className="truncate font-mono text-[11px] font-medium text-neutral-200">{group.fileName}</span>
                {group.relativePath !== group.fileName && (
                  <span className="truncate font-mono text-[10px] text-neutral-600">{group.relativePath}</span>
                )}
                <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-600">
                  {group.errors > 0 && <span className="text-rose-400/80">{group.errors}E </span>}
                  {group.warnings > 0 && <span className="text-amber-400/80">{group.warnings}W</span>}
                </span>
              </div>
              {group.diagnostics.map((diagnostic, index) => {
                const rowKey = `${group.key}-${diagnostic.line}-${diagnostic.character}-${index}`;
                const isFixOpen = fixMenu?.key === rowKey;
                return (
                  <div key={rowKey}>
                    <div className="group flex items-stretch transition-colors hover:bg-white/[0.04]">
                      <button
                        type="button"
                        onClick={() =>
                          onOpenProblem(
                            group.relativePath,
                            diagnostic.line,
                            diagnostic.character,
                            diagnostic.endLine,
                            diagnostic.endCharacter
                          )
                        }
                        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-1 text-left cursor-pointer"
                        title={`${group.relativePath}:${diagnostic.line + 1}:${diagnostic.character + 1}`}
                      >
                        <span className="mt-[3px]">{severityIcon(diagnostic.severity)}</span>
                        <span className="shrink-0 font-mono text-[10px] text-neutral-500">
                          {diagnostic.line + 1}:{diagnostic.character + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300" title={diagnostic.message}>
                          {diagnostic.code && (
                            <span className="mr-1.5 font-mono text-[10px] text-violet-300/80">{diagnostic.code}</span>
                          )}
                          {diagnostic.message}
                        </span>
                      </button>
                      {onRequestFixes && (
                        <button
                          type="button"
                          onClick={() => void toggleFixes(rowKey, group.relativePath, diagnostic)}
                          className={`mr-2 shrink-0 self-start rounded p-1 transition-opacity cursor-pointer hover:text-amber-300 ${
                            isFixOpen
                              ? 'text-amber-300 opacity-100'
                              : 'text-neutral-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                          }`}
                          title="Quick fixes for this problem"
                          aria-label="Quick fixes for this problem"
                          aria-expanded={isFixOpen}
                        >
                          <Lightbulb className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {isFixOpen && fixMenu && (
                      <div className="border-y border-white/[0.05] bg-ink-950/60">
                        {fixMenu.loading ? (
                          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-neutral-400">
                            <Loader2 className="h-3 w-3 animate-spin text-amber-300" />
                            Looking for fixes…
                          </div>
                        ) : fixMenu.error ? (
                          <p className="px-3 py-2 text-[11px] text-rose-400">{fixMenu.error}</p>
                        ) : fixMenu.actions.length === 0 ? (
                          <p className="px-3 py-2 text-[11px] text-neutral-500">
                            No quick fixes available for this problem.
                          </p>
                        ) : (
                          fixMenu.actions.map((action, actionIndex) => (
                            <button
                              key={`${action.name}-${actionIndex}`}
                              type="button"
                              onClick={() => void applyFix(action)}
                              className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px] text-neutral-300 transition-colors hover:bg-white/[0.06] hover:text-white cursor-pointer"
                            >
                              <Lightbulb className="mt-[1px] h-3 w-3 shrink-0 text-amber-300" />
                              <span className="min-w-0 flex-1">{action.description}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
