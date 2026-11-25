export interface PromptCheckpointSnapshot {
  userMessageId: string;
  promptText: string;
  workspaceKey: string;
  createdAt: number;
  /** Pre-turn file contents for paths that existed before the turn modified or deleted them. */
  priorFiles: Record<string, string>;
  /** Paths newly created during the turn that did not exist beforehand. */
  createdPaths: string[];
}

export interface PromptCheckpointRestorePlan {
  targetUserMessageId: string;
  promptText: string;
  /** Files to write back to disk / open buffers (with their pre-turn content). */
  restoreFiles: Array<{ path: string; content: string }>;
  /** Newly created paths to delete from disk / open buffers. */
  deletePaths: string[];
  /** Checkpoints remaining older than the restored target. */
  remainingCheckpoints: PromptCheckpointSnapshot[];
}

export const MAX_PROMPT_CHECKPOINTS = 40;

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function isWindowsReservedCheckpointPath(rawPath: string): boolean {
  const clean = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean) return false;
  return clean.split('/').some((part) => WINDOWS_RESERVED_SEGMENT.test(part));
}

export function normalizeCheckpointPath(rawPath: string): string | null {
  const clean = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean)) return null;
  if (clean.split('/').some((part) => !part || part === '.' || part === '..' || WINDOWS_RESERVED_SEGMENT.test(part))) {
    return null;
  }
  return clean;
}

/**
 * Records pre-mutation file state into a turn delta snapshot without overwriting
 * any path that was already captured earlier in the same turn.
 */
export function recordPreMutationState(
  snapshot: PromptCheckpointSnapshot,
  entries: Array<{ path: string; content: string | null }>
): PromptCheckpointSnapshot {
  let nextPrior: Record<string, string> | null = null;
  let nextCreated: string[] | null = null;

  for (const entry of entries) {
    const clean = normalizeCheckpointPath(entry.path);
    if (!clean) continue;

    const alreadyTrackedAsPrior = Object.prototype.hasOwnProperty.call(
      nextPrior ?? snapshot.priorFiles,
      clean
    );
    const alreadyTrackedAsCreated = (nextCreated ?? snapshot.createdPaths).includes(clean);
    if (alreadyTrackedAsPrior || alreadyTrackedAsCreated) {
      continue;
    }

    if (entry.content !== null) {
      if (!nextPrior) nextPrior = { ...snapshot.priorFiles };
      nextPrior[clean] = entry.content;
    } else {
      if (!nextCreated) nextCreated = [...snapshot.createdPaths];
      nextCreated.push(clean);
    }
  }

  if (!nextPrior && !nextCreated) return snapshot;
  return {
    ...snapshot,
    priorFiles: nextPrior ?? snapshot.priorFiles,
    createdPaths: nextCreated ?? snapshot.createdPaths
  };
}

/** Returns true when a snapshot captured at least one pre-turn file or newly created path. */
export function hasCheckpointDelta(snapshot: PromptCheckpointSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return Object.keys(snapshot.priorFiles).length > 0 || snapshot.createdPaths.length > 0;
}

/** Appends or updates a turn checkpoint, keeping chronological order and capping history length. */
export function upsertPromptCheckpoint(
  checkpoints: readonly PromptCheckpointSnapshot[],
  next: PromptCheckpointSnapshot,
  maxEntries = MAX_PROMPT_CHECKPOINTS
): PromptCheckpointSnapshot[] {
  const filtered = checkpoints.filter((cp) => cp.userMessageId !== next.userMessageId);
  const combined = [...filtered, next];
  if (combined.length <= maxEntries) return combined;
  return combined.slice(combined.length - maxEntries);
}

/**
 * Computes the exact net file writes and deletions needed to rewind the workspace
 * back to immediately before `targetUserMessageId` started, folding every newer
 * checkpoint in reverse chronological order so intermediate edits stay coherent.
 */
export function computeRestorePlan(
  checkpoints: readonly PromptCheckpointSnapshot[],
  targetUserMessageId: string
): PromptCheckpointRestorePlan | null {
  const targetIndex = checkpoints.findIndex((cp) => cp.userMessageId === targetUserMessageId);
  if (targetIndex < 0) return null;

  const target = checkpoints[targetIndex];
  const filesToRestore = new Map<string, string>();
  const pathsToDelete = new Set<string>();

  for (let i = checkpoints.length - 1; i >= targetIndex; i -= 1) {
    const cp = checkpoints[i];
    for (const [filePath, content] of Object.entries(cp.priorFiles)) {
      pathsToDelete.delete(filePath);
      filesToRestore.set(filePath, content);
    }
    for (const createdPath of cp.createdPaths) {
      filesToRestore.delete(createdPath);
      pathsToDelete.add(createdPath);
    }
  }

  const restoreFiles = [...filesToRestore.entries()]
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => a.path.localeCompare(b.path));
  // Delete deepest paths first in case both nested files and directories were created.
  const deletePaths = [...pathsToDelete].sort(
    (a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a)
  );

  return {
    targetUserMessageId,
    promptText: target.promptText,
    restoreFiles,
    deletePaths,
    remainingCheckpoints: checkpoints.slice(0, targetIndex)
  };
}

/**
 * Formats a compact one-line impact summary for hovering a prompt's Restore
 * button (e.g. "Reverts 3 modified, deletes 1 created file").
 */
export function formatRestoreImpactTooltip(modifiedCount: number, createdCount: number): string {
  const modified = Number.isFinite(modifiedCount) ? Math.max(0, Math.trunc(modifiedCount)) : 0;
  const created = Number.isFinite(createdCount) ? Math.max(0, Math.trunc(createdCount)) : 0;
  if (modified === 0 && created === 0) {
    return 'Restore workspace files to before this prompt';
  }
  if (modified > 0 && created > 0) {
    return `Reverts ${modified} modified, deletes ${created} created ${created === 1 ? 'file' : 'files'}`;
  }
  if (modified > 0) {
    return `Reverts ${modified} modified ${modified === 1 ? 'file' : 'files'}`;
  }
  return `Deletes ${created} created ${created === 1 ? 'file' : 'files'}`;
}

/** Computes restore impact tooltip strings keyed by userMessageId for all restorable checkpoints. */
export function summarizeRestoreCheckpoints(
  checkpoints: readonly PromptCheckpointSnapshot[]
): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const checkpoint of checkpoints) {
    if (!hasCheckpointDelta(checkpoint)) continue;
    const plan = computeRestorePlan(checkpoints, checkpoint.userMessageId);
    if (!plan) continue;
    summaries[checkpoint.userMessageId] = formatRestoreImpactTooltip(
      plan.restoreFiles.length,
      plan.deletePaths.length
    );
  }
  return summaries;
}

