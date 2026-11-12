/**
 * The team's ports adapter.
 *
 * It is deliberately thin, and that is the point: the team reuses the exact
 * `runTurn` and `verifyMilestone` the solo run uses, so a team task is verified
 * by the same honest logic — including the `unverified` verdict — and applied by
 * the same patch engine. There is no second path into the workspace.
 */

import type { AutonomyHost } from '../autonomy/ports';
import { verifyMilestone } from '../autonomy/ports';
import type { TeamEvent, TeamPorts } from './types';

export interface TeamPortsOptions {
  /** Workspace root, used to make diagnostic paths repo-relative. */
  rootPath: string;
  onEvent: (event: TeamEvent) => void;
  isCancellationRequested: () => boolean;
  /** The panel's Pause button, when the caller has one. */
  isPauseRequested?: () => boolean;
}

/** Wrap the app's capabilities into the team's ports contract. */
export function createTeamPorts(host: AutonomyHost, options: TeamPortsOptions): TeamPorts {
  return {
    runTurn: (request) => host.runTurn(request),
    verify: (unit) => verifyMilestone(unit, host, options.rootPath),
    listFiles: () => host.listFiles(),
    onEvent: options.onEvent,
    isCancellationRequested: options.isCancellationRequested,
    ...(options.isPauseRequested ? { isPauseRequested: options.isPauseRequested } : {})
  };
}
