/**
 * Turning run events into one readable line for the panel's log.
 *
 * Kept separate from the hook so it can be read (and tested) as a pure function:
 * the log is the only part of a run the user ever sees after the fact, so what
 * it says is worth pinning down.
 */

import type { AutonomyEvent, VerificationReport } from './types';

/** The log keeps the tail; a long run must not grow the panel without bound. */
export const MAX_LOG_LINES = 200;

const MAX_REASON_LENGTH = 160;

/**
 * The shortest honest explanation a verdict can carry: the first error
 * diagnostic when there is one, else the first note. Without it a failed
 * milestone logs a bare "failed." and the user (and the next repair turn)
 * cannot tell a type error from a missing proof command.
 */
function verdictReason(report: VerificationReport): string | null {
  const error = report.diagnostics.find((line) => line.severity === 'error');
  const raw = error
    ? `${error.path}:${error.line} ${error.message}`
    : report.notes.find((note) => note.trim().length > 0) ?? null;
  if (!raw) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

/** One line per event, or null for an event this build does not describe. */
export function describeEvent(event: AutonomyEvent): string | null {
  switch (event.type) {
    case 'plan:created':
      return `Planned ${event.milestones.length} milestone(s).`;
    case 'milestone:start':
      return `Starting "${event.id}".`;
    case 'milestone:attempt':
      return `"${event.id}": attempt ${event.attempt}.`;
    case 'milestone:verdict': {
      const attempt = typeof event.attempt === 'number' ? ` (attempt ${event.attempt})` : '';
      const reason = verdictReason(event.report);
      return `"${event.id}": ${event.verdict}${attempt}${reason ? ` — ${reason}` : ''}.`;
    }
    case 'milestone:done':
      return `"${event.id}": ${event.status}.`;
    case 'milestone:review':
      return `"${event.id}": ${event.paths.length} file(s) await review.`;
    case 'log':
      return event.text;
    case 'run:done':
      return `Run finished: ${event.status}.`;
    default:
      return null;
  }
}
