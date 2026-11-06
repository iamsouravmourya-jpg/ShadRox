import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_INJECTED_STDIN_LENGTH,
  describeInjectedBytes,
  formatInjectionOutcome,
  injectStdinWithApproval,
  isTerminalDockMounted,
  setTerminalDockMounted
} from './injectStdin';
import type { TerminalCommandRequest } from './echoChannel';
import { terminalStateManager } from './state';

const START_COMMAND = '\x1b]133;A\x07\x1b]633;E;npm create vite\x07\x1b]133;C\x07Overwrite? [y/N] ';

function seedExecutingSession(sessionId = 'inject-session', marker = START_COMMAND): void {
  terminalStateManager.clearAll();
  terminalStateManager.getOrCreateParser(sessionId, '/repo/app');
  terminalStateManager.setActiveSession(sessionId);
  terminalStateManager.feed(sessionId, marker);
  setTerminalDockMounted(true);
}

function published(): { events: TerminalCommandRequest[]; publish: (event: TerminalCommandRequest) => boolean } {
  const events: TerminalCommandRequest[] = [];
  return {
    events,
    publish: (event) => {
      events.push(event);
      return true;
    }
  };
}

test('injectStdinWithApproval types the approved answer through the run path', async () => {
  seedExecutingSession();
  const sink = published();
  const requests: Array<{ title: string; body?: string }> = [];

  const outcome = await injectStdinWithApproval('inject-session', 'y', {
    label: 'Shell 1',
    confirm: async (request) => {
      requests.push({ title: request.title, body: request.body });
      return true;
    },
    publish: sink.publish
  });

  assert.equal(outcome.ok, true);
  assert.equal(requests.length, 1);
  const body = String(requests[0].body);
  // The user must see which terminal and which bytes before they land.
  assert.match(body, /Shell 1/);
  assert.match(body, /inject-session/);
  assert.match(body, /\/repo\/app/);
  assert.match(body, /npm create vite/);
  assert.match(body, /y \+ Enter \(2 bytes\)/);
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0], {
    kind: 'command',
    command: 'y',
    source: 'user',
    run: true,
    sessionKey: 'inject-session'
  });
});

test('a cancelled approval injects nothing', async () => {
  seedExecutingSession();
  const sink = published();

  const outcome = await injectStdinWithApproval('inject-session', 'y', {
    confirm: async () => false,
    publish: sink.publish
  });

  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /Cancelled/);
  assert.equal(sink.events.length, 0);
});

test('an idle shell at a prompt is refused before the user is asked', async () => {
  seedExecutingSession();
  terminalStateManager.feed('inject-session', '\x1b]133;D;0\x07\x1b]133;A\x07');
  const sink = published();
  let asked = 0;

  const outcome = await injectStdinWithApproval('inject-session', 'y', {
    confirm: async () => {
      asked += 1;
      return true;
    },
    publish: sink.publish
  });

  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /sitting at a prompt/);
  assert.equal(asked, 0);
  assert.equal(sink.events.length, 0);
});

test('an unknown session is refused', async () => {
  seedExecutingSession('other-session');
  const outcome = await injectStdinWithApproval('no-such-session', 'y', {
    confirm: async () => true,
    publish: () => true
  });
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /No such terminal session/);
});

test('a closed dock is refused so no approved text can be queued for later', async () => {
  seedExecutingSession();
  setTerminalDockMounted(false);
  assert.equal(isTerminalDockMounted(), false);
  const sink = published();

  const outcome = await injectStdinWithApproval('inject-session', 'y', {
    confirm: async () => true,
    publish: sink.publish
  });

  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /dock is closed/);
  assert.equal(sink.events.length, 0);
  setTerminalDockMounted(true);
});

test('text that is not one printable line never reaches the approval dialog', async () => {
  seedExecutingSession();
  const sink = published();
  let asked = 0;
  const confirm = async () => {
    asked += 1;
    return true;
  };

  const multiline = await injectStdinWithApproval('inject-session', 'y\nrm -rf /', { confirm, publish: sink.publish });
  const escaped = await injectStdinWithApproval('inject-session', '\x1b[2J', { confirm, publish: sink.publish });
  const empty = await injectStdinWithApproval('inject-session', '   ', { confirm, publish: sink.publish });
  const huge = await injectStdinWithApproval('inject-session', 'y'.repeat(MAX_INJECTED_STDIN_LENGTH + 1), {
    confirm,
    publish: sink.publish
  });

  for (const outcome of [multiline, escaped, empty, huge]) assert.equal(outcome.ok, false);
  assert.equal(asked, 0);
  assert.equal(sink.events.length, 0);
});

test('an unroutable publish reports failure instead of pretending it typed', async () => {
  seedExecutingSession();
  const outcome = await injectStdinWithApproval('inject-session', 'y', {
    confirm: async () => true,
    publish: () => false
  });
  assert.equal(outcome.ok, false);
  assert.match((outcome as { reason: string }).reason, /did not accept/);
});

test('without a dialog host the native fallback declines, so nothing is typed', async () => {
  seedExecutingSession();
  const sink = published();
  const outcome = await injectStdinWithApproval('inject-session', 'y', { publish: sink.publish });
  assert.equal(outcome.ok, false);
  assert.equal(sink.events.length, 0);
});

test('describeInjectedBytes renders control bytes and counts the trailing Enter', () => {
  assert.equal(describeInjectedBytes('y'), 'y + Enter (2 bytes)');
  assert.equal(describeInjectedBytes('a\tb'), 'a<TAB>b + Enter (4 bytes)');
  assert.equal(describeInjectedBytes(''), 'Enter only (1 byte)');
});

test('formatInjectionOutcome never smuggles control bytes into the transcript', () => {
  const accepted = formatInjectionOutcome({ ok: true, sessionId: 's', text: 'y', byteLength: 2 });
  assert.match(accepted, /sent "y" \+ Enter/);
  assert.doesNotMatch(accepted.replace(/\x1b\[[0-9;]*m|\r\n/g, ''), /[\x00-\x08\x0b-\x1f\x7f]/);
  const refused = formatInjectionOutcome({ ok: false, reason: 'Cancelled: nothing was typed.' });
  assert.match(refused, /Cancelled: nothing was typed\./);
});

test('the injection gate reads the same state the UI and agent tool read', () => {
  seedExecutingSession();
  const summary = terminalStateManager.getSummary();
  assert.equal(summary.isExecuting, true);
  assert.equal(summary.activeCommand, 'npm create vite');
  assert.equal(summary.activeCwd, '/repo/app');
  assert.equal(terminalStateManager.getSessionIds().includes('inject-session'), true);
});
