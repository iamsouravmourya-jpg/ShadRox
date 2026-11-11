import type { ChatMessage, PersistedWriteOutcome } from './types';

/**
 * The chat transcript used to live only in React state, so closing the folder —
 * or the app — erased every answer the user paid tokens for. This module stores
 * one transcript per workspace, keyed by the same stable `kind-path` identity
 * the workspace itself uses, so reopening the same folder brings the conversation
 * back.
 *
 * localStorage is shared and small, so the store is deliberately lossy at the
 * edges: only the recent conversations of only the recent workspaces are kept,
 * each trimmed to its newest turns, and an attachment's base64 image is dropped
 * when it is big enough to threaten the whole quota. The text of the
 * conversation — the part that costs money to reproduce — is never dropped
 * except by those caps.
 */

const HISTORY_KEY = 'shadrox.chat.history';
const MAX_WORKSPACES = 12;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 120_000;
/** A base64 screenshot is display sugar; past a few hundred KB it is not worth the quota. */
const MAX_ATTACHMENT_CHARS = 300_000;

export interface HistoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredConversation {
  messages: ChatMessage[];
  updatedAt: number;
}

type HistoryMap = Record<string, StoredConversation>;

/** localStorage, or an in-memory stand-in when storage is unavailable. */
export function getHistoryStore(): HistoryStore {
  const memory = new Map<string, string>();
  let preferred: Storage | null = null;
  try {
    preferred = window.localStorage;
  } catch {
    preferred = null;
  }
  if (!preferred) {
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
      removeItem: (key) => {
        memory.delete(key);
      }
    };
  }
  return {
    getItem: (key) => {
      try {
        return preferred!.getItem(key);
      } catch {
        return memory.get(key) ?? null;
      }
    },
    setItem: (key, value) => {
      try {
        preferred!.setItem(key, value);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem: (key) => {
      try {
        preferred!.removeItem(key);
      } catch {
        memory.delete(key);
      }
    }
  };
}

/**
 * While a reply is still arriving, the transcript is not worth writing: it
 * would serialise the whole history once per streamed chunk. The finished
 * message reaches state a moment later and lands then.
 */
export function shouldSkipHistoryWrite(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => message.streaming);
}

/** What a stored message is allowed to contain, and nothing else. */
function sanitizeMessage(raw: unknown, position: number): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const message = raw as Partial<ChatMessage>;
  if (message.role !== 'user' && message.role !== 'model') return null;
  if (typeof message.content !== 'string') return null;

  let content = message.content;
  // An answer cut in half is a lie about what the model said, so an oversized
  // turn is dropped whole rather than truncated.
  if (content.length > MAX_MESSAGE_CHARS) return null;

  const stored: ChatMessage = {
    id: typeof message.id === 'string' && message.id ? message.id : `restored-${position}`,
    role: message.role,
    content,
    // A restored reply is finished history: the resume path is the interrupted
    // stream snapshot's job, and replaying either flag would offer a button
    // that cannot work.
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString()
  };
  if (typeof message.reasoning === 'string') stored.reasoning = message.reasoning;
  if (Array.isArray(message.attachments)) stored.attachments = message.attachments.filter((a) => typeof a === 'string');
  if (typeof message.attachedImage === 'string' && message.attachedImage.length <= MAX_ATTACHMENT_CHARS) {
    stored.attachedImage = message.attachedImage;
  }
  if (message.refinedMeta) stored.refinedMeta = message.refinedMeta;
  if (message.metrics) stored.metrics = message.metrics;
  if (Array.isArray(message.toolActivity)) {
    stored.toolActivity = message.toolActivity
      .filter((tool) => tool && typeof tool.name === 'string' && typeof tool.label === 'string')
      .map((tool) => ({ name: tool.name, label: tool.label, ok: tool.ok === true, error: typeof tool.error === 'string' ? tool.error : undefined }));
  }
  if (typeof message.toolRounds === 'number') stored.toolRounds = message.toolRounds;
  // A stored turn is history by definition; the chat uses this to avoid
  // claiming "not applied" for edits whose live patch set no longer exists.
  stored.restored = true;
  if (message.writeOutcomes && typeof message.writeOutcomes === 'object') {
    const outcomes: Record<string, PersistedWriteOutcome> = {};
    for (const [path, state] of Object.entries(message.writeOutcomes)) {
      if (
        path &&
        (state === 'applied' || state === 'pending' || state === 'failed' || state === 'skipped' || state === 'reverted')
      ) {
        outcomes[path] = state;
      }
    }
    if (Object.keys(outcomes).length > 0) stored.writeOutcomes = outcomes;
  }
  return stored;
}

function readMap(store: HistoryStore): HistoryMap {
  let raw: string | null = null;
  try {
    raw = store.getItem(HISTORY_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const map: HistoryMap = {};
    for (const [workspaceId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const record = entry as Partial<StoredConversation> | null;
      if (!record || !Array.isArray(record.messages)) continue;
      const messages = record.messages
        .map((message, position) => sanitizeMessage(message, position))
        .filter((message): message is ChatMessage => message !== null);
      if (messages.length === 0) continue;
      map[workspaceId] = { messages, updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0 };
    }
    return map;
  } catch {
    return {};
  }
}

function writeMap(store: HistoryStore, map: HistoryMap): boolean {
  try {
    store.setItem(HISTORY_KEY, JSON.stringify(map));
    return true;
  } catch {
    // The quota is the realistic failure. Dropping the oldest conversations and
    // retrying keeps the newest answer instead of losing it entirely.
    const oldestFirst = Object.entries(map).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [workspaceId] of oldestFirst.slice(0, Math.max(oldestFirst.length - 1, 0))) {
      delete map[workspaceId];
      try {
        store.setItem(HISTORY_KEY, JSON.stringify(map));
        return true;
      } catch {
        continue;
      }
    }
    return false;
  }
}

/** Stores `messages` for one workspace, keeping only the recent conversations and turns. */
export function saveConversation(store: HistoryStore, workspaceId: string, messages: readonly ChatMessage[]): void {
  if (!workspaceId) return;
  const stored = messages
    .filter((message) => !message.streaming)
    .map((message, position) => sanitizeMessage(message, position))
    .filter((message): message is ChatMessage => message !== null);

  const map = readMap(store);
  if (stored.length === 0) {
    delete map[workspaceId];
    writeMap(store, map);
    return;
  }

  // Re-inserting puts this conversation last, so two writes inside the same
  // millisecond still sort oldest-first and the pruning stays deterministic.
  // `Date.now()` alone is not enough: a burst of saves can share a tick, and a
  // stable descending sort would then keep the oldest twelve and drop this one.
  // Bumping past the newest stored stamp makes every save strictly newer.
  delete map[workspaceId];
  const newestStored = Object.values(map).reduce((newest, entry) => Math.max(newest, entry.updatedAt), 0);
  map[workspaceId] = {
    messages: stored.slice(-MAX_MESSAGES),
    updatedAt: Math.max(Date.now(), newestStored + 1)
  };
  const keep = Object.entries(map)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_WORKSPACES);
  const trimmed: HistoryMap = {};
  for (const [id, entry] of keep) trimmed[id] = entry;
  writeMap(store, trimmed);
}

/** The stored transcript for one workspace, or null when there is none. */
export function loadConversation(store: HistoryStore, workspaceId: string): ChatMessage[] | null {
  if (!workspaceId) return null;
  const entry = readMap(store)[workspaceId];
  return entry ? entry.messages : null;
}

export function clearConversation(store: HistoryStore, workspaceId: string): void {
  if (!workspaceId) return;
  const map = readMap(store);
  if (!(workspaceId in map)) return;
  delete map[workspaceId];
  writeMap(store, map);
}
