import { useCallback, useEffect, useRef, useState } from 'react';

interface UsePreviewSyncOptions {
  /** Bumps whenever something that can change the rendered preview changes. */
  revision: unknown;
  /** False while the preview is hidden, stopped, or user-paused. */
  enabled: boolean;
  /** Coalesces bursts of file-save events into a single reload. */
  debounceMs?: number;
}

export interface PreviewSyncState {
  reloadKey: number;
  lastReloadAt: number | null;
  reload: () => void;
}

/**
 * Debounced reload trigger for the local static preview. Dev servers keep their
 * own HMR, so this intentionally only runs against static previews.
 */
export function usePreviewSync({ revision, enabled, debounceMs = 140 }: UsePreviewSyncOptions): PreviewSyncState {
  const [reloadKey, setReloadKey] = useState(0);
  const [lastReloadAt, setLastReloadAt] = useState<number | null>(null);
  const lastRevision = useRef(revision);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
    setLastReloadAt(Date.now());
  }, []);

  useEffect(() => {
    const changed = lastRevision.current !== revision;
    lastRevision.current = revision;
    if (!changed || !enabled) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setReloadKey((key) => key + 1);
      setLastReloadAt(Date.now());
    }, debounceMs);

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [revision, enabled, debounceMs]);

  return { reloadKey, lastReloadAt, reload };
}
