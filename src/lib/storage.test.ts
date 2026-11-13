import assert from 'node:assert/strict';
import test from 'node:test';

import { getApiKey, getSelectedModel, purgeLegacyEntitlements } from './storage';

/**
 * A minimal stand-in for the renderer's storage. Node has no localStorage, and
 * the module reads the global directly, so it is installed per test and
 * removed afterwards.
 */
function withStorage(
  seed: Record<string, string>,
  run: (values: Map<string, string>) => void
): void {
  const values = new Map<string, string>(Object.entries(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      }
    }
  });
  try {
    run(values);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

/** What a machine that used to pay for a plan still has saved. */
const LEGACY_SEED = {
  'shadrox.plan': 'heavy',
  'shadrox.key.shared': 'true',
  'shadrox.byok.gemini': 'synthetic-gemini-key',
  'shadrox.model.gemini': 'gemini-3.8-flash',
  'shadrox.provider.active': 'groq'
};

test('a saved paid plan and shared-key opt-in are dropped, not interpreted', () => {
  withStorage(LEGACY_SEED, (values) => {
    purgeLegacyEntitlements();
    assert.equal(values.has('shadrox.plan'), false);
    assert.equal(values.has('shadrox.key.shared'), false);
  });
});

test('the cleanup leaves the BYOK settings that survive into this build', () => {
  withStorage(LEGACY_SEED, () => {
    purgeLegacyEntitlements();
    assert.equal(getSelectedModel('gemini'), 'gemini-3.8-flash');
  });
});

test('running the cleanup on a fresh install changes nothing and throws nothing', () => {
  withStorage({}, () => {
    purgeLegacyEntitlements();
    purgeLegacyEntitlements();
  });
});

test('a locked-down renderer where storage throws still starts up', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage is disabled');
      },
      removeItem: () => {
        throw new Error('storage is disabled');
      }
    }
  });
  try {
    purgeLegacyEntitlements();
    assert.equal(getApiKey('gemini'), '');
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
