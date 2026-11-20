'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SELECTOR_LENGTH,
  MAX_CONSOLE_ENTRIES,
  MAX_NETWORK_ENTRIES,
  sanitizeInspectSelector,
  buildDomScript,
  buildClickScript,
  buildTypeScript,
  buildPreviewRectsScript,
  createInspectBuffers,
  isLoopbackPreviewUrl,
  matchPreviewFrameUrl,
  clampRect,
  normalizeConsoleLevel,
  registerPreviewInspect
} = require('./preview-inspect.cjs');

test('sanitizeInspectSelector trims, caps and rejects control characters', () => {
  assert.equal(sanitizeInspectSelector('  #root  '), '#root');
  assert.equal(sanitizeInspectSelector(''), null);
  assert.equal(sanitizeInspectSelector(null), null);
  assert.equal(sanitizeInspectSelector(42), null);
  assert.equal(sanitizeInspectSelector('a'.repeat(500)).length, MAX_SELECTOR_LENGTH);
  assert.equal(sanitizeInspectSelector('#root\u0000'), null);
  assert.equal(sanitizeInspectSelector('#root\n'), '#root'); // trimmed newline is fine
  assert.equal(sanitizeInspectSelector('#ro\u0007ot'), null);
});

test('frame scripts interpolate via JSON and never navigate', () => {
  const hostile = '"); window.location = "https://evil.example"; ("';
  for (const script of [buildDomScript(hostile), buildClickScript(hostile), buildTypeScript(hostile, 'x") ; location.href="https://evil.example"; ("')]) {
    assert.ok(script.includes(JSON.stringify(hostile).slice(1, 20)));
    assert.ok(!/location\s*(?:\.href\s*)?=/.test(script.replace(/JSON|\\\"/g, '')) || script.includes('\\"'));
    assert.ok(!script.includes('window.open('));
    assert.ok(!script.includes('location.assign'));
    assert.ok(!script.includes('location.replace'));
  }
  // The raw hostile payload must only ever appear JSON-escaped.
  const dom = buildDomScript(hostile);
  assert.ok(!dom.includes(hostile));
  assert.ok(dom.includes('\\"'));
  const typed = buildTypeScript('#input', 'hello "world"');
  assert.ok(typed.includes('hello \\"world\\"'));
  assert.ok(buildPreviewRectsScript().includes('getBoundingClientRect'));
  assert.ok(!buildPreviewRectsScript().includes('src ='));
});

test('type script caps text and uses the native value setter', () => {
  const script = buildTypeScript('input', 'x'.repeat(5000));
  assert.ok(script.includes('HTMLInputElement'));
  assert.ok(script.includes("dispatchEvent(new Event('input'"));
  assert.ok(!script.includes('x'.repeat(2100)));
});

test('inspect buffers stay bounded and filter network errors', () => {
  const buffers = createInspectBuffers();
  for (let i = 0; i < MAX_CONSOLE_ENTRIES + 50; i += 1) {
    buffers.pushConsole({ level: 'log', text: `line ${i}` });
  }
  const logs = buffers.consoleLogs();
  assert.equal(logs.length, MAX_CONSOLE_ENTRIES);
  assert.equal(logs[0].text, 'line 50');
  assert.equal(logs.at(-1).text, `line ${MAX_CONSOLE_ENTRIES + 49}`);

  for (let i = 0; i < MAX_NETWORK_ENTRIES + 20; i += 1) {
    buffers.pushNetwork({ url: `http://localhost:5173/${i}`, status: i % 2 === 0 ? 200 : 500 });
  }
  buffers.pushNetwork({ url: 'http://localhost:5173/dead', status: 0, error: 'net::ERR_CONNECTION_REFUSED' });
  const errors = buffers.networkErrors();
  assert.ok(errors.length <= MAX_NETWORK_ENTRIES);
  assert.ok(errors.every((entry) => entry.error || entry.status >= 400));
  assert.ok(errors.some((entry) => entry.error === 'net::ERR_CONNECTION_REFUSED'));
  assert.equal(buffers.consoleLogs()[0].text, 'line 50'); // rings are independent
  buffers.clear();
  assert.equal(buffers.consoleLogs().length, 0);
});

test('console text is clipped and levels normalized', () => {
  const buffers = createInspectBuffers();
  buffers.pushConsole({ level: 'error', text: 'e'.repeat(9000) });
  const [entry] = buffers.consoleLogs();
  assert.equal(entry.level, 'error');
  assert.ok(entry.text.length <= 2001);
  assert.equal(normalizeConsoleLevel(3), 'error');
  assert.equal(normalizeConsoleLevel(2), 'warn');
  assert.equal(normalizeConsoleLevel('warning'), 'warn');
  assert.equal(normalizeConsoleLevel('info'), 'log');
  assert.equal(normalizeConsoleLevel(0), 'log');
});

test('isLoopbackPreviewUrl allows only loopback and the preview scheme', () => {
  assert.ok(isLoopbackPreviewUrl('http://localhost:5173/'));
  assert.ok(isLoopbackPreviewUrl('http://127.0.0.1:3000/path'));
  assert.ok(isLoopbackPreviewUrl('http://[::1]:5173/'));
  assert.ok(isLoopbackPreviewUrl('shadrox-preview://workspace-1/index.html'));
  assert.ok(!isLoopbackPreviewUrl('https://example.com/'));
  assert.ok(!isLoopbackPreviewUrl('http://192.168.1.5:5173/'));
  assert.ok(!isLoopbackPreviewUrl('http://10.0.0.2/'));
  assert.ok(!isLoopbackPreviewUrl('file:///C:/secret.txt'));
  assert.ok(!isLoopbackPreviewUrl('not a url'));
  assert.ok(!isLoopbackPreviewUrl('http://localhost.evil.com/'));
});

test('matchPreviewFrameUrl prefers runtime origins and falls back to the scheme', () => {
  const runtime = (url) => (url.startsWith('http://localhost:5173') ? 'ws-1' : null);
  assert.ok(matchPreviewFrameUrl('http://localhost:5173/x', 'ws-1', runtime));
  assert.ok(!matchPreviewFrameUrl('http://localhost:5173/x', 'ws-2', runtime));
  assert.ok(matchPreviewFrameUrl('shadrox-preview://ws-2/index.html', 'ws-2', runtime));
  assert.ok(!matchPreviewFrameUrl('shadrox-preview://ws-2/index.html', 'ws-1', runtime));
  assert.ok(!matchPreviewFrameUrl('', 'ws-1', runtime));
});

test('clampRect rejects degenerate geometry and bounds huge rects', () => {
  assert.equal(clampRect(null), null);
  assert.equal(clampRect({ x: 0, y: 0, width: 0, height: 100 }), null);
  assert.equal(clampRect({ x: 0, y: 0, width: NaN, height: 100 }), null);
  assert.deepEqual(clampRect({ x: -5, y: 10.4, width: 9000, height: 600 }), { x: 0, y: 10, width: 8192, height: 600 });
});

function fakeElectron({ frameUrl = 'http://localhost:5173/', frameResult = { found: true, tag: 'div', html: '<div>ok</div>' } } = {}) {
  const handlers = new Map();
  const frame = {
    url: frameUrl,
    isDestroyed: () => false,
    executeJavaScript: async () => frameResult
  };
  const mainFrame = { url: 'shadrox-app://renderer/index.html', framesInSubtree: [frame], executeJavaScript: async () => [] };
  const webContents = { mainFrame, isDestroyed: () => false };
  const win = { webContents, isDestroyed: () => false, capturePage: async () => ({ isEmpty: () => true }) };
  const electron = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { on: () => {} },
    BrowserWindow: {
      fromWebContents: (sender) => (sender === webContents ? win : null),
      getAllWindows: () => [win]
    },
    nativeImage: {}
  };
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  return { electron, handlers, trustedEvent, win, frame, mainFrame, webContents };
}

test('registerPreviewInspect is a no-op without ipcMain', () => {
  assert.equal(registerPreviewInspect({}), null);
  assert.equal(registerPreviewInspect(), null);
});

test('inspect handler rejects untrusted frames and bad requests', async () => {
  const { electron, handlers, trustedEvent, mainFrame } = fakeElectron();
  registerPreviewInspect({ ...electron, getWorkspaceIdForUrl: () => null });
  const run = handlers.get('preview-inspect:run');
  assert.ok(run);

  const foreign = await run({ sender: trustedEvent.sender, senderFrame: { url: 'http://localhost:5173/' } }, 'ws-1', { action: 'get_dom' });
  assert.equal(foreign.ok, false); // senderFrame !== mainFrame

  const noRequest = await run(trustedEvent, 'ws-1', null);
  assert.equal(noRequest.ok, false);
  const badId = await run(trustedEvent, '', { action: 'get_dom' });
  assert.equal(badId.ok, false);
  const unknown = await run(trustedEvent, 'ws-1', { action: 'navigate' });
  assert.ok(unknown.ok === false || unknown.error); // frame not found or unknown action, never success
  void mainFrame;
});

test('inspect handler serves dom/click/type through the preview frame only', async () => {
  const { electron, handlers, trustedEvent } = fakeElectron();
  const runtime = (url) => (url.startsWith('http://localhost:5173') ? 'ws-1' : null);
  registerPreviewInspect({ ...electron, getWorkspaceIdForUrl: runtime });
  const run = handlers.get('preview-inspect:run');

  const dom = await run(trustedEvent, 'ws-1', { action: 'get_dom', selector: '#root' });
  assert.deepEqual(dom, { ok: true, found: true, count: 1, tag: 'div', html: '<div>ok</div>' });
  const domAlias = await run(trustedEvent, 'ws-1', { action: 'dom', selector: '#root' });
  assert.equal(domAlias.ok, true);

  const missing = await run(trustedEvent, 'ws-2', { action: 'get_dom' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not open/);

  const badSelector = await run(trustedEvent, 'ws-1', { action: 'click', selector: '#a\u0000b' });
  assert.equal(badSelector.ok, false);

  const tooLongText = await run(trustedEvent, 'ws-1', { action: 'type', selector: 'input', text: 'x'.repeat(3000) });
  assert.equal(tooLongText.ok, false);
});

test('inspect handler refuses non-loopback preview frames', async () => {
  const { electron, handlers, trustedEvent } = fakeElectron({ frameUrl: 'https://example.com/' });
  registerPreviewInspect({ ...electron, getWorkspaceIdForUrl: () => 'ws-1' });
  const run = handlers.get('preview-inspect:run');
  const result = await run(trustedEvent, 'ws-1', { action: 'get_dom' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not open/);
});

test('console and network rings are readable per workspace', async () => {
  const { electron, handlers, trustedEvent } = fakeElectron();
  const registered = registerPreviewInspect({ ...electron, getWorkspaceIdForUrl: () => null });
  registered.buffersFor('ws-1').pushConsole({ level: 'error', text: 'boom' });
  registered.buffersFor('ws-1').pushNetwork({ url: 'http://localhost:5173/api', status: 500 });
  const run = handlers.get('preview-inspect:run');
  const logs = await run(trustedEvent, 'ws-1', { action: 'get_console_logs' });
  assert.equal(logs.ok, true);
  assert.equal(logs.logs[0].message, 'boom');
  const logsAlias = await run(trustedEvent, 'ws-1', { action: 'console' });
  assert.equal(logsAlias.logs[0].message, 'boom');
  const errors = await run(trustedEvent, 'ws-1', { action: 'get_network_errors' });
  assert.equal(errors.ok, true);
  assert.equal(errors.errors[0].status, 500);
  const errorsAlias = await run(trustedEvent, 'ws-1', { action: 'network' });
  assert.equal(errorsAlias.errors[0].status, 500);
  const other = await run(trustedEvent, 'ws-2', { action: 'get_console_logs' });
  assert.equal(other.logs.length, 0);
});