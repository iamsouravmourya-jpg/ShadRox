/**
 * Replayable Change Capsules — canonical schema.
 *
 * A capsule is one AI task treated like an atomic commit plus a runtime
 * verification bundle: the intent that drove it, the scoped file diffs (with
 * base/post content hashes), pre/post verification, model spend, and an optional
 * link to the Machine Delta captured for the same turn. Capsules are stored
 * locally (IndexedDB), export/import as portable JSON, and replay or revert
 * through a 3-way sandbox that refuses to clobber newer manual edits.
 *
 * Secrets never enter a capsule: `redactor.ts` masks credential-shaped values
 * (reusing `envSafety.scrubWorkspaceText`) before storage and records what it
 * masked in `redaction`. `selfHash` is the SHA-256 of the canonical capsule
 * minus the `selfHash` field, so a tampered export fails its own integrity check.
 *
 * This file is the shared contract imported by redactor/store/sandbox/capture
 * and the TaskInspector UI. Keep it dependency-light: types only, plus the two
 * format constants. Hashing lives in `proof/ledger` (sha256Hex, canonicalJson).
 */

export const CAPSULE_FORMAT = 'shadrox-change-capsule' as const;
export const CAPSULE_VERSION = 1 as const;

/** Lifecycle of a capsule relative to the live workspace. */
export type CapsuleStatus = 'captured' | 'applied' | 'reverted' | 'replayed' | 'conflicted';

/** One scoped file change. `before`/`after` are redacted content (null = absent). */
export interface CapsuleFileDiff {
  path: string;
  kind: 'created' | 'deleted' | 'edited';
  /** SHA-256 of base content; null when the file was created by the task. */
  beforeHash: string | null;
  /** SHA-256 of post content; null when the file was deleted by the task. */
  afterHash: string | null;
  /** Redacted base content; null when created. */
  before: string | null;
  /** Redacted post content; null when deleted. */
  after: string | null;
}

/** A verification snapshot taken before or after the task ran. */
export interface CapsuleVerification {
  stage: 'pre' | 'post';
  /** Count of TypeScript diagnostics observed (0 = clean). */
  diagnostics: number;
  testsPassed: number | null;
  testsFailed: number | null;
  consoleErrors: number | null;
  verdict: 'passed' | 'failed' | 'unknown';
  capturedAt: number;
}

/** Provider-reported spend for the task. Null when the turn was unmetered/BYOK. */
export interface CapsuleSpend {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number | null;
}

/** What the redactor masked, so the UI can show "secrets removed" honestly. */
export interface RedactionReport {
  redacted: boolean;
  /** Field paths that had at least one secret masked, e.g. "promptIntent", "diffs[2].after". */
  fields: string[];
  /** Total number of secret occurrences masked across the capsule. */
  count: number;
}

export interface ChangeCapsule {
  format: typeof CAPSULE_FORMAT;
  version: typeof CAPSULE_VERSION;
  /** Stable capsule id (e.g. `cap-<ts>-<rand>`). */
  id: string;
  /** The turn/checkpoint id this capsule bundles. */
  taskId: string;
  workspaceRoot: string;
  createdAt: number;
  status: CapsuleStatus;
  /** Redacted user prompt / task intent. */
  promptIntent: string;
  /** path -> SHA-256 of the base snapshot the task started from. */
  baseHashes: Record<string, string>;
  diffs: CapsuleFileDiff[];
  verification: CapsuleVerification[];
  spend: CapsuleSpend | null;
  /** checkpointId of the associated Machine Delta, when the turn was a machine turn. */
  machineDeltaRef: string | null;
  redaction: RedactionReport;
  /** SHA-256 of canonicalJson(capsule without selfHash). Empty string until sealed. */
  selfHash: string;
}

/** Portable export envelope for JSON backup/restore. */
export interface CapsuleExport {
  format: typeof CAPSULE_FORMAT;
  version: typeof CAPSULE_VERSION;
  exportedAt: number;
  capsules: ChangeCapsule[];
}

/** Why a 3-way replay/revert refused to touch a file. */
export type ReplayConflictReason = 'BASE_DIVERGED' | 'ANCHOR_NOT_FOUND' | 'FILE_MISSING' | 'PATH_UNSAFE';

export interface ReplayConflict {
  path: string;
  reason: ReplayConflictReason;
  detail: string;
}

/** A resolved write job, shaped like atomicApply's AtomicPlanJob. */
export interface ReplayJob {
  path: string;
  content: string;
  originalContent: string;
  created: boolean;
}

/**
 * Result of the 3-way sandbox. `ok` is true only when EVERY file resolves;
 * a single conflict empties `jobs` (all-or-nothing, mirroring planAtomicApply).
 * Anchor mismatch / base divergence => zero bytes written.
 */
export interface ReplayPlan {
  ok: boolean;
  jobs: ReplayJob[];
  conflicts: ReplayConflict[];
}

/** Input to the pure capsule assembler (capture.ts). Content here is RAW; the
 *  assembler redacts before sealing. Kept separate from ChangeCapsule so the
 *  un-redacted shape never accidentally persists. */
export interface CapsuleCaptureInput {
  taskId: string;
  workspaceRoot: string;
  promptIntent: string;
  createdAt?: number;
  status?: CapsuleStatus;
  /** Base snapshot files (path + raw content) the task started from. */
  baseFiles: Array<{ path: string; content: string }>;
  /** Post-task files (path + raw content); absent path = deleted, new path = created. */
  postFiles: Array<{ path: string; content: string }>;
  verification?: CapsuleVerification[];
  spend?: CapsuleSpend | null;
  machineDeltaRef?: string | null;
}