/**
 * `npm run benchmark` — the scorecard.
 *
 * Run with no arguments to grade every case against its own golden reply; pass
 * `--case <id> --reply <file>` to grade a reply an agent really produced. The
 * baseline column is the point of the whole template: it is the same assertion
 * list run against the untouched fixture, and a case that passes there proves
 * nothing about the change it claims to measure.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAllCases, listCaseDirs, loadCase, type LoadedCase } from './case';
import { gradeBaseline, gradeCase, type CaseRun } from './runner';

export const CASES_ROOT = path.resolve(import.meta.dirname, '../../../benchmark/cases');

export interface BenchmarkReport {
  runs: CaseRun[];
  baselines: Array<{ id: string; passed: boolean }>;
  passed: number;
  total: number;
}

function parseArgs(argv: string[]): { caseId: string | null; replyFile: string | null; json: boolean } {
  const options = { caseId: null as string | null, replyFile: null as string | null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--case') options.caseId = argv[++index] ?? '';
    else if (arg === '--reply') options.replyFile = argv[++index] ?? '';
    else if (arg === '--json') options.json = true;
  }
  return options;
}

async function collectCases(casesRoot: string, caseId: string | null): Promise<LoadedCase[]> {
  if (!caseId) return loadAllCases(casesRoot);
  const dirs = await listCaseDirs(casesRoot);
  const match = dirs.filter((dir) => path.basename(dir) === caseId);
  if (match.length === 0) {
    throw new Error(`benchmark: no case named "${caseId}" under ${casesRoot}`);
  }
  return Promise.all(match.map(loadCase));
}

function line(run: CaseRun): string {
  const marks = [
    ...run.checks.map((check) => (check.ok ? '·' : 'x')),
    ...run.testRuns.map((test) => (test.passed ? '·' : 'x'))
  ].join('');
  const failures = [
    ...run.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.details ?? 'failed'}`),
    ...run.testRuns.filter((test) => !test.passed).map((test) => `${test.command}: exit ${test.exitCode ?? 'unknown'}`),
    ...run.applied.failures.map((failure) => `apply: ${failure}`)
  ];
  return [
    `${run.passed ? 'PASS' : 'FAIL'}  ${run.kind.padEnd(8)} ${run.id.padEnd(28)} ${marks}  ${run.outcome.reason}`,
    ...failures.map((failure) => `      ${failure}`)
  ].join('\n');
}

export async function runBenchmark(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const cases = await collectCases(CASES_ROOT, options.caseId);
  if (cases.length === 0) {
    console.error(`benchmark: no cases found under ${CASES_ROOT}`);
    return 1;
  }
  const reply = options.replyFile
    ? await fs.readFile(path.resolve(options.replyFile), 'utf8')
    : undefined;

  const runs: CaseRun[] = [];
  const baselines: Array<{ id: string; passed: boolean }> = [];
  for (const loaded of cases) {
    // A golden reply must fail on its own fixture or the case measures nothing.
    const baseline = await gradeBaseline(loaded);
    baselines.push({ id: loaded.definition.id, passed: baseline.passed });
    runs.push(await gradeCase(loaded, reply && options.caseId === loaded.definition.id ? { reply } : {}));
  }

  const passed = runs.filter((run) => run.passed).length;
  const hollow = baselines.filter((entry) => entry.passed).map((entry) => entry.id);

  if (options.json) {
    console.log(JSON.stringify({ passed, total: runs.length, hollowCases: hollow, runs, baselines }, null, 2));
  } else {
    for (const run of runs) console.log(line(run));
    console.log(`\nbenchmark: ${passed}/${runs.length} case(s) passed${hollow.length ? `; ${hollow.length} assert nothing: ${hollow.join(', ')}` : ''}`);
  }
  // A case that passes before the patch is a broken case, so it fails the run.
  return passed === runs.length && hollow.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  runBenchmark().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    }
  );
}
