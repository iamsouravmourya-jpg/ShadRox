/**
 * Terminal dock height.
 *
 * The panel sizes itself with an inline style because the wrapper in App.tsx is a
 * fixed-height div that the panel cannot edit; these helpers keep the number
 * inside bounds that leave the editor usable, and in `localStorage` so a resized
 * dock survives reopening it.
 */

export const TERMINAL_MIN_HEIGHT = 96;
export const TERMINAL_DEFAULT_HEIGHT = 224;
export const TERMINAL_MAX_HEIGHT = 960;
export const TERMINAL_RESIZE_STEP = 16;
export const TERMINAL_MIN_EDITOR_SPACE = 220;
export const TERMINAL_HEIGHT_STORAGE_KEY = 'shadrox.terminal.dockHeight';

export interface HeightStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function clampTerminalHeight(value: number, viewportHeight: number = 1080): number {
  const requested = Number.isFinite(value) ? Math.round(value) : TERMINAL_DEFAULT_HEIGHT;
  // A dock taller than the window minus the editor floor is unusable, so the
  // ceiling follows the viewport rather than being a fixed pixel count.
  const viewportLimit = Math.floor(viewportHeight) - TERMINAL_MIN_EDITOR_SPACE;
  const max = Math.max(TERMINAL_MIN_HEIGHT, Math.min(TERMINAL_MAX_HEIGHT, viewportLimit));
  if (requested < TERMINAL_MIN_HEIGHT) return TERMINAL_MIN_HEIGHT;
  if (requested > max) return max;
  return requested;
}

/** Dragging the top handle up (`deltaY` negative) grows the dock. */
export function terminalHeightFromDrag(
  startHeight: number,
  deltaY: number,
  viewportHeight: number = 1080
): number {
  const start = Number.isFinite(startHeight) ? startHeight : TERMINAL_DEFAULT_HEIGHT;
  const delta = Number.isFinite(deltaY) ? deltaY : 0;
  return clampTerminalHeight(start - delta, viewportHeight);
}

export function terminalHeightFromKey(height: number, key: string, viewportHeight: number = 1080): number {
  const step = Number.isFinite(height) ? height : TERMINAL_DEFAULT_HEIGHT;
  if (key === 'ArrowUp') return clampTerminalHeight(step + TERMINAL_RESIZE_STEP, viewportHeight);
  if (key === 'ArrowDown') return clampTerminalHeight(step - TERMINAL_RESIZE_STEP, viewportHeight);
  if (key === 'Home') return TERMINAL_DEFAULT_HEIGHT;
  if (key === 'End') return clampTerminalHeight(TERMINAL_MAX_HEIGHT, viewportHeight);
  return clampTerminalHeight(step, viewportHeight);
}

export function readTerminalHeight(
  storage: HeightStorage | null | undefined,
  viewportHeight: number = 1080
): number {
  if (!storage) return TERMINAL_DEFAULT_HEIGHT;
  try {
    const raw = storage.getItem(TERMINAL_HEIGHT_STORAGE_KEY);
    if (raw === null) return TERMINAL_DEFAULT_HEIGHT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return TERMINAL_DEFAULT_HEIGHT;
    return clampTerminalHeight(parsed, viewportHeight);
  } catch {
    return TERMINAL_DEFAULT_HEIGHT;
  }
}

export function writeTerminalHeight(storage: HeightStorage | null | undefined, height: number): void {
  if (!storage) return;
  try {
    storage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(Math.round(height)));
  } catch {
    // Private-mode and full-quota storage failures are not worth surfacing.
  }
}
