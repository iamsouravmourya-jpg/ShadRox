import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAuthorizeUrl,
  challengeForVerifier,
  isSessionExpired,
  normalizeAuthConfig,
  parseCallbackParams,
  profilePayload,
  readStoredSession,
  toSession,
  type AuthSession
} from './authCore';

const config = { url: 'https://demo.supabase.co', anonKey: 'anon-key-that-is-long-enough' };

test('auth config only accepts https or a local development origin', () => {
  assert.deepEqual(normalizeAuthConfig('https://demo.supabase.co/', 'x'.repeat(40)), {
    url: 'https://demo.supabase.co',
    anonKey: 'x'.repeat(40)
  });
  assert.equal(normalizeAuthConfig('http://localhost:54321', 'x'.repeat(40))?.url, 'http://localhost:54321');
  assert.equal(normalizeAuthConfig('http://evil.example.com', 'x'.repeat(40)), null);
  assert.equal(normalizeAuthConfig('https://demo.supabase.co', ''), null);
  assert.equal(normalizeAuthConfig('https://demo.supabase.co', 'short'), null);
  assert.equal(normalizeAuthConfig('not a url', 'x'.repeat(40)), null);
});

test('PKCE challenge matches the RFC 7636 reference vector', async () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(await challengeForVerifier(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('authorize URL carries provider, redirect and PKCE parameters', () => {
  const url = new URL(buildAuthorizeUrl(config, 'http://127.0.0.1:51789/auth/callback', 'challenge-value', 'state-value'));
  assert.equal(url.origin, 'https://demo.supabase.co');
  assert.equal(url.pathname, '/auth/v1/authorize');
  assert.equal(url.searchParams.get('provider'), 'google');
  assert.equal(url.searchParams.get('redirect_to'), 'http://127.0.0.1:51789/auth/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-value');
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.equal(url.searchParams.get('state'), 'state-value');
});

test('callback parsing rejects state mismatches and provider errors', () => {
  assert.deepEqual(parseCallbackParams({ code: 'abc', state: 's1' }, 's1'), { ok: true, code: 'abc', state: 's1' });
  assert.match(
    (parseCallbackParams({ code: 'abc', state: 'other' }, 's1') as { message: string }).message,
    /state mismatch/i
  );
  assert.match(
    (parseCallbackParams({ error: 'access_denied', error_description: 'User+denied' }, 's1') as { message: string }).message,
    /User denied/
  );
  assert.match((parseCallbackParams({ state: 's1' }, 's1') as { message: string }).message, /did not return a code/);
});

test('token responses become a session with user metadata and expiry', () => {
  const session = toSession(
    {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      user: {
        id: 'user-1',
        email: 'dev@example.com',
        user_metadata: { full_name: 'Dev Example', avatar_url: 'https://img.example/a.png' }
      }
    },
    1_000
  );
  assert.ok(session);
  assert.equal(session.user.id, 'user-1');
  assert.equal(session.user.name, 'Dev Example');
  assert.equal(session.user.avatarUrl, 'https://img.example/a.png');
  assert.equal(session.expiresAt, 1_000 + 3_600_000);

  assert.equal(toSession({ access_token: 'a', refresh_token: 'r' }), null);
  assert.equal(toSession({ access_token: 'a', refresh_token: 'r', user: { id: 'only-id' } }), null);
});

test('a session inside the refresh window counts as expired', () => {
  const base: AuthSession = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 100_000,
    user: { id: 'u', email: 'e@example.com', name: '', avatarUrl: '' }
  };
  assert.equal(isSessionExpired(base, 30_000), false);
  assert.equal(isSessionExpired(base, 50_000), true);
  assert.equal(isSessionExpired(base, 99_999), true);
});

test('profile payload matches the Supabase profiles columns', () => {
  const payload = profilePayload(
    { id: 'user-1', email: 'dev@example.com', name: 'Dev', avatarUrl: 'https://img.example/a.png' },
    { appVersion: '0.0.1', platform: 'win32', provider: 'google' }
  );
  assert.equal(payload.id, 'user-1');
  assert.equal(payload.email, 'dev@example.com');
  assert.equal(payload.full_name, 'Dev');
  assert.equal(payload.provider, 'google');
  assert.equal(payload.app_version, '0.0.1');
  assert.equal(payload.platform, 'win32');
  assert.match(payload.last_seen_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('stored sessions survive a JSON round trip and reject garbage', () => {
  const session: AuthSession = {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 123,
    user: { id: 'u', email: 'e@example.com', name: 'n', avatarUrl: '' }
  };
  assert.deepEqual(readStoredSession(JSON.stringify(session)), session);
  assert.equal(readStoredSession('{'), null);
  assert.equal(readStoredSession(JSON.stringify({ accessToken: 'a' })), null);
});
