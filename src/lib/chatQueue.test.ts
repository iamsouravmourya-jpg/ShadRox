import assert from 'node:assert/strict';
import test from 'node:test';
import { dequeueChatItem, enqueueChatItem, MAX_QUEUED_CHAT_MESSAGES, removeQueuedChatItem, type QueuedChatItem } from './chatQueue';
import { createRequestEnvelope, envelopeDrift, type RequestEnvelope } from './requestEnvelope';

const item = (id: string) => ({ id, text: id });

/**
 * S01 acceptance: a request parked in the queue carries its own execution and
 * billing identity. Changing the app's settings while it waits must not rebind
 * it to the new workspace, key, plan, provider, model or permission mode.
 */
const frozenItem = (id: string, envelope: RequestEnvelope): QueuedChatItem & { envelope: RequestEnvelope } => ({
  id,
  text: envelope.prompt,
  envelope
});

const frozenEnvelope = (overrides: Partial<RequestEnvelope> = {}): RequestEnvelope =>
  createRequestEnvelope({
    id: 'req-1',
    workspaceId: 'ws-a',
    prompt: 'fix the parser',
    targets: ['src/parser.ts'],
    permissionMode: 'ask',
    refineMode: 'code',
    payer: 'byok',
    provider: 'gemini',
    model: 'glm-4.7-flash',
    budgetCredits: 4,
    ...overrides
  });

test('chat messages remain FIFO and can be removed before running', () => {
  let queue = [item('first'), item('second')];
  const removed = removeQueuedChatItem(queue, 'first');
  assert.deepEqual(removed, [item('second')]);

  const next = dequeueChatItem(queue);
  assert.deepEqual(next, { item: item('first'), queue: [item('second')] });
});

test('chat queue is bounded and does not drop existing requests', () => {
  const queue = Array.from({ length: MAX_QUEUED_CHAT_MESSAGES }, (_, index) => item(String(index)));
  const result = enqueueChatItem(queue, item('overflow'));
  assert.equal(result.accepted, false);
  assert.equal(result.queue, queue);
});

test('chat queue accepts a request below its limit', () => {
  const result = enqueueChatItem([item('first')], item('second'));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.queue, [item('first'), item('second')]);
});

test('a queued request runs with the identity it was sent with, not later settings', () => {
  const frozen = frozenEnvelope({ permissionMode: 'ask', payer: 'byok' });
  const { queue } = enqueueChatItem([], frozenItem('req-1', frozen));

  // The user switches to Agent mode and flips to the shared key while it waits.
  const later = frozenEnvelope({ permissionMode: 'agent', payer: 'shared' });

  const next = dequeueChatItem(queue);
  assert.ok(next.item);
  // The queued copy is untouched by the later settings.
  assert.equal(next.item.envelope.permissionMode, 'ask');
  assert.equal(next.item.envelope.payer, 'byok');

  const drift = envelopeDrift(next.item.envelope, later);
  assert.deepEqual(drift, ['payer', 'permission']);
});

test('a queued request for another workspace is flagged, not silently rebound', () => {
  const frozen = frozenEnvelope({ workspaceId: 'ws-a' });
  const { queue } = enqueueChatItem([], frozenItem('req-1', frozen));

  const elsewhere = frozenEnvelope({ workspaceId: 'ws-b' });
  const next = dequeueChatItem(queue);
  assert.ok(next.item);

  const drift = envelopeDrift(next.item.envelope, elsewhere);
  assert.ok(drift.includes('workspace'));
  // Its recorded workspace is still the one it was written for.
  assert.equal(next.item.envelope.workspaceId, 'ws-a');
});

test('an unchanged queue entry dispatches with no drift', () => {
  const frozen = frozenEnvelope();
  const { queue } = enqueueChatItem([], frozenItem('req-1', frozen));

  const next = dequeueChatItem(queue);
  assert.ok(next.item);
  assert.deepEqual(envelopeDrift(next.item.envelope, frozenEnvelope()), []);
});
