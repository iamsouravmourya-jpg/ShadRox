const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BODY_MAX_BYTES, createAutomationWebhook } = require('./automation-webhook.cjs');

const SECRET = '0123456789abcdef-secret';
const BASE_DEFINITION = {
  id: 'deploy',
  name: 'Deploy',
  enabled: true,
  trigger: { type: 'webhook', path: '/hooks/deploy', secret: SECRET },
  action: { type: 'prompt', prompt: 'deploy the app' },
  creditsPerRun: 1
};

async function makeWorkspace(context, definitions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-webhook-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.shadrox'), { recursive: true });
  await fs.writeFile(path.join(root, '.shadrox', 'automations.json'), JSON.stringify(definitions));
  return root;
}

async function startWebhook(context, root, onTrigger = () => {}) {
  const webhook = createAutomationWebhook({ getRoot: () => root, onTrigger });
  context.after(() => webhook.stop());
  const status = await webhook.start();
  assert.equal(status.running, true);
  assert.equal(status.error, null);
  assert.ok(Number.isInteger(status.port) && status.port > 0);
  return { webhook, base: `http://127.0.0.1:${status.port}` };
}

test('accepts Bearer and x-shadrox-secret tokens and emits a trigger event', async (context) => {
  const root = await makeWorkspace(context, [BASE_DEFINITION]);
  const triggers = [];
  const { base } = await startWebhook(context, root, (event) => triggers.push(event));

  const bearer = await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main' })
  });
  assert.equal(bearer.status, 202);

  const header = await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { 'x-shadrox-secret': SECRET },
    body: 'plain body'
  });
  assert.equal(header.status, 202);
  assert.equal(triggers.length, 2);
  assert.deepEqual(triggers[0], {
    automationId: 'deploy',
    receivedAt: triggers[0].receivedAt,
    payload: { ref: 'main' }
  });
  assert.equal(triggers[1].payload, 'plain body');
  assert.ok(Number.isFinite(triggers[0].receivedAt));
});

test('rejects missing and wrong secrets with 401', async (context) => {
  const root = await makeWorkspace(context, [BASE_DEFINITION]);
  const { base } = await startWebhook(context, root);

  assert.equal((await fetch(`${base}/hooks/deploy`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { authorization: 'Bearer not-the-secret' },
    body: '{}'
  })).status, 401);
  assert.equal((await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { 'x-shadrox-secret': 'short' },
    body: '{}'
  })).status, 401);
});

test('answers 404 for a method mismatch, an unknown path and a disabled automation', async (context) => {
  const root = await makeWorkspace(context, [
    BASE_DEFINITION,
    {
      ...BASE_DEFINITION,
      id: 'disabled',
      trigger: { type: 'webhook', path: '/hooks/off', secret: SECRET },
      enabled: false
    }
  ]);
  const { base } = await startWebhook(context, root);
  const auth = { authorization: `Bearer ${SECRET}` };

  assert.equal((await fetch(`${base}/hooks/deploy`, { method: 'GET', headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/hooks/deploy`, { method: 'PUT', headers: auth, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/hooks/missing`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/hooks/off`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
});

test('caps the request body at 64 KB with 413', async (context) => {
  const root = await makeWorkspace(context, [BASE_DEFINITION]);
  const triggers = [];
  const { base } = await startWebhook(context, root, (event) => triggers.push(event));

  const oversized = Buffer.alloc(BODY_MAX_BYTES + 1024, 0x61);
  const response = await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/octet-stream' },
    body: oversized
  });
  assert.equal(response.status, 413);
  assert.equal(triggers.length, 0);
});

test('allows ten triggers per minute per automation and then answers 429', async (context) => {
  const root = await makeWorkspace(context, [BASE_DEFINITION]);
  const { base } = await startWebhook(context, root);
  const request = () => fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: '{}'
  });

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await request()).status, 202, `trigger ${index + 1} should be accepted`);
  }
  assert.equal((await request()).status, 429);
});

test('stops cleanly, reports idle status and refuses connections afterwards', async (context) => {
  const root = await makeWorkspace(context, [BASE_DEFINITION]);
  const { webhook, base } = await startWebhook(context, root);

  await webhook.stop();
  assert.deepEqual(webhook.status(), { running: false, port: null, error: null });
  await webhook.stop();
  assert.deepEqual(webhook.status(), { running: false, port: null, error: null });
  await assert.rejects(fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    body: '{}'
  }));
});
