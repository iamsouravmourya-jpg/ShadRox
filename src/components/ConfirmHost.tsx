import { useCallback, useEffect, useRef, useState } from 'react';
import { settleConfirm, subscribeConfirm, type ConfirmRequest } from '../lib/confirm';

export function ConfirmHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const settledRef = useRef(true);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      subscribeConfirm((next) => {
        settledRef.current = false;
        setRequest(next);
      }),
    []
  );

  const dismiss = useCallback((accepted: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    settleConfirm(accepted);
    setRequest(null);
  }, []);

  useEffect(() => {
    if (!request) return;
    const target = request.tone === 'danger' ? cancelRef.current : confirmRef.current;
    target?.focus();
  }, [request]);

  if (!request) return null;

  const danger = request.tone === 'danger';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim)] px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-full max-w-sm rounded-panel border border-line-2 bg-base-2 p-4 shadow-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            dismiss(false);
          }
        }}
      >
        <h2 className="text-sm font-semibold text-ink">{request.title}</h2>
        {request.body && (
          <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{request.body}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => dismiss(false)}
            className="rounded-xl border border-line-2 bg-overlay px-3.5 py-2 text-xs font-medium text-ink-3 transition-colors hover:bg-overlay-2 hover:text-ink cursor-pointer"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => dismiss(true)}
            className={`rounded-xl px-3.5 py-2 text-xs font-semibold text-white transition-opacity cursor-pointer ${
              danger ? 'bg-danger hover:opacity-90' : 'bg-accent-strong hover:opacity-90'
            }`}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
