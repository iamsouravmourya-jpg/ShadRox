import type { SemanticToken } from '../desktop';
import { offsetFromPosition } from './edits';

/**
 * The language service classifies declarations far more precisely than the
 * Lezer grammar can: it knows that `Point` is an interface and `Shape` a type
 * alias, while the grammar only sees an identifier. Its spans therefore get
 * painted on top of the normal highlighting.
 *
 * Only the declarations where that extra precision actually changes the colour
 * are listed; a `null` entry leaves the syntax highlighting untouched, which
 * avoids two systems fighting over the same identifier. The keys mirror the
 * service's own vocabulary (electron/ts-service.cjs).
 */
const SEMANTIC_COLORS: Record<string, string | null> = {
  class: '#c4b5fd',
  enum: '#a5f3fc',
  interface: '#7dd3fc',
  namespace: '#f0abfc',
  typeParameter: '#fda4af',
  type: '#67e8f9',
  parameter: null,
  variable: null,
  enumMember: null,
  property: null,
  function: null,
  member: null
};

export interface SemanticRange {
  from: number;
  to: number;
  color: string;
}

/**
 * Convert service tokens into decoration ranges. Colours are inlined as a style
 * attribute rather than a class so the layer needs no stylesheet of its own.
 * `Text`-agnostic (plain strings) so the geometry can be unit tested.
 */
export function resolveSemanticRanges(tokens: SemanticToken[], text: string): SemanticRange[] {
  const ranges: SemanticRange[] = [];
  for (const token of tokens) {
    const color = SEMANTIC_COLORS[token.type];
    if (!color) continue;
    const from = offsetFromPosition(text, token.line, token.character);
    const to = offsetFromPosition(text, token.endLine, token.endCharacter);
    if (to <= from) continue;
    ranges.push({ from, to, color });
  }
  // CodeMirror's RangeSetBuilder demands ascending, non-overlapping ranges.
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);
  const deduped: SemanticRange[] = [];
  let boundary = 0;
  for (const range of ranges) {
    if (range.from < boundary) continue;
    deduped.push(range);
    boundary = range.to;
  }
  return deduped;
}
