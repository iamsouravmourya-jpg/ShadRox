import { canonicalPathKey, hasTrackedPath, isCaseInsensitivePlatform } from '../paths';
import type { TeamTask } from './types';

const EXPLICIT_PATH_RE =
  /(?:^|[\s`'"(\[,])((?:\.\.?\/)?(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+\.[a-zA-Z0-9]{1,10})(?=$|[\s`'")\],:;?!])/g;

const CREATION_BEFORE_RE = /\b(?:create|add\s+(?:a\s+)?new|scaffold|generate\s+(?:a\s+)?new|new\s+file|write\s+(?:a\s+)?new|make\s+(?:a\s+)?new)\b/i;
const MODIFY_VERB_RE = /\b(?:modify|update|edit|fix|refactor|patch|change|rewrite|extend|repair|debug|replace|rename)\b/i;

function normalizeCandidate(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
}

function isRepoRelativeCandidate(candidate: string): boolean {
  if (!candidate) return false;
  if (candidate.startsWith('http://') || candidate.startsWith('https://')) return false;
  if (candidate.startsWith('/') || candidate.startsWith('..')) return false;
  if (/^\d+\.\d+\.\d+/.test(candidate)) return false;
  if (candidate.startsWith('node_modules/') || candidate.startsWith('.git/')) return false;
  return candidate.includes('/');
}

/**
 * Extract repo-relative file paths referenced in user goals or task instructions
 * alongside their intent (creation vs modification of an existing target).
 */
export function extractExplicitFileTargets(text: string): Array<{ path: string; allowMissing: boolean }> {
  const results: Array<{ path: string; allowMissing: boolean }> = [];
  const seen = new Set<string>();
  const globalModify = MODIFY_VERB_RE.test(text);

  EXPLICIT_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_PATH_RE.exec(text)) !== null) {
    const candidate = normalizeCandidate(match[1]);
    if (!isRepoRelativeCandidate(candidate)) continue;
    const key = canonicalPathKey(candidate, true);
    if (seen.has(key)) continue;
    seen.add(key);

    const start = Math.max(0, match.index - 72);
    const before = text.slice(start, match.index);
    const localCreate = CREATION_BEFORE_RE.test(before);
    const localModify = MODIFY_VERB_RE.test(before);
    // Treat as modification target unless creation language immediately precedes it without a modification verb.
    const allowMissing = localCreate && !localModify && !globalModify;
    results.push({ path: candidate, allowMissing });
  }

  return results;
}

/**
 * Returns explicitly referenced modification targets in the team goal that do
 * not exist in the open workspace. Creation/scaffolding goals are allowed.
 */
export function findMissingExplicitTargets(
  goal: string,
  workspaceFiles: readonly string[],
  caseInsensitive: boolean = isCaseInsensitivePlatform()
): string[] {
  const targets = extractExplicitFileTargets(goal);
  if (targets.length === 0) return [];

  const missing: string[] = [];
  for (const target of targets) {
    if (target.allowMissing) continue;
    if (!hasTrackedPath(workspaceFiles, target.path, caseInsensitive)) {
      missing.push(target.path);
    }
  }
  return missing;
}

/**
 * Checks planned tasks for instructions that explicitly ask to modify/edit an
 * existing `expectedFiles` entry that is absent on disk and not produced by an
 * upstream `dependsOn` task.
 */
export function findMissingTaskTargets(
  tasks: readonly TeamTask[],
  workspaceFiles: readonly string[],
  caseInsensitive: boolean = isCaseInsensitivePlatform()
): Array<{ taskId: string; taskTitle: string; path: string }> {
  const taskById = new Map<string, TeamTask>();
  for (const task of tasks) taskById.set(task.id, task);

  const missing: Array<{ taskId: string; taskTitle: string; path: string }> = [];
  for (const task of tasks) {
    if (!MODIFY_VERB_RE.test(task.instruction) || CREATION_BEFORE_RE.test(task.instruction)) continue;

    const upstreamFiles = new Set<string>();
    const queue = [...task.dependsOn];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);
      const dep = taskById.get(depId);
      if (!dep) continue;
      for (const file of dep.expectedFiles) {
        upstreamFiles.add(canonicalPathKey(file, caseInsensitive));
      }
      queue.push(...dep.dependsOn);
    }

    const explicitInInstruction = extractExplicitFileTargets(task.instruction);
    for (const entry of explicitInInstruction) {
      if (entry.allowMissing) continue;
      const key = canonicalPathKey(entry.path, caseInsensitive);
      if (upstreamFiles.has(key)) continue;
      if (!hasTrackedPath(workspaceFiles, entry.path, caseInsensitive)) {
        missing.push({ taskId: task.id, taskTitle: task.title, path: entry.path });
      }
    }
  }
  return missing;
}
