import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreviewAssertion, DomProbeTarget } from './previewAssertions';

function createMockDomProbe(overrides: Partial<DomProbeTarget> = {}): DomProbeTarget {
  const elements = new Map<string, { textContent: string; width: number; height: number }>([
    ['#root', { textContent: 'ShadRox Live App', width: 1200, height: 800 }],
    ['button.submit', { textContent: 'Save Changes', width: 120, height: 36 }],
    ['.zero-elem', { textContent: '', width: 0, height: 0 }]
  ]);

  return {
    url: 'http://localhost:3000/dashboard',
    querySelector: (selector: string) => {
      const found = elements.get(selector);
      if (!found) return null;
      return {
        textContent: found.textContent,
        getBoundingClientRect: () => ({ width: found.width, height: found.height })
      };
    },
    consoleErrors: [],
    ...overrides
  };
}

test('evaluatePreviewAssertion passes when route, selector, text and bounding box match', () => {
  const probe = createMockDomProbe();
  const result = evaluatePreviewAssertion(probe, {
    route: '/dashboard',
    selector: 'button.submit',
    expectedText: 'Save',
    requireNonZeroBoundingBox: true,
    failOnConsoleErrors: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectorFound, true);
  assert.equal(result.textMatched, true);
  assert.equal(result.boundingBoxValid, true);
  assert.equal(result.consoleErrors.length, 0);
});

test('evaluatePreviewAssertion fails cleanly when selector is missing', () => {
  const probe = createMockDomProbe();
  const result = evaluatePreviewAssertion(probe, {
    route: '/dashboard',
    selector: '#non-existent'
  });

  assert.equal(result.ok, false);
  assert.equal(result.selectorFound, false);
  assert.match(result.failureReason || '', /not found in preview DOM/);
});

test('evaluatePreviewAssertion catches zero-dimension invisible elements', () => {
  const probe = createMockDomProbe();
  const result = evaluatePreviewAssertion(probe, {
    route: '/dashboard',
    selector: '.zero-elem',
    requireNonZeroBoundingBox: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.boundingBoxValid, false);
  assert.match(result.failureReason || '', /zero dimensions/);
});

test('evaluatePreviewAssertion detects fatal console errors in preview', () => {
  const probe = createMockDomProbe({
    consoleErrors: ['Uncaught ReferenceError: foo is not defined at app.js:12']
  });
  const result = evaluatePreviewAssertion(probe, {
    route: '/dashboard',
    failOnConsoleErrors: true
  });

  assert.equal(result.ok, false);
  assert.match(result.failureReason || '', /Fatal console error in preview/);
  assert.equal(result.consoleErrors.length, 1);
});

test('evaluatePreviewAssertion detects wrong route', () => {
  const probe = createMockDomProbe({ url: 'http://localhost:3000/login' });
  const result = evaluatePreviewAssertion(probe, { route: '/admin' });

  assert.equal(result.ok, false);
  assert.match(result.failureReason || '', /Expected route \/admin/);
});
