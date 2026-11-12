import assert from 'node:assert/strict';
import test from 'node:test';

import { containsSecret, redactSecrets } from './secrets';

test('every published key shape is replaced by a marker', () => {
  const cases: Array<[string, string]> = [
    ['OpenAI key sk-abcdefghijklmnopqrstuvwxyz12', 'OpenAI key [redacted]'],
    ['Groq rejected gsk_abcdefghijklmnopqrstuvwxyz12', 'Groq rejected [redacted]'],
    ['xAI uses xai-abcdefghijklmnopqrstuvwx', 'xAI uses [redacted]'],
    ['Google accepts AIzaabcdefghijklmnopqrstuvwxyz0123456789', 'Google accepts [redacted]'],
    ['an AWS key AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ on line 4', 'an AWS key [redacted] on line 4'],
    [
      'session eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5EYjG ended',
      'session [redacted] ended'
    ],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuv', 'Authorization: Bearer [redacted]']
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactSecrets(input), expected, input);
    assert.equal(containsSecret(input), true, input);
  }
});

test('a credential named as one is replaced wherever the value came from', () => {
  const lines = [
    'apiKey = "sk-not-the-shape-here"',
    'the config said api_key: privatevalue123',
    'access token=abc123def456ghi789',
    'refresh_token:"aaaaaaaaaaaaaaaaaaaa"',
    'password: hunter2hunter2',
    'client-secret=abcdefghijklmnop'
  ];
  for (const line of lines) {
    const redacted = redactSecrets(line);
    assert.match(redacted, /\[redacted]/, line);
    assert.equal(containsSecret(redacted), false, `${line} is clean after one pass`);
  }
});

test('ordinary prose about keys and tokens survives untouched', () => {
  const lines = [
    '"m1": passed.',
    'Spent 1.2 of the run budget (total 6).',
    'Rolled the workspace back to the pre-run checkpoint.',
    '2 of 5 milestones did not complete.',
    'The tokenizer counts tokens per request.',
    'Set the API key in Settings, then choose a model.',
    'git status: src/secrets.ts modified',
    'npm error code EACCES: permission denied'
  ];
  for (const line of lines) {
    assert.equal(redactSecrets(line), line);
    assert.equal(containsSecret(line), false);
  }
});

test('a short value nobody could confuse with a key is left alone', () => {
  // The point of the length floors: `token: 5` and a 30-character provider key
  // are not the same object, and a redactor that treats them alike is useless.
  assert.equal(redactSecrets('retry token: 5'), 'retry token: 5');
  assert.equal(redactSecrets('sk-short'), 'sk-short');
});
