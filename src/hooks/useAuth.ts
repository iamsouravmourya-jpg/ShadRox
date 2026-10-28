import { useCallback, useEffect, useRef, useState } from 'react';
import { getDesktopBridge } from '../lib/desktop';
import { deleteSecretItem, readSecretItem, writeSecretItem } from '../lib/secureStore';
import {
  AUTH_SESSION_KEY,
  AUTH_VERIFIER_KEY,
  LOOPBACK_REDIRECT,
  buildAuthorizeUrl,
  challengeForVerifier,
  exchangeCode,
  isSessionExpired,
  parseCallbackParams,
  profilePayload,
  randomToken,
  readAuthConfig,
  readStoredSession,
  refreshSession,
  revokeSession,
  upsertProfile,
  type AuthConfig,
  type AuthSession
} from '../lib/authCore';

export type AuthStatus = 'loading' | 'unconfigured' | 'signed-out' | 'signed-in';

export interface AuthState {
  status: AuthStatus;
  session: AuthSession | null;
  error: string | null;
  busy: boolean;
}

const CLOSED_STATE: AuthState = { status: 'loading', session: null, error: null, busy: false };

interface PendingPkce {
  verifier: string;
  state: string;
}

function storePendingPkce(pending: PendingPkce): void {
  try {
    sessionStorage.setItem(AUTH_VERIFIER_KEY, JSON.stringify(pending));
  } catch {
    /* sessionStorage can be unavailable in hardened contexts */
  }
}

function takePendingPkce(): PendingPkce | null {
  try {
    const raw = sessionStorage.getItem(AUTH_VERIFIER_KEY);
    sessionStorage.removeItem(AUTH_VERIFIER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingPkce;
    return parsed && typeof parsed.verifier === 'string' && typeof parsed.state === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function storeSession(session: AuthSession): void {
  writeSecretItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

function clearSession(): void {
  deleteSecretItem(AUTH_SESSION_KEY);
}

async function syncProfile(config: AuthConfig, session: AuthSession, appVersion: string): Promise<void> {
  try {
    const platform = getDesktopBridge()?.platform ?? 'browser';
    await upsertProfile(
      config,
      session.accessToken,
      profilePayload(session.user, { appVersion, platform, provider: 'google' })
    );
  } catch (error) {
    // Profile sync is best-effort: a missing table or RLS policy must not block sign-in.
    console.warn('[shadrox] profile sync failed', error);
  }
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(CLOSED_STATE);
  const signingIn = useRef(false);
  const syncedUser = useRef<string | null>(null);
  const configRef = useRef<AuthConfig | null>(null);

  const applySession = useCallback(async (config: AuthConfig, session: AuthSession) => {
    storeSession(session);
    setState({ status: 'signed-in', session, error: null, busy: false });
    if (syncedUser.current !== session.user.id) {
      syncedUser.current = session.user.id;
      const bridge = getDesktopBridge();
      const version = bridge ? await bridge.auth.appVersion().catch(() => 'unknown') : 'web';
      void syncProfile(config, session, version);
    }
  }, []);

  const fail = useCallback((message: string) => {
    setState((previous) => ({
      ...previous,
      status: previous.session ? 'signed-in' : 'signed-out',
      busy: false,
      error: message
    }));
  }, []);

  useEffect(() => {
    const config = readAuthConfig();
    configRef.current = config;
    if (!config) {
      setState({ status: 'unconfigured', session: null, error: null, busy: false });
      return;
    }

    let cancelled = false;

    const settle = async () => {
      const pending = takePendingPkce();
      const params = new URLSearchParams(window.location.search);
      const hasCode = params.has('code') || params.has('error');
      if (hasCode) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (!pending) {
          if (!cancelled) fail('Sign-in session expired. Please try again.');
          return;
        }
        const parsed = parseCallbackParams(
          {
            code: params.get('code') ?? undefined,
            state: params.get('state') ?? undefined,
            error: params.get('error') ?? undefined,
            error_description: params.get('error_description') ?? undefined
          },
          pending.state
        );
        if (!parsed.ok) {
          if (!cancelled) fail(parsed.message);
          return;
        }
        try {
          const session = await exchangeCode(config, parsed.code, pending.verifier);
          if (!cancelled) await applySession(config, session);
        } catch (error) {
          if (!cancelled) fail(error instanceof Error ? error.message : 'Sign-in failed.');
        }
        return;
      }

      const stored = readStoredSession(readSecretItem(AUTH_SESSION_KEY));
      if (!stored) {
        if (!cancelled) setState({ status: 'signed-out', session: null, error: null, busy: false });
        return;
      }
      if (!isSessionExpired(stored)) {
        if (!cancelled) await applySession(config, stored);
        return;
      }
      try {
        const refreshed = await refreshSession(config, stored.refreshToken);
        if (!cancelled) await applySession(config, refreshed);
      } catch {
        clearSession();
        if (!cancelled) {
          setState({
            status: 'signed-out',
            session: null,
            error: 'Your session expired. Sign in again to continue.',
            busy: false
          });
        }
      }
    };

    void settle();
    return () => {
      cancelled = true;
    };
  }, [applySession, fail]);

  const signIn = useCallback(async () => {
    const config = configRef.current;
    if (!config) {
      setState({ status: 'unconfigured', session: null, error: null, busy: false });
      return;
    }
    if (signingIn.current) return;
    signingIn.current = true;
    setState((previous) => ({ ...previous, busy: true, error: null }));

    try {
      const verifier = randomToken(48);
      const challenge = await challengeForVerifier(verifier);
      const stateToken = randomToken(24);
      storePendingPkce({ verifier, state: stateToken });

      const bridge = getDesktopBridge();
      if (bridge) {
        const authorizeUrl = buildAuthorizeUrl(config, LOOPBACK_REDIRECT, challenge, stateToken);
        const result = await bridge.auth.startLoopback(authorizeUrl, LOOPBACK_REDIRECT);
        if (!result || result.error) throw new Error(result?.error || 'Sign-in was cancelled.');
        const params = result.params ?? {};
        const parsed = parseCallbackParams(
          {
            code: params.code,
            state: params.state,
            error: params.error,
            error_description: params.error_description
          },
          stateToken
        );
        if (!parsed.ok) throw new Error(parsed.message);
        const session = await exchangeCode(config, parsed.code, verifier);
        await applySession(config, session);
        return;
      }

      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const authorizeUrl = buildAuthorizeUrl(config, redirectTo, challenge, stateToken);
      window.location.assign(authorizeUrl);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      signingIn.current = false;
      setState((previous) => (previous.busy ? { ...previous, busy: false } : previous));
    }
  }, [applySession, fail]);

  const signOut = useCallback(async () => {
    const session = state.session;
    const config = configRef.current;
    if (session && config) void revokeSession(config, session.accessToken);
    clearSession();
    syncedUser.current = null;
    setState({ status: 'signed-out', session: null, error: null, busy: false });
  }, [state.session]);

  return {
    status: state.status,
    user: state.session?.user ?? null,
    error: state.error,
    busy: state.busy,
    signIn,
    signOut
  };
}
