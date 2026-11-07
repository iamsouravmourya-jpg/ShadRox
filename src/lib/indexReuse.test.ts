import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  admitRemoteIndex,
  indexCounts,
  IndexingCoordinator,
  planIndex,
  type IndexedFile
} from './indexReuse';

function file(path: string, contentId: string, length: number): IndexedFile {
  return { path, contentId, length };
}

describe('planIndex (S19)', () => {
  it('reuses a file whose content identity is unchanged (S19)', () => {
    const previous = [file('src/a.ts', 'hash-a', 120)];
    const next = [file('src/a.ts', 'hash-a', 120)];
    const plan = planIndex(previous, next);
    assert.deepEqual(plan.reuse, ['src/a.ts']);
    assert.deepEqual(plan.embed, []);
    assert.deepEqual(plan.removed, []);
  });

  it('re-embeds a same-length edit — identity, not length, decides (S19)', () => {
    const previous = [file('src/a.ts', 'hash-a', 120)];
    const next = [file('src/a.ts', 'hash-b', 120)];
    const plan = planIndex(previous, next);
    assert.deepEqual(plan.embed, ['src/a.ts']);
    assert.deepEqual(plan.reuse, []);
  });

  it('embeds a brand-new file and drops paths that disappeared (S19)', () => {
    const previous = [file('src/a.ts', 'hash-a', 120), file('src/gone.ts', 'hash-g', 40)];
    const next = [file('src/a.ts', 'hash-a', 120), file('src/new.ts', 'hash-n', 10)];
    const plan = planIndex(previous, next);
    assert.deepEqual(plan.reuse, ['src/a.ts']);
    assert.deepEqual(plan.embed, ['src/new.ts']);
    assert.deepEqual(plan.removed, ['src/gone.ts']);
  });

  it('treats path separators and case as the same file (S19)', () => {
    const previous = [file('src\\A.ts', 'hash-a', 120)];
    const next = [file('./src/a.ts', 'hash-a', 120)];
    const plan = planIndex(previous, next);
    assert.deepEqual(plan.reuse, ['./src/a.ts']);
    assert.deepEqual(plan.embed, []);
    assert.deepEqual(plan.removed, []);
  });
});

describe('IndexingCoordinator (S19)', () => {
  it('accepts only the current workspace and epoch (S19)', () => {
    const coordinator = new IndexingCoordinator();
    const batch = coordinator.begin('ws-1');
    assert.equal(coordinator.accept(batch), true);
  });

  it('drops a late result from a previous workspace (S19)', () => {
    const coordinator = new IndexingCoordinator();
    const stale = coordinator.begin('ws-1');
    coordinator.begin('ws-2');
    assert.equal(coordinator.accept(stale), false);
  });

  it('drops a superseded pass within the same workspace (S19)', () => {
    const coordinator = new IndexingCoordinator();
    const stale = coordinator.begin('ws-1');
    coordinator.begin('ws-1');
    assert.equal(coordinator.accept(stale), false);
  });

  it('invalidates every in-flight batch when cancelled (S19)', () => {
    const coordinator = new IndexingCoordinator();
    const batch = coordinator.begin('ws-1');
    coordinator.cancel();
    assert.equal(coordinator.accept(batch), false);
    assert.equal(coordinator.current.workspaceId, 'ws-1');
  });
});

describe('indexCounts (S19)', () => {
  it('never charges or uploads for local indexing and reports each count separately (S19)', () => {
    const plan = planIndex(
      [file('src/a.ts', 'hash-a', 120)],
      [file('src/a.ts', 'hash-a', 120), file('src/new.ts', 'hash-n', 10)]
    );
    const counts = indexCounts(plan, ['src/a.ts', 'src/new.ts']);
    assert.equal(counts.indexed, 1);
    assert.equal(counts.reused, 1);
    assert.equal(counts.sent, 2);
    assert.equal(counts.charged, false);
    assert.equal(counts.uploaded, false);
  });
});

describe('admitRemoteIndex (S19)', () => {
  it('fails closed when remote indexing is not approved (S19)', () => {
    const decision = admitRemoteIndex({
      approved: false,
      payer: 'shared',
      files: ['src/a.ts'],
      estimatedRupees: 0.5
    });
    assert.equal(decision.admitted, false);
    assert.deepEqual(decision.scope, []);
    assert.equal(decision.estimatedRupees, 0);
  });

  it('fails closed on an empty scope or an unpriced request (S19)', () => {
    const empty = admitRemoteIndex({
      approved: true,
      payer: 'shared',
      files: [],
      estimatedRupees: 0.5
    });
    assert.equal(empty.admitted, false);

    const unpriced = admitRemoteIndex({
      approved: true,
      payer: 'shared',
      files: ['src/a.ts'],
      estimatedRupees: 0
    });
    assert.equal(unpriced.admitted, false);
    assert.match(unpriced.reason, /unpriced/i);
  });

  it('admits an approved scope and reserves its cost against the shared budget (S19)', () => {
    const decision = admitRemoteIndex({
      approved: true,
      payer: 'shared',
      files: ['src/a.ts', 'src/b.ts'],
      estimatedRupees: 0.7
    });
    assert.equal(decision.admitted, true);
    assert.deepEqual(decision.scope, ['src/a.ts', 'src/b.ts']);
    assert.equal(decision.estimatedRupees, 0.7);
    assert.match(decision.reason, /reserved/);
  });

  it('admits on the user’s own key without charging anything (S19)', () => {
    const decision = admitRemoteIndex({
      approved: true,
      payer: 'byok',
      files: ['src/a.ts'],
      estimatedRupees: 0.4
    });
    assert.equal(decision.admitted, true);
    assert.match(decision.reason, /charges nothing/);
  });
});
