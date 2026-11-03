/**
 * Cross-task ownership: two agents claiming one file is the failure mode that
 * makes a team worse than one agent, and it is entirely preventable on paper.
 *
 * Tasks run sequentially, so the damage is not a race — it is an ordering
 * problem. Task A rewrites `src/api.ts`; task B, planned against the file as it
 * was before the run, rewrites it again and silently undoes A. This module gives
 * every file exactly one writer at a time by adding a dependency edge from the
 * later claimant to the earlier one, in list order, so the schedule is stable and
 * replays identically from a persisted state.
 *
 * Pure and deterministic: same tasks in, same order out, same notes out. It never
 * invents a cycle (a proposed edge is only taken when the graph stays acyclic),
 * and when an edge is impossible it still reports the collision so the user, not
 * the model, decides.
 */

import { findCycles } from '../autonomy/dag';

/** The slice of a task this module reads. A `TeamTask` satisfies it. */
export interface OwnedTask {
  id: string;
  title: string;
  expectedFiles: string[];
  dependsOn: string[];
}

export interface OwnershipConflict {
  /** Repo-relative, forward-slashed. */
  file: string;
  /** Task ids that claim it, in plan order. */
  taskIds: string[];
  /** One sentence for the card: what was found and what was done about it. */
  note: string;
}

export interface OwnershipResult<T extends OwnedTask> {
  /** New objects; the input is never mutated. */
  tasks: T[];
  conflicts: OwnershipConflict[];
  /** `conflicts` rendered for the trace and the shared context. */
  notes: string[];
  /** True when two tasks collide and no edge could separate them. */
  unresolved: string[];
}

export function normalizeOwnedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

/** Which tasks claim which file, in plan order, without duplicates per task. */
export function fileClaims<T extends OwnedTask>(tasks: T[]): Map<string, T[]> {
  const claims = new Map<string, T[]>();
  for (const task of tasks) {
    const seen = new Set<string>();
    for (const raw of task.expectedFiles) {
      const file = normalizeOwnedPath(raw);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const list = claims.get(file) ?? [];
      list.push(task);
      claims.set(file, list);
    }
  }
  return claims;
}

/** Files more than one runnable-looking task claims. Insertion order is plan order. */
export function detectConflicts<T extends OwnedTask>(tasks: T[]): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];
  for (const [file, owners] of fileClaims(tasks)) {
    if (owners.length < 2) continue;
    conflicts.push({
      file,
      taskIds: owners.map((task) => task.id),
      note: `${owners.map((task) => task.id).join(', ')} all claim ${file} — they are ordered ${owners
        .map((task) => task.id)
        .join(' then ')} so only one writes it at a time.`
    });
  }
  return conflicts;
}

function withDependency<T extends OwnedTask>(task: T, dependencyId: string): T {
  if (task.dependsOn.includes(dependencyId)) return task;
  return { ...task, dependsOn: [...task.dependsOn, dependencyId] };
}

/**
 * Serialise every collision in plan order and report what was done.
 *
 * An edge is only added when the graph stays acyclic, so a plan that already
 * depends the other way round is left alone and flagged instead of corrupted.
 */
export function serialiseConflicts<T extends OwnedTask>(tasks: T[]): OwnershipResult<T> {
  const byId = new Map<string, T>(tasks.map((task) => [task.id, task]));
  const working = tasks.map((task) => ({ ...task, dependsOn: [...task.dependsOn] }));
  const indexById = new Map(working.map((task, index) => [task.id, index]));
  const conflicts = detectConflicts(tasks);
  const unresolved: string[] = [];

  for (const conflict of conflicts) {
    for (let cursor = 1; cursor < conflict.taskIds.length; cursor += 1) {
      const later = byId.get(conflict.taskIds[cursor]);
      const earlier = byId.get(conflict.taskIds[cursor - 1]);
      if (!later || !earlier) continue;
      const laterIndex = indexById.get(later.id) ?? -1;
      if (laterIndex < 0) continue;
      const candidate = working.map((task, index) => (index === laterIndex ? withDependency(task, earlier.id) : task));
      if (findCycles(candidate).length > 0) {
        unresolved.push(`${later.id} and ${earlier.id} both edit ${conflict.file} and neither order is possible — ${conflict.taskIds.join(', ')}`);
        continue;
      }
      for (let write = 0; write < candidate.length; write += 1) working[write] = candidate[write];
    }
  }

  return {
    tasks: working,
    conflicts,
    notes: conflicts.map((conflict) => conflict.note),
    unresolved
  };
}

/** What a later agent must know about the files that already changed. */
export interface TouchedTask {
  id: string;
  title?: string;
  assignee?: string;
  status?: string;
  touchedFiles?: string[];
  pendingReview?: string[];
  summary?: string;
}

const MAX_CONTEXT_TASKS = 8;
const MAX_CONTEXT_FILES = 6;
const MAX_CONTEXT_CHARS = 900;

function firstLine(text: string, limit: number): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const value = line.trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/**
 * The workspace as the team has already changed it, in one block of text.
 *
 * Raw chat transcript tells a later agent what the others *said*; this tells it
 * what is now on disk and which files are still waiting on the user. A backend
 * agent that can see `src/api.ts changed by t1 (awaiting review)` does not write
 * over it blind.
 */
export function touchedFilesContext(tasks: TouchedTask[], exceptId?: string): string {
  const done = tasks
    .filter((task) => task.id !== exceptId)
    .filter((task) => task.status === 'passed' || task.status === 'unverified' || task.status === 'failed')
    .filter((task) => (task.touchedFiles?.length ?? 0) > 0 || (task.pendingReview?.length ?? 0) > 0)
    .slice(-MAX_CONTEXT_TASKS);
  if (done.length === 0) return '';

  const lines: string[] = [];
  for (const task of done) {
    const touched = task.touchedFiles ?? [];
    const held = task.pendingReview ?? [];
    const who = task.assignee ? ` (${task.assignee})` : '';
    const parts: string[] = [];
    if (touched.length > 0) {
      const listed = touched.slice(0, MAX_CONTEXT_FILES).join(', ');
      parts.push(`changed ${listed}${touched.length > MAX_CONTEXT_FILES ? ` (+${touched.length - MAX_CONTEXT_FILES} more)` : ''}`);
    }
    if (held.length > 0) parts.push(`awaiting review: ${held.slice(0, MAX_CONTEXT_FILES).join(', ')}`);
    const note = task.summary ? firstLine(task.summary, 160) : firstLine(task.title ?? '', 160);
    lines.push(`- ${task.id}${who} ${parts.join('; ')}${note ? ` — ${note}` : ''}`);
  }

  const text = lines.join('\n');
  return text.length <= MAX_CONTEXT_CHARS ? text : text.slice(0, MAX_CONTEXT_CHARS);
}

/** The files a set of tasks may not both write; used to warn before a run starts. */
export function conflictSummary(conflicts: OwnershipConflict[]): string {
  if (conflicts.length === 0) return '';
  const files = conflicts.map((conflict) => conflict.file);
  const unique = [...new Set(files)];
  return `${unique.length} file${unique.length === 1 ? '' : 's'} claimed by more than one task: ${unique.slice(0, 4).join(', ')}${unique.length > 4 ? ` (+${unique.length - 4} more)` : ''}.`;
}
