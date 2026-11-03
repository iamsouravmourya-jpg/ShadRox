import { Loader2, SearchCode } from 'lucide-react';
import type { ReferenceLocation } from '../lib/desktop';
import { baseName, groupReferencesByFile, totalReferences } from '../lib/editor/references';

export interface ReferencesPanelProps {
  /** Workspace-relative references, already normalised by the caller. */
  references: ReferenceLocation[];
  isLoading: boolean;
  error?: string | null;
  /** The symbol the results belong to, shown in the header. */
  symbolName?: string | null;
  onSelect: (reference: ReferenceLocation) => void;
  onClose: () => void;
}

/**
 * Find-all-references results, rendered in the Explorer sidebar beside the
 * outline. Rows are grouped per file so the list stays readable when a symbol
 * is used across a dozen modules, and each row jumps straight to its position.
 */
export function ReferencesPanel({
  references,
  isLoading,
  error,
  symbolName,
  onSelect,
  onClose
}: ReferencesPanelProps) {
  const groups = groupReferencesByFile(references);
  const count = totalReferences(groups);

  return (
    <section className="shrink-0 border-t border-white/[0.07]" aria-label="References">
      <div className="flex h-7 items-center justify-between px-3 text-[10px] font-bold uppercase tracking-wider text-neutral-400">
        <span className="flex min-w-0 items-center gap-1.5">
          <SearchCode className="h-3 w-3 shrink-0 text-neutral-500" />
          <span className="truncate">
            References
            {symbolName ? <span className="ml-1 font-mono normal-case text-violet-300">{symbolName}</span> : null}
          </span>
          {!isLoading && !error && count > 0 && <span className="text-neutral-600 font-normal">({count})</span>}
        </span>
        <span className="flex items-center gap-1">
          {isLoading && <Loader2 className="h-3 w-3 animate-spin text-violet-300" />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close references"
            className="rounded p-0.5 text-neutral-600 transition-colors hover:text-white cursor-pointer"
          >
            <span className="block text-[11px] leading-none">✕</span>
          </button>
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto pb-1">
        {error ? (
          <p className="px-3 py-2 text-[10.5px] text-amber-300/90" title={error}>
            References unavailable: {error}
          </p>
        ) : groups.length === 0 ? (
          <p className="px-3 py-2 text-[10.5px] italic text-neutral-600">
            {isLoading ? 'Searching…' : 'No references found.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.file}>
              <div
                className="sticky top-0 z-10 flex items-center gap-1.5 truncate bg-ink-950/95 px-3 py-1 font-mono text-[10px] text-neutral-500"
                title={group.file}
              >
                <span className="truncate">{baseName(group.file)}</span>
                <span className="shrink-0 text-neutral-700">{group.references.length}</span>
              </div>
              {group.references.map((reference, index) => (
                <button
                  key={`${reference.line}-${reference.character}-${index}`}
                  type="button"
                  onClick={() => onSelect(reference)}
                  title={`${group.file}:${reference.line + 1}:${reference.character + 1}`}
                  className="flex w-full min-w-0 items-center gap-2 py-[3px] pl-6 pr-2 text-left text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white cursor-pointer"
                >
                  <span
                    className={`w-1.5 shrink-0 text-center font-mono text-[10px] ${
                      reference.isDefinition ? 'text-violet-300' : 'text-neutral-700'
                    }`}
                    title={reference.isDefinition ? 'Declaration' : undefined}
                  >
                    {reference.isDefinition ? '◆' : '·'}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-neutral-600">{reference.line + 1}</span>
                  <span className="truncate font-mono">:{reference.character + 1}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
