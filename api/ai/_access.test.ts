import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveKeyAccess, sharedKeyPathEnabled } from './_access.js';

/**
 * Synthetic values only. These are set and deleted around each test so a real
 * key in the runner's environment cannot change what the assertions prove.
 */
const GEMINI_KEY = 'synthetic-gemini-shared-key';
const USER_KEY = 'synthetic-users-own-key';

type EnvName = 'SHADROX_ALLOW_SHARED_KEY' | 'SHADROX_GEMINI_API_KEY' | 'GEMINI_API_KEY' | 'SHADROX_LOCAL_BACKEND';

function withEnv(overrides: Partial<Record<EnvName, string>>, run: () => void): void {
  const names = Object.keys(overrides) as EnvName[];
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) {
      const value = overrides[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    run();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index] as string;
    });
  }
}

test('the shared-key path is closed unless the operator opens it by name', () => {
  withEnv({ SHADROX_ALLOW_SHARED_KEY: undefined }, () => {
    assert.equal(sharedKeyPathEnabled(), false);
  });
  withEnv({ SHADROX_ALLOW_SHARED_KEY: '1' }, () => {
    assert.equal(sharedKeyPathEnabled(), true);
  });
  // Anything but exactly "1" is off, so a stray truthy value cannot open it.
  withEnv({ SHADROX_ALLOW_SHARED_KEY: 'true' }, () => {
    assert.equal(sharedKeyPathEnabled(), false);
  });
});

test('an unkeyed request is refused even when a shared key sits in the environment', () => {
  withEnv({ SHADROX_ALLOW_SHARED_KEY: undefined, SHADROX_GEMINI_API_KEY: GEMINI_KEY, GEMINI_API_KEY: GEMINI_KEY }, () => {
    const result = resolveKeyAccess('gemini', 'gemini-3.8-flash', undefined);
    assert.ok('error' in result);
    assert.equal('access' in result, false);
    assert.match(result.error, /apni key/);
  });
});

test('a blank or whitespace key counts as no key, not as BYOK', () => {
  withEnv({ SHADROX_ALLOW_SHARED_KEY: undefined, SHADROX_GEMINI_API_KEY: GEMINI_KEY }, () => {
    for (const raw of ['', '   ', undefined]) {
      const result = resolveKeyAccess('gemini', 'gemini-3.8-flash', raw);
      assert.ok('error' in result, `expected a refusal for ${JSON.stringify(raw)}`);
    }
  });
});

test('BYOK is the accepted path: the caller’s key is what gets spent', () => {
  withEnv({ SHADROX_ALLOW_SHARED_KEY: undefined, SHADROX_GEMINI_API_KEY: GEMINI_KEY }, () => {
    const result = resolveKeyAccess('gemini', 'gemini-3.8-flash', `  ${USER_KEY}  `);
    assert.ok('access' in result);
    assert.equal(result.access.apiKey, USER_KEY);
    assert.equal(result.access.byok, true);
  });
});

test('a custom endpoint never falls back to a shared key, gate open or closed', () => {
  // The endpoint is the user's own server and their own bill, so there is no
  // ShadRox key that could pay for it even with the switch flipped on.
  withEnv({ SHADROX_ALLOW_SHARED_KEY: '1', SHADROX_GEMINI_API_KEY: GEMINI_KEY }, () => {
    const result = resolveKeyAccess('custom', 'local-model', undefined);
    assert.ok('error' in result);
  });
});

test('closing the gate is what it claims: the same request succeeds once opened', () => {
  // Pro-tier model and no local-backend override, so the only variable here is
  // the switch — which proves the refusal above is the gate, not a missing key.
  withEnv({ SHADROX_ALLOW_SHARED_KEY: '1', SHADROX_GEMINI_API_KEY: GEMINI_KEY, GEMINI_API_KEY: GEMINI_KEY, SHADROX_LOCAL_BACKEND: undefined }, () => {
    const closed = resolveKeyAccess('gemini', 'gemini-3.8-pro', undefined);
    assert.ok('access' in closed, JSON.stringify(closed));
    assert.equal(closed.access.apiKey, GEMINI_KEY);
    assert.equal(closed.access.byok, false);
  });
});
