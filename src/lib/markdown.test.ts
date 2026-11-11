import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskFileWrites, parseInline, parseMarkdownBlocks } from './markdown';

test('bold, inline code and links become runs instead of literal markers', () => {
  const tokens = parseInline('**Sabse bada risk:** `credits.ts` dekh [docs](https://example.com/a)');
  assert.deepEqual(tokens, [
    { kind: 'bold', value: 'Sabse bada risk:' },
    { kind: 'text', value: ' ' },
    { kind: 'code', value: 'credits.ts' },
    { kind: 'text', value: ' dekh ' },
    { kind: 'link', label: 'docs', href: 'https://example.com/a' }
  ]);
});

test('an http link cannot smuggle a script URL', () => {
  const tokens = parseInline('[click](javascript:alert(1))');
  assert.deepEqual(tokens, [{ kind: 'text', value: '[click](javascript:alert(1))' }]);
});

test('underscores inside paths are not turned into italics', () => {
  assert.deepEqual(parseInline('run_harsh_task now'), [{ kind: 'text', value: 'run_harsh_task now' }]);
});

test('an unclosed marker stays literal instead of eating the line', () => {
  assert.deepEqual(parseInline('**oops then more text'), [{ kind: 'text', value: '**oops then more text' }]);
});

test('a markdown table is parsed into header and rows', () => {
  const blocks = parseMarkdownBlocks('| Layer | Tech |\n|---|---|\n| UI | React 18.3 |\n| AI | `groq-sdk` |');
  assert.deepEqual(blocks, [
    { kind: 'table', header: ['Layer', 'Tech'], rows: [['UI', 'React 18.3'], ['AI', '`groq-sdk`']] }
  ]);
});

test('a pipe in prose is not a table', () => {
  const blocks = parseMarkdownBlocks('either | or\nnext line');
  assert.deepEqual(blocks, [
    { kind: 'paragraph', text: 'either | or' },
    { kind: 'paragraph', text: 'next line' }
  ]);
});

test('numbered steps keep their numbers', () => {
  const blocks = parseMarkdownBlocks('1. **Close the ledger.**\n10. Ship it');
  assert.deepEqual(blocks, [
    { kind: 'ordered', index: 1, text: '**Close the ledger.**' },
    { kind: 'ordered', index: 10, text: 'Ship it' }
  ]);
});

test('a fenced patch keeps its code and loses the fence info line', () => {
  const blocks = parseMarkdownBlocks(
    [
      '```path=src/App.tsx',
      '<<<<<<< ORIGINAL',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> UPDATED',
      '```'
    ].join('\n')
  );
  assert.deepEqual(blocks, [
    { kind: 'code', lines: ['<<<<<<< ORIGINAL', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> UPDATED'] }
  ]);
});

test('a real reply parses without losing any line of substance', () => {
  const blocks = parseMarkdownBlocks(
    [
      '**Sabse bada risk:** credits, daily quota aur `isPro` sab `src/lib/credits.ts` me hain.',
      '',
      'Checked:',
      '- `api/razorpay/create-order.ts` signs orders',
      '2. Nothing verifies the payment server-side',
      '',
      '| Layer | Tech |',
      '|---|---|',
      '| UI | React |'
    ].join('\n')
  )
    .filter((block) => block.kind !== 'space')
    .map((block) => block.kind);
  assert.deepEqual(blocks, ['paragraph', 'paragraph', 'bullet', 'ordered', 'table']);
});

test('two writes to one path leave one bullet, two paths leave two', () => {
  const onePath = maskFileWrites(
    ['```ts path=src/a.ts', 'export const a = 1;', '```', '', '```ts path=src/a.ts', 'export const a = 2;', '```'].join('\n')
  );
  assert.equal(onePath.split('\n').filter((line) => line.startsWith('- ')).length, 1, onePath);

  const twoPaths = maskFileWrites(
    ['```ts path=src/a.ts', 'export const a = 1;', '```', '', '```ts path=src/b.ts', 'export const b = 1;', '```'].join('\n')
  );
  assert.equal(twoPaths.split('\n').filter((line) => line.startsWith('- ')).length, 2, twoPaths);
});

test('the write bullet reflects the apply outcome, never the reply shape', () => {
  const reply = ['```ts path=src/a.ts', 'export const a = 2;', '```'].join('\n');
  const files = [{ name: 'src/a.ts', content: 'export const a = 1;' }];
  assert.match(maskFileWrites(reply, files, () => 'applied'), /- src\/a\.ts — change applied/);
  assert.match(maskFileWrites(reply, files, () => 'failed'), /not applied — see Changes below/);
  assert.match(maskFileWrites(reply, files, () => 'pending'), /awaiting review/);
  assert.match(maskFileWrites(reply, files, () => 'streaming'), /writing change/);
  // Without a known outcome the bullet must not claim success.
  assert.match(maskFileWrites(reply, files), /- src\/a\.ts — not applied/);
});

test('a truncated fence never claims a patched file', () => {
  const reply = ['```ts path=src/a.ts', '<<<<<<< ORIGINAL', 'const a = 1;', '======='].join('\n');
  const files = [{ name: 'src/a.ts', content: 'const a = 1;' }];
  const masked = maskFileWrites(reply, files, () => 'unapplied');
  assert.match(masked, /not applied/);
  assert.doesNotMatch(masked, /patched/);
});

test('restored history without an outcome record claims neither success nor failure', () => {
  const reply = ['```ts path=src/a.ts', 'export const a = 2;', '```'].join('\n');
  const files = [{ name: 'src/a.ts', content: 'export const a = 1;' }];
  const masked = maskFileWrites(reply, files, () => 'historic');
  assert.match(masked, /- src\/a\.ts — change from an earlier session/);
  assert.doesNotMatch(masked, /not applied/);
  assert.doesNotMatch(masked, /change applied/);
});
