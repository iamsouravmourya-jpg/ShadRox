/**
 * The repair brief.
 *
 * When a milestone fails its check, the next attempt is handed this text instead
 * of a paraphrase: the verifier's diagnostics verbatim, the command's real
 * output, and the patches the engine refused. The run-loop already decided the
 * milestone needs repair; this file only decides how to say it, and it says it
 * with the original messages so nothing is lost in translation.
 */

import type { TurnUnit, VerificationReport } from './types';

function diagnosticsBlock(report: VerificationReport): string {
  if (report.diagnostics.length === 0) return '(no type errors were reported)';
  return report.diagnostics
    .map((diagnostic) => `- ${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${diagnostic.severity}] ${diagnostic.message}`)
    .join('\n');
}

function commandBlock(report: VerificationReport): string | null {
  const command = report.command;
  if (!command) return null;
  if (command.declinedReason) {
    return `Proof command was NOT run: ${command.declinedReason}`;
  }
  const lines = [`Proof command: ${command.argv}`, `Exit code: ${command.exitCode ?? 'none'}${command.timedOut ? ' (timed out)' : ''}`];
  if (command.stdoutTail.trim()) lines.push('stdout (tail):', command.stdoutTail.trim());
  if (command.stderrTail.trim()) lines.push('stderr (tail):', command.stderrTail.trim());
  return lines.join('\n');
}

/**
 * `attemptIndex` is the number of attempts already spent on this unit (1-based
 * when describing the upcoming retry), matching the run-loop's own
 * `attempts.length`. Only the title, instruction and expected files are read, so
 * a milestone and a team task both produce the same brief.
 */
export function buildRepairBrief(
  milestone: TurnUnit,
  report: VerificationReport,
  patchFailures: string[],
  attemptIndex: number
): string {
  const sections: string[] = [
    `The previous attempt at "${milestone.title}" did not pass its check. This is repair attempt ${attemptIndex + 1}.`,
    '',
    'ORIGINAL INSTRUCTION:',
    milestone.instruction
  ];

  if (milestone.expectedFiles.length > 0) {
    sections.push('', 'FILES THIS MILESTONE MAY TOUCH:', milestone.expectedFiles.map((path) => `- ${path}`).join('\n'));
  }

  sections.push('', 'WHAT THE CHECK FOUND:', diagnosticsBlock(report));

  const command = commandBlock(report);
  if (command) sections.push('', command);

  if (patchFailures.length > 0) {
    sections.push('', 'PATCHES THE ENGINE REFUSED (fix the search block so it matches the file exactly):', patchFailures.map((line) => `- ${line}`).join('\n'));
  }

  if (report.notes.length > 0) {
    sections.push('', 'NOTES FROM THE CHECKER:', report.notes.map((note) => `- ${note}`).join('\n'));
  }

  sections.push(
    '',
    'Fix only what the check above reports. Reply with SEARCH/REPLACE blocks against the current file contents; do not restate the plan.'
  );

  return sections.join('\n');
}
