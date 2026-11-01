import { useMemo } from 'react';
import { AlertCircle, AlertTriangle, CircleCheck, Info, Loader2, RefreshCw, X } from 'lucide-react';
import type { DesktopDiagnostic } from '../lib/desktop';
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
}

interface ProblemFileGroup {
  key: string;
  relativePath: string;
  fileName: string;
  diagnostics: DesktopDiagnostic[];
  errors: number;
  warnings: number;
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
  onOpenProblem
}: ProblemsPanelProps) {
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
              {group.diagnostics.map((diagnostic, index) => (
                <button
                  key={`${group.key}-${diagnostic.line}-${diagnostic.character}-${index}`}
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
                  className="flex w-full items-start gap-2 px-3 py-1 text-left transition-colors hover:bg-white/[0.04] cursor-pointer"
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
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
