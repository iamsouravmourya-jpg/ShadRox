import { useEffect, useRef, useState } from 'react';
import { Bug, Loader2, Sparkles, X } from 'lucide-react';
import { isFeedbackConfigured, submitFeedback, type FeedbackKind } from '../lib/feedback';
import { Notice, errorMessage, primaryButtonClass } from './settings/shared';

const MAX_MESSAGE = 4000;

const KIND_OPTIONS: Array<{ id: FeedbackKind; label: string; icon: typeof Bug; placeholder: string }> = [
  {
    id: 'bug',
    label: "Something's broken",
    icon: Bug,
    placeholder: 'What happened, and what did you expect instead?'
  },
  {
    id: 'feature',
    label: 'Feature request',
    icon: Sparkles,
    placeholder: 'What would you like ShadRox to do?'
  }
];

export function FeedbackPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);

  const successTimer = useRef<number | null>(null);
  const configured = isFeedbackConfigured();

  // Each visit starts clean so a stale notice from an earlier send never
  // lingers over a fresh draft.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current);
      successTimer.current = null;
    }
    setSuccess(false);
  }, [isOpen]);

  // Slide-in: mount off-screen, then move into place on the next frame.
  useEffect(() => {
    if (!isOpen) {
      setEntered(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(
    () => () => {
      if (successTimer.current !== null) window.clearTimeout(successTimer.current);
    },
    []
  );

  if (!isOpen) return null;

  const trimmedMessage = message.trim();
  const messageIsValid = trimmedMessage.length >= 3;
  const activeOption = KIND_OPTIONS.find((option) => option.id === kind) ?? KIND_OPTIONS[0];

  // Typing after a successful send cancels the pending reset so new text is
  // never wiped out from under the user 2 seconds later.
  const cancelPendingReset = () => {
    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current);
      successTimer.current = null;
    }
    if (success) setSuccess(false);
  };

  const handleSubmit = async () => {
    if (!messageIsValid || !configured || isSubmitting || success) return;
    setIsSubmitting(true);
    setError(null);
    setSuccess(false);
    try {
      await submitFeedback({ kind, message: trimmedMessage });
      setSuccess(true);
      if (successTimer.current !== null) window.clearTimeout(successTimer.current);
      successTimer.current = window.setTimeout(() => {
        setMessage('');
        setSuccess(false);
        successTimer.current = null;
      }, 2000);
    } catch (cause) {
      // Never report success on failure: the error below is the only feedback.
      setError(errorMessage(cause));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-end bg-[var(--scrim)] backdrop-blur-sm transition-opacity duration-200 ${
        entered ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Feedback"
        onClick={(event) => event.stopPropagation()}
        className={`fixed right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-line-2 bg-base text-ink shadow-2xl transition-transform duration-200 ease-[var(--ease-smooth)] ${
          entered ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Sits over the app header, so it carries the same drag region and
            window-controls inset as the workspace header. */}
        <header className="titlebar window-controls-inset h-12 shrink-0 border-b border-line">
          <div className="flex h-full items-center justify-between gap-2 pl-4 pr-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent-line bg-accent-soft text-accent">
                <Bug className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-ink">Feedback</div>
                <div className="truncate text-[10px] text-ink-4">
                  Bug or feature request — it lands in our Google Sheet.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Close feedback (Esc)"
              aria-label="Close feedback"
              className="flex shrink-0 cursor-pointer items-center rounded-md p-1 text-ink-4 transition-colors hover:bg-overlay-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <div role="group" aria-label="Feedback type" className="grid grid-cols-2 gap-2">
              {KIND_OPTIONS.map(({ id, label, icon: Icon }) => {
                const selected = kind === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      cancelPendingReset();
                      setKind(id);
                    }}
                    className={`flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition-all duration-150 active:scale-[0.98] ${
                      selected
                        ? 'border-accent-line bg-accent-soft text-accent'
                        : 'border-line text-ink-3 hover:border-line-2 hover:text-ink-2'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>

            <div>
              <label htmlFor="feedback-message" className="sr-only">
                Your feedback
              </label>
              <textarea
                id="feedback-message"
                rows={5}
                autoFocus
                maxLength={MAX_MESSAGE}
                value={message}
                onChange={(event) => {
                  cancelPendingReset();
                  setMessage(event.target.value);
                }}
                placeholder={activeOption.placeholder}
                className="min-h-[110px] w-full resize-none rounded-xl border border-line bg-overlay px-3 py-2 text-xs leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-5 focus:border-accent-line"
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="min-w-0 text-[10px] leading-relaxed text-ink-4">
                  {configured
                    ? "Sent straight to the maker's Google Sheet — only your message and the date."
                    : "Feedback isn't configured in this build."}
                </span>
                <span
                  className={`shrink-0 font-mono text-[10px] ${
                    message.length >= MAX_MESSAGE ? 'text-warn' : 'text-ink-5'
                  }`}
                >
                  {message.length}/{MAX_MESSAGE}
                </span>
              </div>
            </div>

            {error && <Notice tone="error">{error}</Notice>}
            {success && <Notice tone="ok">Thanks — your report is in.</Notice>}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!messageIsValid || !configured || isSubmitting || success}
              title={!configured ? 'Feedback is not configured in this build' : undefined}
              className={`${primaryButtonClass} w-full cursor-pointer`}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Sending…
                </>
              ) : (
                'Send feedback'
              )}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
