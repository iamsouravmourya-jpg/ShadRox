import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellIntegrationParser } from './shellIntegration';
import { terminalStateManager } from './state';

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
