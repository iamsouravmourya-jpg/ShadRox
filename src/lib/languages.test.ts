import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage,
  getCachedLanguageExtension,
  loadLanguageExtension,
  resolveLanguageLoaderKey
} from './languages';

test('resolveLanguageLoaderKey maps file extensions accurately', () => {
  assert.equal(resolveLanguageLoaderKey('App.tsx'), 'tsx');
  assert.equal(resolveLanguageLoaderKey('server.ts'), 'ts');
  assert.equal(resolveLanguageLoaderKey('Button.jsx'), 'jsx');
  assert.equal(resolveLanguageLoaderKey('index.js'), 'js');
  assert.equal(resolveLanguageLoaderKey('main.py'), 'python');
  assert.equal(resolveLanguageLoaderKey('README.md'), 'markdown');
  assert.equal(resolveLanguageLoaderKey('notes.txt'), null);
  assert.equal(detectLanguage('app.py'), 'python');
});

test('loadLanguageExtension lazily loads and caches language packs', async () => {
  const pyExt = await loadLanguageExtension('main.py');
  assert.ok(pyExt, 'expected python language extension');
  assert.equal(getCachedLanguageExtension('other.py'), pyExt);

  const mdExt = await loadLanguageExtension('README.md');
  assert.ok(mdExt, 'expected markdown language extension');
  assert.equal(getCachedLanguageExtension('untitled.md'), mdExt);

  const plainExt = await loadLanguageExtension('notes.txt');
  assert.equal(plainExt, null);
});
