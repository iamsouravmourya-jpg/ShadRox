export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

type PendingConfirm = ConfirmRequest & { resolve: (accepted: boolean) => void };

type ConfirmSubscriber = (request: ConfirmRequest) => void;

let subscriber: ConfirmSubscriber | null = null;
let pending: PendingConfirm | null = null;

function normalize(request: ConfirmRequest | string): ConfirmRequest {
  return typeof request === 'string' ? { title: request } : request;
}

function fallback(request: ConfirmRequest): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  return window.confirm(request.body ? `${request.title}\n\n${request.body}` : request.title);
}

/**
 * Resolves the dialog that is currently on screen. A no-op when nothing is open,
 * so hosts can settle defensively.
 */
export function settleConfirm(accepted: boolean): void {
  const request = pending;
  pending = null;
  request?.resolve(accepted);
}

/**
 * Registers the host that renders confirm dialogs. Pass null to detach. The
 * returned unsubscribe settles any dialog that is still open so no caller hangs.
 */
export function subscribeConfirm(handler: ConfirmSubscriber | null): () => void {
  subscriber = handler;
  return () => {
    if (subscriber !== handler) return;
    subscriber = null;
    settleConfirm(false);
  };
}

/**
 * Asks the user to confirm an action. Only one dialog is tracked at a time: a
 * second request made while a dialog is open resolves false immediately instead
 * of stacking or waiting. Without a host (SSR, plain tests) the native
 * window.confirm fallback keeps callers working.
 */
export function confirmAction(request: ConfirmRequest | string): Promise<boolean> {
  const normalized = normalize(request);
  if (!subscriber) return Promise.resolve(fallback(normalized));
  if (pending) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { ...normalized, resolve };
    try {
      subscriber?.(normalized);
    } catch {
      settleConfirm(false);
    }
  });
}
