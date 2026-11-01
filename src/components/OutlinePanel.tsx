import { Loader2, ListTree } from 'lucide-react';
import type { OutlineSymbol } from '../lib/desktop';

export interface OutlinePanelProps {
  symbols: OutlineSymbol[];
  isLoading: boolean;
  error?: string | null;
  onSelect: (symbol: OutlineSymbol) => void;
}

const KIND_LABELS: Record<string, string> = {
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
  field: 'f',
  getter: 'g',
  setter: 's',
  parameter: 'a',
  typeParameter: 'T'
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind?.toLowerCase()] ?? '·';
}

/**
 * Document outline for the active file, rendered inside the Explorer sidebar.
 * Rows use the symbol's own `depth` for indentation; clicking one asks the
 * parent to scroll the editor to that position.
 */
export function OutlinePanel({ symbols, isLoading, error, onSelect }: OutlinePanelProps) {
  return (
    <section className="shrink-0 border-t border-white/[0.07]" aria-label="Document outline">
      <div className="flex h-7 items-center justify-between px-3 text-[10px] font-bold uppercase tracking-wider text-neutral-400">
        <span className="flex items-center gap-1.5">
          <ListTree className="h-3 w-3 text-neutral-500" />
          Outline
        </span>
        {isLoading && <Loader2 className="h-3 w-3 animate-spin text-violet-300" />}
      </div>
      <div className="max-h-56 overflow-y-auto pb-1">
        {error ? (
          <p className="px-3 py-2 text-[10.5px] text-amber-300/90" title={error}>
            Outline unavailable: {error}
          </p>
        ) : symbols.length === 0 ? (
          <p className="px-3 py-2 text-[10.5px] italic text-neutral-600">
            {isLoading ? 'Reading symbols…' : 'No symbols in this file.'}
          </p>
        ) : (
          symbols.map((symbol, index) => (
            <button
              key={`${symbol.line}-${symbol.character}-${symbol.name}-${index}`}
              type="button"
              onClick={() => onSelect(symbol)}
              title={`${symbol.kind} ${symbol.name} · line ${symbol.line + 1}`}
              className="group flex w-full min-w-0 items-center gap-1.5 py-[3px] pr-2 text-left text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.04] hover:text-white cursor-pointer"
              style={{ paddingLeft: `${10 + Math.max(0, symbol.depth) * 12}px` }}
            >
              <span className="w-3 shrink-0 font-mono text-[10px] text-violet-300/80">{kindLabel(symbol.kind)}</span>
              <span className="truncate font-mono">{symbol.name}</span>
              <span className="ml-auto hidden shrink-0 font-mono text-[9px] text-neutral-600 group-hover:inline">
                {symbol.line + 1}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
