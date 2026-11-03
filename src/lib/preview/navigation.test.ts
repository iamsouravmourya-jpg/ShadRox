import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NAVIGATION_LIMIT,
  canGoBack,
  canGoForward,
  clearNavigation,
  createNavigation,
  currentUrl,
  describeAddress,
  goBack,
  goForward,
  pushEntry,
  replaceEntry,
  resolveAddress,
  rootUrl,
  withPort
} from './navigation';

const BASE = 'http://127.0.0.1:5173/';

test('resolveAddress turns what the user typed into a URL on the running server', () => {
  assert.deepEqual(resolveAddress(BASE, 'about'), { ok: true, url: 'http://127.0.0.1:5173/about' });
  assert.deepEqual(resolveAddress(BASE, '/about'), { ok: true, url: 'http://127.0.0.1:5173/about' });
  assert.deepEqual(resolveAddress('http://127.0.0.1:5173/docs/index.html', 'price'), {
    ok: true,
    url: 'http://127.0.0.1:5173/docs/price'
  });
  assert.deepEqual(resolveAddress(BASE, 'cart?qty=2#top'), {
    ok: true,
    url: 'http://127.0.0.1:5173/cart?qty=2#top'
  });
  assert.deepEqual(resolveAddress(BASE, 'http://127.0.0.1:5173/deep/page'), {
    ok: true,
    url: 'http://127.0.0.1:5173/deep/page'
  });
});

test('resolveAddress refuses anything that would leave the preview server', () => {
  assert.equal(resolveAddress(BASE, '').ok, false);
  assert.equal(resolveAddress(BASE, '   ').ok, false);
  assert.equal(resolveAddress(BASE, 'javascript:alert(1)').ok, false);
  assert.equal(resolveAddress(BASE, 'data:text/html,<script>alert(1)</script>').ok, false);
  assert.equal(resolveAddress(BASE, 'file:///C:/Windows/system.ini').ok, false);
  assert.equal(resolveAddress(BASE, 'https://evil.example/x').ok, false);
  assert.equal(resolveAddress(BASE, 'http://localhost:3000/x').ok, false);
  assert.equal(resolveAddress(BASE, '//evil.example/x').ok, false);
  const foreign = resolveAddress(BASE, 'https://evil.example/x');
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.match(foreign.reason, /^Only pages on http:\/\/127\.0\.0\.1:5173 can be previewed\.$/);
});

test('resolveAddress with no server running asks for a path instead of guessing', () => {
  assert.deepEqual(resolveAddress(null, 'http://127.0.0.1:3000/'), {
    ok: false,
    reason: 'No preview server is running, so only its own pages can be opened.'
  });
  assert.deepEqual(resolveAddress(null, '/about'), {
    ok: false,
    reason: 'No preview server is running.'
  });
});

test('resolveAddress rejects oversized and control-character input', () => {
  assert.equal(resolveAddress(BASE, `a${'x'.repeat(2100)}`).ok, false);
  assert.equal(resolveAddress(BASE, 'bad\ncharacter').ok, false);
});

test('the stack records every address the panel asked for', () => {
  let stack = createNavigation(BASE);
  assert.equal(currentUrl(stack), BASE);
  stack = pushEntry(stack, 'http://127.0.0.1:5173/cart');
  stack = pushEntry(stack, 'http://127.0.0.1:5173/checkout');
  assert.deepEqual(stack.entries, [BASE, 'http://127.0.0.1:5173/cart', 'http://127.0.0.1:5173/checkout']);
  assert.equal(stack.index, 2);

  stack = goBack(stack);
  stack = goBack(stack);
  assert.equal(canGoBack(stack), false);
  assert.equal(currentUrl(stack), BASE);
  stack = goBack(stack);
  assert.equal(currentUrl(stack), BASE);

  stack = goForward(stack);
  assert.equal(currentUrl(stack), 'http://127.0.0.1:5173/cart');
  assert.equal(canGoForward(stack), true);
  stack = goForward(stack);
  stack = goForward(stack);
  assert.equal(canGoForward(stack), false);
  assert.equal(currentUrl(stack), 'http://127.0.0.1:5173/checkout');
});

test('pushing after going back drops the forward branch', () => {
  let stack = createNavigation(BASE);
  for (const path of ['/a', '/b', '/c']) stack = pushEntry(stack, BASE.slice(0, -1) + path);
  stack = goBack(goBack(stack));
  assert.equal(currentUrl(stack), 'http://127.0.0.1:5173/a');
  stack = pushEntry(stack, 'http://127.0.0.1:5173/d');
  assert.deepEqual(stack.entries, [BASE, 'http://127.0.0.1:5173/a', 'http://127.0.0.1:5173/d']);
  assert.equal(canGoForward(stack), false);
});

test('repeating the current address does not grow the stack', () => {
  const stack = pushEntry(createNavigation(BASE), BASE);
  assert.deepEqual(stack.entries, [BASE]);
  assert.deepEqual(pushEntry(createNavigation(null), ''), { entries: [], index: -1 });
});

test('the stack is capped so a long session cannot grow without bound', () => {
  let stack = createNavigation(BASE);
  for (let index = 0; index < NAVIGATION_LIMIT + 20; index += 1) {
    stack = pushEntry(stack, `${BASE}page-${index}`);
  }
  assert.equal(stack.entries.length, NAVIGATION_LIMIT);
  assert.equal(stack.index, NAVIGATION_LIMIT - 1);
  assert.equal(currentUrl(stack), `${BASE}page-${NAVIGATION_LIMIT + 19}`);
  assert.equal(canGoBack(stack), true);
});

test('replaceEntry swaps only the live entry, including when the stack is empty', () => {
  let stack = createNavigation(BASE);
  stack = pushEntry(stack, 'http://127.0.0.1:5173/a');
  stack = goBack(stack);
  const replaced = replaceEntry(stack, 'http://127.0.0.1:4000/');
  assert.deepEqual(replaced.entries, ['http://127.0.0.1:4000/', 'http://127.0.0.1:5173/a']);
  assert.equal(replaced.index, 0);
  assert.equal(replaceEntry(stack, stack.entries[stack.index]), stack);
  assert.deepEqual(replaceEntry(clearNavigation(), 'http://127.0.0.1:4000/'), {
    entries: ['http://127.0.0.1:4000/'],
    index: 0
  });
});

test('rootUrl, withPort and describeAddress keep the address honest', () => {
  assert.equal(rootUrl('http://127.0.0.1:5173/docs/page?x=1#y'), 'http://127.0.0.1:5173/');
  assert.equal(rootUrl(null), null);
  assert.equal(withPort('http://127.0.0.1:5173/app', 3000), 'http://127.0.0.1:3000/app');
  assert.equal(withPort('http://127.0.0.1:5173/app', null), 'http://127.0.0.1:5173/app');
  assert.equal(withPort('http://127.0.0.1:5173/app', 0), 'http://127.0.0.1:5173/app');
  assert.equal(withPort('http://127.0.0.1:5173/app', 70000), 'http://127.0.0.1:5173/app');
  assert.deepEqual(describeAddress('http://127.0.0.1:5173/cart?qty=2'), {
    origin: 'http://127.0.0.1:5173',
    path: '/cart?qty=2'
  });
  assert.equal(describeAddress('not a url'), null);
});
