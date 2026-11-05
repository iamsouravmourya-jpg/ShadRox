/**
 * Milestone confinement: the rule that a turn may only write the files its
 * milestone declared.
 *
 * The planner's `expectedFiles` is a contract, not a suggestion. A model can
 * still emit a patch for any file it has seen in context, so every patch is
 * checked here before it reaches the review/apply path. Refused patches are
 * reported with the reason the model needs on its next attempt; they are never
 * applied silently.
 */

import { normalizeRelativePath } from './ports';
import { isProtectedAgentWritePath } from '../agents/applyPolicy';

export interface ConfinablePatch {
  path: string;
}

export interface ConfinementResult<T extends ConfinablePatch> {
  allowed: T[];
  refused: string[];
}

export function confinePatches<T extends ConfinablePatch>(
  patches: T[],
  expectedFiles: string[]
): ConfinementResult<T> {
  const allowedPaths = new Set(expectedFiles.map(normalizeRelativePath));
  const allowed: T[] = [];
  const refused: string[] = [];

  for (const patch of patches) {
    if (isProtectedAgentWritePath(patch.path)) {
      refused.push(`${patch.path}: refused — agent turns cannot alter plugin or automation manifests`);
      continue;
    }
    if (allowedPaths.has(normalizeRelativePath(patch.path))) {
      allowed.push(patch);
      continue;
    }
    refused.push(
      allowedPaths.size === 0
        ? `${patch.path}: refused — this milestone declared no files to edit`
        : `${patch.path}: refused — outside this milestone's expectedFiles (${expectedFiles.join(', ')})`
    );
  }

  return { allowed, refused };
}
