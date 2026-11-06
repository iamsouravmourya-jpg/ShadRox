import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';

/**
 * Hover values for a paused debug session.
 *
 * The expression sent to the adapter is exactly the identifier under the
 * pointer — never the line, never a statement — and only while a frame is
 * paused, because that is the only time the debuggee is not running the user's
 * code. A failed evaluate renders as "not available" rather than an error.
 */

export interface DebugHoverHandlers {
  /** True only while the debugger is paused on a frame. */
  enabled: () => boolean;
  /** Resolves to the value text, or null when the adapter has no answer. */
  evaluate: (expression: string) => Promise<string | null>;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** True for a dotted identifier and nothing else — never a statement. */
export function isHoverableIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

const HOVER_THEME = EditorView.baseTheme({
  '.cm-debug-hover': {
    maxWidth: '420px',
    padding: '3px 8px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    lineHeight: '1.5',
    color: '#e5e7eb',
    backgroundColor: '#18181b',
    border: '1px solid rgba(255, 255, 255, 0.12)',
    borderRadius: '6px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word'
  },
  '.cm-debug-hover .cm-debug-hover-name': { color: '#93c5fd' },
  '.cm-debug-hover .cm-debug-hover-value': { color: '#fbbf24' }
});

function render(dom: HTMLElement, name: string, value: string, pending: boolean): void {
  dom.replaceChildren();
  const label = document.createElement('span');
  label.className = 'cm-debug-hover-name';
  label.textContent = name;
  const result = document.createElement('span');
  result.className = 'cm-debug-hover-value';
  result.textContent = pending ? ': …' : `: ${value}`;
  dom.append(label, result);
}

export function debugHoverExtension(handlers: DebugHoverHandlers): Extension {
  return [
    HOVER_THEME,
    hoverTooltip((view, pos) => {
      if (!handlers.enabled()) return null;
      const word = view.state.wordAt(pos);
      if (!word) return null;
      const name = view.state.doc.sliceString(word.from, word.to);
      if (!isHoverableIdentifier(name)) return null;
      return {
        pos: word.from,
        end: word.to,
        above: true,
        create() {
          const dom = document.createElement('div');
          dom.className = 'cm-debug-hover';
          render(dom, name, '', true);
          void handlers
            .evaluate(name)
            .then((value) => render(dom, name, value ?? 'not available', false))
            .catch(() => render(dom, name, 'not available', false));
          return { dom };
        }
      };
    })
  ];
}
