import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};
(globalThis as unknown as Record<string, unknown>).window = { shadroxDesktop: null };

const pm = await import('./projectMemory');

test('appendNote caps the number of stored notes (no unbounded growth)', () => {
  let markdown = '# Project memory\n\n## Notes\n';
  for (let i = 0; i < pm.MAX_NOTES + 25; i += 1) {
    markdown = pm.appendNote(markdown, `fact number ${i} about the workspace`);
  }
  const noteLines = markdown.split('\n').filter((line) => line.trim().startsWith('- ['));
  assert.ok(noteLines.length <= pm.MAX_NOTES, `notes capped at ${pm.MAX_NOTES}, got ${noteLines.length}`);
  assert.ok(markdown.length <= pm.MAX_MEMORY_CHARS, 'document stays under the hard char cap');
});

test('appendNote redacts credential-shaped notes and caps a single note length', () => {
  const markdown = pm.appendNote('# Project memory\n\n## Notes\n', `sk-ant-${'a'.repeat(40)}`);
  assert.ok(!markdown.includes('sk-ant-'), 'secret-shaped note is redacted before storage');
  const long = pm.appendNote('# Project memory\n\n## Notes\n', 'x'.repeat(pm.MAX_NOTE_CHARS * 3));
  const noteLine = long.split('\n').find((line) => line.trim().startsWith('- [')) ?? '';
  assert.ok(noteLine.length <= pm.MAX_NOTE_CHARS + 40, 'one note is bounded to MAX_NOTE_CHARS');
});

test('buildProjectMemoryContext returns a bounded excerpt, never the whole unbounded doc', async () => {
  storage.clear();
  let markdown = '# Project memory\n\n## Stack\n- Node project\n\n## Notes\n';
  for (let i = 0; i < pm.MAX_NOTES; i += 1) {
    markdown = pm.appendNote(markdown, `durable note ${i} `.repeat(20));
  }
  const context = await pm.buildProjectMemoryContext('ws');
  assert.ok(context, 'an excerpt is produced');
  // Header text + the bounded excerpt; the excerpt itself is capped at the budget.
  assert.ok(
    context!.length <= pm.MEMORY_CONTEXT_BUDGET_CHARS + 400,
    `excerpt bounded (~${pm.MEMORY_CONTEXT_BUDGET_CHARS} chars), got ${context!.length}`
  );
  assert.ok(context!.includes('PROJECT MEMORY'), 'header present');
});