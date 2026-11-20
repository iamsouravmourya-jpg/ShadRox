/**
 * Per-turn state the tool loop and the tools share: what was read, what was
 * changed, and what verified the change.
 *
 * The registry is keyed by workspace id and lives only for one `runToolRounds`
 * call. `beginTurn` replaces any stale entry (a crashed turn must not leak its
 * read-set into the next one) and `endTurn` removes it, so a direct `runTool`
 * call outside a loop keeps the legacy unguarded behaviour.
 *
 * Everything here is pure data — no bridge, no disk — so the read-before-write
 * gate, the forced-verify gate and the docs-only exemption can be unit-tested
 * without a workspace.
 */

import { dedupePaths, hasTrackedPath } from '../paths';

export type VerificationKind = 'verify' | 'problems' | 'command';

export interface VerificationRecord {
  kind: VerificationKind;
  /** Whether the check itself passed; a failed check still counts as RAN. */
  ok: boolean;
  /** Paths the check covered; empty means the whole project. */
  paths: string[];
  /** Monotonic sequence shared with mutations, so "after the last write" is decidable. */
  seq: number;
  detail: string;
}

export interface AgentTurnState {
  workspaceId: string;
  userAsk: string;
  startedAt: number;
  /** Paths read this turn (a failed read never lands here). */
  reads: Set<string>;
  /** Content fingerprint of the last read, for the unchanged re-read note. */
  readHashes: Map<string, string>;
  /** Paths written or deleted this turn. */
  changed: Set<string>;
  /** Paths this turn created (a rollback deletes them again). */
  created: Set<string>;
  /** Mutations whose paths are unknown (run_command, MCP): conservative count. */
  unknownWrites: number;
  /** Shared clock for mutations and verifications. */
  seq: number;
  /** Seq of the last mutation; a verification must land after it. */
  lastMutationSeq: number;
  verifications: VerificationRecord[];
  /** Checkpoint taken before the turn's first write, if one could be made. */
  checkpointId: string | null;
  /** Pre-image paths already merged into the turn checkpoint. */
  checkpointPaths: Set<string>;
  scaffoldIntent: boolean;
  addPageIntent: boolean;
  scaffoldNudged: boolean;
  addPageNudged: boolean;
  previewNudged: boolean;
  previewVerified: boolean;
}

const turns = new Map<string, AgentTurnState>();

export function beginTurn(workspaceId: string, userAsk: string, intent: { scaffold: boolean; addPage: boolean }): AgentTurnState {
  const turn: AgentTurnState = {
    workspaceId,
    userAsk,
    startedAt: Date.now(),
    reads: new Set(),
    readHashes: new Map(),
    changed: new Set(),
    created: new Set(),
    unknownWrites: 0,
    seq: 0,
    lastMutationSeq: 0,
    verifications: [],
    checkpointId: null,
    checkpointPaths: new Set(),
    scaffoldIntent: intent.scaffold,
    addPageIntent: intent.addPage,
    scaffoldNudged: false,
    addPageNudged: false,
    previewNudged: false,
    previewVerified: false
  };
  turns.set(workspaceId, turn);
  return turn;
}

export function endTurn(workspaceId: string): void {
  turns.delete(workspaceId);
}

export function getTurn(workspaceId: string | null): AgentTurnState | null {
  if (!workspaceId) return null;
  return turns.get(workspaceId) ?? null;
}

/** Test seam: drop every registry entry. */
export function resetTurns(): void {
  turns.clear();
}

export function hasTurnRead(turn: AgentTurnState, path: string): boolean {
  return hasTrackedPath([...turn.reads], path);
}

export function noteRead(turn: AgentTurnState, path: string, contentHash?: string): void {
  turn.reads.add(path);
  if (contentHash !== undefined) turn.readHashes.set(path, contentHash);
}

export function noteWrite(turn: AgentTurnState, paths: string[], created: string[] = []): void {
  const existing = [...turn.changed];
  for (const path of dedupePaths(paths)) {
    if (!hasTrackedPath(existing, path)) {
      turn.changed.add(path);
      existing.push(path);
    }
  }
  const existingCreated = [...turn.created];
  for (const path of dedupePaths(created)) {
    if (!hasTrackedPath(existingCreated, path)) {
      turn.created.add(path);
      existingCreated.push(path);
    }
    if (!hasTrackedPath(existing, path)) {
      turn.changed.add(path);
      existing.push(path);
    }
  }
  turn.seq += 1;
  turn.lastMutationSeq = turn.seq;
}

/** A mutation with unknown reach (a shell command, an MCP call). */
export function noteUnknownWrite(turn: AgentTurnState): void {
  turn.unknownWrites += 1;
  turn.seq += 1;
  turn.lastMutationSeq = turn.seq;
}

export function noteVerification(turn: AgentTurnState, record: Omit<VerificationRecord, 'seq'>): void {
  turn.seq += 1;
  turn.verifications.push({ ...record, seq: turn.seq });
}

export function hasMutations(turn: AgentTurnState): boolean {
  return turn.changed.size > 0 || turn.unknownWrites > 0;
}

const DOC_PATH = /(^|\/)docs\/|\.(md|markdown|mdx|txt|rst)$/i;

/** A turn that only touched documentation: verification does not apply to it. */
export function isDocsOnlyTurn(turn: AgentTurnState): boolean {
  return turn.unknownWrites === 0 && turn.changed.size > 0 && [...turn.changed].every((path) => DOC_PATH.test(path));
}

/** The latest verification that ran after the last mutation and covers every changed path. */
export function satisfyingVerification(turn: AgentTurnState): VerificationRecord | null {
  const changed = [...turn.changed];
  for (let index = turn.verifications.length - 1; index >= 0; index -= 1) {
    const record = turn.verifications[index];
    if (record.seq <= turn.lastMutationSeq) continue;
    if (record.kind === 'problems' && record.paths.length > 0) {
      if (!changed.every((path) => hasTrackedPath(record.paths, path))) continue;
    }
    return record;
  }
  return null;
}

/** True when the turn wrote something and nothing has verified it since. */
export function needsVerification(turn: AgentTurnState): boolean {
  if (!hasMutations(turn)) return false;
  if (isDocsOnlyTurn(turn)) return false;
  return satisfyingVerification(turn) === null;
}

/** The changed paths a finish summary should name, created files included. */
export function changedPathList(turn: AgentTurnState): string[] {
  return [...turn.changed].sort();
}

/** The exact instruction a refused finish carries, so the model knows what to run. */
export function verificationDemand(turn: AgentTurnState): string {
  const files = changedPathList(turn);
  const named = files.length > 0 ? files.slice(0, 12).join(', ') : 'files this turn changed';
  return `finish refused: this turn changed ${named}${turn.unknownWrites > 0 ? ' (and ran commands that may have changed more)' : ''}, `
    + 'but nothing verified the change yet. Run the verify tool now — it detects the project kind and runs its typecheck/build/test — '
    + `or call problems with {"paths":${JSON.stringify(files.slice(0, 12))}}, or run_command the project's build/test/typecheck script. `
    + 'Then call finish again with "verified" set to what the check actually showed.';
}