import assert from 'node:assert/strict';
import test from 'node:test';

import { confinePatches } from './confinement';

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
