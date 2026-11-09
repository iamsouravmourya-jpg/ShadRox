/**
 * Living Intent Graph — canonical schema.
 *
 * A persistent semantic memory of WHY code exists. It links user-approved
 * decisions (rationale, invariants, rejected alternatives) to the symbols and
 * files they govern, indexes the workspace's symbols and file dependencies, and
 * flags a decision "stale / needs review" when a governing file's content hash
 * changes — instead of blindly wiping the knowledge.
 *
 * When a new task starts, a budgeted BFS walks the graph from the task's seed
 * files/symbols and extracts only the tightest relevant decisions within a
 * strict token budget, so the agent gets high-value intent without context
 * pollution. Stale decisions are surfaced with an explicit flag, never silently
 * trusted or dropped.
 *
 * Decisions are stored locally (IndexedDB), export/import as portable JSON, and
 * their title/body are scrubbed of credential-shaped values before storage
 * (reusing `envSafety.scrubWorkspaceText`). Hashing lives in `proof/ledger`
 * (sha256Hex); symbol/dependency scanning reuses `repoMap` (extractSignatures,
 * buildGraph); token accounting reuses `contextBudget` (estimateTokens).
 *
 * This file is the shared contract imported by graph/store, the useIntentGraph
 * hook, and the IntentGraphPanel UI. Keep it dependency-light: types only, plus
 * the two format constants.
 */

export const INTENT_FORMAT = 'shadrox-intent-graph' as const;
export const INTENT_VERSION = 1 as const;

/** A code symbol indexed from a workspace file. */
export type IntentSymbolKind = 'function' | 'class' | 'component' | 'type' | 'other';

export interface IntentSymbol {
  /** Stable id: `${normalizedPath}#${name}`. */
  id: string;
  name: string;
  kind: IntentSymbolKind;
  /** Workspace-relative, forward-slash normalized path. */
  path: string;
  /** 1-based declaration line. */
  line: number;
  /** Truncated declaration text (one prompt line). */
  signature: string;
  exported: boolean;
}

/** What a decision records about the code it governs. */
export type DecisionKind = 'rationale' | 'invariant' | 'rejected';

/**
 * `stale` means a governing file changed since the decision was approved; the
 * decision is kept and flagged for review, never deleted. `fresh` means every
 * governing file still hashes to its approved base.
 */
export type DecisionStatus = 'fresh' | 'stale';

export type DecisionSource = 'user' | 'agent';

/** A file (and optional symbol within it) a decision governs. */
export interface DecisionTarget {
  /** Workspace-relative, normalized path. */
  path: string;
  /** Optional symbol name within the file. */
  symbol?: string;
}

export interface IntentDecision {
  /** Stable id (e.g. `dec-<ts>-<rand>`). */
  id: string;
  workspaceRoot: string;
  createdAt: number;
  updatedAt: number;
  kind: DecisionKind;
  /** Short headline, scrubbed of secrets. */
  title: string;
  /** The rationale / invariant / rejected-alternative text, scrubbed. */
  body: string;
  targets: DecisionTarget[];
  /** path -> SHA-256 of the governing file content when approved. */
  baseHashes: Record<string, string>;
  /** Last computed freshness; recomputed against live hashes on every build. */
  status: DecisionStatus;
  source: DecisionSource;
  /** Optional link to the Change Capsule that motivated this decision. */
  capsuleRef: string | null;
}

/** A directed file-dependency edge (from imports/references), weight = strength. */
export interface FileEdge {
  from: string;
  to: string;
  weight: number;
}

/** The assembled graph for one workspace at one point in time. */
export interface IntentGraph {
  workspaceRoot: string;
  symbols: IntentSymbol[];
  /** Decisions with `status` recomputed against `fileHashes`. */
  decisions: IntentDecision[];
  fileEdges: FileEdge[];
  /** path -> current SHA-256 of file content. */
  fileHashes: Record<string, string>;
  builtAt: number;
}

/** Portable export envelope for JSON backup/restore. */
export interface IntentExport {
  format: typeof INTENT_FORMAT;
  version: typeof INTENT_VERSION;
  exportedAt: number;
  workspaceRoot: string;
  decisions: IntentDecision[];
}

/** A file handed to the pure graph builder, already read (no disk I/O inside). */
export interface IntentFile {
  path: string;
  content: string;
}

/** Request for the budgeted BFS context extractor. */
export interface IntentContextRequest {
  /** Seed paths and/or symbol ids the new task is about (open tabs, active file). */
  seeds: string[];
  /** The user's request, used to score relevance alongside the graph walk. */
  query: string;
  /** Hard token allowance for the extracted block (chars/4 heuristic). */
  tokenBudget: number;
  /** Optional cap on how many decisions may be selected. */
  maxDecisions?: number;
}

/** One decision chosen by the BFS, with its provenance. */
export interface SelectedDecision {
  decision: IntentDecision;
  /** Hops from the nearest seed (0 = directly targets a seed). */
  distance: number;
  /** Higher = more relevant; distance + query-term overlap. */
  relevance: number;
}

/** Result of the budgeted BFS extraction. */
export interface IntentContextResult {
  /** Compact prompt block; '' when nothing relevant fits. */
  text: string;
  selected: SelectedDecision[];
  tokensUsed: number;
  /** How many selected decisions are stale (flagged in the text). */
  staleCount: number;
}

/**
 * Input to create a decision. `baseHashes` is captured by the caller from the
 * live file hashes at approval time; the store stamps id/timestamps/status and
 * scrubs title/body. Kept separate from IntentDecision so the un-stamped shape
 * never accidentally persists.
 */
export interface DecisionInput {
  workspaceRoot: string;
  kind: DecisionKind;
  title: string;
  body: string;
  targets: DecisionTarget[];
  baseHashes: Record<string, string>;
  source?: DecisionSource;
  capsuleRef?: string | null;
}

/** Patch applied to an existing decision; re-stamps updatedAt and recomputes status. */
export interface DecisionPatch {
  kind?: DecisionKind;
  title?: string;
  body?: string;
  targets?: DecisionTarget[];
  baseHashes?: Record<string, string>;
  capsuleRef?: string | null;
}