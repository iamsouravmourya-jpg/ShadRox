import type { TerminalMode } from '../desktop';

export type TerminalSessionStatus = 'starting' | 'connected' | 'exited' | 'failed';

export interface TerminalSession {
  /**
   * Renderer-owned identity, reused verbatim as the pty key on every
   * `terminal:create`. It has to survive a tab switch, a restart and a re-dock so
   * the desktop can tell "the shell for this tab already exists" from "spawn a
   * new shell"; a UUID minted by main cannot do that because main forgets it when
   * the tab's last pty dies.
   */
  key: string;
  name: string;
  mode: TerminalMode;
  status: TerminalSessionStatus;
}

export interface TerminalSessionsState {
  sessions: TerminalSession[];
  activeKey: string | null;
  /** How many tabs have ever been created; only used to name the next default tab. */
  created: number;
}

export type TerminalSessionsAction =
  | { type: 'add'; key: string; name?: string; mode: TerminalMode }
  | { type: 'activate'; key: string }
  | { type: 'cycle'; delta: number }
  | { type: 'rename'; key: string; name: string }
  | { type: 'status'; key: string; status: TerminalSessionStatus }
  | { type: 'close'; key: string };

export const MAX_TERMINAL_SESSIONS = 12;
export const MAX_SESSION_NAME_LENGTH = 40;

export function createTerminalSessions(sessions: TerminalSession[] = []): TerminalSessionsState {
  return {
    sessions: sessions.map((session) => ({ ...session })),
    activeKey: sessions.length > 0 ? sessions[sessions.length - 1].key : null,
    created: sessions.length
  };
}

/** Tab labels are user text, so control bytes cannot reach the tab strip or the pty. */
export function sanitizeSessionName(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SESSION_NAME_LENGTH);
  return cleaned || fallback.slice(0, MAX_SESSION_NAME_LENGTH);
}

export function nextSessionName(created: number): string {
  return `Shell ${Math.max(0, created) + 1}`;
}

export function activeTerminalSession(state: TerminalSessionsState): TerminalSession | null {
  return state.sessions.find((session) => session.key === state.activeKey) ?? null;
}

export function findTerminalSession(state: TerminalSessionsState, key: string): TerminalSession | null {
  return state.sessions.find((session) => session.key === key) ?? null;
}

export function terminalSessionsReducer(
  state: TerminalSessionsState,
  action: TerminalSessionsAction
): TerminalSessionsState {
  switch (action.type) {
    case 'add': {
      if (state.sessions.length >= MAX_TERMINAL_SESSIONS) return state;
      if (state.sessions.some((session) => session.key === action.key)) return state;
      const created = state.created + 1;
      const session: TerminalSession = {
        key: action.key,
        name: sanitizeSessionName(action.name ?? '', nextSessionName(state.created)),
        mode: action.mode === 'agent' ? 'agent' : 'system',
        status: 'starting'
      };
      return { sessions: [...state.sessions, session], activeKey: session.key, created };
    }
    case 'activate': {
      if (action.key === state.activeKey) return state;
      if (!state.sessions.some((session) => session.key === action.key)) return state;
      return { ...state, activeKey: action.key };
    }
    case 'cycle': {
      if (state.sessions.length < 2) return state;
      const current = state.sessions.findIndex((session) => session.key === state.activeKey);
      const from = current < 0 ? 0 : current;
      const step = action.delta < 0 ? -1 : 1;
      // Wrapping matches the tab strip: the next tab after the last one is the first.
      const next = (from + step + state.sessions.length) % state.sessions.length;
      return { ...state, activeKey: state.sessions[next].key };
    }
    case 'rename': {
      const index = state.sessions.findIndex((session) => session.key === action.key);
      if (index < 0) return state;
      const name = sanitizeSessionName(action.name, state.sessions[index].name);
      if (name === state.sessions[index].name) return state;
      const sessions = [...state.sessions];
      sessions[index] = { ...sessions[index], name };
      return { ...state, sessions };
    }
    case 'status': {
      const index = state.sessions.findIndex((session) => session.key === action.key);
      if (index < 0) return state;
      if (state.sessions[index].status === action.status) return state;
      const sessions = [...state.sessions];
      sessions[index] = { ...sessions[index], status: action.status };
      return { ...state, sessions };
    }
    case 'close': {
      const index = state.sessions.findIndex((session) => session.key === action.key);
      if (index < 0) return state;
      const sessions = state.sessions.filter((session) => session.key !== action.key);
      let activeKey = state.activeKey;
      if (state.activeKey === action.key) {
        // Land on the tab that slid into the closed slot, else the one to its left.
        const neighbour = sessions[index] ?? sessions[index - 1] ?? null;
        activeKey = neighbour ? neighbour.key : null;
      }
      return { ...state, sessions, activeKey };
    }
    default:
      return state;
  }
}

const rememberedSessions = new Map<string, TerminalSession[]>();
const MAX_REMEMBERED_WORKSPACES = 8;

/**
 * The dock unmounts when it is closed, so the tab list lives here instead of in
 * component state. Recalled sessions always start as `starting`: their shell died
 * with the previous mount, only the identity and the label survived.
 */
export function rememberWorkspaceSessions(workspaceId: string, sessions: TerminalSession[]): void {
  if (rememberedSessions.has(workspaceId)) rememberedSessions.delete(workspaceId);
  rememberedSessions.set(workspaceId, sessions.map((session) => ({ ...session })));
  while (rememberedSessions.size > MAX_REMEMBERED_WORKSPACES) {
    const oldest = rememberedSessions.keys().next();
    if (oldest.done) break;
    rememberedSessions.delete(oldest.value);
  }
}

export function recallWorkspaceSessions(workspaceId: string): TerminalSession[] {
  const remembered = rememberedSessions.get(workspaceId);
  if (!remembered || remembered.length === 0) return [];
  rememberedSessions.delete(workspaceId);
  rememberedSessions.set(workspaceId, remembered);
  return remembered
    .slice(0, MAX_TERMINAL_SESSIONS)
    .map((session) => ({ ...session, status: 'starting' as TerminalSessionStatus }));
}

export function forgetWorkspaceSessions(workspaceId: string): void {
  rememberedSessions.delete(workspaceId);
}
