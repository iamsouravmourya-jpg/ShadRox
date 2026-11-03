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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        className="w-full max-w-sm rounded-panel border border-white/10 bg-ink-900 p-4 shadow-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            dismiss(false);
          }
        }}
      >
        <h2 className="text-sm font-semibold text-neutral-100">{request.title}</h2>
        {request.body && (
          <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{request.body}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => dismiss(false)}
            className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-neutral-300 transition-colors hover:bg-white/[0.08] hover:text-white cursor-pointer"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => dismiss(true)}
            className={`rounded-xl px-3.5 py-2 text-xs font-semibold text-white transition-colors cursor-pointer ${
              danger ? 'bg-rose-500 hover:bg-rose-400' : 'bg-violet-500 hover:bg-violet-400'
            }`}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
