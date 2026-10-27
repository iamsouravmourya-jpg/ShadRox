export type Stage = 'STAGE_2' | 'STAGE_3';

export type TabType = 'CODE' | 'PREVIEW';

export type SettingsTab = 'CHAT' | 'PLAN' | 'GITHUB' | 'SECRETS';

/**
 * UI-only plan ladder. Nothing is wired to billing yet — there is no database,
 * so the upgrade buttons just preview a tier locally.
 */
export type PlanTier = 'free' | 'pro' | 'adv' | 'enterprise';

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

export interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'file';
  nativeWorkspaceId?: string;
  files: WorkspaceFile[];
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
  /** Provider reasoning stream (Gemini thoughts / Groq reasoning models). */
  reasoning?: string;
  /** Latency and token usage reported by the streaming endpoint. */
  metrics?: { tokens: number; firstTokenMs: number | null; durationMs: number | null };
  /** True when the stream died mid-way and can be continued without losing output. */
  resumable?: boolean;
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
