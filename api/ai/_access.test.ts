import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveKeyAccess } from './_access.js';

/** Synthetic value only — never a real key. */
const USER_KEY = 'synthetic-users-own-key';

test('an unkeyed request is refused even when a provider key sits in the environment', () => {
  const previous = {
    gemini: process.env.SHADROX_GEMINI_API_KEY,
    geminiPlain: process.env.GEMINI_API_KEY,
    groq: process.env.SHADROX_GROQ_API_KEY
  };
  process.env.SHADROX_GEMINI_API_KEY = 'synthetic-env-key';
  process.env.GEMINI_API_KEY = 'synthetic-env-key';
  process.env.SHADROX_GROQ_API_KEY = 'synthetic-env-key';
  try {
    const result = resolveKeyAccess(undefined);
    assert.ok('error' in result);
    assert.equal('access' in result, false);
    assert.match(result.error, /own API key/i);
    assert.match(result.error, /Settings → BYOK/);
  } finally {
    if (previous.gemini === undefined) delete process.env.SHADROX_GEMINI_API_KEY;
    else process.env.SHADROX_GEMINI_API_KEY = previous.gemini;
    if (previous.geminiPlain === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous.geminiPlain;
    if (previous.groq === undefined) delete process.env.SHADROX_GROQ_API_KEY;
    else process.env.SHADROX_GROQ_API_KEY = previous.groq;
  }
});

test('a blank or whitespace key counts as no key, not as BYOK', () => {
  for (const raw of ['', '   ', undefined]) {
    const result = resolveKeyAccess(raw);
    assert.ok('error' in result, `expected a refusal for ${JSON.stringify(raw)}`);
  }
});

test('BYOK is the only path: the caller’s trimmed key is what gets spent', () => {
  const result = resolveKeyAccess(`  ${USER_KEY}  `);
  assert.ok('access' in result);
  assert.equal(result.access.apiKey, USER_KEY);
  assert.equal(result.access.byok, true);
});