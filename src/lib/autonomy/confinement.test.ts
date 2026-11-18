import assert from 'node:assert/strict';
import test from 'node:test';

import { confinePatches, isInsideWorkspaceRoot } from './confinement';

test('only patches inside expectedFiles survive confinement', () => {
  const patches = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'package.json' }];
  const { allowed, refused } = confinePatches(patches, ['src/a.ts']);
  assert.deepEqual(allowed.map((patch) => patch.path), ['src/a.ts']);
  assert.equal(refused.length, 2);
  assert.match(refused[0], /outside the files this turn may write/);
});

test('the refusal names the effective writable set, never a wider one', () => {
  // A narrowed scope reaches confinement as the already-narrowed list, so the
  // reason a model reads must not invite it to retry a file that was cut.
  const { allowed, refused } = confinePatches([{ path: 'src/b.ts' }], ['src/a.ts']);
  assert.deepEqual(allowed, []);
  assert.equal(refused.length, 1);
  assert.ok(refused[0].includes('(src/a.ts)'), refused[0]);
  assert.equal(refused[0].includes('src/b.ts)'), false, 'the writable set must not name the refused file');
});

test('confinement normalizes separators and leading ./, case-sensitively', () => {
  const { allowed, refused } = confinePatches(
    [{ path: './src\\ui\\Button.tsx' }, { path: 'src/ui/button.tsx' }],
    ['src/ui/Button.tsx']
  );
  assert.deepEqual(allowed.map((patch) => patch.path), ['./src\\ui\\Button.tsx']);
  assert.equal(refused.length, 1);
});

test('a milestone that declares no files may not write any', () => {
  const { allowed, refused } = confinePatches([{ path: 'src/a.ts' }], []);
  assert.deepEqual(allowed, []);
  assert.match(refused[0], /declared no files to edit/);
});

test('plugin and automation manifests stay outside the agent-writable set', () => {
  const { allowed, refused } = confinePatches(
    [
      { path: '.shadrox/plugins/demo/plugin.json' },
      { path: '.shadrox/automations.json' },
      { path: 'src/app.ts' }
    ],
    ['.shadrox/plugins/demo/plugin.json', '.shadrox/automations.json', 'src/app.ts']
  );
  assert.deepEqual(allowed.map((patch) => patch.path), ['src/app.ts']);
  assert.equal(refused.length, 2);
  assert.match(refused[0], /cannot alter plugin or automation manifests/);
});

test('protected paths are recognized after separator and traversal normalization', () => {
  const { allowed, refused } = confinePatches(
    [{ path: 'src\\..\\.shadrox\\plugins\\demo\\plugin.json' }],
    ['.shadrox/plugins/demo/plugin.json']
  );
  assert.deepEqual(allowed, []);
  assert.equal(refused.length, 1);
});

test('an empty patch list is a no-op', () => {
  const { allowed, refused } = confinePatches([], ['src/a.ts']);
  assert.deepEqual(allowed, []);
  assert.deepEqual(refused, []);
});

test('a brand-new unlisted file inside the workspace is allowed when the host says it does not exist', () => {
  const existing = new Set(['src/a.ts', 'src/other.ts']);
  const { allowed, refused } = confinePatches(
    [{ path: 'src/a.ts' }, { path: 'src/types.ts' }, { path: 'src/other.ts' }],
    ['src/a.ts'],
    { fileExists: (path) => existing.has(path) }
  );
  assert.deepEqual(allowed.map((patch) => patch.path), ['src/a.ts', 'src/types.ts']);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /^src\/other\.ts: refused — outside the files this turn may write/);
});

test('without the existence callback every unlisted patch is still refused', () => {
  const { allowed, refused } = confinePatches([{ path: 'src/types.ts' }], ['src/a.ts']);
  assert.deepEqual(allowed, []);
  assert.match(refused[0], /outside the files this turn may write/);
});

test('out-of-root paths are refused even when the host reports them as new', () => {
  const { allowed, refused } = confinePatches(
    [{ path: '../escape.ts' }, { path: '/etc/passwd' }, { path: 'C:/Windows/evil.ts' }, { path: 'src/../../up.ts' }],
    ['src/a.ts'],
    { fileExists: () => false }
  );
  assert.deepEqual(allowed, []);
  assert.equal(refused.length, 4);
  for (const reason of refused) assert.match(reason, /outside the workspace root/);
});

test('a read-only milestone stays read-only even with the existence callback', () => {
  const { allowed, refused } = confinePatches([{ path: 'src/new.ts' }], [], { fileExists: () => false });
  assert.deepEqual(allowed, []);
  assert.match(refused[0], /declared no files to edit/);
});

test('a new protected manifest is refused before any new-file allowance', () => {
  const { allowed, refused } = confinePatches(
    [{ path: '.shadrox/plugins/demo/plugin.json' }],
    ['src/a.ts'],
    { fileExists: () => false }
  );
  assert.deepEqual(allowed, []);
  assert.match(refused[0], /cannot alter plugin or automation manifests/);
});

test('isInsideWorkspaceRoot accepts relative paths and in-root traversal, rejects escapes and absolutes', () => {
  assert.equal(isInsideWorkspaceRoot('src/types.ts'), true);
  assert.equal(isInsideWorkspaceRoot('./src\\ui\\Button.tsx'), true);
  assert.equal(isInsideWorkspaceRoot('src/../types.ts'), true, 'traversal that stays in root is fine');
  assert.equal(isInsideWorkspaceRoot('../escape.ts'), false);
  assert.equal(isInsideWorkspaceRoot('src/../../escape.ts'), false);
  assert.equal(isInsideWorkspaceRoot('/etc/passwd'), false);
  assert.equal(isInsideWorkspaceRoot('C:/Windows/evil.ts'), false);
  assert.equal(isInsideWorkspaceRoot('C:\\Windows\\evil.ts'), false);
  assert.equal(isInsideWorkspaceRoot('\\\\server\\share\\x.ts'), false);
  assert.equal(isInsideWorkspaceRoot(''), false);
  assert.equal(isInsideWorkspaceRoot('.'), false);
});
