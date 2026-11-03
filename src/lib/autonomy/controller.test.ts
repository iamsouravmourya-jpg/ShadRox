import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunController, type RunExecutorHelpers } from './controller';
import type { RunState } from './types';

function state(status: RunState['status'] = 'done'): RunState {
  return { id: 'run-1', goal: 'g', status, milestones: [], creditsSpent: 0, startedAt: 1 };
}

test('start runs the executor, exposes the final state, persists it and notifies', async () => {
  const persisted: RunState[] = [];
  const seen: (RunState | null)[] = [];
  const controller = createRunController({
    execute: async () => state('done'),
    persist: (s) => persisted.push(s)
  });
  controller.subscribe((s) => seen.push(s));

  const final = await controller.start('goal');
  assert.equal(final?.status, 'done');
  assert.equal(controller.getState()?.status, 'done');
  assert.equal(controller.isRunning(), false);
  assert.deepEqual(persisted.map((s) => s.status), ['done']);
  assert.equal(seen[seen.length - 1]?.status, 'done');
});

test('stop flips the cancellation flag the executor checks', async () => {
  const controller = createRunController({
    execute: async (_goal, helpers: RunExecutorHelpers) => {
      assert.equal(helpers.isCancellationRequested(), false);
      controller.stop();
      assert.equal(helpers.isCancellationRequested(), true, 'Stop is visible to the running loop');
      return state('cancelled');
    }
  });
  const final = await controller.start('goal');
  assert.equal(final?.status, 'cancelled');
});

test('events from the run are forwarded to subscribers while it is in flight', async () => {
  const events: string[] = [];
  const controller = createRunController({
    execute: async (_goal, helpers) => {
      helpers.onEvent({ type: 'log', text: 'planning' });
      return state();
    }
  });
  controller.subscribe((_s, event) => {
    if (event) events.push(event.type);
  });
  await controller.start('goal');
  assert.deepEqual(events, ['log']);
});

test('a second start while a run is in flight is refused', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = createRunController({
    execute: async () => {
      await gate;
      return state();
    }
  });
  const first = controller.start('goal');
  assert.equal(controller.isRunning(), true);
  assert.equal(await controller.start('second'), null, 'a concurrent run is refused, not queued');
  release();
  await first;
});

test('restore seeds the initial state and isRunning starts false', () => {
  const controller = createRunController({ execute: async () => state('running'), restore: () => state('paused') });
  assert.equal(controller.getState()?.status, 'paused');
  assert.equal(controller.isRunning(), false);
});

test('unsubscribe stops delivery', async () => {
  const controller = createRunController({ execute: async () => state() });
  let count = 0;
  const off = controller.subscribe(() => {
    count += 1;
  });
  await controller.start('goal');
  const afterFirst = count;
  off();
  await controller.start('again');
  assert.equal(count, afterFirst, 'no notifications after unsubscribe');
});
