import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceStateStore } from './workspaceStateStore';
import type { PromptCheckpointSnapshot } from './chatCheckpoints';
import type { SubagentActivityRecord } from './types';

function createFakeIdb(): { idb: IDBFactory; backing: Map<string, unknown> } {
  const backing = new Map<string, unknown>();

  const makeRequest = <T,>(run: () => T) => {
    const req: {
      result?: T;
      onsuccess: ((ev: Event) => void) | null;
      onerror: ((ev: Event) => void) | null;
    } = {
      onsuccess: null,
      onerror: null
    };
    queueMicrotask(() => {
      req.result = run();
      req.onsuccess?.({} as Event);
    });
    return req as unknown as IDBRequest<T>;
  };

  const makeStore = (onWriteDone: () => void) => ({
    createIndex() {
      return {} as IDBIndex;
    },
    get(key: IDBValidKey) {
      return makeRequest(() => backing.get(String(key)));
    },
    getAll() {
      return makeRequest(() => [...backing.values()]);
    },
    put(value: { workspaceKey: string }) {
      const req = makeRequest(() => {
        backing.set(value.workspaceKey, structuredClone(value));
        return value.workspaceKey as IDBValidKey;
      });
      onWriteDone();
      return req;
    },
    delete(key: IDBValidKey) {
      const req = makeRequest(() => {
        backing.delete(String(key));
        return undefined;
      });
      onWriteDone();
      return req;
    }
  });

  const db = {
    objectStoreNames: {
      contains: () => true
    },
    createObjectStore() {
      return makeStore(() => {});
    },
    transaction() {
      const tx: {
        oncomplete: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
        onabort: ((ev: Event) => void) | null;
        objectStore: () => ReturnType<typeof makeStore>;
      } = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () =>
          makeStore(() => {
            queueMicrotask(() => tx.oncomplete?.({} as Event));
          })
      };
      return tx as unknown as IDBTransaction;
    }
  };

  const idb = {
    open() {
      const req: {
        result?: IDBDatabase;
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
      } = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null
      };
      queueMicrotask(() => {
        req.result = db as unknown as IDBDatabase;
        req.onupgradeneeded?.({} as IDBVersionChangeEvent);
        req.onsuccess?.({} as Event);
      });
      return req as unknown as IDBOpenDBRequest;
    }
  };

  return { idb: idb as unknown as IDBFactory, backing };
}

test('workspaceStateStore persists checkpoints and subagents across fresh instances without clobbering concurrent writes', async () => {
  const fake = createFakeIdb();
  const storeA = createWorkspaceStateStore({ indexedDb: fake.idb });

  const checkpoints: PromptCheckpointSnapshot[] = [
    {
      userMessageId: 'u1',
      promptText: 'add auth',
      workspaceKey: 'folder-a',
      createdAt: 100,
      priorFiles: { 'src/App.tsx': 'old app', nul: 'ignored-reserved' },
      createdPaths: ['src/auth.ts', 'CON']
    }
  ];
  const subagents: Record<string, SubagentActivityRecord[]> = {
    m1: [
      { id: 'sa1', index: 1, title: 'Frontend', label: 'Scan UI', status: 'done', stepsCount: 2, summary: 'Ready' },
      { id: 'sa2', index: 2, title: 'Backend', label: 'Scan API', status: 'running', stepsCount: 1 }
    ]
  };

  await Promise.all([
    storeA.saveCheckpoints('folder-a', checkpoints),
    storeA.saveSubagents('folder-a', subagents)
  ]);

  // Simulate app restart with a fresh store instance over the same IndexedDB backing
  const storeB = createWorkspaceStateStore({ indexedDb: fake.idb });
  const loaded = await storeB.load('folder-a');
  assert.equal(loaded.promptCheckpoints.length, 1);
  assert.deepEqual(loaded.promptCheckpoints[0].priorFiles, { 'src/App.tsx': 'old app' });
  assert.deepEqual(loaded.promptCheckpoints[0].createdPaths, ['src/auth.ts']);
  assert.equal(loaded.subagentsByMessage.m1.length, 2);
  assert.equal(loaded.subagentsByMessage.m1[0].status, 'done');
  assert.equal(loaded.subagentsByMessage.m1[1].status, 'error');
  assert.match(loaded.subagentsByMessage.m1[1].summary ?? '', /Interrupted/);

  // Clearing checkpoints keeps subagents; clearing subagents drops record cleanly
  await storeB.clearCheckpoints('folder-a');
  const afterCpClear = await storeB.load('folder-a');
  assert.equal(afterCpClear.promptCheckpoints.length, 0);
  assert.equal(afterCpClear.subagentsByMessage.m1.length, 2);

  await storeB.clearSubagents('folder-a');
  const afterAllClear = await storeB.load('folder-a');
  assert.deepEqual(afterAllClear, { promptCheckpoints: [], subagentsByMessage: {} });
  assert.equal(fake.backing.has('folder-a'), false);
});

test('workspaceStateStore falls back safely when IndexedDB is unavailable', async () => {
  const store = createWorkspaceStateStore({ indexedDb: null });
  await store.saveSubagents('folder-mem', {
    m1: [{ id: 's1', label: 'Explore', status: 'done', summary: 'Found' }]
  });
  const loaded = await store.load('folder-mem');
  assert.equal(loaded.subagentsByMessage.m1[0].summary, 'Found');
  await store.clearAll('folder-mem');
  assert.deepEqual(await store.load('folder-mem'), { promptCheckpoints: [], subagentsByMessage: {} });
});
