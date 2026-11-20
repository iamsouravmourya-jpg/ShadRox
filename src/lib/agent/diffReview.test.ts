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

let gitState = { isRepo: true, status: '', diff: '', log: '', dirty: 0 };
const fakeBridge = {
  gitRead: async () => gitState
} as unknown as ShadRoxDesktopAPI;
(globalThis as unknown as Record<string, unknown>).window = { shadroxDesktop: fakeBridge };

const dr = await import('./diffReview');

const FIXTURE = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,3 +1,6 @@',
  ' export function login() {',
  '+  const apiKey = "sk-abcdefghijklmnopqrstuvwx";',
  '+  console.log("debugging login");',
  '+  // TODO: handle refresh tokens',
  '   return true;',
  ' }',
  'diff --git a/src/auth.test.ts b/src/auth.test.ts',
  '--- a/src/auth.test.ts',
  '+++ b/src/auth.test.ts',
  '@@ -1,2 +1,3 @@',
  ' test("login", () => {',
  '+  console.log("test trace");',
  ' });',
  'diff --git a/src/unrelated.ts b/src/unrelated.ts',
  '--- a/src/unrelated.ts',
  '+++ b/src/unrelated.ts',
  '@@ -1,2 +1,3 @@',
  ' export const z = 1;',
  '+export const extra = 2;',
  ' // end'
].join('\n');

test('parseDiff tracks new-side line numbers per hunk', () => {
  const files = dr.parseDiff(FIXTURE);
  assert.equal(files.length, 3);
  const auth = files[0];
  assert.equal(auth.path, 'src/auth.ts');
  assert.equal(auth.added.length, 3);
  assert.equal(auth.added[0].line, 2);
  assert.equal(auth.added[1].line, 3);
  assert.equal(auth.added[2].line, 4);
  assert.equal(auth.removedCount, 0);
  assert.deepEqual(dr.parseDiff(''), []);
});

test('reviewDiff flags secrets as errors without echoing the value', () => {
  const result = dr.reviewDiff(FIXTURE, '');
  const secret = result.findings.find((finding) => finding.kind === 'secret');
  assert.ok(secret);
  assert.equal(secret.severity, 'error');
  assert.equal(secret.path, 'src/auth.ts');
  assert.equal(secret.line, 2);
  assert.ok(!JSON.stringify(result).includes('sk-abcdefghijklmnopqrstuvwx'));
  assert.equal(result.findings[0].severity, 'error'); // errors sort first
});

test('reviewDiff distinguishes debug prints in code vs tests, and TODOs', () => {
  const result = dr.reviewDiff(FIXTURE, '');
  const debug = result.findings.filter((finding) => finding.kind === 'debug_print');
  assert.equal(debug.length, 2);
  const inCode = debug.find((finding) => finding.path === 'src/auth.ts');
  const inTest = debug.find((finding) => finding.path === 'src/auth.test.ts');
  assert.equal(inCode?.severity, 'warning');
  assert.equal(inTest?.severity, 'info');
  const todo = result.findings.find((finding) => finding.kind === 'todo');
  assert.equal(todo?.severity, 'warning');
  assert.equal(todo?.line, 4);
});

test('expectedFiles drive out_of_scope and missed_file findings', () => {
  const result = dr.reviewDiff(FIXTURE, '', { expectedFiles: ['src/auth.ts', 'src/missing.ts'] });
  const out = result.findings.filter((finding) => finding.kind === 'out_of_scope');
  assert.equal(out.length, 2); // auth.test.ts and unrelated.ts were not declared
  assert.ok(out.every((finding) => finding.severity === 'warning'));
  const missed = result.findings.find((finding) => finding.kind === 'missed_file');
  assert.equal(missed?.path, 'src/missing.ts');
  assert.equal(missed?.severity, 'info');
});

test('intent heuristic marks vocabulary-unrelated files as info, not proof', () => {
  const result = dr.reviewDiff(FIXTURE, '', { intent: 'fix the login auth flow' });
  const unrelated = result.findings.filter((finding) => finding.kind === 'unrelated');
  assert.ok(unrelated.some((finding) => finding.path === 'src/unrelated.ts'));
  assert.ok(unrelated.every((finding) => finding.severity === 'info'));
  assert.ok(!unrelated.some((finding) => finding.path === 'src/auth.ts'));
});

test('untracked files and oversized changes are surfaced', () => {
  const big = ['diff --git a/src/big.ts b/src/big.ts', '@@ -0,0 +1,250 @@'];
  for (let i = 0; i < 250; i += 1) big.push(`+line ${i}`);
  const result = dr.reviewDiff(big.join('\n'), '?? stray.log\n M src/big.ts');
  assert.ok(result.findings.some((finding) => finding.kind === 'large_change' && finding.path === 'src/big.ts'));
  const untracked = result.findings.find((finding) => finding.kind === 'untracked');
  assert.equal(untracked?.path, 'stray.log');
  assert.equal(result.addedLines, 250);
});

test('a clean diff reports no issues', () => {
  const clean = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1,2 +1,2 @@', '-const x = 1;', '+const x = 2;'].join('\n');
  const result = dr.reviewDiff(clean, '');
  assert.equal(result.findings.length, 0);
  assert.equal(result.addedLines, 1);
  assert.equal(result.removedLines, 1);
});

test('handleDiffReview reads the real bridge and is honest about edge states', async () => {
  gitState = { isRepo: true, status: '', diff: FIXTURE, log: '', dirty: 3 };
  const result = await dr.handleDiffReview('ws', { intent: 'fix login', expectedFiles: ['src/auth.ts'] });
  assert.equal(result.ok, true);
  assert.ok(result.content.includes('[error] secret src/auth.ts:2'));
  assert.ok(result.content.includes('```shadrox:diff-review'));
  const fence = /```shadrox:diff-review\n([\s\S]*?)\n```/.exec(result.content);
  assert.ok(fence);
  const parsed = JSON.parse(fence[1]);
  assert.equal(parsed.kind, 'shadrox:diff-review');
  assert.ok(parsed.findings.length > 0);

  gitState = { isRepo: false, status: '', diff: '', log: '', dirty: 0 };
  const notRepo = await dr.handleDiffReview('ws', {});
  assert.equal(notRepo.ok, true);
  assert.ok(notRepo.content.includes('not a git repository'));

  gitState = { isRepo: true, status: '', diff: '', log: '', dirty: 0 };
  const clean = await dr.handleDiffReview('ws', {});
  assert.equal(clean.ok, true);
  assert.ok(clean.content.includes('no uncommitted changes'));

  gitState = { isRepo: true, status: '?? new-file.ts', diff: '', log: '', dirty: 1 };
  const untrackedOnly = await dr.handleDiffReview('ws', {});
  assert.equal(untrackedOnly.ok, true);
  assert.ok(untrackedOnly.content.includes('new-file.ts'));
});