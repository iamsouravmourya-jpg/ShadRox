/**
 * App-level navigation stack for the preview frame.
 *
 * The dev-server frame is cross-origin, so `iframe.contentWindow.history`
 * throws and nothing inside the page can be trusted to report where it went.
 * Navigation is therefore modelled here as an explicit list of addresses the
 * user asked ShadRox to load, which keeps back/forward honest: it can only
 * revisit pages this panel opened, never the page's own internal history.
 */

export const NAVIGATION_LIMIT = 32;
export const MAX_ADDRESS_LENGTH = 2048;

export interface NavigationState {
  entries: string[];
  /** Index of the active entry; -1 when the stack is empty. */
  index: number;
}

export type AddressResult = { ok: true; url: string } | { ok: false; reason: string };

const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:', 'shadrox-preview:']);

export function emptyNavigation(): NavigationState {
  return { entries: [], index: -1 };
}

export function createNavigation(url?: string | null): NavigationState {
  if (!url) return emptyNavigation();
  return { entries: [url], index: 0 };
}

export function currentUrl(state: NavigationState): string | null {
  if (state.index < 0 || state.index >= state.entries.length) return null;
  return state.entries[state.index];
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavigationState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

function trim(entries: string[], wantedIndex: number): { entries: string[]; index: number } {
  if (entries.length <= NAVIGATION_LIMIT) return { entries, index: wantedIndex };
  const excess = entries.length - NAVIGATION_LIMIT;
  return { entries: entries.slice(excess), index: Math.max(0, wantedIndex - excess) };
}

/** Appends an address, discarding any forward entries and capping the stack. */
export function pushEntry(state: NavigationState, url: string): NavigationState {
  if (!url) return state;
  if (currentUrl(state) === url) return state;
  const kept = state.entries.slice(0, state.index + 1);
  kept.push(url);
  const next = trim(kept, kept.length - 1);
  return { entries: next.entries, index: next.index };
}

/** Swaps the active entry without growing the stack — used when the server's URL changes. */
export function replaceEntry(state: NavigationState, url: string): NavigationState {
  if (!url || state.index < 0) return createNavigation(url);
  if (state.entries[state.index] === url) return state;
  const entries = state.entries.slice();
  entries[state.index] = url;
  return { entries, index: state.index };
}

export function goBack(state: NavigationState): NavigationState {
  return canGoBack(state) ? { entries: state.entries, index: state.index - 1 } : state;
}

export function goForward(state: NavigationState): NavigationState {
  return canGoForward(state) ? { entries: state.entries, index: state.index + 1 } : state;
}

export function clearNavigation(): NavigationState {
  return emptyNavigation();
}

/** Scheme + host of an address, or null when it is not a URL at all. */
function authorityOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function isNavigable(url: URL): boolean {
  return NAVIGABLE_PROTOCOLS.has(url.protocol);
}

/**
 * Resolves what the user typed against the running server's address.
 * Absolute URLs must stay on the same scheme + host, so the preview frame can
 * never be pointed at an arbitrary site through the address bar.
 */
export function resolveAddress(baseUrl: string | null, rawInput: string): AddressResult {
  const input = rawInput.trim();
  if (!input) return { ok: false, reason: 'Enter an address.' };
  if (input.length > MAX_ADDRESS_LENGTH) return { ok: false, reason: 'That address is too long.' };
  if (/[\u0000-\u001f\u007f]/.test(input)) return { ok: false, reason: 'That address contains invalid characters.' };

  let base: URL | null = null;
  if (baseUrl) {
    try {
      base = new URL(baseUrl);
    } catch {
      base = null;
    }
  }

  let candidate: URL;
  try {
    candidate = base ? new URL(input, base) : new URL(input);
  } catch {
    return { ok: false, reason: base ? 'Type a path on this server, e.g. /about' : 'No preview server is running.' };
  }

  if (!isNavigable(candidate)) {
    return { ok: false, reason: `Cannot load ${candidate.protocol} addresses in the preview.` };
  }
  if (!base) {
    return { ok: false, reason: 'No preview server is running, so only its own pages can be opened.' };
  }
  if (authorityOf(candidate) !== authorityOf(base)) {
    return { ok: false, reason: `Only pages on ${authorityOf(base)} can be previewed.` };
  }
  return { ok: true, url: candidate.toString() };
}

/** The server root of an address, used by the home button and port override. */
export function rootUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Rewrites only the port of a server address; returns the input when it cannot apply. */
export function withPort(url: string | null, port: number | null): string | null {
  if (!url || !port) return url;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return url;
  try {
    const parsed = new URL(url);
    parsed.port = String(port);
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Compact display form: host + path, never the scheme noise of a localhost URL. */
export function describeAddress(url: string | null): { origin: string; path: string } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return {
      origin: `${parsed.protocol}//${parsed.host}`,
      path: `${parsed.pathname}${parsed.search}${parsed.hash}`
    };
  } catch {
    return null;
  }
}
