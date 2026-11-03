import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunStore, isRunState, type RunStorage } from './runStore';
import type { RunState } from './types';

function memoryStorage(): RunStorage & { dump: () => Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map)
  };
}

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    id: 'run-1',
    goal: 'ship it',
    status: 'done',
    milestones: [
      {
        id: 'm1',
        title: 'do a thing',
        instruction: 'do it',
        expectedFiles: ['src/a.ts'],
        dependsOn: [],
        status: 'passed',
        attempts: []
      }
    ],
    creditsSpent: 3,
    startedAt: 1,
    ...overrides
  };
}

test('a run round-trips per workspace root and does not leak across roots', () => {
  const storage = memoryStorage();
  const store = createRunStore(storage);
  store.save('/ws/a', state({ goal: 'first' }));
  store.save('/ws/b', state({ goal: 'second' }));

  assert.equal(store.load('/ws/a')?.goal, 'first');
  assert.equal(store.load('/ws/b')?.goal, 'second');
  assert.equal(store.load('/ws/c'), null, 'an unrun workspace has no run');
});

test('clear forgets one workspace without touching another', () => {
  const store = createRunStore(memoryStorage());
  store.save('/ws/a', state());
  store.save('/ws/b', state());
  store.clear('/ws/a');
  assert.equal(store.load('/ws/a'), null);
  assert.notEqual(store.load('/ws/b'), null);
});

test('a corrupt blob is treated as no run, not a crash', () => {
  const storage = memoryStorage();
  storage.setItem('shadrox.autonomy.run:/ws/a', '{ not json');
  const store = createRunStore(storage);
  assert.equal(store.load('/ws/a'), null);

  storage.setItem('shadrox.autonomy.run:/ws/a', JSON.stringify({ goal: 'x' }));
  assert.equal(store.load('/ws/a'), null, 'a partial shape is rejected');
});

test('save survives a storage that throws, and the null store is a safe no-op', () => {
  const hostile: RunStorage = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('denied');
    }
  };
  const store = createRunStore(hostile);
  assert.doesNotThrow(() => store.save('/ws', state()));
  assert.equal(store.load('/ws'), null);
  assert.doesNotThrow(() => store.clear('/ws'));

  const empty = createRunStore(null);
  assert.doesNotThrow(() => empty.save('/ws', state()));
  assert.equal(empty.load('/ws'), null);
});

test('isRunState accepts a real state and rejects the shapes the panel cannot render', () => {
  assert.equal(isRunState(state()), true);
  assert.equal(isRunState(null), false);
  assert.equal(isRunState('run'), false);
  assert.equal(isRunState({ ...state(), milestones: [{ id: 'm1' }] }), false);
});
