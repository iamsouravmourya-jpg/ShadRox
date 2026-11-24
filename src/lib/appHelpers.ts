import { normalizeSlashes } from './diagnostics';
import {
  createMemoryStore,
  parseBackgroundSnapshot,
  serializeBackgroundSnapshot,
  type BackgroundRunStore
} from './autonomy/background';
import type { AutomationState } from './automations';
import type { PastedText, PinnedSymbol } from '../components/ChatPanel';
import type { QueuedChatItem } from './chatQueue';
import type { IntroducedDiagnostics, VerificationCard } from './calibratedAuto/evidence';
import type { PluginLoadEntry } from './plugins';
import type { RequestEnvelope } from './requestEnvelope';
import type { ChatMessage, PersistedWriteOutcome, RefineMode, RefinedPromptMeta, ReviewPatch } from './types';

/**
 * How much of a folder workspace the prompt may see when no tabs are open.
 * The explorer is deliberately lazy, but a model that is told "never invent a
 * path" has to be shown some real file contents, so a few files are read from
 * disk per request. Bytes, not tokens: these are upper bounds and the context
 * fitter still degrades the result to the model's window.
 */
export const MAX_DISK_CONTEXT_FILES = 12;
export const MAX_DISK_CONTEXT_BYTES = 60_000;
export const MAX_DISK_CONTEXT_TOTAL_BYTES = 180_000;

/** Auto's cheap reader chooses from this many candidates, not from 12. */
export const PICKER_WIDEN = 4;
export const MAX_PICKER_PICKS = 8;
/** A cheap model that is slow is worse than no cheap model at all. */
export const PICKER_TIMEOUT_MS = 20_000;
/** What a full disk-context read costs, before Auto has trimmed it (chars ≈ 4/byte). */
export const DISK_CONTEXT_TOKEN_ESTIMATE = Math.round(MAX_DISK_CONTEXT_TOTAL_BYTES / 4);

/** How much of the active / attached file the system instruction wants at most. */
export const ACTIVE_FILE_EXCERPT_CHARS = 12_000;
export const ATTACHED_FILE_EXCERPT_CHARS = 12_000;

/** Result of the esbuild-wasm compile that powers the live preview. */
export type BundleState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; html: string; label: string }
  | { status: 'error'; message: string };

export function formatTime(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The chat message a live run/team is writing into, plus the goal it must match. */
export interface ActiveOrchestration {
  messageId: string;
  goal: string;
  startedAt: number;
  kind: 'autonomy' | 'team';
  seenRunning: boolean;
  /**
   * True when this card continues a run that already exists. A resumed run keeps
   * its original `startedAt`, so the "is this the run I just started" check has to
   * compare the goal alone — otherwise a resume looks like a run that never began.
   */
  resumed?: boolean;
}

export type OrchestrationStatus = NonNullable<ChatMessage['orchestration']>['status'];

export interface QueuedChatDraft extends QueuedChatItem {
  attachedFiles: string[];
  attachedImage: string | null;
  /** Long clipboard pastes kept out of the message body, sent as text context. */
  pastedTexts: PastedText[];
  pinnedSymbols: PinnedSymbol[];
  pendingRefine: RefinedPromptMeta | null;
  refineMode: RefineMode;
  /** Frozen execution identity captured at send time (S01), not live app state. */
  envelope: RequestEnvelope;
}

/**
 * One apply pass, reported so the turn can log evidence rather than intent.
 * `verification` and `diagnostics` stay absent when the pass never reached the
 * checks — an unanswered check is no data, not a failure.
 */
export interface ReviewSetOutcome {
  applied: string[];
  failures: string[];
  verification?: VerificationCard | null;
  diagnostics?: IntroducedDiagnostics | null;
}

/**
 * What one Auto reader pass produced, written by the pass itself.
 *
 * `ran` distinguishes a picker call that happened from a turn that skipped it —
 * a short request needs no second pass and must never be recorded against the
 * model that would have run it.
 */
export interface PickerReport {
  model: string;
  ran: boolean;
  shortlist: number;
  answered: boolean;
  picked: number;
  durationMs: number;
}

export function orchestrationStatusOfRun(status: string, isRunning = true): OrchestrationStatus {
  switch (status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'paused':
      // Its own state, never folded into 'stopped': a paused run can continue,
      // and the card offers Resume only when it can.
      return 'paused';
    case 'cancelled':
    case 'stopped':
      return 'stopped';
    case 'planning':
    case 'ready':
    case 'running':
      return isRunning ? 'running' : 'failed';
    default:
      return isRunning ? 'running' : 'failed';
  }
}

/**
 * A run only exists inside this process, so a restored "running" card is a lie:
 * the engine that was writing into it is gone. Settle those on load so the user
 * sees an interrupted run instead of a spinner that never ends.
 */
export function settleRestoredOrchestration(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const settled = messages.map((message) => {
    const status = message.orchestration?.status;
    if (!message.orchestration || (status !== 'planning' && status !== 'running')) return message;
    changed = true;
    return {
      ...message,
      streaming: false,
      content:
        message.content ||
        'This run was interrupted when the app closed. Send the request again to retry.',
      orchestration: {
        ...message.orchestration,
        status: 'stopped' as const,
        detail: 'Interrupted when the app closed.'
      }
    };
  });
  return changed ? settled : messages;
}

/**
 * Per-file write outcomes worth persisting, with the same precedence the chat
 * bullets use: a failure outranks a pending review, which outranks a success.
 */
export function summarizeWriteOutcomes(patches: ReviewPatch[]): Record<string, PersistedWriteOutcome> {
  const byPath = new Map<string, { path: string; statuses: ReviewPatch['status'][] }>();
  for (const patch of patches) {
    const key = normalizeSlashes(patch.path).toLowerCase();
    const entry = byPath.get(key);
    if (entry) entry.statuses.push(patch.status);
    else byPath.set(key, { path: patch.path, statuses: [patch.status] });
  }
  const outcomes: Record<string, PersistedWriteOutcome> = {};
  for (const { path, statuses } of byPath.values()) {
    outcomes[path] = statuses.includes('failed')
      ? 'failed'
      : statuses.includes('pending')
        ? 'pending'
        : statuses.includes('applied')
          ? 'applied'
          : statuses.every((status) => status === 'rejected')
            ? 'skipped'
            : 'reverted';
  }
  return outcomes;
}

// --- background runs ---------------------------------------------------------
// A snapshot describes a run; it never carries file contents or replies. The
// store is localStorage-backed, with an in-memory fallback for private mode.

const BACKGROUND_RUNS_KEY = 'shadrox.backgroundRuns.v1';

function readLocalStorage(key: string): Storage | null {
  try {
    const storage = window.localStorage;
    const probe = `${key}.probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function createBackgroundStore(): BackgroundRunStore {
  const storage = readLocalStorage(BACKGROUND_RUNS_KEY);
  if (!storage) return createMemoryStore();

  const read = (): string[] => {
    try {
      const raw = storage.getItem(BACKGROUND_RUNS_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
      return [];
    }
  };
  const write = (entries: string[]): void => {
    try {
      storage.setItem(BACKGROUND_RUNS_KEY, JSON.stringify(entries));
    } catch {
      /* quota or private mode: the run that is live still runs */
    }
  };
  const runIdOf = (entry: string): string | null => parseBackgroundSnapshot(entry).snapshot?.runId ?? null;

  return {
    load: read,
    save(snapshot) {
      const raw = serializeBackgroundSnapshot(snapshot);
      const entries = read();
      const index = entries.findIndex((entry) => runIdOf(entry) === snapshot.runId);
      if (index >= 0) entries[index] = raw;
      else entries.push(raw);
      write(entries);
    },
    remove(runId) {
      write(read().filter((entry) => runIdOf(entry) !== runId));
    }
  };
}

export function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  const windows = /^[A-Za-z]:/.test(a) || /^[A-Za-z]:/.test(b);
  return windows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// --- automations -------------------------------------------------------------

const AUTOMATION_STATE_KEY = 'shadrox.automations.state.v1';
export const AUTOMATION_POLL_MS = 30_000;
export const AUTOMATIONS_PATH = '.shadrox/automations.json';
export const MAX_PLUGIN_PROMPTS_PER_BATCH = 3;
export const MAX_PLUGIN_COMMANDS_PER_BATCH = 3;
export const MAX_PLUGIN_PROMPT_QUEUE = 6;

/** The desktop methods introduced in v0.0.3; optional so an older shell still boots. */
export interface AutomationDesktopApi {
  scanPlugins?: (workspaceId: string) => Promise<{ files: PluginLoadEntry[]; errors: string[] }>;
  stopBackendPreview?: (workspaceId: string) => Promise<unknown>;
}

export function workspaceRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isPluginManifestPath(path: string): boolean {
  return /(?:^|\/)\.shadrox\/plugins\/[^/]+\/plugin\.json$/.test(workspaceRelative(path));
}

/** The documents `loadProjectDocs` reads; a save to any of them re-loads the prompt rules. */
export function isProjectDocPath(path: string): boolean {
  const clean = workspaceRelative(path);
  return /(?:^|\/)(?:SHADROX|AGENTS|QODER)\.md$/i.test(clean)
    || clean.toLowerCase() === '.cursorrules'
    || /^\.shadrox\/(?:rules|skills)\/[^/]+\.md$/i.test(clean);
}

export function readAutomationStates(root: string): Record<string, AutomationState> {
  try {
    const raw = window.localStorage.getItem(AUTOMATION_STATE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const states = (parsed as Record<string, unknown>)[root];
    if (!states || typeof states !== 'object' || Array.isArray(states)) return {};
    const result: Record<string, AutomationState> = {};
    for (const [id, value] of Object.entries(states as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Partial<AutomationState>;
      if (typeof entry.id !== 'string' || typeof entry.createdAt !== 'number' || typeof entry.runCount !== 'number') continue;
      result[id] = {
        id: entry.id,
        createdAt: entry.createdAt,
        runCount: entry.runCount,
        ...(typeof entry.lastRunAt === 'number' ? { lastRunAt: entry.lastRunAt } : {}),
        ...(typeof entry.dayKey === 'string' ? { dayKey: entry.dayKey } : {})
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function writeAutomationStates(root: string, states: Record<string, AutomationState>): void {
  try {
    const raw = window.localStorage.getItem(AUTOMATION_STATE_KEY);
    let byRoot: Record<string, unknown> = {};
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) byRoot = parsed as Record<string, unknown>;
    }
    byRoot[root] = states;
    window.localStorage.setItem(AUTOMATION_STATE_KEY, JSON.stringify(byRoot));
  } catch {
    /* storage is optional; the scheduler still runs in memory */
  }
}

/**
 * Electron wraps every IPC rejection in `Error invoking remote method 'x':`,
 * which reads as a crash instead of a fixable preview problem.
 */
export function friendlyPreviewError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/i, '').trim() || message;
}
