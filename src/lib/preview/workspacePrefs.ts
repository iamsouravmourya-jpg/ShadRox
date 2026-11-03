/**
 * Per-workspace preview preferences, persisted in localStorage.
 *
 * A workspace's dev server port and the folder the user chose to preview are
 * properties of *this project on this machine*, so they live keyed by workspace
 * id rather than in the main process. Storage is injected to keep this module
 * pure and testable.
 */

export interface PreviewPrefs {
  /** Manual port override; null means "use whatever the runtime reported". */
  port: number | null;
  /** projectPath of the candidate the user picked when several folders were runnable. */
  projectPath: string | null;
}

export const EMPTY_PREFS: PreviewPrefs = { port: null, projectPath: null };

const KEY_PREFIX = 'shadrox.preview.prefs.';
const MAX_PROJECT_PATH = 512;

export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function prefsKey(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

function isStorage(value: PrefsStorage | null | undefined): value is PrefsStorage {
  return !!value && typeof value.getItem === 'function' && typeof value.setItem === 'function';
}

/** Corrupt, foreign or oversized payloads fall back to defaults instead of throwing. */
export function readPrefs(workspaceId: string | null | undefined, storage?: PrefsStorage | null): PreviewPrefs {
  if (!workspaceId || !isStorage(storage)) return { ...EMPTY_PREFS };
  let raw: string | null = null;
  try {
    raw = storage.getItem(prefsKey(workspaceId));
  } catch {
    return { ...EMPTY_PREFS };
  }
  if (!raw) return { ...EMPTY_PREFS };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_PREFS };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_PREFS };
  const record = parsed as Record<string, unknown>;

  const port = record.port;
  const safePort =
    (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) ||
    (typeof port === 'string' && /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)
    ? Number(port)
    : null;

  const projectPath = typeof record.projectPath === 'string' ? record.projectPath.trim() : null;
  const safePath =
    projectPath &&
    projectPath.length <= MAX_PROJECT_PATH &&
    !projectPath.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(projectPath)
      ? projectPath
      : null;

  return { port: safePort, projectPath: safePath };
}

export function writePrefs(workspaceId: string | null | undefined, prefs: PreviewPrefs, storage?: PrefsStorage | null): boolean {
  if (!workspaceId || !isStorage(storage)) return false;
  const payload: PreviewPrefs = {
    port: typeof prefs.port === 'number' && Number.isInteger(prefs.port) && prefs.port >= 1 && prefs.port <= 65535 ? prefs.port : null,
    projectPath: typeof prefs.projectPath === 'string' && prefs.projectPath.trim() && prefs.projectPath.length <= MAX_PROJECT_PATH
      ? prefs.projectPath.trim()
      : null
  };
  try {
    storage.setItem(prefsKey(workspaceId), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearPrefs(workspaceId: string | null | undefined, storage?: PrefsStorage | null): void {
  if (!workspaceId || !isStorage(storage) || typeof storage.removeItem !== 'function') return;
  try {
    storage.removeItem(prefsKey(workspaceId));
  } catch {
    // A locked-down storage backend is not a reason to break the preview.
  }
}

export function parsePortInput(value: string): { ok: true; port: number } | { ok: false; reason: string } {
  const text = value.trim();
  if (!text) return { ok: false, reason: 'Enter a port between 1 and 65535.' };
  if (!/^\d{1,5}$/.test(text)) return { ok: false, reason: 'A port must be digits only.' };
  const port = Number(text);
  if (port < 1 || port > 65535) return { ok: false, reason: 'A port must be between 1 and 65535.' };
  return { ok: true, port };
}
