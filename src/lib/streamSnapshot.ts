/**
 * Interrupted-stream snapshots — the single source of truth for "a reply was
 * cut off mid-way and can be resumed after a reload".
 *
 * The bug this module fixes: the snapshot used to be written by whichever code
 * path noticed the drop, and cleared by whichever code path remembered to call
 * `clearInterruptedStream()`. Regenerate, delete, workspace switch and a failed
 * resume all missed that call, so a reload could overwrite the live
 * conversation with a stale snapshot — or lose a partial reply forever.
 *
 * The invariant, enforced here and nowhere else:
 *
 *   a persisted snapshot always describes the currently-displayed conversation
 *
 * `syncInterruptedSnapshot()` is called on every change to the messages array
 * (plus the resume prefixes and the workspace identity). It recomputes the
 * snapshot from scratch and writes, refreshes or removes it. No mutation path
 * can forget to clear it because none of them own it.
 */
import type { ChatMessage } from './types';
import type { RefineMode } from './types';

/** sessionStorage key holding the chat state of a stream interrupted mid-reply. */
export const INTERRUPTED_STREAM_KEY = 'shadrox.interruptedStream';

export interface InterruptedStreamSnapshot {
  messages: ChatMessage[];
  interruptedId: string;
  prefix: string;
  refineMode: RefineMode;
  /** Workspace the conversation belongs to; guards a stale cross-workspace restore. */
  workspaceId: string | null;
  /** The user turn that produced the interrupted reply, for restore-time validation. */
  lastUserMessageId: string | null;
}

export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConversationState {
  messages: ChatMessage[];
  /** Partial replies keyed by message id, maintained by the streaming handlers. */
  prefixes: Record<string, string>;
  refineMode: RefineMode;
  workspaceId: string | null;
}

export interface RestoredConversation {
  messages: ChatMessage[];
  interruptedId: string;
  prefix: string;
  refineMode: RefineMode;
}

/** sessionStorage, or an in-memory stand-in for tests / privacy modes. */
export function getSessionStore(): SnapshotStorage | null {
  try {
    const store = window.sessionStorage;
    return store ? {
      getItem: (key) => store.getItem(key),
      setItem: (key, value) => store.setItem(key, value),
      removeItem: (key) => store.removeItem(key)
    } : null;
  } catch {
    return null;
  }
}

function prefixOf(message: ChatMessage, prefixes: Record<string, string>): string {
  return (prefixes[message.id] ?? message.content).trim();
}

/**
 * The last non-streaming message flagged `resumable` with actual text, or null.
 * A live stream (`streaming: true`) is deliberately ignored: while a request is
 * in flight there is nothing to resume, so nothing may be persisted.
 */
function findInterrupted(messages: ChatMessage[], prefixes: Record<string, string>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.streaming) return -1;
    if (message.role === 'model' && message.resumable && prefixOf(message, prefixes)) return index;
  }
  return -1;
}

/**
 * Derives the snapshot that currently describes this conversation, or `null`
 * when nothing is interrupted (which means nothing may be persisted).
 */
export function snapshotForConversation(state: ConversationState): InterruptedStreamSnapshot | null {
  const index = findInterrupted(state.messages, state.prefixes);
  if (index < 0) return null;

  const target = state.messages[index];
  const prefix = prefixOf(target, state.prefixes);

  // A resumable reply without a user turn before it is not a conversation we
  // are allowed to restore, so it is not a snapshot either.
  let lastUserIndex = -1;
  for (let scan = index - 1; scan >= 0; scan -= 1) {
    if (state.messages[scan].role === 'user') {
      lastUserIndex = scan;
      break;
    }
  }
  if (lastUserIndex < 0 || !state.messages[lastUserIndex].content.trim()) return null;

  // The snapshot must be self-consistent: the restored transcript shows exactly
  // the text that is resumed from, so the interrupted message's content is
  // rewritten to the accumulated prefix instead of trusting whatever the array
  // happened to hold (they can differ by trailing whitespace after a trim).
  const messages = state.messages.map((message) => ({
    ...message,
    content: message.id === target.id ? prefix : message.content,
    streaming: false,
    resumable: message.id === target.id
  }));

  return {
    messages,
    interruptedId: target.id,
    prefix,
    refineMode: state.refineMode,
    workspaceId: state.workspaceId,
    lastUserMessageId: state.messages[lastUserIndex].id
  };
}

/**
 * Forgets resume prefixes whose message is gone. Regenerate truncates the
 * transcript and clearing a chat empties it, and without this the prefixes —
 * which hold the partial reply text — would grow forever.
 *
 * Returns the input reference when nothing changed so callers can skip a
 * state update (and therefore a re-render).
 */
export function pruneResumePrefixes(
  prefixes: Record<string, string>,
  messages: ChatMessage[]
): Record<string, string> {
  const alive = new Set(messages.map((message) => message.id));
  const dead = Object.keys(prefixes).filter((id) => !alive.has(id));
  if (dead.length === 0) return prefixes;
  const next: Record<string, string> = {};
  Object.entries(prefixes).forEach(([id, value]) => {
    if (alive.has(id)) next[id] = value;
  });
  return next;
}

/**
 * Rewrites, clears or leaves alone the persisted snapshot so it matches the
 * conversation on screen. Returns the pruned prefix map for the same reason:
 * one call, one place, every mutation path covered.
 */
export function syncInterruptedSnapshot(
  store: SnapshotStorage | null,
  state: ConversationState
): { persisted: boolean; prefixes: Record<string, string> } {
  const prefixes = pruneResumePrefixes(state.prefixes, state.messages);
  if (!store) return { persisted: false, prefixes };

  const snapshot = snapshotForConversation({ ...state, prefixes });
  const raw = snapshot ? JSON.stringify(snapshot) : null;

  let current: string | null = null;
  try {
    current = store.getItem(INTERRUPTED_STREAM_KEY);
  } catch {
    current = null;
  }
  if (current === raw) return { persisted: Boolean(snapshot), prefixes };

  try {
    if (raw === null) {
      if (current !== null) store.removeItem(INTERRUPTED_STREAM_KEY);
      return { persisted: false, prefixes };
    }
    store.setItem(INTERRUPTED_STREAM_KEY, raw);
    return { persisted: true, prefixes };
  } catch {
    /* storage unavailable — the in-memory resume path still works */
    return { persisted: false, prefixes };
  }
}

/** Structural + semantic checks a snapshot must pass before it may touch state. */
export function validateSnapshot(
  snapshot: InterruptedStreamSnapshot | null | undefined,
  context: { workspaceId: string | null } = { workspaceId: null }
): RestoredConversation | null {
  if (!snapshot || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return null;
  if (!snapshot.interruptedId || !snapshot.prefix?.trim()) return null;

  const index = snapshot.messages.findIndex((message) => message.id === snapshot.interruptedId);
  if (index < 0) return null;
  const target = snapshot.messages[index];
  if (target.role !== 'model') return null;
  if (target.streaming) return null;
  // The snapshot has to describe the text that is on screen, otherwise
  // resuming would duplicate or drop output.
  if (target.content.trim() !== snapshot.prefix.trim()) return null;

  const lastUserIndex = (() => {
    for (let scan = index - 1; scan >= 0; scan -= 1) {
      if (snapshot.messages[scan].role === 'user') return scan;
    }
    return -1;
  })();
  if (lastUserIndex < 0) return null;
  const lastUser = snapshot.messages[lastUserIndex];
  if (!lastUser.content.trim()) return null;
  if (snapshot.lastUserMessageId && snapshot.lastUserMessageId !== lastUser.id) return null;

  // Stale-snapshot guard. The restore only happens once a workspace is mounted,
  // and the snapshot must be attributable to *that* workspace: a snapshot that
  // cannot say where it came from (its workspace was closed) is a description of
  // a conversation the user already left, so it is dropped rather than replayed
  // into an unrelated project.
  if (!snapshot.workspaceId || !context.workspaceId) return null;
  if (snapshot.workspaceId !== context.workspaceId) return null;

  const refineMode = snapshot.refineMode;
  return {
    messages: snapshot.messages.map((message) => ({
      ...message,
      streaming: false,
      resumable: message.id === snapshot.interruptedId
    })),
    interruptedId: snapshot.interruptedId,
    prefix: snapshot.prefix,
    refineMode: refineMode === 'plan' || refineMode === 'complex' || refineMode === 'code'
      ? refineMode
      : 'code'
  };
}

/**
 * Reads and validates the persisted snapshot, removing it whichever way the
 * decision goes: a snapshot is consumed exactly once.
 */
export function takeRestorableSnapshot(
  store: SnapshotStorage | null,
  context: { workspaceId: string | null }
): RestoredConversation | null {
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(INTERRUPTED_STREAM_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: InterruptedStreamSnapshot | null = null;
  try {
    parsed = JSON.parse(raw) as InterruptedStreamSnapshot;
  } catch {
    parsed = null;
  }

  const restored = validateSnapshot(parsed, context);
  try {
    // An unusable snapshot is dropped (it would be a lie about the current
    // conversation), and a usable one is consumed so it cannot be replayed.
    store.removeItem(INTERRUPTED_STREAM_KEY);
  } catch {
    /* ignore */
  }
  return restored;
}
