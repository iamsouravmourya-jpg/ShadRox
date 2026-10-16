export type Stage = 'STAGE_1' | 'STAGE_2' | 'STAGE_3';

export type TabType = 'CODE' | 'PREVIEW';

export type SettingsTab = 'CHAT' | 'GITHUB' | 'SECRETS';

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
}

export interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
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
  fileCount: number;
  openedAt: number;
  /** Standalone single-file opens vs full folder mounts */
  kind: 'folder' | 'file';
}
