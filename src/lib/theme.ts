/**
 * The app's theme: one stored choice (day / night), one resolved value, one
 * place that writes `data-theme` on <html>. Everything else — CSS tokens,
 * CodeMirror, the terminal, the native window chrome — reads from here so a
 * single click repaints the whole app consistently.
 *
 * Before the user ever picks a side, the app starts on whatever the OS uses;
 * the first toggle stores an explicit day/night choice.
 */

import { getDesktopBridge } from './desktop';

export type ThemeMode = 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'shadrox.theme';

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readStoredMode(): ThemeMode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* storage unavailable (private mode) — fall through to the OS default */
  }
  return null;
}

let mode: ThemeMode = readStoredMode() ?? systemTheme();
let resolved: ResolvedTheme = mode;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function apply() {
  resolved = mode;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f7fb' : '#090a0d');
  }
  // The native chrome (window buttons, dialogs) follows the same choice.
  getDesktopBridge()?.setTheme?.(mode);
  emit();
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved;
}

export function setThemeMode(next: ThemeMode) {
  if ((next !== 'light' && next !== 'dark') || next === mode) return;
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* the choice still applies for this session */
  }
  apply();
}

/** day → night → day, for the one-button toggle. */
export function cycleThemeMode() {
  setThemeMode(mode === 'light' ? 'dark' : 'light');
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Call once before React renders so the first paint is already themed. */
export function initTheme() {
  apply();
}

/** Concrete colors for surfaces that cannot read CSS variables (xterm). */
export function terminalPalette(theme: ResolvedTheme = resolved) {
  return theme === 'light'
    ? { background: '#fbfbfd', foreground: '#24292f', cursor: '#7c3aed', selectionBackground: '#ddd6fe' }
    : { background: '#050505', foreground: '#d4d4d4', cursor: '#34d399', selectionBackground: '#065f46' };
}
