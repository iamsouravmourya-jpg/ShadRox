/**
 * Turning team events into one readable line for the panel's log.
 *
 * Same shape as `autonomy/events.ts` and for the same reason: the log is the one
 * part of a run a user reads after the fact, so the mapping is a pure function
 * that is worth pinning down on its own.
 */

import type { TeamEvent } from './types';

/** One line per event, or null for the ones that only move the credit meter. */
export function describeTeamEvent(event: TeamEvent): string | null {
  switch (event.type) {
    case 'team:planned':
      return `Coordinator planned ${event.tasks.length} task(s).`;
    case 'task:start':
      return `${event.assignee} started "${event.id}".`;
    case 'task:attempt':
      return `"${event.id}": attempt ${event.attempt}.`;
    case 'task:verdict':
      return `"${event.id}": ${event.verdict}.`;
    case 'task:done':
      return `"${event.id}": ${event.status}.`;
    case 'task:review':
      return `"${event.id}": ${event.paths.length} file(s) await review.`;
    case 'message':
      return `${event.message.from} → ${event.message.to}: ${event.message.text}`;
    case 'credit':
      return `Spent ${event.spent} credits (team total ${event.total}).`;
    case 'team:log':
      return event.text;
    case 'team:done':
      return `Team finished: ${event.status}.`;
    default:
      return null;
  }
}
