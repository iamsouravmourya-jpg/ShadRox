import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellIntegrationParser } from './shellIntegration';
import {
  DEFAULT_HUNG_THRESHOLD_SECONDS,
  MAX_HUNG_THRESHOLD_SECONDS,
  MIN_HUNG_THRESHOLD_SECONDS,
  readHungThresholdSetting,
  terminalStateManager,
  writeHungThresholdSetting
} from './state';
import type { TerminalStateSummary } from './state';

test('ShellIntegrationParser parses prompt and command lifecycle markers cleanly', () => {
  const parser = new ShellIntegrationParser('session-1', '/workspace');

  // Prompt start
  const step1 = parser.feed('\x1b]133;A\x07$ ');
  assert.equal(step1.cleanText, '$ ');
  assert.equal(parser.getState().isPromptActive, true);
  assert.equal(parser.getState().isExecuting, false);

  // Command input
  const step2 = parser.feed('\x1b]133;B\x07\x1b]633;E;npm test\x07npm test\r\n');
  assert.equal(step2.cleanText, 'npm test\r\n');
  assert.equal(parser.getState().isPromptActive, false);
  assert.equal(parser.getState().currentCommand, 'npm test');

  // Execution started
  const step3 = parser.feed('\x1b]133;C\x07Running 42 tests...\r\nAll passed.\r\n');
  assert.equal(step3.cleanText, 'Running 42 tests...\r\nAll passed.\r\n');
  assert.equal(parser.getState().isExecuting, true);

  // Command finished with exit code 0
  const step4 = parser.feed('\x1b]133;D;0\x07');
  assert.equal(step4.cleanText, '');
  assert.equal(parser.getState().isExecuting, false);
  assert.equal(parser.getState().lastCommand?.command, 'npm test');
  assert.equal(parser.getState().lastCommand?.exitCode, 0);
  assert.match(parser.getState().lastCommand?.outputTail || '', /Running 42 tests/);
});

test('ShellIntegrationParser handles nonzero exit codes and CWD updates', () => {
  const parser = new ShellIntegrationParser('session-2', '/repo');

  // CWD change via OSC 133;P;Cwd=
  parser.feed('\x1b]133;P;Cwd=/repo/packages/core\x07');
  assert.equal(parser.getState().cwd, '/repo/packages/core');

  // CWD change via OSC 7
  parser.feed('\x1b]7;file://localhost/repo/packages/client\x07');
  assert.equal(parser.getState().cwd, '/repo/packages/client');

  // Failing command
  parser.feed('\x1b]633;E;pytest\x07\x1b]133;C\x07Failing test assertion\r\n\x1b]133;D;2\x07');
  assert.equal(parser.getState().lastCommand?.command, 'pytest');
  assert.equal(parser.getState().lastCommand?.exitCode, 2);
  assert.match(parser.getState().lastCommand?.outputTail || '', /Failing test assertion/);
});

test('ShellIntegrationParser correctly reassembles split escape sequence fragments across chunks', () => {
  const parser = new ShellIntegrationParser('session-split', '/root');

  // Chunk 1 ends in middle of OSC sequence
  const part1 = parser.feed('Some output \x1b]133;');
  assert.equal(part1.cleanText, 'Some output ');

  // Chunk 2 finishes the sequence
  const part2 = parser.feed('D;127\x07Next line\r\n');
  assert.equal(part2.cleanText, 'Next line\r\n');
  assert.equal(parser.getState().isExecuting, false);
});

test('ShellIntegrationParser detects hung command duration', () => {
  const parser = new ShellIntegrationParser('session-hung', '/app');

  parser.feed('\x1b]633;E;sleep 100\x07\x1b]133;C\x07');
  assert.equal(parser.getState().isExecuting, true);

  const fiveSecondsLater = Date.now() + 5000;
  assert.ok(parser.getHungSeconds(fiveSecondsLater) >= 5);
});

test('terminalStateManager tracks active session summary and drops closed sessions', () => {
  terminalStateManager.clearAll();

  terminalStateManager.getOrCreateParser('sess-a', '/home/user/project');
  terminalStateManager.setActiveSession('sess-a');

  terminalStateManager.feed('sess-a', '\x1b]133;A\x07\x1b]633;E;git status\x07\x1b]133;C\x07branch main\r\n\x1b]133;D;0\x07');

  const summary = terminalStateManager.getSummary();
  assert.equal(summary.activeSessionId, 'sess-a');
  assert.equal(summary.activeCwd, '/home/user/project');
  assert.equal(summary.lastExitCode, 0);

  terminalStateManager.dropSession('sess-a');
  assert.equal(terminalStateManager.getSummary().activeSessionId, null);
});

test('ShellIntegrationParser keeps Windows paths inside OSC 633 cwd markers', () => {
  const parser = new ShellIntegrationParser('session-win', '');
  parser.feed('\x1b]633;P;Cwd=C:\\Users\\sourav\\proj\x07\x1b]633;E;npm test\x07\x1b]133;D;1\x07');
  assert.equal(parser.getState().cwd, 'C:\\Users\\sourav\\proj');
  assert.equal(parser.getState().lastCommand?.command, 'npm test');
  assert.equal(parser.getState().lastCommand?.exitCode, 1);
});

// ── hung detection ────────────────────────────────────────────────────────────

function seedRunningSession(command = 'npm run build'): void {
  terminalStateManager.clearAll();
  terminalStateManager.setHungThresholdSeconds(DEFAULT_HUNG_THRESHOLD_SECONDS);
  terminalStateManager.getOrCreateParser('hung-session', '/repo');
  terminalStateManager.setActiveSession('hung-session');
  terminalStateManager.feed('hung-session', `\x1b]133;A\x07\x1b]633;E;${command}\x07\x1b]133;C\x07building…\r\n`);
}

test('hung threshold defaults to 20s and is configurable and clamped', () => {
  assert.equal(terminalStateManager.getHungThresholdSeconds(), DEFAULT_HUNG_THRESHOLD_SECONDS);
  assert.equal(terminalStateManager.setHungThresholdSeconds(45), 45);
  assert.equal(terminalStateManager.getHungThresholdSeconds(), 45);
  assert.equal(terminalStateManager.setHungThresholdSeconds(1), MIN_HUNG_THRESHOLD_SECONDS);
  assert.equal(terminalStateManager.setHungThresholdSeconds(99999), MAX_HUNG_THRESHOLD_SECONDS);
  assert.equal(terminalStateManager.setHungThresholdSeconds(Number.NaN), DEFAULT_HUNG_THRESHOLD_SECONDS);
  terminalStateManager.setHungThresholdSeconds(DEFAULT_HUNG_THRESHOLD_SECONDS);
});

test('summary reports hung state and the countdown to it', () => {
  seedRunningSession();
  const quiet = Date.now() + 8_000;
  const soon = terminalStateManager.getSummary(quiet);
  assert.equal(soon.isExecuting, true);
  assert.equal(soon.isHung, false, '8s of silence must not be hung at the 20s default');
  assert.equal(soon.secondsToHung, 12);
  assert.equal(soon.hungThresholdSeconds, DEFAULT_HUNG_THRESHOLD_SECONDS);
  assert.equal(soon.awaitingInput, false, '8s of silence is still a busy build, not a prompt');

  const promptLike = terminalStateManager.getSummary(Date.now() + 12_000);
  assert.equal(promptLike.isHung, false);
  assert.equal(promptLike.awaitingInput, true, '12s of silence may be an interactive prompt');

  const late = terminalStateManager.getSummary(Date.now() + 25_000);
  assert.equal(late.isHung, true);
  assert.ok(late.hungSeconds >= 25);
  assert.equal(late.secondsToHung, 0);
  assert.equal(late.awaitingInput, false, 'a hung command is not merely awaiting input');
});

test('a lower configured threshold trips the same silence', () => {
  seedRunningSession();
  terminalStateManager.setHungThresholdSeconds(5);
  const summary = terminalStateManager.getSummary(Date.now() + 6_000);
  assert.equal(summary.isHung, true);
  assert.equal(summary.hungThresholdSeconds, 5);
  terminalStateManager.setHungThresholdSeconds(DEFAULT_HUNG_THRESHOLD_SECONDS);
});

test('one hung notice per command, re-armed by the next command', () => {
  seedRunningSession();
  const late = Date.now() + 30_000;
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', late), true);
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', late), false);
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', late), false);

  // The same command keeps printing: still one notice for that run.
  terminalStateManager.feed('hung-session', 'still working\r\n');
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', Date.now() + 30_000), false);

  // A new command execution gets its own notice.
  terminalStateManager.feed('hung-session', '\x1b]133;D;0\x07\x1b]133;A\x07\x1b]633;E;npm test\x07\x1b]133;C\x07');
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', Date.now() + 30_000), true);
});

test('the hung flag clears when output resumes or the command exits', () => {
  seedRunningSession();
  assert.equal(terminalStateManager.getSummary(Date.now() + 30_000).isHung, true);

  terminalStateManager.feed('hung-session', 'chunk after the silence\r\n');
  const afterOutput = terminalStateManager.getSummary();
  assert.equal(afterOutput.isHung, false);
  assert.equal(afterOutput.hungSeconds, 0);

  terminalStateManager.feed('hung-session', '\x1b]133;D;0\x07');
  const afterExit = terminalStateManager.getSummary(Date.now() + 60_000);
  assert.equal(afterExit.isHung, false, 'an exited command is never hung');
  assert.equal(afterExit.hungSeconds, 0);
});

test('hung fields are inert with no session', () => {
  terminalStateManager.clearAll();
  const summary: TerminalStateSummary = terminalStateManager.getSummary();
  assert.equal(summary.activeSessionId, null);
  assert.equal(summary.isHung, false);
  assert.equal(summary.awaitingInput, false);
  assert.equal(summary.hungSeconds, 0);
  assert.equal(summary.lastFailure, null);
  assert.equal(summary.hungThresholdSeconds, terminalStateManager.getHungThresholdSeconds());
});

test('hung threshold persists through the storage helpers', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  };
  assert.equal(readHungThresholdSetting(storage), DEFAULT_HUNG_THRESHOLD_SECONDS);
  writeHungThresholdSetting(storage, 30);
  assert.equal(readHungThresholdSetting(storage), 30);
  assert.equal(store.get('shadrox.terminal.hungSeconds'), '30');
  store.set('shadrox.terminal.hungSeconds', 'garbage');
  assert.equal(readHungThresholdSetting(storage), DEFAULT_HUNG_THRESHOLD_SECONDS);
  store.set('shadrox.terminal.hungSeconds', '0');
  assert.equal(readHungThresholdSetting(storage), DEFAULT_HUNG_THRESHOLD_SECONDS);
  assert.equal(readHungThresholdSetting(null), DEFAULT_HUNG_THRESHOLD_SECONDS);
  writeHungThresholdSetting(storage, 5000);
  assert.equal(readHungThresholdSetting(storage), MAX_HUNG_THRESHOLD_SECONDS);
});

// ── failure classification in the summary the agent reads ─────────────────────

test('summary classifies the failing command that just exited', () => {
  terminalStateManager.clearAll();
  terminalStateManager.getOrCreateParser('fail-session', '/repo');
  terminalStateManager.setActiveSession('fail-session');
  terminalStateManager.feed(
    'fail-session',
    "\x1b]633;E;node server.js\x07\x1b]133;C\x07Error: Cannot find module 'express'\r\n\x1b]133;D;1\x07"
  );

  const failure = terminalStateManager.getSummary().lastFailure;
  assert.ok(failure);
  assert.equal(failure.class, 'missing-dependency');
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.command, 'node server.js');
  assert.match(failure.detail, /Cannot find module 'express'/);
  assert.ok(failure.repairHints.length > 0);
});

test('a clean exit has no failure to classify', () => {
  terminalStateManager.clearAll();
  terminalStateManager.getOrCreateParser('ok-session', '/repo');
  terminalStateManager.setActiveSession('ok-session');
  terminalStateManager.feed('ok-session', '\x1b]633;E;npm test\x07\x1b]133;C\x07all good\r\n\x1b]133;D;0\x07');

  const summary = terminalStateManager.getSummary();
  assert.equal(summary.lastExitCode, 0);
  assert.equal(summary.lastFailure, null);
});

test('dropSession clears the hung bookkeeping', () => {
  seedRunningSession();
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', Date.now() + 30_000), true);
  terminalStateManager.feed('hung-session', '\x1b]133;D;0\x07\x1b]133;A\x07\x1b]633;E;npm test\x07\x1b]133;C\x07');
  terminalStateManager.dropSession('hung-session');
  assert.equal(terminalStateManager.hasSession('hung-session'), false);
  assert.equal(terminalStateManager.consumeHungNotice('hung-session', Date.now() + 30_000), false);
});

test('getSummaryFor reads a named tab, not the one the manager last activated', () => {
  terminalStateManager.clearAll();
  terminalStateManager.getOrCreateParser('tab-left', '/repo/left');
  terminalStateManager.getOrCreateParser('tab-right', '/repo/right');
  terminalStateManager.setActiveSession('tab-left');
  terminalStateManager.feed('tab-right', '\x1b]633;E;make deploy\x07\x1b]133;C\x07uploading…\r\n');

  const right = terminalStateManager.getSummaryFor('tab-right', Date.now() + 21_000);
  assert.equal(right.activeSessionId, 'tab-right');
  assert.equal(right.activeCommand, 'make deploy');
  assert.equal(right.isHung, true);

  // A tab the panel has not registered yet reports inert numbers, never a crash.
  const ghost = terminalStateManager.getSummaryFor('tab-ghost');
  assert.equal(ghost.isExecuting, false);
  assert.equal(ghost.isHung, false);
  assert.equal(terminalStateManager.getSummaryFor(null).activeSessionId, null);
});
