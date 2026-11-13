The parser is fine; it is simply never tested. This describes the behaviour it
already has, in five cases, and leaves `src/flags.mjs` alone.

```ts path=src/flags.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFlags } from './flags.mjs';

test('reads a value that follows its flag', () => {
  assert.deepEqual(parseFlags(['--name', 'shadrox']), { name: 'shadrox' });
});

test('reads a value joined with =', () => {
  assert.deepEqual(parseFlags(['--level=3']), { level: '3' });
});

test('treats a flag with no value as true', () => {
  assert.deepEqual(parseFlags(['--dry-run', '--name', 'x']), { 'dry-run': true, name: 'x' });
});

test('skips tokens that are not flags', () => {
  assert.deepEqual(parseFlags(['build', '--watch', 'src']), { watch: 'src' });
});

test('returns nothing for no arguments', () => {
  assert.deepEqual(parseFlags([]), {});
});
```
