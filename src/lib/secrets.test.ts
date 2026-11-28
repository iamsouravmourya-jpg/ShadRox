import assert from 'node:assert/strict';
import test from 'node:test';

import { containsSecret, redactSecrets } from './secrets';

test('every published key shape is replaced by a marker', () => {
  const cases: Array<[string, string]> = [
    ['OpenAI key sk-abcdefghijklmnopqrstuvwxyz12', 'OpenAI key [redacted]'],
    ['Groq rejected gsk_abcdefghijklmnopqrstuvwxyz12', 'Groq rejected [redacted]'],
    ['xAI uses xai-abcdefghijklmnopqrstuvwx', 'xAI uses [redacted]'],
    ['Google accepts AIzaabcdefghijklmnopqrstuvwxyz0123456789', 'Google accepts [redacted]'],
    ['Google token AQ.Abcdefghijklmnopqrstuvwxyz12', 'Google token [redacted]'],
    ['GitHub PAT ghp_abcdefghijklmnopqrstuvwxyz12345678', 'GitHub PAT [redacted]'],
    ['GitHub fine-grained github_pat_1234567890_abcdefghijklmno', 'GitHub fine-grained [redacted]'],
    ['an AWS key AKIAABCDEFGHIJKLMNOPQRSTUVWXYZ on line 4', 'an AWS key [redacted] on line 4'],
    ['an AWS temp key ASIAABCDEFGHIJKLMNOPQRSTUVWXYZ on line 5', 'an AWS temp key [redacted] on line 5'],
    ['Slack bot xoxb-1234567890-abcdefghijkl', 'Slack bot [redacted]'],
    ['key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQE=\n-----END PRIVATE KEY-----', 'key:\n[redacted]'],
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

test('inline connection-string credentials are redacted, bare URLs are not', () => {
  assert.equal(
    redactSecrets('db postgres://admin:s3cr3tPass@db.internal:5432/app'),
    'db postgres://[redacted]@db.internal:5432/app'
  );
  assert.equal(containsSecret('mongodb://root:toor@10.0.0.5:27017'), true);
  // A URL with no credentials is ordinary text and must survive.
  assert.equal(redactSecrets('see https://react.dev/learn for docs'), 'see https://react.dev/learn for docs');
});
