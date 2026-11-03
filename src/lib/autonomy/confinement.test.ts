import assert from 'node:assert/strict';
import test from 'node:test';

import { confinePatches } from './confinement';

test('only patches inside expectedFiles survive confinement', () => {
  const patches = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'package.json' }];
  const { allowed, refused } = confinePatches(patches, ['src/a.ts']);
  assert.deepEqual(allowed.map((patch) => patch.path), ['src/a.ts']);
  assert.equal(refused.length, 2);
  assert.match(refused[0], /outside this milestone's expectedFiles/);
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

test('an empty patch list is a no-op', () => {
  const { allowed, refused } = confinePatches([], ['src/a.ts']);
  assert.deepEqual(allowed, []);
  assert.deepEqual(refused, []);
});
