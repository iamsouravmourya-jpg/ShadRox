import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeWebhook, encodeWebhook } from './webhook-codec';
import { isFeedbackConfigured, postFeedback, submitFeedback } from './feedback';

const PLAIN = 'https://script.google.com/macros/s/AKfycbx_example_deployment_id/exec';

test('the codec round-trips plain URLs, query strings and Unicode', () => {
  const cases = [
    PLAIN,
    'https://script.google.com/macros/s/abc/exec?token=1&scope=a%20b',
    'https://example.test/é/日本/emoji-🙂',
    ''
  ];
  for (const value of cases) {
    assert.equal(decodeWebhook(encodeWebhook(value)), value, value);
  }
});

test('an empty string encodes to an empty string', () => {
  assert.equal(encodeWebhook(''), '');
  assert.equal(decodeWebhook(''), '');
});

test('the encoded value does not expose the plain URL', () => {
  const encoded = encodeWebhook(PLAIN);
  assert.notEqual(encoded, PLAIN);
  assert.equal(encoded.includes(PLAIN), false);
  assert.equal(encoded.includes('script.google.com'), false);
});

test('the test build has no feedback endpoint', () => {
  assert.equal(isFeedbackConfigured(), false);
});

test('sending without a configured endpoint says so instead of pretending', async () => {
  await assert.rejects(submitFeedback({ kind: 'bug', message: 'The panel crashed' }), {
    message: "Feedback isn't configured in this build."
  });
});

test('a too-short or empty message is rejected before sending', async () => {
  await assert.rejects(submitFeedback({ kind: 'feature', message: '  ok  ' }), {
    message: /at least a few words/
  });
  await assert.rejects(submitFeedback({ kind: 'feature', message: '   ' }), {
    message: /at least a few words/
  });
});

function stubFetch(handler: () => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => handler()) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('an accepted report resolves after the sheet confirms ok:true', async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    await postFeedback('https://sheet.test/exec', 'bug', 'The panel crashed');
  } finally {
    restore();
  }
});

test('Apps Script HTTP 200 with ok:false is surfaced, not reported as success', async () => {
  const restore = stubFetch(
    () => new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), { status: 200 })
  );
  try {
    await assert.rejects(postFeedback('https://sheet.test/exec', 'bug', 'The panel crashed'), {
      message: /lot of reports/
    });
  } finally {
    restore();
  }
});

test('a non-JSON answer from the sheet is a failure, not a silent success', async () => {
  const restore = stubFetch(() => new Response('<html>Sign in</html>', { status: 200 }));
  try {
    await assert.rejects(postFeedback('https://sheet.test/exec', 'feature', 'Add a shortcut'), {
      message: /did not confirm/
    });
  } finally {
    restore();
  }
});
