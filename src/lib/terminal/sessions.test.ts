import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TERMINAL_SESSIONS,
  activeTerminalSession,
  createTerminalSessions,
  recallWorkspaceSessions,
  rememberWorkspaceSessions,
  sanitizeSessionName,
  terminalSessionsReducer
} from './sessions';
import type { TerminalSession } from './sessions';

const session = (key: string, name = key): TerminalSession => ({
  key,
  name,
  mode: 'system',
  status: 'connected'
});

test('add appends a tab, makes it active and names it from the counter', () => {
  let state = createTerminalSessions();
  state = terminalSessionsReducer(state, { type: 'add', key: 'aaaa1111', mode: 'system' });
  state = terminalSessionsReducer(state, { type: 'add', key: 'bbbb2222', mode: 'system' });
  assert.deepEqual(state.sessions.map((entry) => entry.key), ['aaaa1111', 'bbbb2222']);
  assert.deepEqual(state.sessions.map((entry) => entry.name), ['Shell 1', 'Shell 2']);
  assert.equal(state.activeKey, 'bbbb2222');
});

test('add refuses to exceed the tab limit and ignores a duplicate key', () => {
  let state = createTerminalSessions();
  for (let index = 0; index < MAX_TERMINAL_SESSIONS + 4; index += 1) {
    state = terminalSessionsReducer(state, { type: 'add', key: `key-${index}`, mode: 'system' });
  }
  assert.equal(state.sessions.length, MAX_TERMINAL_SESSIONS);
  const before = state;
  state = terminalSessionsReducer(state, { type: 'add', key: 'key-0', mode: 'system' });
  assert.equal(state, before);
});

test('activate and cycle move between tabs without reordering them', () => {
  let state = createTerminalSessions([session('one'), session('two'), session('three')]);
  state = terminalSessionsReducer(state, { type: 'add', key: 'four', mode: 'system' });
  assert.equal(state.activeKey, 'four');
  state = terminalSessionsReducer(state, { type: 'cycle', delta: 1 });
  assert.equal(state.activeKey, 'one');
  state = terminalSessionsReducer(state, { type: 'cycle', delta: -1 });
  assert.equal(state.activeKey, 'four');
  state = terminalSessionsReducer(state, { type: 'activate', key: 'two' });
  assert.equal(activeTerminalSession(state)?.name, 'two');
  assert.deepEqual(state.sessions.map((entry) => entry.key), ['one', 'two', 'three', 'four']);
});

test('close lands on the tab that slid into the slot, then the left neighbour', () => {
  const base = createTerminalSessions([session('one'), session('two'), session('three')]);
  const middle = terminalSessionsReducer({ ...base, activeKey: 'two' }, { type: 'close', key: 'two' });
  assert.deepEqual(middle.sessions.map((entry) => entry.key), ['one', 'three']);
  assert.equal(middle.activeKey, 'three');

  const last = terminalSessionsReducer({ ...base, activeKey: 'three' }, { type: 'close', key: 'three' });
  assert.equal(last.activeKey, 'two');

  const only = terminalSessionsReducer({ ...base, sessions: [session('one')], activeKey: 'one' }, { type: 'close', key: 'one' });
  assert.deepEqual(only.sessions, []);
  assert.equal(only.activeKey, null);
  assert.equal(activeTerminalSession(only), null);
});

test('close keeps the active tab when a different one is removed', () => {
  const state = terminalSessionsReducer({ ...createTerminalSessions([session('one'), session('two')]), activeKey: 'one' }, { type: 'close', key: 'two' });
  assert.equal(state.activeKey, 'one');
});

test('rename and status only touch the addressed tab', () => {
  let state = createTerminalSessions([session('one', 'One'), session('two', 'Two')]);
  state = terminalSessionsReducer(state, { type: 'rename', key: 'two', name: '  backend  ' });
  assert.equal(state.sessions[1].name, 'backend');
  assert.equal(state.sessions[0].name, 'One');
  state = terminalSessionsReducer(state, { type: 'status', key: 'one', status: 'exited' });
  assert.equal(state.sessions[0].status, 'exited');
  assert.equal(state.sessions[1].status, 'connected');
  const unchanged = terminalSessionsReducer(state, { type: 'status', key: 'one', status: 'exited' });
  assert.equal(unchanged, state);
});

test('unknown keys and empty names cannot corrupt the list', () => {
  const state = createTerminalSessions([session('one')]);
  assert.equal(terminalSessionsReducer(state, { type: 'activate', key: 'ghost' }), state);
  assert.equal(terminalSessionsReducer(state, { type: 'close', key: 'ghost' }), state);
  assert.equal(terminalSessionsReducer(state, { type: 'rename', key: 'ghost', name: 'x' }), state);
  assert.equal(sanitizeSessionName('', 'Shell 3'), 'Shell 3');
  assert.equal(sanitizeSessionName('a\u001b[2Jb\u0007c', 'Shell'), 'a [2Jb c');
  assert.equal(sanitizeSessionName('x'.repeat(120), 'Shell').length, 40);
});

test('tabs recalled after a re-dock keep their identity and start clean', () => {
  rememberWorkspaceSessions('ws-1', [session('one', 'One'), { ...session('two', 'backend'), status: 'exited' }]);
  const recalled = recallWorkspaceSessions('ws-1');
  assert.deepEqual(recalled.map((entry) => [entry.key, entry.name]), [['one', 'One'], ['two', 'backend']]);
  assert.deepEqual(recalled.map((entry) => entry.status), ['starting', 'starting']);
  assert.deepEqual(recallWorkspaceSessions('ws-unknown'), []);
});
