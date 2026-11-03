import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFixPrompt, errorSignature, formatSourceLocation, formatStackExcerpt } from './errorPrompt';

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'map')",
  '    at ProductList (http://127.0.0.1:5173/src/components/ProductList.tsx:23:14)',
  '    at http://127.0.0.1:5173/src/main.tsx:7:3'
].join('\n');

test('the stack excerpt is capped and says how much was dropped', () => {
  const long = ['Error: boom', ...Array.from({ length: 20 }, (_, index) => `    at fn (file-${index}.js:${index + 1}:1)`)].join('\n');
  const excerpt = formatStackExcerpt(long);
  assert.ok(excerpt.split('\n').length <= 7, 'keeps six frames plus the summary line');
  assert.match(excerpt, /14 more frame\(s\)/);
  assert.equal(formatStackExcerpt(undefined), '');
  assert.equal(formatStackExcerpt('Error: x'), 'Error: x');
});

test('formatSourceLocation renders what the stack actually reported', () => {
  assert.equal(formatSourceLocation({ path: 'src/App.tsx', line: 12, character: 4 }), 'src/App.tsx:12:4');
  assert.equal(formatSourceLocation({ path: 'src/App.tsx', line: 12 }), 'src/App.tsx:12');
  assert.equal(formatSourceLocation({ path: 'index.html' }), 'index.html');
  assert.equal(formatSourceLocation(null), '');
});

test('the fix prompt carries only facts the runtime produced', () => {
  const prompt = buildFixPrompt({
    message: "TypeError: Cannot read properties of undefined (reading 'map')",
    stack: STACK,
    url: 'http://127.0.0.1:5173/cart',
    source: { path: 'src/components/ProductList.tsx', line: 23, character: 14 }
  });
  assert.match(prompt, /running preview reported this runtime error/);
  assert.match(prompt, /Error: TypeError: Cannot read properties of undefined/);
  assert.match(prompt, /Page: http:\/\/127\.0\.0\.1:5173\/cart/);
  assert.match(prompt, /Nearest source in the stack: src\/components\/ProductList\.tsx:23:14/);
  assert.match(prompt, /Stack:/);
  assert.match(prompt, /do not add mocks, placeholder data or new dependencies/);
  assert.ok(prompt.length < 1900, `prompt is bounded (was ${prompt.length})`);
  assert.ok(!prompt.includes('node_modules'), 'dependency frames are not forwarded');
});

test('the fix prompt refuses to forward oversized or hostile input whole', () => {
  const huge = buildFixPrompt({ message: 'x'.repeat(20_000), stack: 'y'.repeat(20_000), maxChars: 400 });
  assert.ok(huge.length <= 400, `respects maxChars (was ${huge.length})`);
  assert.ok(huge.endsWith('...[truncated]'));

  const minimal = buildFixPrompt({ message: '' });
  assert.match(minimal, /Error: Runtime error/);
  assert.ok(!minimal.includes('Stack:'));
  assert.ok(!minimal.includes('Page:'));

  const control = buildFixPrompt({ message: 'evil\n\u0000text' });
  assert.ok(!control.includes('\u0000'));
});

test('the prompt names the picked element when the user clicked one', () => {
  const prompt = buildFixPrompt({
    message: 'Cannot read properties of null',
    reveal: { path: 'index.html', tag: 'button', id: 'buy', className: 'cta', text: 'Buy now' }
  });
  assert.match(prompt, /Element picked in the preview: <button id="buy"> served from index\.html/);
});

test('error signatures collapse repeats but keep distinct errors apart', () => {
  const a = errorSignature('boom', STACK);
  const b = errorSignature('boom', `${STACK}\n    at extra (http://127.0.0.1:5173/src/x.ts:1:1)`);
  assert.equal(a, b, 'only the first frame participates');
  assert.notEqual(errorSignature('boom', STACK), errorSignature('other', STACK));
  assert.equal(errorSignature('boom'), 'boom|');
});
