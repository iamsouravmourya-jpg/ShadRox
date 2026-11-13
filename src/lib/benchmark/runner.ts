/**
 * Grading a benchmark case through the real apply rail.
 *
 * The runner applies a reply with `pipelineHarness` — the same plan / verify /
 * stage / commit sequence the renderer runs — then decides the result from
 * declared evidence only: the file patterns the case asserts and the exit codes
 * of the commands it names. Nothing is asked of a model, so the same case run
 * twice on the same machine scores the same, and the score is written in the
 * same `VerificationCard` / `TestRun` / `TurnOutcome` vocabulary the outcome
 * ledger keeps, which is what lets a benchmark result be compared with a real
 * turn instead of needing its own private format.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { outcomeOfTurn, type TestRun, type VerificationCard, type VerificationCheck } from '../calibratedAuto/evidence';
import { withPipeline } from './pipelineHarness';
import type { CaseDefinition, LoadedCase } from './case';

const execFileAsync = promisify(execFile);

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** A transcript longer than this is truncated for the report, never for judging. */
const OUTPUT_PREVIEW_CHARS = 600;

export interface CaseRun {
  id: string;
  kind: CaseDefinition['kind'];
  title: string;
  /** Every declared file pattern plus the applied-files row, in case order. */
  checks: VerificationCheck[];
  testRuns: TestRun[];
  verification: VerificationCard;
  /** What the rail did with the reply, kept so a failure is explainable. */
  applied: { written: number; failures: string[] };
  /** The ledger-shaped verdict for exactly this run. */
  outcome: ReturnType<typeof outcomeOfTurn>;
  passed: boolean;
  durationMs: number;
}

async function runCommand(root: string, argv: string[], name: string, timeoutMs: number): Promise<TestRun & { output: string }> {
  const command = argv.join(' ');
  try {
    const result = await execFileAsync(argv[0], argv.slice(1), { cwd: root, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { command, exitCode: 0, passed: true, output: preview(`${result.stdout ?? ''}${result.stderr ?? ''}`) };
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string; message?: string };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    const transcript = `${failure.stdout ?? ''}${failure.stderr ?? ''}${exitCode === null ? failure.message ?? '' : ''}`;
    return {
      command,
      exitCode,
      passed: false,
      output: `${failure.killed ? `${name}: timed out after ${timeoutMs}ms\n` : ''}${preview(transcript)}`
    };
  }
}

function preview(text: string): string {
  const clean = (text || '').trim();
  return clean.length <= OUTPUT_PREVIEW_CHARS ? clean : `${clean.slice(0, OUTPUT_PREVIEW_CHARS)}…`;
}

async function fileChecks(root: string, definition: CaseDefinition, written: number | null): Promise<VerificationCheck[]> {
  // `null` is the baseline run: nothing was applied, so whether a patch landed
  // is not one of its claims. Keeping the row would make every baseline fail
  // and hide the cases that assert nothing.
  const rows: VerificationCheck[] = written === null ? [] : [{
    name: 'Patch landed',
    ok: written > 0,
    details: written > 0 ? `${written} file(s) written to disk` : 'nothing reached the disk'
  }];
  for (const check of definition.checks) {
    const target = path.join(root, ...check.file.replace(/\\/g, '/').split('/'));
    let content: string | null = null;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch {
      content = null;
    }
    if (content === null) {
      rows.push({ name: check.name, ok: false, details: `${check.file} does not exist` });
      continue;
    }
    let matched = false;
    try {
      matched = new RegExp(check.match as string).test(content);
    } catch (error) {
      rows.push({ name: check.name, ok: false, details: `pattern error: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const ok = check.absent ? !matched : matched;
    rows.push({
      name: check.name,
      ok,
      details: `${check.file} ${check.absent ? 'must not' : 'must'} match /${check.match}/ — ${ok ? 'ok' : 'not satisfied'}`
    });
  }
  return rows;
}

interface GradeOptions {
  /** Grade something other than the case's golden reply. */
  reply?: string;
  prompt?: string;
}

/**
 * Apply the reply, then run every assertion against the resulting folder.
 *
 * `gradeCase` is also how the suite proves a case is worth having: the same
 * checks are run against the untouched fixture, and a case whose checks pass
 * before the patch asserts nothing.
 */
export async function gradeCase(loaded: LoadedCase, options: GradeOptions & { applyReply?: boolean } = {}): Promise<CaseRun> {
  const startedAt = Date.now();
  const definition = loaded.definition;
  const apply = options.applyReply !== false;
  const reply = options.reply ?? loaded.reply;

  return withPipeline(loaded.fixture, async (pipeline, root) => {
    const failures: string[] = [];
    let written = 0;
    if (apply) {
      const turn = await pipeline.applyReply(reply, { allowDestructive: definition.allowDestructive === true });
      if (turn.blocked === 'plan') {
        failures.push(...(turn.failures ?? []).map((failure) => `${failure.path}: ${failure.reason}`));
      } else if (turn.blocked === 'verify') {
        failures.push(...(turn.issues ?? []).map((issue: any) => String(issue?.message ?? issue?.path ?? issue)));
      } else {
        written = turn.outcome?.written ?? 0;
        if (turn.outcome?.failed) failures.push(turn.outcome.message ?? 'the save failed');
      }
    }

    const checks = await fileChecks(root, definition, apply ? written : null);
    const testRuns: TestRun[] = [];
    for (const command of definition.commands) {
      const run = await runCommand(root, command.argv, command.name, command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      testRuns.push({ command: run.command, exitCode: run.exitCode, passed: run.passed });
      // The row carries the transcript so a failing case is explainable from the
      // scorecard alone; `testRuns` stays in the ledger's own shape.
      checks.push({
        name: command.name,
        ok: run.passed,
        details: run.passed ? run.output : `exit ${run.exitCode ?? 'unknown'}\n${run.output}`
      });
    }

    const verification: VerificationCard = { passed: checks.every((row) => row.ok), checks };
    const outcome = outcomeOfTurn({
      prompt: options.prompt ?? loaded.prompt,
      writesFiles: apply,
      editAttempted: apply && reply.includes('```'),
      filesWritten: written,
      patchFailures: failures,
      verification,
      diagnostics: null,
      testRuns,
      blocked: null,
      streamError: null,
      answerEmpty: !apply,
      repairIterations: 0
    });

    return {
      id: definition.id,
      kind: definition.kind,
      title: definition.title,
      checks,
      testRuns,
      verification,
      applied: { written, failures },
      outcome,
      passed: failures.length === 0 && verification.passed,
      durationMs: Date.now() - startedAt
    };
  });
}

/** The same assertions against the untouched fixture: they must not already pass. */
export async function gradeBaseline(loaded: LoadedCase): Promise<CaseRun> {
  return gradeCase(loaded, { applyReply: false });
}
