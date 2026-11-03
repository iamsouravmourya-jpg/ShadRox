import type { ReferenceLocation } from '../desktop';

export interface ReferenceGroup {
  file: string;
  references: ReferenceLocation[];
}

/**
 * Group references by file so the panel can render one header per file instead
 * of repeating the path on every row.
 *
 * The group holding the declaration sorts first and the rest follow
 * alphabetically: the declaration is what the user usually wants to confirm,
 * and a stable order keeps the list from reshuffling between two identical
 * queries. Paths are compared exactly rather than case-folded because the
 * caller has already normalised them to workspace-relative form.
 */
export function groupReferencesByFile(references: ReferenceLocation[]): ReferenceGroup[] {
  const groups = new Map<string, ReferenceGroup>();
  for (const reference of references) {
    let group = groups.get(reference.file);
    if (!group) {
      group = { file: reference.file, references: [] };
      groups.set(reference.file, group);
    }
    group.references.push(reference);
  }
  return [...groups.values()].sort((left, right) => {
    const leftDefinition = left.references.some((reference) => reference.isDefinition) ? 0 : 1;
    const rightDefinition = right.references.some((reference) => reference.isDefinition) ? 0 : 1;
    return leftDefinition - rightDefinition || left.file.localeCompare(right.file);
  });
}

/** Every reference across every group, for the panel's count badge. */
export function totalReferences(groups: ReferenceGroup[]): number {
  return groups.reduce((sum, group) => sum + group.references.length, 0);
}

/**
 * The basename of a workspace-relative path. References are shown in the
 * explorer-style short form, with the full path kept in the row's tooltip.
 */
export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

/**
 * The identifier the caret sits in or beside, at a 0-based position.
 *
 * This only labels the references panel; the language service is still the one
 * deciding what can actually be renamed. Reading the word from the buffer is
 * therefore enough, and it keeps the header meaningful even before the round
 * trip completes.
 */
export function symbolAt(content: string, line: number, character: number): string {
  const lines = content.split('\n');
  const index = Math.max(0, Math.min(Math.trunc(line) || 0, lines.length - 1));
  const text = lines[index] ?? '';
  const position = Math.max(0, Math.min(Math.trunc(character) || 0, text.length));
  const before = /[A-Za-z0-9_$]*$/.exec(text.slice(0, position))?.[0] ?? '';
  const after = /^[A-Za-z0-9_$]*/.exec(text.slice(position))?.[0] ?? '';
  return `${before}${after}`;
}
