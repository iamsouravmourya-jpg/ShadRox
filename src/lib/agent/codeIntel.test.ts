import test from 'node:test';
import assert from 'node:assert/strict';
import type { ShadRoxDesktopAPI } from '../desktop';

const storage = new Map<string, string>();
(globalThis as unknown as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() { return storage.size; }
};

const A_CONTENT = "export function greet(name: string) {\n  return 'hi ' + name;\n}\n";
const B_CONTENT = "import { greet } from './a';\n\nconst x = greet('world');\n";
const files: Record<string, { content: string; version: string }> = {
  'src/a.ts': { content: A_CONTENT, version: 'hash-a' },
  'src/b.ts': { content: B_CONTENT, version: 'hash-b' }
};
const writeAttempts: string[] = [];
let renameResult: unknown = {
  canRename: true,
  displayName: 'greet',
  edits: [
    { file: '/proj/src/a.ts', line: 0, character: 16, endLine: 0, endCharacter: 21, newText: 'salute' },
    { file: '/proj/src/b.ts', line: 0, character: 9, endLine: 0, endCharacter: 14, newText: 'salute' },
    { file: '/proj/src/b.ts', line: 2, character: 10, endLine: 2, endCharacter: 15, newText: 'salute' }
  ]
};
const renameCalls: Array<{ path: string; line: number; character: number; newName: string }> = [];
const referenceCalls: Array<{ path: string; line: number; character: number }> = [];

const fakeBridge = {
  readFile: async (_id: string, path: string) => {
    const file = files[path];
    if (!file) throw new Error(`not found: ${path}`);
    return { name: path, content: file.content, version: file.version };
  },
  saveFiles: async (_id: string, targets: Array<{ name: string }>) => {
    writeAttempts.push(...targets.map((entry) => entry.name));
    return { saved: [], errors: [] };
  },
  workspaceSymbols: async (_id: string, query: string) =>
    query === 'greet' ? [{ name: 'greet', kind: 'function', file: '/proj/src/a.ts', line: 0, character: 16 }] : [],
  references: async (_id: string, path: string, line: number, character: number) => {
    referenceCalls.push({ path, line, character });
    return [
      { file: '/proj/src/a.ts', line: 0, character: 16, isDefinition: true },
      { file: '/proj/src/b.ts', line: 2, character: 10, isDefinition: false }
    ];
  },
  definition: async () => [{ file: '/proj/src/a.ts', line: 0, character: 16, kind: 'function', name: 'greet' }],
  rename: async (_id: string, path: string, line: number, character: number, newName: string) => {
    renameCalls.push({ path, line, character, newName });
    return renameResult;
  }
} as unknown as ShadRoxDesktopAPI;

(globalThis as unknown as Record<string, unknown>).window = { shadroxDesktop: fakeBridge };

const ci = await import('./codeIntel');
ci.setCodeIntelRoot('/proj');

function editSetFrom(content: string): { kind: string; files: Array<{ path: string; expectedVersion: string; content: string }>; edits: Array<{ path: string; line: number; character: number; endLine: number; endCharacter: number; newText: string }> } {
  const match = /```shadrox:edit-set\n([\s\S]*?)\n```/.exec(content);
  assert.ok(match, 'expected a shadrox:edit-set fence');
  return JSON.parse(match[1]);
}

test('non-TS files are refused honestly, never guessed', async () => {
  const refs = await ci.handleFindReferences('ws', { file: 'main.py', line: 1 });
  assert.equal(refs.ok, false);
  assert.equal(refs.refused, true);
  assert.ok(refs.error?.includes('not supported yet'));
  const def = await ci.handleGoToDefinition('ws', { file: 'styles.css', line: 2 });
  assert.equal(def.refused, true);
  const rename = await ci.handleRenameSymbol('ws', { file: 'main.py', symbol: 'x', newName: 'y' });
  assert.equal(rename.refused, true);
});

test('find_references resolves file+line (1-based) to the service position (0-based)', async () => {
  const result = await ci.handleFindReferences('ws', { file: 'src/b.ts', line: 3, symbol: 'greet' });
  assert.equal(result.ok, true);
  assert.deepEqual(referenceCalls.at(-1), { path: 'src/b.ts', line: 2, character: 10 });
  assert.ok(result.content.includes('def src/a.ts:1:17'));
  assert.ok(result.content.includes('ref src/b.ts:3:11'));
  assert.ok(result.content.includes("const x = greet('world');"));

  const bySymbol = await ci.handleFindReferences('ws', { symbol: 'greet' });
  assert.equal(bySymbol.ok, true);
  assert.ok(bySymbol.content.includes('src/a.ts:1:17'));

  const missing = await ci.handleFindReferences('ws', { symbol: 'noSuchSymbol' });
  assert.equal(missing.refused, true);
  const badLine = await ci.handleFindReferences('ws', { file: 'src/b.ts', line: 99 });
  assert.equal(badLine.refused, true);
});

test('go_to_definition returns the definition with a snippet', async () => {
  const result = await ci.handleGoToDefinition('ws', { file: 'src/b.ts', line: 3, symbol: 'greet' });
  assert.equal(result.ok, true);
  assert.ok(result.content.includes('function greet — src/a.ts:1:17'));
  assert.ok(result.content.includes('export function greet'));
  const noArgs = await ci.handleGoToDefinition('ws', {});
  assert.equal(noArgs.refused, true);
});

test('rename_symbol produces a version-pinned atomic edit SET and writes nothing', async () => {
  const result = await ci.handleRenameSymbol('ws', { file: 'src/a.ts', symbol: 'greet', newName: 'salute' });
  assert.equal(result.ok, true);
  assert.equal(writeAttempts.length, 0); // the tool never writes
  assert.deepEqual(renameCalls.at(-1), { path: 'src/a.ts', line: 0, character: 16, newName: 'salute' });

  const set = editSetFrom(result.content);
  assert.equal(set.kind, 'shadrox-edit-set');
  assert.equal(set.files.length, 2);
  const a = set.files.find((file) => file.path === 'src/a.ts');
  const b = set.files.find((file) => file.path === 'src/b.ts');
  assert.ok(a && b);
  assert.equal(a.expectedVersion, 'hash-a');
  assert.equal(b.expectedVersion, 'hash-b');
  assert.ok(a.content.includes('export function salute'));
  assert.ok(!a.content.includes('greet'));
  assert.ok(b.content.includes("import { salute } from './a';"));
  assert.ok(b.content.includes("const x = salute('world');"));
  assert.equal(set.edits.length, 3);
  assert.ok(set.edits.every((edit) => edit.newText === 'salute' && edit.line >= 0));

  // Applying the positioned hunks back-to-front reproduces the full contents.
  const applySpans = (before: string, spans: typeof set.edits) => {
    const lines = before.split('\n');
    const offsets: number[] = [];
    let total = 0;
    for (const line of lines) { offsets.push(total); total += line.length + 1; }
    const sorted = [...spans].sort((left, right) => (right.line - left.line) || (right.character - left.character));
    let out = before;
    for (const span of sorted) {
      const start = offsets[span.line] + span.character;
      const end = offsets[span.endLine] + span.endCharacter;
      out = out.slice(0, start) + span.newText + out.slice(end);
    }
    return out;
  };
  assert.equal(applySpans(A_CONTENT, set.edits.filter((edit) => edit.path === 'src/a.ts')), a.content);
  assert.equal(applySpans(B_CONTENT, set.edits.filter((edit) => edit.path === 'src/b.ts')), b.content);
});

test('rename_symbol validates names and reports service refusals', async () => {
  const reserved = await ci.handleRenameSymbol('ws', { file: 'src/a.ts', symbol: 'greet', newName: 'class' });
  assert.equal(reserved.refused, true);
  const invalid = await ci.handleRenameSymbol('ws', { file: 'src/a.ts', symbol: 'greet', newName: 'not-valid' });
  assert.equal(invalid.refused, true);
  const same = await ci.handleRenameSymbol('ws', { file: 'src/a.ts', symbol: 'greet', newName: 'greet' });
  assert.equal(same.ok, true);
  assert.ok(same.content.includes('nothing to rename'));

  renameResult = { canRename: false, reason: 'You cannot rename this element.', edits: [] };
  const refused = await ci.handleRenameSymbol('ws', { file: 'src/a.ts', symbol: 'greet', newName: 'salute' });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
  assert.ok(refused.error?.includes('cannot rename'));
  renameResult = {
    canRename: true,
    displayName: 'greet',
    edits: [{ file: '/elsewhere/a.ts', line: 0, character: 16, endLine: 0, endCharacter: 21, newText: 'salute' }]
  };
  const outside = await ci.handleRenameSymbol('ws', { file: 'src/a.ts', symbol: 'greet', newName: 'salute' });
  assert.equal(outside.ok, false);
  assert.ok(outside.error?.includes('outside the workspace root'));
});

test('find_references safely escapes regex metacharacters like $store and reads staged pending buffers', async () => {
  const pc = await import('./pendingChanges');
  files['src/store.ts'] = { content: 'export const $store = { count: 1 };\n', version: 'hash-s' };
  const dollarRes = await ci.handleFindReferences('ws', { file: 'src/store.ts', line: 1, symbol: '$store' });
  assert.equal(dollarRes.ok, true);
  assert.deepEqual(referenceCalls.at(-1), { path: 'src/store.ts', line: 0, character: 13 });

  pc.clearWorkspacePendingChanges('ws-staged-ci');
  pc.stagePendingChange('ws-staged-ci', {
    path: 'src/a.ts',
    content: "export function greetStaged(name: string) {\n  return 'yo ' + name;\n}\n",
    originalContent: A_CONTENT,
    originalVersion: 'hash-a',
    created: false
  });
  try {
    const stagedRes = await ci.handleGoToDefinition('ws-staged-ci', { file: 'src/a.ts', line: 1, symbol: 'greetStaged' });
    assert.equal(stagedRes.ok, true);
  } finally {
    pc.clearWorkspacePendingChanges('ws-staged-ci');
    delete files['src/store.ts'];
  }
});