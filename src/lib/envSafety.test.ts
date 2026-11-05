import assert from 'node:assert/strict';
import test from 'node:test';
import { isSensitive, scrubEnvironment } from './envSafety.js';

// ── isSensitive — name-based rules ───────────────────────────────────────────

test('SHADROX_ prefix is always sensitive', () => {
  assert.equal(isSensitive('SHADROX_INTERNAL_TOKEN', 'anything'), true);
  assert.equal(isSensitive('SHADROX_DEBUG', 'true'), true);
});

test('provider key names are sensitive', () => {
  for (const key of [
    'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
    'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT',
  ]) {
    assert.equal(isSensitive(key, 'dummy-value'), true, `expected ${key} to be sensitive`);
  }
});

test('generic credential suffixes are sensitive regardless of prefix', () => {
  for (const key of [
    'MY_API_KEY', 'CUSTOM_SECRET_KEY', 'APP_PASSWORD',
    'DB_ACCESS_TOKEN', 'STRIPE_CLIENT_SECRET', 'REDIS_CREDENTIALS',
    'DEPLOY_PRIVATE_KEY', 'USER_REFRESH_TOKEN',
  ]) {
    assert.equal(isSensitive(key, 'dummy'), true, `expected ${key} to be sensitive`);
  }
});

test('benign env vars are NOT sensitive by name', () => {
  for (const key of [
    'PATH', 'HOME', 'NODE_ENV', 'PORT', 'DEBUG',
    'LANG', 'TERM', 'SHELL', 'USER', 'LOGNAME',
  ]) {
    assert.equal(isSensitive(key, 'some-value'), false, `expected ${key} to be safe`);
  }
});

// ── isSensitive — value-based rules ──────────────────────────────────────────

test('GitHub classic token value is caught even with innocent key name', () => {
  const token = 'ghp_' + 'A'.repeat(36);
  assert.equal(isSensitive('MY_RANDOM_VAR', token), true);
});

test('GitHub OAuth / server / user tokens are caught by value', () => {
  for (const prefix of ['gho_', 'ghs_', 'ghu_']) {
    assert.equal(isSensitive('SOME_VAR', prefix + 'B'.repeat(36)), true);
  }
});

test('fine-grained GitHub PAT value is caught', () => {
  const token = 'github_pat_' + 'C'.repeat(30);
  assert.equal(isSensitive('TOOL_TOKEN', token), true);
});

test('AWS AKIA access key value is caught', () => {
  assert.equal(isSensitive('CLOUD_ID', 'AKIAABCDEFGHIJKLMNOP'), true);
});

test('AWS ASIA temporary key value is caught', () => {
  assert.equal(isSensitive('CLOUD_ID', 'ASIAABCDEFGHIJKLMNOP'), true);
});

test('Gemini AIza key value is caught', () => {
  assert.equal(isSensitive('SOME_ID', 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'), true);
});

test('Groq gsk_ key value is caught', () => {
  assert.equal(isSensitive('SOME_ID', 'gsk_' + 'x'.repeat(40)), true);
});

test('short/ordinary values with innocent names are NOT caught', () => {
  assert.equal(isSensitive('MY_VAR', 'localhost'), false);
  assert.equal(isSensitive('NODE_ENV', 'production'), false);
  assert.equal(isSensitive('PORT', '3000'), false);
});

// ── scrubEnvironment ─────────────────────────────────────────────────────────

test('scrubEnvironment removes credential vars and keeps safe ones', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    GEMINI_API_KEY: 'AIzaSy_test_key',
    AWS_SECRET_ACCESS_KEY: 'secret123',
    GH_TOKEN: 'ghp_' + 'A'.repeat(36),
    NODE_ENV: 'production',
    PORT: '8080',
  };
  const scrubbed = scrubEnvironment(env as NodeJS.ProcessEnv);
  assert.ok('PATH' in scrubbed, 'PATH should survive');
  assert.ok('HOME' in scrubbed, 'HOME should survive');
  assert.ok('NODE_ENV' in scrubbed, 'NODE_ENV should survive');
  assert.ok('PORT' in scrubbed, 'PORT should survive');
  assert.ok(!('GEMINI_API_KEY' in scrubbed), 'GEMINI_API_KEY must be removed');
  assert.ok(!('AWS_SECRET_ACCESS_KEY' in scrubbed), 'AWS_SECRET_ACCESS_KEY must be removed');
  assert.ok(!('GH_TOKEN' in scrubbed), 'GH_TOKEN must be removed');
});

test('scrubEnvironment strips var whose value looks like a token even if name is innocent', () => {
  const env = {
    NORMAL_VAR: 'hello',
    MYSTERY_VAR: 'ghp_' + 'Z'.repeat(36),
  };
  const scrubbed = scrubEnvironment(env as NodeJS.ProcessEnv);
  assert.ok('NORMAL_VAR' in scrubbed);
  assert.ok(!('MYSTERY_VAR' in scrubbed));
});

test('scrubEnvironment does not mutate the input object', () => {
  const env = { API_KEY: 'secret', PATH: '/bin' } as NodeJS.ProcessEnv;
  scrubEnvironment(env);
  assert.ok('API_KEY' in env, 'original env must be unchanged');
});

test('scrubEnvironment with empty input returns empty output', () => {
  assert.deepEqual(scrubEnvironment({} as NodeJS.ProcessEnv), {});
});
