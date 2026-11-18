/**
 * Milestone confinement: the rule that a turn may only modify the files its
 * milestone declared, plus brand-new files inside the workspace root.
 *
 * The planner's `expectedFiles` is a contract, not a suggestion. A model can
 * still emit a patch for any file it has seen in context, so every patch is
 * checked here before it reaches the review/apply path. Refused patches are
 * reported with the reason the model needs on its next attempt; they are never
 * applied silently. Nothing outside the workspace root is ever writable.
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

export interface ConfinementOptions {
  /**
   * Whether a normalized workspace-relative path already exists on disk,
   * supplied by the host (the turn runner probes its readFile port). When
   * given, a patch creating a brand-NEW file inside the workspace root is
   * allowed even if expectedFiles never named it — a task that declares
   * `src/auth.ts` may still need `src/types.ts`. Modifications of pre-existing
   * unlisted files stay refused. Without the callback every unlisted patch is
   * refused, which is the original contract.
   */
  fileExists?: (normalizedPath: string) => boolean;
}

/**
 * Whether a patch path stays inside the workspace root: relative, with no `..`
 * segment climbing above it. Absolute paths (POSIX, Windows drive, UNC) are
 * outside by definition. This boundary is security-critical and applies even
 * when the host says the file does not exist yet.
 */
export function isInsideWorkspaceRoot(path: string): boolean {
  const normalized = normalizeRelativePath(path);
  if (!normalized) return false;
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  let depth = 0;
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return false;
      continue;
    }
    depth += 1;
  }
  return depth > 0;
}

export function confinePatches<T extends ConfinablePatch>(
  patches: T[],
  expectedFiles: string[],
  options: ConfinementOptions = {}
): ConfinementResult<T> {
  const allowedPaths = new Set(expectedFiles.map(normalizeRelativePath));
  const allowed: T[] = [];
  const refused: string[] = [];

  for (const patch of patches) {
    if (isProtectedAgentWritePath(patch.path)) {
      refused.push(`${patch.path}: refused — agent turns cannot alter plugin or automation manifests`);
      continue;
    }
    if (!isInsideWorkspaceRoot(patch.path)) {
      refused.push(`${patch.path}: refused — outside the workspace root`);
      continue;
    }
    const normalized = normalizeRelativePath(patch.path);
    if (allowedPaths.has(normalized)) {
      allowed.push(patch);
      continue;
    }
    // A brand-new file the planner did not name is still creatable: confinement
    // guards modifications of existing files, not the birth of needed new ones.
    // A read-only milestone (no declared files) keeps refusing everything.
    if (allowedPaths.size > 0 && options.fileExists && !options.fileExists(normalized)) {
      allowed.push(patch);
      continue;
    }
    refused.push(
      allowedPaths.size === 0
        ? `${patch.path}: refused — this milestone declared no files to edit`
        : `${patch.path}: refused — outside the files this turn may write (${expectedFiles.join(', ')})`
    );
  }

  return { allowed, refused };
}
