import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReferenceLocation } from '../desktop';
import { baseName, groupReferencesByFile, symbolAt, totalReferences } from './references';

const ref = (file: string, line: number, isDefinition = false): ReferenceLocation => ({
  file,
  isDefinition,
  line,
  character: 0,
  endLine: line,
  endCharacter: 3
});

test('groupReferencesByFile keeps files together and hoists the declaration', () => {
  const groups = groupReferencesByFile([
    ref('src/b.ts', 4),
    ref('src/a.ts', 0, true),
    ref('src/b.ts', 9),
    ref('src/a.ts', 7)
  ]);

  assert.deepEqual(
    groups.map((group) => group.file),
    ['src/a.ts', 'src/b.ts']
  );
  assert.equal(groups[0].references.length, 2);
  assert.equal(groups[1].references.length, 2);
});

test('groupReferencesByFile orders the remaining files alphabetically', () => {
  const groups = groupReferencesByFile([ref('src/z.ts', 1), ref('src/a.ts', 2), ref('src/m.ts', 3)]);
  assert.deepEqual(
    groups.map((group) => group.file),
    ['src/a.ts', 'src/m.ts', 'src/z.ts']
  );
});

test('totalReferences counts every reference in every group', () => {
  const groups = groupReferencesByFile([ref('a.ts', 1), ref('a.ts', 2), ref('b.ts', 3)]);
  assert.equal(totalReferences(groups), 3);
});

test('baseName returns the last path segment and tolerates a backslash path', () => {
  assert.equal(baseName('src/lib/editor/references.ts'), 'references.ts');
  assert.equal(baseName('C:\\repo\\src\\a.ts'), 'a.ts');
  assert.equal(baseName('standalone.ts'), 'standalone.ts');
});

test('symbolAt reads the identifier under or beside the caret', () => {
  const content = 'const total = add(1, 2);\n';
  // Mid-identifier.
  assert.equal(symbolAt(content, 0, 8), 'total');
  // At the identifier's first character.
  assert.equal(symbolAt(content, 0, 14), 'add');
  // Just after it, which is where a caret usually rests.
  assert.equal(symbolAt(content, 0, 17), 'add');
  // On punctuation there is no identifier, which is how the rename prompt
  // knows not to open.
  assert.equal(symbolAt(content, 0, 12), '');
  assert.equal(symbolAt(content, 0, 23), '');
});

test('symbolAt clamps a position past the end of the file', () => {
  assert.equal(symbolAt('let value = 1;\n', 99, 99), '');
  assert.equal(symbolAt('let value = 1;\n', 0, 999), '');
});
