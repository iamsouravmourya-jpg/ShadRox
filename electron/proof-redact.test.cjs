'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { commandSummary, redactCommandForProof, MASK } = require('./proof-redact.cjs');

test('an env assignment that names a credential loses its value', () => {
  const out = redactCommandForProof('OPENAI_API_KEY=sk-live-abc123 node scripts/run.mjs');
  assert.equal(out, `OPENAI_API_KEY=${MASK} node scripts/run.mjs`);
});

test('the provider-shaped bare key is caught even without a NAME= prefix', () => {
  for (const secret of ['sk-proj-abcdefgh1234', 'ghp_abcdefgh1234', 'AIzaSyA1234567890abcdefgh', 'gsk_abcdefgh1234']) {
    const out = redactCommandForProof(`curl https://api.example.com -d "${secret}"`);
    assert.equal(out.includes(secret), false, `leaked ${secret}`);
    assert.ok(out.includes(MASK));
  }
});

test('an authorization header is masked but the header name survives', () => {
  const out = redactCommandForProof('curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com');
  assert.equal(out, `curl -H "Authorization: ${MASK}" https://api.example.com`);
});

test('credentials in a URL userinfo are masked, the host stays readable', () => {
  const out = redactCommandForProof('git clone https://user:s3cret@github.com/org/repo.git');
  assert.equal(out, `git clone https://${MASK}@github.com/org/repo.git`);
});

test('a secret flag and its value are masked, including the = form', () => {
  assert.equal(
    redactCommandForProof('mysql --password hunter2 -e "select 1"'),
    `mysql --password ${MASK} -e "select 1"`
  );
  assert.equal(
    redactCommandForProof('tool --token=abc123 --verbose'),
    `tool --token=${MASK} --verbose`
  );
});

test('an ordinary command is untouched, so the ledger stays useful', () => {
  const command = 'npm test -- --grep "receipt" && node scripts/run-tests.mjs';
  assert.equal(redactCommandForProof(command), command);
  assert.equal(commandSummary(command), 'npm test --');
});

test('redaction is idempotent and never throws on odd input', () => {
  assert.equal(redactCommandForProof(null), '');
  assert.equal(redactCommandForProof(undefined), '');
  const once = redactCommandForProof('GITHUB_TOKEN=ghp_abcdefgh1234 npm run build');
  assert.equal(redactCommandForProof(once), once);
});
