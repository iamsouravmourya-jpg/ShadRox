/**
 * Turning team events into one readable line for the panel's log.
 *
 * Same shape as `autonomy/events.ts` and for the same reason: the log is the one
 * part of a run a user reads after the fact, so the mapping is a pure function
 * that is worth pinning down on its own.
 */

import type { TeamEvent, TeamMergeReport } from './types';

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
    case 'team:integration':
      return describeMergeReport(event.report);
    case 'team:done':
      return `Team finished: ${event.status}.`;
    default:
      return null;
  }
}

/**
 * The closing merge report on one line: the verdict, what it covered, and — when
 * two roles wrote one file — how many of them have to be argued about. A conflict
 * is never folded into a green count.
 */
function describeMergeReport(report: TeamMergeReport): string {
  const parts = [`${report.verdict} — ${report.files.length} changed file(s) across ${report.byRole.length} role(s)`];
  if (report.overlaps.length > 0) {
    parts.push(`${report.overlaps.length} file(s) written by more than one role (${report.overlaps.map((overlap) => overlap.file).slice(0, 3).join(', ')}${report.overlaps.length > 3 ? ' …' : ''})`);
  }
  if (report.errors > 0) parts.push(`${report.errors} error(s)`);
  else if (report.warnings > 0) parts.push(`${report.warnings} warning(s)`);
  if (!report.ran) parts.push('closing turn did not run');
  return `Integration (${report.role}): ${parts.join('; ')}.`;
}
