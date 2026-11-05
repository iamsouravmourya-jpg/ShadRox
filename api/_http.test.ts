import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ERROR_MESSAGE_CHARS, readErrorPayload, sanitizeErrorMessage } from './_http.js';

// Synthetic values only: every credential below is fabricated for the test.
const GH_CLASSIC = ['ghp', 'A'.repeat(36)].join('_');
const GH_FINE = 'github_pat_11ABCDEFG0AAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const GH_CLASSIC_VALID = GH_CLASSIC;
const GH_OAUTH = ['gho', 'B'.repeat(36)].join('_');
const GH_SERVER = ['ghs', 'C'.repeat(36)].join('_');
const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP';
const AWS_TEMP = 'ASIAABCDEFGHIJKLMNOP';

test('a GitHub token quoted bare in an upstream error never survives', () => {
  const out = sanitizeErrorMessage(`Bad credentials: ${GH_CLASSIC}`);
  assert.ok(!out.includes(GH_CLASSIC));
  assert.ok(out.includes('[redacted]'));
});

test('fine-grained tokens, AWS access keys and temporary keys are redacted', () => {
  const out = sanitizeErrorMessage(`${GH_FINE} rejected; ${AWS_KEY} and ${AWS_TEMP} are not allowed here`);
  for (const secret of [GH_FINE, AWS_KEY, AWS_TEMP]) assert.ok(!out.includes(secret), out);
});

test('all supported GitHub token prefixes are redacted', () => {
  const out = sanitizeErrorMessage(`${GH_CLASSIC_VALID}, ${GH_OAUTH}, ${GH_SERVER}`);
  for (const secret of [GH_CLASSIC_VALID, GH_OAUTH, GH_SERVER]) assert.ok(!out.includes(secret), out);
});

test('upstream error payloads use the sanitizer before being returned', async () => {
  const response = new Response(
    JSON.stringify({
      error: { message: `Bad credentials: ${GH_CLASSIC_VALID}, ${GH_FINE} and ${AWS_KEY}` }
    }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  );
  const message = await readErrorPayload(response);
  for (const secret of [GH_CLASSIC_VALID, GH_FINE, AWS_KEY]) assert.ok(!message.includes(secret), message);
  assert.equal((message.match(/\[redacted\]/g) || []).length, 3, message);
});

test('labeled secret pairs whose name does not contain "key" are redacted', () => {
  const out = sanitizeErrorMessage('failed: access_key_id=ABCDEFGH secret_access_key=IJKLMNOP refresh_token=WXYZ');
  assert.ok(!out.includes('ABCDEFGH'), out);
  assert.ok(!out.includes('IJKLMNOP'), out);
  assert.ok(!out.includes('WXYZ'), out);
});

test('multiple credentials in one message are all removed', () => {
  const out = sanitizeErrorMessage(`retry with ${GH_CLASSIC} or ${AWS_KEY}, then ${GH_CLASSIC} again`);
  assert.equal(out.split('[redacted]').length - 1, 3, out);
});

test('provider patterns that already worked keep working', () => {
  const out = sanitizeErrorMessage('AIzaSyTESTTESTTEST failed with key=XYZ123 and bearer abcdefghijklmnop');
  assert.ok(!out.includes('AIzaSyTESTTESTTEST'), out);
  assert.ok(!out.includes('XYZ123'), out);
  assert.ok(!out.includes('abcdefghijklmnop'), out);
});

test('ordinary diagnostic text is passed through untouched', () => {
  assert.equal(
    sanitizeErrorMessage('Repository was not found (404). Check the owner name.'),
    'Repository was not found (404). Check the owner name.'
  );
});

test('a message with nothing but a credential falls back, usable text survives', () => {
  assert.equal(sanitizeErrorMessage(GH_CLASSIC), 'Request failed.');
  assert.equal(sanitizeErrorMessage(`invalid ${GH_CLASSIC}`), 'invalid [redacted]');
  assert.equal(sanitizeErrorMessage(new Error(`invalid ${GH_CLASSIC}`), 'GitHub failed.'), 'invalid [redacted]');
  assert.equal(sanitizeErrorMessage('   ', 'Empty upstream reply.'), 'Empty upstream reply.');
});

test('oversized replies are capped after redaction, not before', () => {
  const out = sanitizeErrorMessage(`${GH_CLASSIC} ${'x'.repeat(1000)}`);
  assert.equal(out.length, MAX_ERROR_MESSAGE_CHARS + 1);
  assert.ok(!out.includes(GH_CLASSIC));
});

test('repeated calls are stable — no shared regex state leaks between them', () => {
  const message = `both ${GH_CLASSIC} and ${AWS_KEY} were rejected`;
  assert.equal(sanitizeErrorMessage(message), sanitizeErrorMessage(message));
});
