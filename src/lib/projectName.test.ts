import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { sanitizeProjectName, MAX_NAME_LENGTH } from './projectName';

const require = createRequire(import.meta.url);
const cjs = require('../../electron/project-scaffold.cjs') as {
  sanitizeProjectName: (raw: string) => string;
  MAX_NAME_LENGTH: number;
};

const CASES = [
  'my-app', '  my-app  ', 'My Project', 'demo...', 'demo. .', 'console', 'a.b',
  '..', '.', '', '   ', '.hidden', '..hidden',
  'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b',
  'a\u0000b', 'a\nb', 'con', 'CON', 'nul.txt', 'com1', 'lpt9', 'com0',
  '<img src=x onerror=alert(1)>', 'a"><script>alert(1)</script>',
  'x'.repeat(64), 'x'.repeat(65)
];

test('the renderer sanitizer matches the main-process sanitizer exactly', () => {
  assert.equal(MAX_NAME_LENGTH, cjs.MAX_NAME_LENGTH);
  for (const input of CASES) {
    let renderer: string | Error;
    let main: string | Error;
    try { renderer = sanitizeProjectName(input); } catch (error) { renderer = error as Error; }
    try { main = cjs.sanitizeProjectName(input); } catch (error) { main = error as Error; }
    if (renderer instanceof Error || main instanceof Error) {
      assert.ok(renderer instanceof Error, `renderer should reject ${JSON.stringify(input)}`);
      assert.ok(main instanceof Error, `main should reject ${JSON.stringify(input)}`);
      assert.equal(renderer.message, main.message, `messages differ for ${JSON.stringify(input)}`);
    } else {
      assert.equal(renderer, main, `results differ for ${JSON.stringify(input)}`);
    }
  }
});
