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

test('pause is its own flag, kept apart from Stop so the panel can tell them apart', async () => {
  const controller = createRunController({
    execute: async (_goal, helpers: RunExecutorHelpers) => {
      controller.pause();
      assert.equal(helpers.isPauseRequested(), true, 'Pause is visible to the running loop');
      assert.equal(helpers.isCancellationRequested(), false, 'a pause is not a cancellation');
      return state('paused');
    }
  });
  const final = await controller.start('goal');
  assert.equal(final?.status, 'paused');
});

test('Stop and Pause both end the signal of the turn in flight', async () => {
  for (const press of ['stop', 'pause'] as const) {
    let sawAbort = false;
    const controller = createRunController({
      execute: async (_goal, helpers: RunExecutorHelpers) => {
        helpers.turnSignal().addEventListener('abort', () => {
          sawAbort = true;
        });
        controller[press]();
        return state(press === 'stop' ? 'cancelled' : 'paused');
      }
    });
    await controller.start('goal');
    assert.equal(sawAbort, true, `${press} must interrupt the request that is being paid for`);
  }
});

test('a new run starts with both halt flags clear', async () => {
  const controller = createRunController({
    execute: async (_goal, helpers: RunExecutorHelpers) => {
      const first = helpers.isCancellationRequested() || helpers.isPauseRequested();
      return { ...state(), goal: first ? 'stale halt' : 'clean' };
    }
  });
  assert.equal((await controller.start('one'))?.goal, 'clean');
  controller.pause();
  controller.stop();
  // The halted run left its flags set; the next run must not inherit them.
  assert.equal((await controller.start('two'))?.goal, 'clean');
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
