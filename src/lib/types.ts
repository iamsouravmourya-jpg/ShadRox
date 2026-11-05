export type Stage = 'STAGE_2' | 'STAGE_3';

export type TabType = 'CODE' | 'PREVIEW' | 'PLAN' | 'PLUGINS' | 'AGENTS' | 'AUTOMATIONS';

export type SettingsTab = 'CHAT' | 'PLAN' | 'GITHUB' | 'SECRETS' | 'TOOLS' | 'AUTOMATIONS';

/**
 * Local-embedding retrieval state shown in the chat toolbar. `unavailable`
 * means the optional embeddings package is not installed, so retrieval stays
 * on the BM25 default.
 */
export type SemanticStatus = 'off' | 'checking' | 'ready' | 'unavailable';

/**
 * UI-only plan ladder. Nothing is wired to billing yet — there is no database,
 * so the upgrade buttons just preview a tier locally.
 * Paid tiers are metered in credits, not messages.
 */
export type PlanTier = 'free' | 'starter' | 'pro';

export type ViewportSize = 'desktop' | 'tablet' | 'mobile';

/**
 * How much thinking the assistant should do, and whether it may write files.
 * `plan` is the one mode that never touches the code.
 */
export type RefineMode = 'code' | 'plan' | 'complex';

export interface WorkspaceFile {
  name: string;
  content: string;
  language: string;
  version?: string;
}

/** A file that exists in the workspace, described without reading its contents. */
export interface WorkspaceFileEntry {
  path: string;
  /** Size in bytes; 0 when it could not be stat'ed. */
  size: number;
}

export interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'file';
  nativeWorkspaceId?: string;
  files: WorkspaceFile[];
  /** Files on disk (folder workspaces), independent of the open editor tabs. */
  diskFileCount?: number;
  diskFileCountTruncated?: boolean;
  /**
   * Every explorer-visible path in the folder with its size, read at open.
   * Contents are not included; this is what the repo map and the context
   * candidate picker work from when the user has no tabs open.
   */
  diskFileTree?: WorkspaceFileEntry[];
}

export interface RefinedPromptMeta {
  original: string;
  detectedLanguage: string;
  translated: string;
  intent: string;
  refinedPrompt?: string;
  mode?: RefineMode;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: string;
  refinedMeta?: RefinedPromptMeta;
  attachments?: string[];
  attachedImage?: string;
  streaming?: boolean;
  /** Read-only tool calls this turn ran against the opened folder. */
  toolActivity?: Array<{
    name: string;
    label: string;
    ok: boolean;
    error?: string;
    input?: Record<string, unknown> | string;
    output?: string;
    durationMs?: number;
    stage?: 'reading' | 'planning' | 'editing' | 'checking' | 'completed' | 'failed';
    refused?: boolean;
  }>;
  /** Live status during execution (e.g. "Reading src/App.tsx...", "Running checks..."). */
  activeStatus?: string;
  /** Plan approval gate for multi-file or architectural tasks. */
  planApproval?: {
    status: 'required' | 'approved' | 'rejected' | 'pending';
    planSummary?: string;
    targetFiles?: string[];
  };
  /** Verification report showing passing/failing checks. */
  verificationResult?: {
    passed: boolean;
    checks: Array<{ name: string; ok: boolean; details?: string }>;
    summary: string;
  };
  /** Model turns spent on tool rounds before the answer. */
  toolRounds?: number;
  /** The step list the model tracked for itself during this turn. */
  taskPlan?: Array<{ id: string; subject: string; status: 'pending' | 'doing' | 'done' | 'blocked'; evidence?: string; files?: string[] }>;
  /** Set when the turn ended with the finish tool; `blocked` says why it is unfinished. */
  finishedWith?: { summary: string; blocked: string | null };
  /** Provider reasoning stream (Gemini thoughts / Groq reasoning models). */
  reasoning?: string;
  /** Latency and token usage reported by the streaming endpoint. */
  metrics?: {
    tokens: number;
    /** Absent when the provider reported no input/output split. */
    inputTokens?: number;
    outputTokens?: number;
    /**
     * Credits this turn actually cost at the rate table, derived from the real
     * split. Absent when the split is unknown — a guessed charge is worse than
     * no charge, because the balance would drift silently.
     */
    credits?: number;
    firstTokenMs: number | null;
    durationMs: number | null;
  };
  /** True when the stream died mid-way and can be continued without losing output. */
  resumable?: boolean;
  /** An automatic run/team turn, rendered inline instead of a separate panel. */
  orchestration?: {
    kind: 'autonomy' | 'team';
    status: 'planning' | 'running' | 'done' | 'failed' | 'stopped' | 'budget';
    /** Why Auto escalated this request instead of answering it directly. */
    reason: string;
    /** Hard ceiling the engine enforces for this run, in credits. */
    budgetCredits: number;
    creditsSpent?: number;
    /** Newest engine log lines, trimmed; the full log stays in the hook. */
    progress?: string[];
    /** One-line outcome: milestones/tasks passed, files changed, or the error. */
    detail?: string;
    /** Structured executive summary report generated upon team or autonomous run completion. */
    summaryReport?: {
      overview: string;
      filesModified: string[];
      tasksCompleted: number;
      totalTasks: number;
      testsPassed?: number;
      testsRun?: number;
      durationMs?: number;
      openIssues?: string[];
    };
  };
}

/** A single file change proposed by one assistant reply, awaiting review. */
export interface ReviewPatch {
  path: string;
  kind: 'rewrite' | 'searchReplace';
  blocks?: Array<{ original: string; updated: string }>;
  content?: string;
  status: 'pending' | 'applied' | 'rejected' | 'failed' | 'reverted';
  /** Human-readable reason when status === 'failed'. */
  failure?: string;
  /** File content captured before applying, so the change can be undone. */
  originalContent?: string;
  /** Workspace-canonical name the buffer write landed on (patch paths may differ in case). */
  landed?: string;
  /** Whether the change reached the user's disk — the UI must not claim it did when it did not. */
  disk?: 'saved' | 'buffer' | 'failed';
  /** Why the disk write failed or was skipped. */
  diskMessage?: string;
}

/** All file changes one assistant reply proposed, reviewed as one set. */
export interface PatchSet {
  messageId: string;
  patches: ReviewPatch[];
}

export interface SecretItem {
  id: string;
  key: string;
  value: string;
  visible: boolean;
}

export type KeyStatusState = 'idle' | 'checking' | 'ok' | 'error';

export interface KeyStatus {
  state: KeyStatusState;
  message?: string;
  latencyMs?: number;
  modelCount?: number;
}

export interface GitHubUser {
  login: string;
  name: string;
  avatar_url: string;
  html_url: string;
  public_repos: number;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  updated_at: string;
}

export interface RecentEntry {
  id: string;
  name: string;
  path: string;
  /** Absolute file paths for single-file openings; lets the desktop app reopen them directly. */
  filePaths?: string[];
  fileCount: number;
  openedAt: number;
  /** Standalone single-file opens vs full folder mounts */
  kind: 'folder' | 'file';
}
