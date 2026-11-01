'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  SOURCE_BRIDGE_MARKER,
  SOURCE_BRIDGE_SCRIPT,
  SOURCE_FILE_TOKEN,
  buildSourceBridgeScript,
  injectSourceBridge,
  normalizeSourceFileName,
  shouldInject
} = require('./preview-source.cjs');

function makeElement(tagName, options) {
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    parentElement: null
  };
  return Object.assign(element, options || {});
}

function createPage(fileName) {
  const posted = [];
  const listeners = [];
  const document = {
    addEventListener(type, listener, capture) {
      listeners.push({ type, listener, capture });
    }
  };
  const window = {
    parent: {
      postMessage(payload, targetOrigin) {
        posted.push({ payload, targetOrigin });
      }
    }
  };
  const context = vm.createContext({ window, document, String });
  vm.runInContext(buildSourceBridgeScript(fileName || 'pages/index.html'), context);
  return { posted, listeners };
}

function dispatch(listeners, event) {
  assert.equal(listeners.length, 1);
  listeners[0].listener(event);
}

test('injects the bridge before the last closing body tag without touching other bytes', () => {
  const html = '<!doctype html>\n<html>\n<body>\n  <p>hi</p>\n</body>\n</html>\n';
  const injected = injectSourceBridge(html, { fileName: 'public/index.html' });

  assert.ok(injected.includes(SOURCE_BRIDGE_MARKER));
  assert.ok(injected.indexOf('<script data-shadrox-source-bridge="1">') < injected.lastIndexOf('</body>'));
  assert.equal(
    injected.replace(/<script data-shadrox-source-bridge="1">[\s\S]*?<\/script>/, ''),
    html
  );
  // Idempotent: a second pass is a byte-for-byte no-op.
  assert.equal(injectSourceBridge(injected, { fileName: 'public/index.html' }), injected);
});

test('handles uppercase closing tags and fragments without a body tag', () => {
  const upper = '<HTML>\n<BODY>\n<P>x</P>\n</BODY>\n</HTML>';
  const injected = injectSourceBridge(upper, { fileName: 'index.html' });
  assert.ok(injected.endsWith('</BODY>\n</HTML>'));
  assert.ok(injected.indexOf(SOURCE_BRIDGE_MARKER) !== -1);
  assert.ok(injected.indexOf('<script') < injected.indexOf('</BODY>'));

  const fragment = '<p>standalone fragment</p>';
  const appended = injectSourceBridge(fragment, { fileName: 'fragment.htm' });
  assert.ok(appended.startsWith(fragment));
  assert.ok(appended.includes(SOURCE_BRIDGE_MARKER));
});

test('rejects non-string html and unsafe file names', () => {
  assert.throws(() => injectSourceBridge(null, { fileName: 'index.html' }), /html must be a string/);
  assert.throws(() => injectSourceBridge(Buffer.from('<body></body>'), { fileName: 'index.html' }), /html must be a string/);
  assert.throws(() => injectSourceBridge('<body></body>', undefined), /fileName/);
  assert.throws(() => injectSourceBridge('<body></body>', {}), /fileName must be a string/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: '' }), /non-empty/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: '/etc/passwd.html' }), /relative, not absolute/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: 'C:\\site\\index.html' }), /drive letter/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: '../secrets.html' }), /parent path/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: 'public\\..\\secrets.html' }), /parent path/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: 'https://evil.test/x.html' }), /URL/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: 'a/<script>.html' }), /forbidden/);
  assert.throws(() => injectSourceBridge('<body></body>', { fileName: 'a//b.html' }), /plain relative path/);
  assert.equal(normalizeSourceFileName('public\\pages\\index.html'), 'public/pages/index.html');
});

test('bakes the file name in as a JSON literal, never from page data', () => {
  const injected = injectSourceBridge('<body></body>', { fileName: 'odd"name.html' });
  assert.ok(injected.includes('var FILE_PATH = "odd\\"name.html";'));
  assert.ok(!SOURCE_BRIDGE_SCRIPT.includes('document.currentScript'));
  assert.ok(!SOURCE_BRIDGE_SCRIPT.includes('electronAPI'));
  assert.ok(!SOURCE_BRIDGE_SCRIPT.includes('require('));
  assert.ok(!SOURCE_BRIDGE_SCRIPT.includes('eval('));
  assert.equal((SOURCE_BRIDGE_SCRIPT.match(/postMessage/g) || []).length, 1);
  assert.ok(SOURCE_BRIDGE_SCRIPT.includes(SOURCE_FILE_TOKEN));
});

test('shouldInject only accepts served HTML documents', () => {
  assert.equal(shouldInject('index.html', 'text/html'), true);
  assert.equal(shouldInject('pages\\about.HTM', 'Text/HTML; charset=utf-8'), true);
  assert.equal(shouldInject('index.html?v=2', 'text/html'), true);
  assert.equal(shouldInject('styles.css', 'text/css'), false);
  assert.equal(shouldInject('app.js', 'text/html'), false);
  assert.equal(shouldInject('index.html', 'application/xhtml+xml'), false);
  assert.equal(shouldInject('index.html', undefined), false);
  assert.equal(shouldInject(undefined, 'text/html'), false);
});

test('a click posts one descriptive message for the nearest ancestor with an id', () => {
  const { posted, listeners } = createPage();
  assert.equal(listeners[0].type, 'click');
  assert.equal(listeners[0].capture, true);

  const span = makeElement('span', { className: 'price big', textContent: '  $19   only ' });
  const button = makeElement('button', { className: 'buy', textContent: 'Buy' });
  const hero = makeElement('section', { id: 'hero', className: 'hero   panel', textContent: '  Big   promo  ' });
  span.parentElement = button;
  button.parentElement = hero;
  hero.parentElement = makeElement('body');

  const event = { target: span, button: 0 };
  dispatch(listeners, event);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].targetOrigin, '*');
  // Copy into this realm: the payload object is created inside the vm context.
  assert.deepEqual({ ...posted[0].payload }, {
    source: 'shadrox-preview',
    type: 'reveal-source',
    path: 'pages/index.html',
    tag: 'section',
    id: 'hero',
    className: 'hero panel',
    text: 'Big promo'
  });

  // The same click object never posts twice.
  dispatch(listeners, event);
  assert.equal(posted.length, 1);
});

test('ignores body clicks and clicks with modifier keys held', () => {
  const bodyPage = createPage();
  const body = makeElement('body', { textContent: 'Everything' });
  dispatch(bodyPage.listeners, { target: body, button: 0 });
  assert.equal(bodyPage.posted.length, 0);

  const page = createPage('index.html');
  const link = makeElement('a', { className: 'cta', textContent: 'Open' });
  link.parentElement = body;
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    dispatch(page.listeners, { target: link, button: 0, [modifier]: true });
  }
  assert.equal(page.posted.length, 0);

  // Middle/right clicks are ignored too.
  dispatch(page.listeners, { target: link, button: 1 });
  assert.equal(page.posted.length, 0);

  // A plain click with no id ancestor reports the clicked element itself.
  const event = { target: link, button: 0 };
  dispatch(page.listeners, event);
  assert.equal(page.posted.length, 1);
  assert.equal(page.posted[0].payload.tag, 'a');
  assert.equal(page.posted[0].payload.id, '');
  assert.equal(page.posted[0].payload.path, 'index.html');
});

test('caps the forwarded text at 200 characters but sends only strings', () => {
  const { posted, listeners } = createPage();
  const paragraph = makeElement('p', { textContent: 'x'.repeat(500) });
  paragraph.parentElement = makeElement('body');
  dispatch(listeners, { target: paragraph, button: 0 });

  assert.equal(posted.length, 1);
  const payload = posted[0].payload;
  assert.equal(payload.text.length, 200);
  assert.equal(typeof payload.path, 'string');
  assert.equal(typeof payload.tag, 'string');
  assert.equal(typeof payload.id, 'string');
  assert.equal(typeof payload.className, 'string');
});
