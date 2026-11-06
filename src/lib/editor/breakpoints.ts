import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension
} from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from '@codemirror/view';

/**
 * The clickable breakpoint gutter.
 *
 * The set of breakpoint lines arrives as a `StateEffect` rather than as a
 * re-created `Extension`, for the same reason the lint layer does: clicking a
 * dot must not reconfigure CodeMirror and throw away scroll or selection
 * state. Everything the gutter needs is read from a field.
 */

interface BreakpointFieldValue {
  enabled: boolean;
  lines: Set<number>;
}

/** Replace the breakpoints painted in the gutter; an empty list clears them. */
export const setBreakpointLines = StateEffect.define<{ enabled: boolean; lines: number[] }>();

const breakpointField = StateField.define<BreakpointFieldValue>({
  create: () => ({ enabled: false, lines: new Set<number>() }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setBreakpointLines)) {
        return { enabled: effect.value.enabled, lines: new Set(effect.value.lines) };
      }
    }
    return value;
  }
});

class BreakpointDot extends GutterMarker {
  toDOM(): HTMLElement {
    const dot = document.createElement('div');
    dot.className = 'cm-breakpoint-dot';
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }
}

const BREAKPOINT_DOT = new BreakpointDot();

/** Callbacks read through a getter object so the extension can stay stable. */
export interface BreakpointGutterHandlers {
  onToggle: (line: number) => void;
}

function buildMarkers(view: EditorView) {
  const { enabled, lines } = view.state.field(breakpointField);
  if (!enabled || lines.size === 0) return RangeSet.empty as RangeSet<GutterMarker>;
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const lineNumber of [...lines].sort((a, b) => a - b)) {
    if (lineNumber < 1 || lineNumber > view.state.doc.lines) continue;
    builder.add(view.state.doc.line(lineNumber).from, view.state.doc.line(lineNumber).from, BREAKPOINT_DOT);
  }
  return builder.finish();
}

const enabledClassPlugin = ViewPlugin.fromClass(
  class {
    private enabled: boolean | null = null;

    constructor(private readonly view: EditorView) {
      this.sync();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setBreakpointLines)))) {
        this.sync();
      }
    }

    private sync() {
      const { enabled } = this.view.state.field(breakpointField);
      if (enabled === this.enabled) return;
      this.enabled = enabled;
      for (const element of this.view.dom.querySelectorAll('.cm-breakpoint-gutter')) {
        element.classList.toggle('is-enabled', enabled);
      }
    }
  }
);

/** The gutter extension; reusing one instance across renders is intentional. */
export function breakpointGutterExtension(handlers: BreakpointGutterHandlers): Extension {
  return [
    breakpointField,
    gutter({
      class: 'cm-breakpoint-gutter',
      renderEmptyElements: true,
      markers: buildMarkers,
      domEventHandlers: {
        mousedown(view, line, event) {
          if (!view.state.field(breakpointField).enabled) return false;
          event.preventDefault();
          handlers.onToggle(view.state.doc.lineAt(line.from).number);
          return true;
        }
      }
    }),
    enabledClassPlugin,
    EditorView.theme({
      '.cm-breakpoint-gutter': {
        width: '14px',
        cursor: 'default'
      },
      '.cm-breakpoint-gutter .cm-gutterElement': {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 2px'
      },
      '.cm-breakpoint-dot': {
        width: '8px',
        height: '8px',
        borderRadius: '9999px',
        backgroundColor: '#f43f5e',
        boxShadow: '0 0 0 1px rgba(244, 63, 94, 0.35)'
      },
      '.cm-breakpoint-gutter.is-enabled .cm-gutterElement:hover': {
        cursor: 'pointer'
      },
      '.cm-breakpoint-gutter.is-enabled .cm-gutterElement:hover::after': {
        content: '""',
        position: 'absolute',
        width: '8px',
        height: '8px',
        borderRadius: '9999px',
        backgroundColor: 'rgba(244, 63, 94, 0.32)'
      },
      '.cm-breakpoint-gutter.is-enabled .cm-gutterElement:hover .cm-breakpoint-dot': {
        position: 'relative',
        zIndex: '1'
      }
    })
  ];
}
