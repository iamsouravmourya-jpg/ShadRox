import type { WorkspaceTextEdit } from '../desktop';

/**
 * Language-service edits (rename, code actions) arrive as 0-based line/character
 * spans keyed by absolute path. CodeMirror works in character offsets, so every
 * edit has to be converted before it can be applied to a document — and applied
 * back-to-front, because replacing text earlier in the file shifts every offset
 * after it.
 */

/** Convert a 0-based line/character position into a character offset. */
export function offsetFromPosition(text: string, line: number, character: number): number {
  const targetLine = Math.max(0, Math.trunc(line) || 0);
  let offset = 0;
  for (let index = 0; index < targetLine; index += 1) {
    const newline = text.indexOf('\n', offset);
    if (newline === -1) return text.length;
    offset = newline + 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const end = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(offset + Math.max(0, Math.trunc(character) || 0), end);
}

export interface ResolvedEdit {
  from: number;
  to: number;
  newText: string;
}

/**
 * Order edits so a single pass leaves the document correct.
 *
 * Sorting by `to` descending puts every edit after the ones it follows, which is
 * exactly the back-to-front order a single pass needs. For disjoint spans that is
 * the same as ordering by `from` descending, but it also makes a containing span
 * win over the span nested inside it: the outer edit is applied first and the
 * inner one is then dropped as an overlap instead of corrupting the offsets.
 */
export function resolveEdits(text: string, edits: WorkspaceTextEdit[]): ResolvedEdit[] {
  return edits
    .map((edit) => {
      const a = offsetFromPosition(text, edit.line, edit.character);
      const b = offsetFromPosition(text, edit.endLine, edit.endCharacter);
      return { from: Math.min(a, b), to: Math.max(a, b), newText: edit.newText };
    })
    .sort((left, right) => right.to - left.to || left.from - right.from);
}

/**
 * Apply a batch of edits to one file's text. The service never emits two edits
 * that overlap for a single symbol, but a rename can produce a whole-file
 * replacement alongside a symbol edit, so overlaps are dropped rather than
 * allowed to corrupt offsets.
 */
export function applyTextEdits(text: string, edits: WorkspaceTextEdit[]): string {
  let result = text;
  let boundary = Number.POSITIVE_INFINITY;
  for (const edit of resolveEdits(text, edits)) {
    if (edit.to > boundary) continue;
    result = result.slice(0, edit.from) + edit.newText + result.slice(edit.to);
    boundary = edit.from;
  }
  return result;
}

/** Group edits by their (case-insensitive) absolute path, preserving order. */
export function groupEditsByFile(edits: WorkspaceTextEdit[]): Map<string, WorkspaceTextEdit[]> {
  const groups = new Map<string, WorkspaceTextEdit[]>();
  const byLowerPath = new Map<string, string>();
  for (const edit of edits) {
    const lower = edit.file.replace(/\\/g, '/').toLowerCase();
    let file = byLowerPath.get(lower);
    if (!file) {
      file = edit.file;
      byLowerPath.set(lower, file);
    }
    const bucket = groups.get(file);
    if (bucket) bucket.push(edit);
    else groups.set(file, [edit]);
  }
  return groups;
}

export interface PlannedFileEdit {
  file: string;
  content: string;
  /** Number of replacements that landed; 0 means the file was already correct. */
  changes: number;
}

/**
 * Turn a cross-file edit batch into the new content of every affected file.
 * `contentFor` resolves the buffer that should be edited (the unsaved editor
 * buffer when one is open, otherwise the file on disk). Files whose content
 * cannot be read are skipped so a rename never writes a truncated file.
 */
export function planFileEdits(
  edits: WorkspaceTextEdit[],
  contentFor: (file: string) => string | null
): PlannedFileEdit[] {
  const planned: PlannedFileEdit[] = [];
  for (const [file, fileEdits] of groupEditsByFile(edits)) {
    const before = contentFor(file);
    if (before === null) continue;
    const content = applyTextEdits(before, fileEdits);
    if (content !== before) planned.push({ file, content, changes: fileEdits.length });
  }
  return planned;
}

export interface StaleEditRange {
  from: number;
  to: number;
}

/**
 * Flat result shape (no discriminated union) so callers can read `reason`
 * without narrowing — the project compiles with strictNullChecks off, where a
 * union member missing a field is a type error, not a warning.
 */
export interface ReanchoredEdit {
  ok: boolean;
  from: number;
  to: number;
  moved: boolean;
  reason: string;
}

/**
 * Re-validate a quick-edit span against the document as it is *now*.
 *
 * The span is captured before the model round-trip, so any typing (or an agent
 * write) during that call can leave `to` past the end of the document, which
 * makes CodeMirror throw inside the apply click. Rather than crash, the span is
 * re-anchored on the text it was meant to replace: an exact match at the old
 * offsets wins, a unique match elsewhere is followed, and anything ambiguous or
 * missing refuses the apply so the user keeps their undo history intact.
 */
export function reanchorEditRange(
  text: string,
  range: StaleEditRange,
  original: string
): ReanchoredEdit {
  const from = Math.max(0, Math.min(Math.trunc(range.from) || 0, text.length));
  const to = Math.max(from, Math.min(Math.trunc(range.to) || 0, text.length));
  const clamped = { ok: true, from, to, moved: from !== range.from || to !== range.to, reason: '' };

  if (!original || text.slice(from, to) === original) return clamped;

  const first = text.indexOf(original);
  if (first === -1) {
    return {
      ok: false,
      from,
      to,
      moved: false,
      reason: 'The code this edit was written against is no longer in the file. Close the diff and ask again.'
    };
  }
  if (first !== text.lastIndexOf(original)) {
    return {
      ok: false,
      from,
      to,
      moved: false,
      reason: 'The code this edit was written against now appears more than once, so it cannot be placed safely. Close the diff and ask again.'
    };
  }
  return { ok: true, from: first, to: first + original.length, moved: true, reason: '' };
}
