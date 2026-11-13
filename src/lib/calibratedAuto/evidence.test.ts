import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyTaskType,
  lastTestRun,
  outcomeOfReader,
  outcomeOfTurn,
  testRunsFrom,
  type TurnEvidence,
  type TurnToolCall
} from './evidence';

function evidence(overrides: Partial<TurnEvidence> = {}): TurnEvidence {
  return {
    prompt: 'add a save button to the editor',
    writesFiles: true,
    editAttempted: false,
    filesWritten: 0,
    patchFailures: [],
    verification: null,
    diagnostics: null,
    testRuns: [],
    blocked: null,
    streamError: null,
    answerEmpty: false,
    repairIterations: 0,
    ...overrides
  };
}

function call(overrides: Partial<TurnToolCall> = {}): TurnToolCall {
  return {
    name: 'run_command',
    ok: true,
    label: 'run_command · npm test',
    output: '$ npm test\nexit 0',
    ...overrides
  };
}

const CARD = {
  passed: true,
  checks: [{ name: 'Disk persistence', ok: true, details: '2 file(s) confirmed saved' }]
};

describe('testRunsFrom', () => {
  it('reads the exit code the shell printed', () => {
    const runs = testRunsFrom([call()]);
    assert.deepEqual(runs, [{ command: 'npm test', exitCode: 0, passed: true }]);
  });

  it('recognises the real runners and nothing else', () => {
    const accepted = ['npm test', 'pnpm vitest run', 'npx jest src/a.test.ts', 'go test ./...', 'node --test', 'pytest -q'];
    for (const command of accepted) {
      assert.equal(testRunsFrom([call({ label: `run_command · ${command}`, output: `$ ${command}\nexit 0` })]).length, 1, `${command} is a test run`);
    }
    const rejected = ['npm run build', 'git commit -m "fix failing test"', 'ls src', 'npm install'];
    for (const command of rejected) {
      assert.equal(testRunsFrom([call({ label: `run_command · ${command}`, output: `$ ${command}\nexit 0` })]).length, 0, `${command} is not a test run`);
    }
  });

  it('skips a call the permission guard refused, because nothing ran', () => {
    assert.deepEqual(testRunsFrom([call({ refused: true, ok: false, output: 'Command not run: denied' })]), []);
  });

  it('keeps a run whose transcript was clipped before the exit line, judged on the tool verdict', () => {
    const runs = testRunsFrom([call({ ok: false, output: '$ npm test\n…[truncated]' })]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].exitCode, null);
    assert.equal(runs[0].passed, false);
  });

  it('reads the command from the call arguments when the label was truncated', () => {
    const runs = testRunsFrom([call({ label: 'run_command · npm test -t "src/lib/very/deep/na', input: { command: 'npm test' } })]);
    assert.equal(runs[0].command, 'npm test');
  });

  it('ignores tools that are not commands', () => {
    assert.deepEqual(testRunsFrom([call({ name: 'read_file', label: 'read_file · src/a.ts' })]), []);
  });
});

describe('lastTestRun', () => {
  it('gives the agent the last word when it re-runs after fixing', () => {
    const runs = testRunsFrom([
      call({ ok: false, output: '$ npm test\nexit 1' }),
      call({ output: '$ npm test\nexit 0' })
    ]);
    assert.equal(lastTestRun(runs)?.exitCode, 0);
    assert.equal(lastTestRun([]), null);
  });
});

describe('classifyTaskType', () => {
  it('calls a turn that ran the suite a test task, whatever it was asked', () => {
    assert.equal(classifyTaskType(evidence({ testRuns: [{ command: 'npm test', exitCode: 0, passed: true }] })), 'test');
  });

  it('calls a read-only answer chat even when the prompt asked for an edit', () => {
    assert.equal(classifyTaskType(evidence({ writesFiles: false })), 'chat');
    assert.equal(classifyTaskType(evidence({ editAttempted: false, filesWritten: 0 })), 'chat');
  });

  it('calls a turn that needed a repair bugfix', () => {
    assert.equal(classifyTaskType(evidence({ editAttempted: true, filesWritten: 2, repairIterations: 1 })), 'bugfix');
    assert.equal(classifyTaskType(evidence({ editAttempted: true, patchFailures: ['src/a.ts: no match'] })), 'bugfix');
  });

  it('uses the wording of the prompt only when the evidence cannot say', () => {
    assert.equal(classifyTaskType(evidence({ editAttempted: true, filesWritten: 1, prompt: 'refactor the auth module' })), 'refactor');
    assert.equal(classifyTaskType(evidence({ editAttempted: true, filesWritten: 1, prompt: 'the preview crashes on reload' })), 'bugfix');
    assert.equal(classifyTaskType(evidence({ editAttempted: true, filesWritten: 1, prompt: 'add a save button' })), 'feature');
  });
});

describe('outcomeOfTurn', () => {
  it('fails a turn whose stream died, and says which error', () => {
    const outcome = outcomeOfTurn(evidence({ streamError: '429 rate limited', verification: CARD }));
    assert.equal(outcome.passed, false);
    assert.equal(outcome.verified, true);
    assert.match(outcome.reason, /answer stream failed: 429 rate limited/);
  });

  it('does not call a stream failure verified when nothing had been checked', () => {
    const outcome = outcomeOfTurn(evidence({ streamError: 'socket hung up' }));
    assert.equal(outcome.verified, false);
  });

  it('fails an agent that stopped early', () => {
    const outcome = outcomeOfTurn(evidence({ blocked: 'the budget ran out after 3 rounds' }));
    assert.equal(outcome.passed, false);
    assert.match(outcome.reason, /stopped early/);
  });

  it('fails the reply that asked for edits but changed no file', () => {
    const outcome = outcomeOfTurn(evidence({ editAttempted: true, filesWritten: 0 }));
    assert.equal(outcome.passed, false);
    assert.equal(outcome.verified, false);
    assert.match(outcome.reason, /asked for edits but no file changed/);
  });

  it('records a patch refusal as a failure, and keeps the first reason', () => {
    const outcome = outcomeOfTurn(evidence({ editAttempted: true, patchFailures: ['src/a.ts: ORIGINAL not found', 'src/b.ts: path escapes'] }));
    assert.equal(outcome.passed, false);
    assert.match(outcome.reason, /2 patch\(es\) did not apply — src\/a\.ts: ORIGINAL not found/);
  });

  it('lets a failing suite override a clean verification card', () => {
    const outcome = outcomeOfTurn(evidence({
      filesWritten: 1,
      editAttempted: true,
      verification: CARD,
      testRuns: [{ command: 'npm test', exitCode: 1, passed: false }]
    }));
    assert.equal(outcome.passed, false);
    assert.equal(outcome.verified, true);
    assert.match(outcome.reason, /npm test exited 1/);
  });

  it('names the checks that failed', () => {
    const outcome = outcomeOfTurn(evidence({
      filesWritten: 1,
      editAttempted: true,
      verification: { passed: false, checks: [{ name: 'Disk persistence', ok: false }, { name: 'Static syntax validation', ok: true }] }
    }));
    assert.equal(outcome.passed, false);
    assert.match(outcome.reason, /verification failed: Disk persistence/);
  });

  it('counts new type errors introduced by the change as a failure', () => {
    const outcome = outcomeOfTurn(evidence({ filesWritten: 1, editAttempted: true, verification: CARD, diagnostics: { ran: true, introduced: 3 } }));
    assert.equal(outcome.passed, false);
    assert.match(outcome.reason, /3 new TypeScript error\(s\)/);
  });

  it('does not blame the model for a language service that never answered', () => {
    const outcome = outcomeOfTurn(evidence({ filesWritten: 1, editAttempted: true, verification: CARD, diagnostics: { ran: false, introduced: 0 } }));
    assert.equal(outcome.passed, true);
  });

  it('passes a saved change whose checks all said yes', () => {
    const outcome = outcomeOfTurn(evidence({
      filesWritten: 2,
      editAttempted: true,
      verification: CARD,
      diagnostics: { ran: true, introduced: 0 },
      testRuns: [{ command: 'npm test', exitCode: 0, passed: true }]
    }));
    assert.equal(outcome.passed, true);
    assert.equal(outcome.verified, true);
    assert.match(outcome.reason, /2 file\(s\) saved and npm test passed, 3 check\(s\) ran/);
  });

  it('leaves an unchecked answer out of the record: passed without verification', () => {
    const outcome = outcomeOfTurn(evidence({ writesFiles: false }));
    assert.equal(outcome.taskType, 'chat');
    assert.equal(outcome.passed, true);
    assert.equal(outcome.verified, false);
    assert.match(outcome.reason, /nothing to check it against/);
  });

  it('does not count a check that reported "Not run" as evidence', () => {
    const outcome = outcomeOfTurn(evidence({
      editAttempted: true,
      patchFailures: ['src/a.ts: no match'],
      verification: { passed: true, checks: [{ name: 'Static syntax validation', ok: true, details: 'Not run' }] },
      diagnostics: { ran: false, introduced: 0 }
    }));
    assert.equal(outcome.passed, false);
    assert.equal(outcome.verified, false);
  });

  it('fails an empty turn that changed nothing', () => {
    const outcome = outcomeOfTurn(evidence({ answerEmpty: true }));
    assert.equal(outcome.passed, false);
    assert.match(outcome.reason, /no answer and no change/);
  });
});

/**
 * The cheap file-selection pass is ranked in the same table as the writer, so
 * it is judged on the paths it returned, not on the turn those paths served.
 */
describe('outcomeOfReader', () => {
  it('counts real paths that reached the context as a verified pass', () => {
    const outcome = outcomeOfReader({ shortlist: 40, answered: true, picked: 6 });
    assert.equal(outcome.taskType, 'chat');
    assert.equal(outcome.passed, true);
    assert.equal(outcome.verified, true);
    assert.match(outcome.reason, /6 of 40 candidate\(s\) it named were real paths/);
  });

  it('calls an answer with no real path behind it a verified failure', () => {
    const outcome = outcomeOfReader({ shortlist: 40, answered: true, picked: 0 });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.verified, true);
    assert.match(outcome.reason, /named no real path among 40 candidate\(s\)/);
    assert.match(outcome.reason, /deterministic shortlist was used instead/);
  });

  it('records no verdict at all when the call never came back', () => {
    const outcome = outcomeOfReader({ shortlist: 40, answered: false, picked: 0 });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.verified, false, 'an aborted or failed picker call says nothing about the model');
    assert.match(outcome.reason, /never answered/);
  });
});
