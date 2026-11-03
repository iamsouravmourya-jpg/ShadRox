/**
 * Multi-agent teams.
 *
 * One coordinator splits a goal into tasks; four specialists carry them out.
 * The layer owns no engine of its own: `ports.ts` adapts the app's single
 * `AutonomyHost`, so a team task is run and verified by exactly the same code a
 * solo run uses. A team member therefore cannot invent a write or exec path the
 * user could not have taken by hand.
 */

export * from './types';
export * from './roles';
export * from './plan';
export * from './ports';
export * from './team-run';
