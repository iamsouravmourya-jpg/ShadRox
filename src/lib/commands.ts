/**
 * Command palette registry.
 *
 * The palette is a shortcut into actions that already exist in the app — it
 * never invents behaviour. Each command carries its own `run` closure, so a
 * command can only be built where its action is in scope (App.tsx).
 *
 * Ranking is pure and unit-tested so the palette can never quietly drop a
 * command that clearly matches what the user typed.
 */

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

function subsequence(needle: string, haystack: string): boolean {
  let cursor = 0;
  for (const char of needle) {
    cursor = haystack.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

/**
 * Rank commands for a query. An empty query returns registry order untouched.
 * A hit inside the title beats a hit in the category/keywords or shortcut, and
 * a subsequence hit in the title ranks last but still matches. Ties keep
 * registry order so the list stays stable as the user types.
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands.slice();

  const scored: Array<{ command: Command; rank: number; index: number }> = [];
  commands.forEach((command, index) => {
    const title = command.title.toLowerCase();
    const titleAt = title.indexOf(needle);
    if (titleAt >= 0) {
      scored.push({ command, rank: titleAt, index });
      return;
    }
    const meta = `${command.category} ${command.keywords ?? ''} ${command.shortcut ?? ''}`.toLowerCase();
    const metaAt = meta.indexOf(needle);
    if (metaAt >= 0) {
      scored.push({ command, rank: 100 + metaAt, index });
      return;
    }
    if (subsequence(needle, title)) scored.push({ command, rank: 500, index });
  });

  return scored
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command);
}
