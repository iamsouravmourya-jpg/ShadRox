import assert from 'node:assert/strict';
import test from 'node:test';
import type { SemanticToken } from '../desktop';
import { resolveSemanticRanges } from './semanticTokens';

const token = (
  type: string,
  line: number,
  character: number,
  endLine: number,
  endCharacter: number
): SemanticToken => ({ type, line, character, endLine, endCharacter });

test('resolveSemanticRanges turns line/character spans into offsets with a colour', () => {
  const text = 'export interface Point {\n  x: number;\n}\n';
  const ranges = resolveSemanticRanges([token('interface', 0, 17, 0, 22)], text);
  assert.deepEqual(ranges, [{ from: 17, to: 22, color: '#7dd3fc' }]);
});

test('types the syntax highlighter already handles are left alone', () => {
  const text = 'const x = 1;\n';
  const ranges = resolveSemanticRanges(
    [token('variable', 0, 6, 0, 7), token('function', 0, 6, 0, 7)],
    text
  );
  assert.deepEqual(ranges, []);
});

test('overlapping and out-of-order tokens are sanitised for the decoration builder', () => {
  const text = 'aaaa\n';
  const ranges = resolveSemanticRanges(
    [
      token('interface', 0, 2, 0, 4),
      token('class', 0, 0, 0, 3),
      // Zero-width spans carry no information and must be dropped.
      token('type', 0, 1, 0, 1)
    ],
    text
  );
  assert.deepEqual(
    ranges.map((range) => [range.from, range.to]),
    [
      [0, 3]
    ]
  );
});
