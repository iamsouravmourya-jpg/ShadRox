export interface AuthConfig {
  url: string;
  anonKey: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token stops working. */
  expiresAt: number;
  user: AuthUser;
}

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

export const AUTH_SESSION_KEY = 'shadrox.auth.session';
export const AUTH_VERIFIER_KEY = 'shadrox.auth.pkce';
export const LOOPBACK_PORT = 51789;
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/auth/callback`;

const DEFAULT_PROFILE_TABLE = 'profiles';

export function normalizeAuthConfig(url: string | undefined, anonKey: string | undefined): AuthConfig | null {
  const base = (url ?? '').trim().replace(/\/+$/, '');
  const key = (anonKey ?? '').trim();
  if (!base || !key) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return null;
  if (key.length < 20) return null;
  return { url: base, anonKey: key };
}

export function readAuthConfig(): AuthConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  return normalizeAuthConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function challengeForVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function buildAuthorizeUrl(config: AuthConfig, redirectTo: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: 's256',
    state
  });
  return `${config.url}/auth/v1/authorize?${params.toString()}`;
}

export type CallbackResult =
  | { ok: true; code: string; state: string }
  | { ok: false; message: string };

export function parseCallbackParams(params: CallbackParams, expectedState: string): CallbackResult {
  const error = params.error_description || params.error;
  if (error) return { ok: false, message: error.replace(/\+/g, ' ') };
  const code = params.code ?? '';
  const state = params.state ?? '';
  if (!code) return { ok: false, message: 'Google sign-in did not return a code.' };
  if (!expectedState || state !== expectedState) return { ok: false, message: 'Sign-in state mismatch. Please try again.' };
  return { ok: true, code, state };
}

export function toSession(body: unknown, now = Date.now()): AuthSession | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const user = raw.user as Record<string, unknown> | undefined;
  if (typeof raw.access_token !== 'string' || typeof raw.refresh_token !== 'string' || !user) return null;
  if (typeof user.id !== 'string' || typeof user.email !== 'string') return null;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600;
  const name = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : '';
  const avatar = typeof meta.avatar_url === 'string' ? meta.avatar_url : typeof meta.picture === 'string' ? meta.picture : '';
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: now + expiresIn * 1000,
    user: { id: user.id, email: user.email, name, avatarUrl: avatar }
  };
}

export function isSessionExpired(session: AuthSession, now = Date.now()): boolean {
  return session.expiresAt - 60_000 <= now;
}

export function profilePayload(
  user: AuthUser,
  context: { appVersion: string; platform: string; provider: string }
): Record<string, string> {
  return {
    id: user.id,
    email: user.email,
    full_name: user.name,
    avatar_url: user.avatarUrl,
    provider: context.provider || 'google',
    app_version: context.appVersion,
    platform: context.platform,
    last_seen_at: new Date().toISOString()
  };
}

async function authHeaders(config: AuthConfig, accessToken?: string): Promise<Record<string, string>> {
  return {
    apikey: config.anonKey,
    'Content-Type': 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const message = body.msg || body.message || body.error_description || body.error;
    if (typeof message === 'string' && message) return message;
  } catch {
    /* non-JSON error body */
  }
  return `Authentication failed (${response.status}).`;
}

export async function exchangeCode(config: AuthConfig, code: string, verifier: string): Promise<AuthSession> {
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: await authHeaders(config),
    body: JSON.stringify({ auth_code: code, code_verifier: verifier })
  });
  if (!response.ok) throw new Error(await readError(response));
  const session = toSession(await response.json());
  if (!session) throw new Error('Authentication returned an unexpected payload.');
  return session;
}

export async function refreshSession(config: AuthConfig, refreshToken: string): Promise<AuthSession> {
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: await authHeaders(config),
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!response.ok) throw new Error(await readError(response));
  const session = toSession(await response.json());
  if (!session) throw new Error('Session refresh returned an unexpected payload.');
  return session;
}

export async function revokeSession(config: AuthConfig, accessToken: string): Promise<void> {
  try {
    await fetch(`${config.url}/auth/v1/logout`, {
      method: 'POST',
      headers: await authHeaders(config, accessToken)
    });
  } catch {
    // Local sign-out must succeed even when the network is down.
  }
}

export async function upsertProfile(
  config: AuthConfig,
  accessToken: string,
  payload: Record<string, string>,
  table = DEFAULT_PROFILE_TABLE
): Promise<void> {
  const response = await fetch(`${config.url}/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: {
      ...(await authHeaders(config, accessToken)),
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(await readError(response));
}

export function readStoredSession(raw: string | null): AuthSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') return null;
    if (!parsed.user || typeof parsed.user.id !== 'string' || typeof parsed.user.email !== 'string') return null;
    if (typeof parsed.expiresAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
