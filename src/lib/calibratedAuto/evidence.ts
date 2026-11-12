/**
 * What actually happened in a turn, as opposed to what the model claimed.
 *
 * The calibrated router is only as honest as the records it reads. Until now a
 * completed turn wrote `passed: true, verified: true` for itself, so every
 * model that answered without a transport error looked flawless and the ledger
 * could not tell a checked edit from a paragraph. This module decides both
 * fields from evidence the app already produced — patch results, the
 * verification card, post-apply diagnostics, and the exit codes of commands the
 * agent really ran — and refuses to promote an unchecked turn to `verified`.
 */

import type { CalibratedTaskType } from './types';

/** One recorded tool call, reduced to what an outcome can be judged from. */
export interface TurnToolCall {
  name: string;
  ok: boolean;
  label: string;
  output?: string;
  error?: string;
  /** The untruncated arguments, so a long command is not judged on its prefix. */
  input?: Record<string, unknown> | string;
  /** The guard stopped it; the command never ran, so it proves nothing. */
  refused?: boolean;
}

export interface TestRun {
  command: string;
  /**
   * The number the shell reported, or null when the output was clipped before
   * the `exit` line and only the tool's own verdict survived.
   */
  exitCode: number | null;
  /** What the run ended on, from whichever of the two was observable. */
  passed: boolean;
}

/** One row of the verification card the apply pass builds. */
export interface VerificationCheck {
  name: string;
  ok: boolean;
  details?: string;
}

/** The card itself: a pass means every row said yes. */
export interface VerificationCard {
  passed: boolean;
  checks: readonly VerificationCheck[];
}

/** Post-apply language-service result. `ran: false` means it never answered. */
export interface IntroducedDiagnostics {
  ran: boolean;
  introduced: number;
}

export interface TurnEvidence {
  /** The user's own words, used only when the evidence cannot name the task. */
  prompt: string;
  /** The mode's write permission, not an inference. */
  writesFiles: boolean;
  /** A patch grammar was extracted, so the model really tried to edit. */
  editAttempted: boolean;
  /** Files the patch engine landed AND saved for this turn. */
  filesWritten: number;
  /** Every patch-engine refusal, block or rollback message for this turn. */
  patchFailures: readonly string[];
  /** The verification card the apply built, or null when no apply happened. */
  verification: VerificationCard | null;
  /** Post-apply TypeScript diagnostics: how many errors this change introduced. */
  diagnostics: IntroducedDiagnostics | null;
  /** Test commands that ran, with the exit codes the shell reported. */
  testRuns: readonly TestRun[];
  /** The agent's own `finish.blocked` reason, when it stopped early. */
  blocked: string | null;
  /** Transport failure of the answer stream. */
  streamError: string | null;
  answerEmpty: boolean;
  /** Repair attempts the self-healing engine made during this turn. */
  repairIterations: number;
}

/**
 * What one apply pass reports back to the turn that asked for it, so the turn
 * can record what happened instead of asserting that it worked.
 */
export interface ApplyOutcome {
  /** The reply carried an edit grammar, whether or not any of it landed. */
  editAttempted: boolean;
  /** Files this pass landed and saved. */
  filesWritten: number;
  /** Every refusal, block or rollback message this pass produced. */
  patchFailures: string[];
  verification: VerificationCard | null;
  diagnostics: IntroducedDiagnostics | null;
}

export const NO_APPLY: ApplyOutcome = {
  editAttempted: false,
  filesWritten: 0,
  patchFailures: [],
  verification: null,
  diagnostics: null
};

export interface TurnOutcome {
  taskType: CalibratedTaskType;
  passed: boolean;
  verified: boolean;
  /** One line saying what decided it, stored with the record. */
  reason: string;
}

/**
 * Runners we accept as a test signal. Deliberately narrow: `npm run build` is
 * not a test, and counting a build as one would inflate both `test` volume and
 * the pass rate.
 */
const TEST_COMMAND = /(?:^|[\s&;|])(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?(?:test|t\b|vitest|jest|mocha|playwright test|cypress run)\b|\b(?:vitest|jest|pytest|phpunit|rspec|go\s+test|cargo\s+test|dotnet\s+test|gradle\s+(?:test\b|.*\btest\b)|mvn\s+test)\b|\bnode\s+(?:--test|test\.)\b/i;

const REFACTOR_INTENT = /\b(refactor|restructure|rename|extract (?:a |the )?(?:method|function|component|class)|clean[- ]?up|simplif|deduplicate|move .{0,30}\b(?:to|into)\b)\b/i;
const BUGFIX_INTENT = /\b(fix|bug|broken|crash|error|exception|regression|does ?n'?t work|not working|fails?|failing|reproduc)/i;

/** The command a `run_command` activity executed: arguments first, label as the fallback. */
function commandOf(call: TurnToolCall): string {
  const fromArgs = typeof call.input === 'object' && call.input !== null
    ? (call.input as Record<string, unknown>).command
    : undefined;
  if (typeof fromArgs === 'string' && fromArgs.trim()) return fromArgs.trim();
  const separator = call.label.indexOf('·');
  return (separator >= 0 ? call.label.slice(separator + 1) : call.label).trim();
}

/**
 * Test runs, read back out of the tool log.
 *
 * `run_command` prints its verdict as `exit <code>`, which is the only number
 * the app ever saw from the shell, so that is what this parses — and when the
 * transcript was clipped before that line, the call's own `ok` flag is still a
 * real verdict, so the run is kept with `exitCode: null` rather than dropped.
 * A refused call is skipped either way: nothing ran, so it proves nothing.
 */
export function testRunsFrom(calls: readonly TurnToolCall[]): TestRun[] {
  const runs: TestRun[] = [];
  for (const call of calls) {
    if (call.name !== 'run_command' || call.refused) continue;
    const command = commandOf(call);
    if (!TEST_COMMAND.test(command)) continue;
    const reported = /exit (-?\d+)/.exec(call.output ?? '')?.[1];
    const exitCode = reported === undefined ? null : Number(reported);
    runs.push({ command, exitCode, passed: exitCode === null ? call.ok : exitCode === 0 });
  }
  return runs;
}

/** The last word wins: an agent that fixes its own failure ends on a pass. */
export function lastTestRun(runs: readonly TestRun[]): TestRun | null {
  return runs.length > 0 ? runs[runs.length - 1] : null;
}

function classifyByIntent(prompt: string): CalibratedTaskType {
  if (REFACTOR_INTENT.test(prompt)) return 'refactor';
  if (BUGFIX_INTENT.test(prompt)) return 'bugfix';
  return 'feature';
}

/**
 * Evidence first, intent last.
 *
 * A test command that ran is a fact about the turn, so it outranks the wording
 * of the prompt; `bugfix` needs a repair attempt or a failing check behind it,
 * because otherwise every edit would be called a fix; and only when nothing was
 * written does the prompt decide between refactor/bugfix/feature.
 */
export function classifyTaskType(evidence: TurnEvidence): CalibratedTaskType {
  if (evidence.testRuns.length > 0) return 'test';
  if (!evidence.writesFiles || (evidence.filesWritten === 0 && !evidence.editAttempted)) return 'chat';
  if (evidence.repairIterations > 0 || evidence.patchFailures.length > 0) return 'bugfix';
  return classifyByIntent(evidence.prompt);
}

function decisiveChecks(evidence: TurnEvidence): number {
  const verificationChecks = evidence.verification?.checks.filter((check) => !/not run/i.test(check.details ?? '')).length ?? 0;
  return (
    verificationChecks +
    (evidence.diagnostics?.ran ? 1 : 0) +
    evidence.testRuns.length
  );
}

/**
 * `verified` means something outside the model looked at the result, and
 * `passed` means that look came back clean.
 *
 * Both are derived, never supplied. A chat answer with no check behind it is
 * `unverified` even when it streamed perfectly, because there is no receipt
 * that says it was right; the ranking treats those records as no data.
 */
export function outcomeOfTurn(evidence: TurnEvidence): TurnOutcome {
  const taskType = classifyTaskType(evidence);
  const lastTest = lastTestRun(evidence.testRuns);
  const checked = decisiveChecks(evidence);

  if (evidence.streamError) {
    return { taskType, passed: false, verified: checked > 0, reason: `the answer stream failed: ${evidence.streamError}` };
  }
  if (evidence.blocked) {
    return { taskType, passed: false, verified: checked > 0, reason: `the agent stopped early: ${evidence.blocked}` };
  }
  if (evidence.answerEmpty && evidence.filesWritten === 0) {
    return { taskType, passed: false, verified: checked > 0, reason: 'the turn produced no answer and no change' };
  }
  if (evidence.patchFailures.length > 0) {
    return {
      taskType,
      passed: false,
      verified: checked > 0,
      reason: `${evidence.patchFailures.length} patch(es) did not apply — ${evidence.patchFailures[0]}`
    };
  }
  if (evidence.editAttempted && evidence.filesWritten === 0) {
    return { taskType, passed: false, verified: checked > 0, reason: 'the reply asked for edits but no file changed' };
  }
  if (lastTest && !lastTest.passed) {
    return {
      taskType,
      passed: false,
      verified: true,
      reason: `${lastTest.command} ${lastTest.exitCode === null ? 'did not pass' : `exited ${lastTest.exitCode}`}`
    };
  }
  if (evidence.verification && !evidence.verification.passed) {
    const failed = evidence.verification.checks.filter((check) => !check.ok).map((check) => check.name);
    return { taskType, passed: false, verified: true, reason: `verification failed: ${failed.join(', ') || 'no check passed'}` };
  }
  if (evidence.diagnostics && evidence.diagnostics.ran && evidence.diagnostics.introduced > 0) {
    return {
      taskType,
      passed: false,
      verified: true,
      reason: `${evidence.diagnostics.introduced} new TypeScript error(s) after the change`
    };
  }
  if (evidence.filesWritten > 0) {
    return {
      taskType,
      passed: true,
      verified: true,
      reason: `${evidence.filesWritten} file(s) saved${lastTest ? ` and ${lastTest.command} passed` : ''}, ${checked} check(s) ran`
    };
  }
  // Nothing was checked and nothing was written: an answer, not a change.
  return { taskType: 'chat', passed: true, verified: false, reason: 'a written answer with nothing to check it against' };
}

/**
 * What the cheap file-selection pass did, on its own terms.
 *
 * The reader is ranked next to the writer, so it needs a record of its own
 * rather than borrowing the turn's. Its job has a result that is fully
 * observable without any model being consulted: the paths it names either exist
 * on the shortlist it was handed or they do not, and `applySelection` reads
 * them from disk. A pass that invented nothing is a failure; a pass whose call
 * never came back is not a judgement of the model at all.
 */
export interface ReaderEvidence {
  /** How many candidates the deterministic shortlist offered it. */
  shortlist: number;
  /** The call answered. False covers transport error, abort and timeout alike. */
  answered: boolean;
  /** Paths it named that are on that shortlist, so they could really be read. */
  picked: number;
}

export function outcomeOfReader(evidence: ReaderEvidence): TurnOutcome {
  if (!evidence.answered) {
    return {
      taskType: 'chat',
      passed: false,
      verified: false,
      reason: `the picker call never answered, so nothing it would have picked is known`
    };
  }
  if (evidence.picked > 0) {
    return {
      taskType: 'chat',
      passed: true,
      verified: true,
      reason: `${evidence.picked} of ${evidence.shortlist} candidate(s) it named were real paths and went into the context`
    };
  }
  return {
    taskType: 'chat',
    passed: false,
    verified: true,
    reason: `it named no real path among ${evidence.shortlist} candidate(s), so the deterministic shortlist was used instead`
  };
}
