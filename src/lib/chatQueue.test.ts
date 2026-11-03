import assert from 'node:assert/strict';
import test from 'node:test';
import { dequeueChatItem, enqueueChatItem, MAX_QUEUED_CHAT_MESSAGES, removeQueuedChatItem } from './chatQueue';

const item = (id: string) => ({ id, text: id });

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
