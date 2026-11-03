/**
 * Webhook matching for the loopback server.
 *
 * Kept dependency-free so it can be imported by both the main process and the
 * renderer tests. The server still owns the HTTP surface: it calls
 * `matchWebhook` first, then `authorizeWebhook` with the token it received, and
 * only then hands the action to the same gated dispatcher as every other run.
 */

import type { AutomationDefinition } from './types';

/**
 * Compare two strings without returning early on the first mismatch.
 *
 * Length is mixed into the difference, so unequal-length inputs always fail;
 * the loop runs to the longer length so a wrong-length secret cannot be
 * distinguished by a short input returning faster, except for the length itself
 * (which cannot be hidden without padding secrets to a fixed size).
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftLength = left.length;
  const rightLength = right.length;
  let difference = leftLength ^ rightLength;
  const length = Math.max(leftLength, rightLength);
  for (let index = 0; index < length; index += 1) {
    const a = index < leftLength ? left.charCodeAt(index) : 0;
    const b = index < rightLength ? right.charCodeAt(index) : 0;
    difference |= a ^ b;
  }
  return difference === 0;
}

function compareIds(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * The enabled webhook definition for this request, or null.
 *
 * POST only and an exact path match. When two definitions claim the same path
 * the lowest id wins, so the outcome does not depend on file order.
 */
export function matchWebhook(
  definitions: readonly AutomationDefinition[],
  method: string,
  path: string
): AutomationDefinition | null {
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return null;
  const sorted = [...definitions].sort(compareIds);
  for (const definition of sorted) {
    if (!definition.enabled || definition.trigger.type !== 'webhook') continue;
    if (definition.trigger.path === path) return definition;
  }
  return null;
}

/** Check the shared token for the matched definition. Non-webhook definitions never authorize. */
export function authorizeWebhook(
  definition: AutomationDefinition,
  providedSecret: string
): boolean {
  if (definition.trigger.type !== 'webhook') return false;
  if (typeof providedSecret !== 'string' || providedSecret.length === 0) return false;
  return constantTimeEqual(definition.trigger.secret, providedSecret);
}
