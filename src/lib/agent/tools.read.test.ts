import assert from 'node:assert/strict';
import test from 'node:test';
import { runTool } from './tools';

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

test('read_file defaults to reading up to 400 lines in one call (main agent)', async () => {
  const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  await withBridge({ readFile: async () => ({ name: 'src/big.ts', content: long, version: 'v1' }) }, async () => {
    const outcome = await runTool('ws', { name: 'read_file', args: { path: 'src/big.ts' } });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.content.includes('Total lines: 500 | Showing lines 1-400'), 'header reports 400-line cap');
    assert.ok(outcome.content.includes('lines (>400). Showing lines 1-400'), 'guidance tells the model to range-read');
    assert.ok(outcome.content.includes('search_text'), 'guidance points to outline/search_text');
    const shown = outcome.content.split('\n').filter((line) => /^\d+\| /.test(line));
    assert.equal(shown.length, 400, 'read_file caps at 400 lines by default');
  });

  const short = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  await withBridge({ readFile: async () => ({ name: 'src/small.ts', content: short, version: 'v1' }) }, async () => {
    const outcome = await runTool('ws', { name: 'read_file', args: { path: 'src/small.ts' } });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.content.includes('Total lines: 50 | Showing lines 1-50'), 'short files read in full');
    const shown = outcome.content.split('\n').filter((line) => /^\d+\| /.test(line));
    assert.equal(shown.length, 50, 'no cap applied to a <=400 line file');
  });
});
