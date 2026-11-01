import assert from 'node:assert/strict';
import test from 'node:test';
import { findElementLine, parseRevealMessage } from './previewSource';

const SOURCE = [
  '<!doctype html>', // 0
  '<html>', // 1
  '<head><title>Demo</title></head>', // 2
  '<body>', // 3
  '  <header id="top">', // 4
  '    <h1 class="hero-title big">Welcome</h1>', // 5
  '  </header>', // 6
  '  <div class="card" id="first">', // 7
  '    <p class="card-copy">Hello world</p>', // 8
  '  </div>', // 9
  '  <!-- <div id="commented">Hidden</div> -->', // 10
  '  <section id="panel-section" class="panel">', // 11
  '    <span class="badge">New arrival</span>', // 12
  '  </section>', // 13
  '  <div class="first">Plain block</div>', // 14
  '</body>', // 15
  '</html>' // 16
].join('\n');

function target(overrides: Partial<Parameters<typeof findElementLine>[1]> = {}) {
  return {
    path: 'index.html',
    tag: 'div',
    id: '',
    className: '',
    text: '',
    ...overrides
  };
}

test('parseRevealMessage accepts well-formed reveal messages', () => {
  const parsed = parseRevealMessage({
    source: 'shadrox-preview',
    type: 'reveal-source',
    path: 'pages/index.html',
    tag: 'SECTION',
    id: 'hero',
    className: 'hero   panel',
    text: '  Big   promo  '
  });
  assert.deepEqual(parsed, {
    path: 'pages/index.html',
    tag: 'section',
    id: 'hero',
    className: 'hero panel',
    text: 'Big promo'
  });
});

test('parseRevealMessage caps oversized fields', () => {
  const parsed = parseRevealMessage({
    source: 'shadrox-preview',
    type: 'reveal-source',
    path: 'index.html',
    tag: 'p',
    id: 'i'.repeat(500),
    className: 'c'.repeat(1000),
    text: 't'.repeat(500)
  });
  assert.ok(parsed);
  assert.equal(parsed.id.length, 256);
  assert.equal(parsed.className.length, 400);
  assert.equal(parsed.text.length, 200);
});

test('parseRevealMessage rejects wrong sources, types and shapes', () => {
  const base = { source: 'shadrox-preview', type: 'reveal-source', path: 'index.html', tag: 'div' };
  assert.equal(parseRevealMessage(null), null);
  assert.equal(parseRevealMessage('reveal-source'), null);
  assert.equal(parseRevealMessage([base]), null);
  assert.equal(parseRevealMessage({ ...base, source: 'other-app' }), null);
  assert.equal(parseRevealMessage({ ...base, type: 'console-log' }), null);
  assert.equal(parseRevealMessage({ ...base, tag: '<script>alert(1)</script>' }), null);
  assert.equal(parseRevealMessage({ ...base, tag: 42 }), null);
  assert.equal(parseRevealMessage({ ...base, id: { value: 'x' } }), null);
  assert.equal(parseRevealMessage({ ...base, className: ['a'] }), null);
  assert.equal(parseRevealMessage({ ...base, text: { toString: 'x' } }), null);
  assert.equal(parseRevealMessage({ ...base, path: undefined }), null);
});

test('parseRevealMessage rejects hostile paths', () => {
  const base = { source: 'shadrox-preview', type: 'reveal-source', tag: 'div' };
  for (const path of [
    '../secrets.html',
    'pages/../../secrets.html',
    '/etc/passwd.html',
    '\\\\server\\share\\index.html',
    'C:\\site\\index.html',
    'file:///etc/passwd.html',
    'index.html\u0000',
    'a/<script>.html',
    'pages//index.html',
    ''
  ]) {
    assert.equal(parseRevealMessage({ ...base, path }), null, `path should be rejected: ${path}`);
  }
});

test('findElementLine matches an id regardless of attribute order or quotes', () => {
  assert.deepEqual(findElementLine(SOURCE, target({ id: 'first' })), { line: 7, character: 2 });

  const reordered = '<div class="card" id="first">A</div>\n<div id="first" class="other">B</div>';
  assert.deepEqual(findElementLine(reordered, target({ id: 'first' })), { line: 0, character: 0 });

  const singleQuoted = '<div id=\'solo\' class="x">Solo</div>';
  assert.deepEqual(findElementLine(singleQuoted, target({ id: 'solo' })), { line: 0, character: 0 });

  const unquoted = '<div id=solo class=x>Solo</div>';
  assert.deepEqual(findElementLine(unquoted, target({ id: 'solo' })), { line: 0, character: 0 });
});

test('findElementLine keeps ids case-sensitive and always ignores <html>/<body>', () => {
  const singleDiv = '<div id="first">Alpha</div>';
  assert.deepEqual(findElementLine(singleDiv, target({ id: 'first' })), { line: 0, character: 0 });
  assert.equal(findElementLine(singleDiv, target({ id: 'FIRST' })), null);

  assert.equal(findElementLine(SOURCE, target({ tag: 'html', id: 'top' })), null);
  assert.equal(findElementLine(SOURCE, target({ tag: 'body', text: 'Welcome' })), null);
});

test('findElementLine falls back to a distinctive class token', () => {
  assert.deepEqual(findElementLine(SOURCE, target({ tag: 'span', className: 'badge', text: '' })), {
    line: 12,
    character: 4
  });

  // Case-insensitive class matching, and short tokens are not distinctive.
  assert.deepEqual(findElementLine(SOURCE, target({ tag: 'div', className: 'CARD' })), {
    line: 7,
    character: 2
  });
  assert.equal(findElementLine(SOURCE, target({ tag: 'div', id: 'missing', className: 'ab' })), null);
});

test('findElementLine falls back to the first text word', () => {
  assert.deepEqual(findElementLine(SOURCE, target({ tag: 'p', className: '', text: 'Hello world' })), {
    line: 8,
    character: 4
  });
  assert.deepEqual(findElementLine(SOURCE, target({ tag: 'DIV', className: '', text: 'Plain block' })), {
    line: 14,
    character: 2
  });
});

test('findElementLine never matches inside HTML comments', () => {
  assert.equal(findElementLine(SOURCE, target({ tag: 'div', id: 'commented', text: 'Hidden' })), null);
  assert.equal(findElementLine(SOURCE, target({ tag: 'div', text: 'Hidden' })), null);

  const commentedFirst = '<!--\n<div id="dup">Old</div>\n-->\n<div id="dup">Real</div>';
  assert.deepEqual(findElementLine(commentedFirst, target({ tag: 'div', id: 'dup' })), {
    line: 3,
    character: 0
  });
});

test('findElementLine returns null on misses and respects the 40 line window', () => {
  assert.equal(findElementLine(SOURCE, target({ tag: 'table', text: 'Nothing' })), null);
  assert.equal(findElementLine(SOURCE, target({ tag: 'div', text: 'Missing words entirely' })), null);
  assert.equal(findElementLine('', target({ tag: 'div' })), null);

  const farAway = ['<div class="block">', ...Array.from({ length: 45 }, () => '  <p>noise</p>'), '  Far text'].join('\n');
  assert.equal(findElementLine(farAway, target({ tag: 'div', text: 'Far' })), null);
});

test('findElementLine maps CRLF sources to correct 0-based positions', () => {
  const crlf = '<body>\r\n<section id="x">\r\n  <span>Hi</span>\r\n</section>\r\n</body>';
  assert.deepEqual(findElementLine(crlf, target({ tag: 'span', text: 'Hi' })), {
    line: 2,
    character: 2
  });
});
