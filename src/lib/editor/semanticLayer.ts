import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SemanticToken } from '../desktop';
import { resolveSemanticRanges } from './semanticTokens';

/**
 * Paints the language service's semantic classification on top of the Lezer
 * highlighting. The tokens are stored line/character-keyed rather than as
 * offsets, so typing can still be mapped back onto a moved line: the decoration
 * builder re-resolves them against the current document on every change instead
 * of trusting a snapshot of the old text.
 */

/** Replace the tokens painted on the active document; empty clears the layer. */
export const setSemanticTokens = StateEffect.define<SemanticToken[]>();

const semanticTokensField = StateField.define<SemanticToken[]>({
  create: () => [],
  update(tokens, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSemanticTokens)) return effect.value;
    }
    return tokens;
  }
});

/**
 * One mark per colour, reused across ranges. CodeMirror diffs its decoration
 * set on every change, so sharing the mark instances keeps that comparison
 * cheap for a file with thousands of identifiers.
 */
const markCache = new Map<string, Decoration>();

function markFor(color: string): Decoration {
  let mark = markCache.get(color);
  if (!mark) {
    mark = Decoration.mark({ attributes: { style: `color:${color}` } });
    markCache.set(color, mark);
  }
  return mark;
}

function buildDecorations(tokens: SemanticToken[], doc: { length: number; toString(): string }): DecorationSet {
  if (tokens.length === 0 || doc.length === 0) return Decoration.none;
  const ranges = resolveSemanticRanges(tokens, doc.toString());
  if (ranges.length === 0) return Decoration.none;
  // `resolveSemanticRanges` already returns ascending, non-overlapping ranges,
  // which is exactly what `Decoration.set` wants without re-sorting.
  return Decoration.set(ranges.map((range) => markFor(range.color).range(range.from, range.to)));
}

const semanticPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state.field(semanticTokensField), view.state.doc);
    }

    update(update: ViewUpdate) {
      const changedTokens = update.state.field(semanticTokensField) !== update.startState.field(semanticTokensField);
      // A document edit shifts every offset, so the decoration set has to be
      // rebuilt from the stored tokens even when no new response arrived.
      if (update.docChanged || changedTokens) {
        this.decorations = buildDecorations(update.state.field(semanticTokensField), update.state.doc);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);

export function semanticHighlighting(): Extension {
  return [semanticTokensField, semanticPlugin];
}
