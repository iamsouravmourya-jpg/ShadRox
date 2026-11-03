import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TERMINAL_DEFAULT_HEIGHT,
  TERMINAL_HEIGHT_STORAGE_KEY,
  TERMINAL_MAX_HEIGHT,
  TERMINAL_MIN_EDITOR_SPACE,
  TERMINAL_MIN_HEIGHT,
  TERMINAL_RESIZE_STEP,
  clampTerminalHeight,
  readTerminalHeight,
  terminalHeightFromDrag,
  terminalHeightFromKey,
  writeTerminalHeight
} from './dockHeight';

function fakeStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values
  };
}

test('heights are clamped to a usable band', () => {
  assert.equal(clampTerminalHeight(10), TERMINAL_MIN_HEIGHT);
  assert.equal(clampTerminalHeight(5000, 1080), 1080 - TERMINAL_MIN_EDITOR_SPACE);
  assert.equal(clampTerminalHeight(Number.NaN), TERMINAL_DEFAULT_HEIGHT);
  assert.equal(clampTerminalHeight(300, 400), 400 - TERMINAL_MIN_EDITOR_SPACE);
  assert.equal(clampTerminalHeight(300, 200), TERMINAL_MIN_HEIGHT);
  assert.equal(clampTerminalHeight(224, 1080), 224);
  assert.equal(clampTerminalHeight(240.6, 1080), 241);
});

test('dragging the handle up grows the dock and down shrinks it', () => {
  assert.equal(terminalHeightFromDrag(224, -80, 1080), 304);
  assert.equal(terminalHeightFromDrag(224, 80, 1080), 144);
  assert.equal(terminalHeightFromDrag(224, 5000, 1080), TERMINAL_MIN_HEIGHT);
  assert.equal(terminalHeightFromDrag(224, -5000, 1080), 1080 - TERMINAL_MIN_EDITOR_SPACE);
  assert.equal(terminalHeightFromDrag(224, Number.NaN, 1080), 224);
});

test('keyboard resizing steps, resets and never leaves the band', () => {
  assert.equal(terminalHeightFromKey(224, 'ArrowUp', 1080), 224 + TERMINAL_RESIZE_STEP);
  assert.equal(terminalHeightFromKey(224, 'ArrowDown', 1080), 224 - TERMINAL_RESIZE_STEP);
  assert.equal(terminalHeightFromKey(600, 'Home', 1080), TERMINAL_DEFAULT_HEIGHT);
  assert.equal(terminalHeightFromKey(600, 'End', 1080), 1080 - TERMINAL_MIN_EDITOR_SPACE);
  assert.equal(terminalHeightFromKey(600, 'Enter', 1080), 600);
});

test('the persisted height is read back and written rounded', () => {
  const storage = fakeStorage({ [TERMINAL_HEIGHT_STORAGE_KEY]: '350' });
  assert.equal(readTerminalHeight(storage, 1080), 350);
  writeTerminalHeight(storage, 410.4);
  assert.equal(storage.values.get(TERMINAL_HEIGHT_STORAGE_KEY), '410');
});

test('garbage or missing storage falls back to the default height', () => {
  assert.equal(readTerminalHeight(fakeStorage(), 1080), TERMINAL_DEFAULT_HEIGHT);
  assert.equal(readTerminalHeight(fakeStorage({ [TERMINAL_HEIGHT_STORAGE_KEY]: 'not-a-number' }), 1080), TERMINAL_DEFAULT_HEIGHT);
  assert.equal(readTerminalHeight(fakeStorage({ [TERMINAL_HEIGHT_STORAGE_KEY]: '-40' }), 1080), TERMINAL_DEFAULT_HEIGHT);
  assert.equal(readTerminalHeight(null, 1080), TERMINAL_DEFAULT_HEIGHT);
  assert.equal(readTerminalHeight({
    getItem() {
      throw new Error('storage blocked');
    },
    setItem() {
      throw new Error('storage blocked');
    }
  }, 1080), TERMINAL_DEFAULT_HEIGHT);
  assert.doesNotThrow(() => writeTerminalHeight({
    getItem: () => null,
    setItem() {
      throw new Error('quota');
    }
  }, 300));
});

test('the ceiling can never be below the floor', () => {
  assert.equal(clampTerminalHeight(900, 100), TERMINAL_MIN_HEIGHT);
  assert.ok(TERMINAL_MAX_HEIGHT > TERMINAL_MIN_HEIGHT);
});
