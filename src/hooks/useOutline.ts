import { useEffect, useRef, useState } from 'react';
import { getDesktopBridge, type OutlineSymbol, type TsFileOverride } from '../lib/desktop';
import { warnBridgeError } from '../lib/diagnostics';

interface UseOutlineOptions {
  enabled: boolean;
  workspaceId: string | null;
  /** Workspace-relative path of the active file. */
  filePath: string | null;
  overrides?: TsFileOverride[];
}

interface OutlineState {
  symbols: OutlineSymbol[];
  isLoading: boolean;
  error: string | null;
}

const OUTLINE_DEBOUNCE_MS = 400;

/**
 * Document outline for the active file, debounced so switching tabs or typing
 * does not hammer the language service. Responses are id-guarded; failures are
 * reported to the panel and logged once.
 */
export function useOutline({ enabled, workspaceId, filePath, overrides }: UseOutlineOptions): OutlineState {
  const [state, setState] = useState<OutlineState>({ symbols: [], isLoading: false, error: null });
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const requestActive = enabled && Boolean(workspaceId) && Boolean(filePath);
    if (!requestActive) {
      requestIdRef.current += 1;
      setState({ symbols: [], isLoading: false, error: null });
      return;
    }
    const desktop = getDesktopBridge();
    if (!desktop) {
      setState({ symbols: [], isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((previous) => ({ ...previous, isLoading: true, error: null }));
    const timer = window.setTimeout(() => {
      const id = ++requestIdRef.current;
      void desktop
        .outline(workspaceId as string, filePath as string, overrides)
        .then((symbols) => {
          if (cancelled || !mountedRef.current || id !== requestIdRef.current) return;
          setState({ symbols: symbols ?? [], isLoading: false, error: null });
        })
        .catch((error) => {
          if (cancelled || !mountedRef.current || id !== requestIdRef.current) return;
          warnBridgeError('outline', error);
          setState({
            symbols: [],
            isLoading: false,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }, OUTLINE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, workspaceId, filePath, overrides]);

  return state;
}
