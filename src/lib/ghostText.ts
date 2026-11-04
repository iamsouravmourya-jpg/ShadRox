/**
 * Inline ghost-text tab completion for CodeMirror 6.
 *
 * The suggestion renders as a dim inline widget after the caret; Tab inserts
 * it, Escape or any further editing dismisses it. Requests are debounced and
 * aborted on every keystroke, and a stale response is dropped by comparing the
 * caret position it was computed for.
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { completionStatus } from '@codemirror/autocomplete';
import { isWorthCompleting } from './fim';
import { requestFimCompletion, type FimRequestContext } from './fimClient';
import { boostFor, ingestDocument, mergeGhostSuggestion, trailingIdentifier } from './completionTrie';

interface Ghost {
  pos: number;
  text: string;
}

export interface GhostTextOptions extends FimRequestContext {
  /** Disables the feature without tearing the extension down. */
  enabled?: boolean;
  debounceMs?: number;
  /** Called once for every suggestion the user accepts, so it can be billed. */
  onAccepted?: () => void;
  /**
   * NOTE: there is deliberately no `temperature` here, and the chat
   * temperature must never be forwarded to a completion request. Tab
   * completion continues the code that is already on screen; it wants
   * near-deterministic output, so sampling stays at the provider's completion
   * default (see api/ai/fim.ts). Chat creativity is a different knob for a
   * different job — see `runQuickEdit`, which does honour it, clamped.
   */
}

class GhostWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'shadrox-ghost';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const setGhost = StateEffect.define<Ghost | null>();

const ghostField = StateField.define<Ghost | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setGhost)) return effect.value;
    }
    // Our own insertion carries 'input.complete'; anything else invalidates.
    if (transaction.docChanged && value && !transaction.isUserEvent('input.complete')) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (ghost): DecorationSet =>
      ghost
        ? Decoration.set([Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos)])
        : Decoration.none
    )
});

/** Upper bound on how much of a freshly opened buffer feeds the trie. */
const TRIE_INGEST_CAP = 400_000;

class GhostController {
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private requestId = 0;
  /** Registry key for this view's buffer inside the project trie. */
  private readonly docId = `ghost-view-${++GhostController.viewCounter}`;
  private static viewCounter = 0;

  constructor(
    private readonly view: EditorView,
    private readonly options: GhostTextOptions
  ) {
    // Seed the project trie from the buffer this view opened: pure local CPU,
    // zero API calls. Every file the user visits passes through here.
    ingestDocument(this.docId, view.state.doc.sliceString(0, TRIE_INGEST_CAP));
  }

  update(update: ViewUpdate): void {
    if (this.options.enabled === false) {
      this.cancel();
      return;
    }
    if (update.docChanged) this.ingestChanges(update);
    if (!update.docChanged && !update.selectionSet) return;
    if (update.selectionSet && !update.docChanged) this.show(null);
    this.schedule();
  }

  destroy(): void {
    this.cancel();
  }

  /**
   * Only newly inserted text feeds the trie — deletions are not re-indexed,
   * and each keystroke tokenizes at most its inserted run, so the cost stays
   * far below the debounce interval it shares with the FIM request.
   */
  private ingestChanges(update: ViewUpdate): void {
    let inserted = '';
    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      if (toB > fromB && inserted.length < 8_000) {
        inserted += update.state.doc.sliceString(fromB, Math.min(toB, fromB + 8_000));
      }
    });
    if (inserted) ingestDocument(this.docId, inserted);
  }

  private schedule(): void {
    this.cancel();
    const delay = this.options.debounceMs ?? 380;
    this.timer = window.setTimeout(() => void this.run(), delay);
  }

  private cancel(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private async run(): Promise<void> {
    const { state } = this.view;
    const cursor = state.selection.main;
    if (!cursor.empty) return;
    if (completionStatus(state) !== null) return;

    const prefix = state.doc.sliceString(0, cursor.from);
    const suffix = state.doc.sliceString(cursor.from);
    if (!isWorthCompleting(prefix)) return;

    // The local boost is computed before the network call so a project
    // identifier is still on hand when the model is offline, aborted or cooling
    // down — fimClient resolves those to an empty string rather than throwing.
    const partial = trailingIdentifier(prefix);
    const boost = boostFor(prefix);

    const id = ++this.requestId;
    const controller = new AbortController();
    this.controller = controller;
    try {
      // Passed whole: hand-listing these fields is how a custom endpoint's
      // baseUrl once went missing and every keystroke came back as a 400.
      const result = await requestFimCompletion(
        this.options,
        prefix,
        suffix,
        controller.signal
      );
      // Drop the response if a newer request started or the caret moved.
      if (id !== this.requestId) return;
      if (this.view.state.selection.main.from !== cursor.from) return;
      const ghost = mergeGhostSuggestion(result.text, partial, boost);
      this.show(ghost ? { pos: cursor.from, text: ghost } : null);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private show(ghost: Ghost | null): void {
    if (!ghost && !this.view.state.field(ghostField)) return;
    this.view.dispatch({ effects: setGhost.of(ghost) });
  }

  accept(): boolean {
    const ghost = this.view.state.field(ghostField);
    if (!ghost) return false;
    this.cancel();
    this.requestId += 1;
    this.view.dispatch({
      changes: { from: ghost.pos, insert: ghost.text },
      effects: setGhost.of(null),
      selection: { anchor: ghost.pos + ghost.text.length },
      userEvent: 'input.complete'
    });
    this.view.focus();
    this.options.onAccepted?.();
    return true;
  }

  dismiss(): void {
    if (this.view.state.field(ghostField)) this.show(null);
  }
}

const ghostTheme = EditorView.baseTheme({
  '.shadrox-ghost': {
    color: 'rgba(226, 232, 240, 0.32)',
    fontStyle: 'italic',
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none'
  }
});

export function ghostText(options: GhostTextOptions): Extension {
  // Bound here so the ViewPlugin class keeps the (view) constructor signature
  // CodeMirror requires, while still carrying the live BYOK configuration.
  const plugin = ViewPlugin.fromClass(
    class extends GhostController {
      constructor(view: EditorView) {
        super(view, options);
      }
    }
  );

  return [
    ghostField,
    plugin,
    // Lower precedence than the autocomplete panel, so its Tab binding wins when open.
    keymap.of([
      {
        key: 'Tab',
        preventDefault: true,
        run: (view) => view.plugin(plugin)?.accept() ?? false
      },
      {
        key: 'Escape',
        run: (view) => {
          const controller = view.plugin(plugin);
          if (!controller || !view.state.field(ghostField)) return false;
          controller.dismiss();
          return true;
        }
      }
    ]),
    ghostTheme
  ];
}
