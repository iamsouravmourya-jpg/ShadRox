/**
 * Turning run events into one readable line for the panel's log.
 *
 * Kept separate from the hook so it can be read (and tested) as a pure function:
 * the log is the only part of a run the user ever sees after the fact, so what
 * it says is worth pinning down.
 */

import type { AutonomyEvent } from './types';

/** The log keeps the tail; a long run must not grow the panel without bound. */
export const MAX_LOG_LINES = 200;

/** One line per event, or null for the ones that only move the credit meter. */
export function describeEvent(event: AutonomyEvent): string | null {
  switch (event.type) {
    case 'plan:created':
      return `Planned ${event.milestones.length} milestone(s).`;
    case 'milestone:start':
      return `Starting "${event.id}".`;
    case 'milestone:attempt':
      return `"${event.id}": attempt ${event.attempt}.`;
    case 'milestone:verdict':
      return `"${event.id}": ${event.verdict}.`;
    case 'milestone:done':
      return `"${event.id}": ${event.status}.`;
    case 'milestone:review':
      return `"${event.id}": ${event.paths.length} file(s) await review.`;
    case 'credit':
      return `Spent ${event.spent} credits (run total ${event.total}).`;
    case 'log':
      return event.text;
    case 'run:done':
      return `Run finished: ${event.status}.`;
    default:
      return null;
  }
}
