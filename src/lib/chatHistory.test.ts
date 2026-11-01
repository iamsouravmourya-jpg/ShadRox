import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  loadConversation,
  saveConversation,
  shouldSkipHistoryWrite,
  type HistoryStore
} from './chatHistory';
import type { ChatMessage } from './types';

function memoryStore(backing = new Map<string, string>()): HistoryStore & { backing: Map<string, string> } {
  return {
    backing,
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => {
      backing.set(key, value);
    },
    removeItem: (key) => {
      backing.delete(key);
    }
  };
}

function turn(id: string, role: 'user' | 'model', content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-11-02T02:00:00.000Z' };
}

test('a saved transcript comes back after the app restarts', () => {
  const backing = new Map<string, string>();
  saveConversation(memoryStore(backing), 'folder-C:/proj/a', [
    turn('1', 'user', 'why is login broken'),
    turn('2', 'model', 'the callback URL is pinned to localhost')
  ]);

  // A second store over the same bytes is what a fresh window sees.
  const restored = loadConversation(memoryStore(backing), 'folder-C:/proj/a');
  assert.ok(restored);
  assert.deepEqual(restored.map((message) => message.content), [
    'why is login broken',
    'the callback URL is pinned to localhost'
  ]);
});

test('a reply still streaming is not written, and never comes back half-made', () => {
  const store = memoryStore();
  const partial: ChatMessage = { ...turn('2', 'model', 'half an answer'), streaming: true, resumable: true };
  assert.equal(shouldSkipHistoryWrite([partial]), true);

  saveConversation(store, 'folder-a', [turn('1', 'user', 'hi'), partial]);
  const restored = loadConversation(store, 'folder-a');
  assert.ok(restored);
  assert.deepEqual(restored.map((message) => message.id), ['1']);
  assert.equal(restored[0].streaming, undefined);
});

test('starting a new chat really drops the stored conversation', () => {
  const store = memoryStore();
  saveConversation(store, 'folder-a', [turn('1', 'user', 'hi')]);
  saveConversation(store, 'folder-a', []);
  assert.equal(loadConversation(store, 'folder-a'), null);
});

test('each workspace gets its own transcript', () => {
  const store = memoryStore();
  saveConversation(store, 'folder-a', [turn('1', 'model', 'from A')]);
  saveConversation(store, 'folder-b', [turn('2', 'model', 'from B')]);
  assert.deepEqual(loadConversation(store, 'folder-a')?.map((m) => m.content), ['from A']);
  assert.deepEqual(loadConversation(store, 'folder-b')?.map((m) => m.content), ['from B']);
  assert.equal(loadConversation(store, 'folder-c'), null);
});

test('only the newest turns of a long chat are kept', () => {
  const store = memoryStore();
  saveConversation(store, 'folder-a', Array.from({ length: 200 }, (_, index) => turn(`${index}`, 'model', `line ${index}`)));
  const restored = loadConversation(store, 'folder-a');
  assert.ok(restored);
  assert.equal(restored.length, 80);
  assert.equal(restored[0].content, 'line 120');
  assert.equal(restored[restored.length - 1].content, 'line 199');
});

test('an oversized base64 screenshot is dropped, the text around it is not', () => {
  const store = memoryStore();
  const withImage: ChatMessage = { ...turn('1', 'user', 'look at this'), attachedImage: 'data:image/png;base64,' + 'A'.repeat(400_000) };
  saveConversation(store, 'folder-a', [withImage, turn('2', 'model', 'noted')]);
  const restored = loadConversation(store, 'folder-a');
  assert.ok(restored);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].attachedImage, undefined);
  assert.equal(restored[0].content, 'look at this');
});

test('only the recent workspaces keep a transcript', () => {
  const store = memoryStore();
  for (let index = 0; index < 20; index += 1) {
    saveConversation(store, `folder-${index}`, [turn('1', 'model', `project ${index}`)]);
  }
  const restored = store.backing.get('shadrox.chat.history');
  assert.ok(restored);
  assert.equal(Object.keys(JSON.parse(restored) as Record<string, unknown>).length, 12);
  assert.deepEqual(loadConversation(store, 'folder-19')?.map((m) => m.content), ['project 19']);
});

test('a full quota loses the oldest conversation, not the newest answer', () => {
  const store = memoryStore();
  saveConversation(store, 'folder-old', [turn('1', 'model', 'stale')]);

  let firstAttempt = true;
  const failing: HistoryStore = {
    ...store,
    setItem: (key, value) => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('QuotaExceededError');
      }
      store.setItem(key, value);
    }
  };
  saveConversation(failing, 'folder-new', [turn('2', 'model', 'worth keeping')]);
  assert.deepEqual(loadConversation(store, 'folder-new')?.map((m) => m.content), ['worth keeping']);
});

test('corrupt storage is ignored instead of breaking the chat panel', () => {
  const store = memoryStore();
  store.setItem('shadrox.chat.history', '{not json');
  assert.equal(loadConversation(store, 'folder-a'), null);

  store.setItem('shadrox.chat.history', JSON.stringify({ 'folder-a': { messages: [{ role: 'hacker' }, { content: 5 }], updatedAt: 1 } }));
  assert.equal(loadConversation(store, 'folder-a'), null);

  saveConversation(store, 'folder-a', [turn('1', 'model', 'still works')]);
  assert.deepEqual(loadConversation(store, 'folder-a')?.map((m) => m.content), ['still works']);
});
