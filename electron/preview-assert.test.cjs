'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildFrameAssertionScript,
  createConsoleErrorSink,
  mergePreviewVerdict,
  sanitizeSelectors,
  summarizeFrameResult
} = require('./preview-assert.cjs');

test('selector allowlist rejects scripts and caps accepted input', () => {
  assert.deepEqual(sanitizeSelectors(['#root', '.App', 'body', 'main', 'body *', '#x")']), ['#root', '.App', 'body', 'main']);
  assert.match(buildFrameAssertionScript(['#root']), /const selectors = \["#root"\]/);
  assert.doesNotMatch(buildFrameAssertionScript(['body *']), /body \*/);
});

test('frame summaries expose only bounded structural results', () => {
  assert.deepEqual(summarizeFrameResult({
    evaluated: true,
    results: [{ selector: '#root', count: 1, visibleCount: 1, width: 800, height: 600 }]
  }), { evaluated: true, failedSelectors: [], warningSelectors: [] });
  assert.deepEqual(summarizeFrameResult({
    evaluated: true,
    results: [{ selector: '#root', count: 0, visibleCount: 0 }]
  }), { evaluated: true, failedSelectors: ['#root'], warningSelectors: [] });
});

test('console sink bounds messages and drains per workspace', () => {
  const sink = createConsoleErrorSink({ maxKeptPerWorkspace: 2, maxMessageLength: 8 });
  sink.record('a', '  first\nerror  ');
  sink.record('a', 'second error');
  sink.record('a', 'third');
  assert.deepEqual(sink.drain('a'), ['second e', 'third']);
  assert.deepEqual(sink.drain('a'), []);
});

test('assertion verdict stays observed without source-derived app selectors', () => {
  const result = mergePreviewVerdict({
    frameFound: true,
    evaluated: true,
    failedSelectors: [],
    warningSelectors: [],
    consoleErrors: [],
    containerDerived: false
  });
  assert.equal(result.status, 'observed');
  assert.equal(result.ok, false);
});

test('missing roots and runtime errors are reported as fatal', () => {
  const missing = mergePreviewVerdict({
    frameFound: true,
    evaluated: true,
    failedSelectors: ['#root'],
    warningSelectors: [],
    consoleErrors: [],
    containerDerived: true
  });
  const runtime = mergePreviewVerdict({
    frameFound: true,
    evaluated: true,
    failedSelectors: [],
    warningSelectors: [],
    consoleErrors: ['TypeError: render failed'],
    containerDerived: true
  });
  assert.equal(missing.status, 'fatal');
  assert.equal(runtime.status, 'fatal');
});
