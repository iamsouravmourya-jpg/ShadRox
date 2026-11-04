/**
 * Command palette registry.
 *
 * The palette is a shortcut into actions that already exist in the app — it
 * never invents behaviour. Each command carries its own `run` closure, so a
 * command can only be built where its action is in scope (App.tsx).
 *
 * Ranking is pure and unit-tested so the palette can never quietly drop a
 * command that clearly matches what the user typed. It runs on the ported
 * VSCode fuzzy scorer (`./search/fuzzyScorer`).
 */

import { rankByFuzzy, type IItemAccessor } from './search/fuzzyScorer';

export interface Command {
  /** Stable id; also the React key. */
  id: string;
  /** Primary label. */
  title: string;
  /** Grouping label shown on the right of the row. */
  category: string;
  /** Shortcut hint, e.g. `Ctrl+Shift+P`. Matched, never executed here. */
  shortcut?: string;
  /** Extra search terms that help discovery without cluttering the row. */
  keywords?: string;
  run: () => void;
}

interface ScoredEntry {
  command: Command;
  /** Registry position; the stable sort keeps registry order on full ties. */
  index: number;
}

const commandAccessor: IItemAccessor<ScoredEntry> = {
  getItemLabel: (entry) => entry.command.title,
  getItemDescription: (entry) => {
    const meta = `${entry.command.category} ${entry.command.keywords ?? ''} ${entry.command.shortcut ?? ''}`.trim();
    return meta || undefined;
  },
  getItemPath: () => undefined
};

/**
 * Rank commands for a query on the ported VSCode fuzzy scorer. An empty query
 * returns registry order untouched. A hit inside the title beats a hit in the
 * category/keywords or shortcut (label vs description tiers), prefix matches
 * rank first, and a plain subsequence hit still matches via non-contiguous
 * scoring. `+`/`~` tokens include/exclude candidates. Ties keep registry order
 * because the sort is stable and the input is indexed.
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const trimmed = query.trim();
  if (!trimmed) return commands.slice();

  const entries: ScoredEntry[] = commands.map((command, index) => ({ command, index }));
  return rankByFuzzy(trimmed, entries, commandAccessor).map((entry) => entry.item.command);
}
