import { useEffect, useRef, useState } from 'react';
import { getDesktopBridge, type SemanticToken, type TsFileOverride } from '../lib/desktop';
import { warnBridgeError } from '../lib/diagnostics';

interface UseSemanticTokensOptions {
  enabled: boolean;
  workspaceId: string | null;
  /** Workspace-relative path of the active file. */
  filePath: string | null;
  overrides?: TsFileOverride[];
}

const SEMANTIC_DEBOUNCE_MS = 500;

/**
 * Semantic classification for the active file, debounced so typing does not
 * re-classify on every keystroke. The tokens are only a colour refinement on
 * top of the syntax highlighter, so a stale or empty response is harmless and
 * failures stay silent apart from one log line — there is nothing for the user
 * to act on.
 */
export function useSemanticTokens({
  enabled,
  workspaceId,
  filePath,
  overrides
}: UseSemanticTokensOptions): SemanticToken[] {
  const [tokens, setTokens] = useState<SemanticToken[]>([]);
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
    const desktop = getDesktopBridge();
    if (!enabled || !workspaceId || !filePath || !desktop) {
      requestIdRef.current += 1;
      setTokens([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const id = ++requestIdRef.current;
      void desktop
        .semanticTokens(workspaceId, filePath, overrides)
        .then((result) => {
          if (cancelled || !mountedRef.current || id !== requestIdRef.current) return;
          setTokens(result ?? []);
        })
        .catch((error) => {
          if (cancelled || !mountedRef.current || id !== requestIdRef.current) return;
          warnBridgeError('semantic-tokens', error);
          setTokens([]);
        });
    }, SEMANTIC_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, workspaceId, filePath, overrides]);

  return tokens;
}
