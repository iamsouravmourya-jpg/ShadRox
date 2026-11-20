import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGitignore, isIgnoredPath } from './gitignore';

const ignored = (text: string, path: string, isDir = false) => isIgnoredPath(parseGitignore(text), path, isDir);

test('comments and blank lines are skipped', () => {
  const rules = parseGitignore('# a comment\n\n   \nnode_modules\n');
  assert.equal(rules.length, 1);
});

test('a bare name matches at any depth', () => {
  assert.equal(ignored('node_modules', 'node_modules', true), true);
  assert.equal(ignored('node_modules', 'src/node_modules', true), true);
  assert.equal(ignored('node_modules', 'src/node_modules/x.js'), true);
  assert.equal(ignored('node_modules', 'src/app.js'), false);
});

test('a directory-only rule hides the folder and everything under it', () => {
  assert.equal(ignored('build/', 'build', true), true);
  assert.equal(ignored('build/', 'build/out/x.js'), true);
  assert.equal(ignored('build/', 'build', false), false, 'dir-only does not match a file named build');
});

test('an anchored rule matches only from the root', () => {
  assert.equal(ignored('/root-only', 'root-only'), true);
  assert.equal(ignored('/root-only', 'src/root-only'), false);
  assert.equal(ignored('src/generated', 'src/generated', true), true);
  assert.equal(ignored('src/generated', 'other/src/generated', true), false);
});

test('globs: *, ? and **', () => {
  assert.equal(ignored('*.log', 'debug.log'), true);
  assert.equal(ignored('*.log', 'src/debug.log'), true);
  assert.equal(ignored('*.log', 'debug.logx'), false);
  assert.equal(ignored('file?.txt', 'file1.txt'), true);
  assert.equal(ignored('file?.txt', 'file12.txt'), false);
  assert.equal(ignored('**/temp', 'a/b/temp', true), true);
  assert.equal(ignored('a/**/c', 'a/b/c'), true);
});

test('negation re-includes a file, last matching rule wins', () => {
  assert.equal(ignored('*.log\n!keep.log', 'keep.log'), false);
  assert.equal(ignored('*.log\n!keep.log', 'drop.log'), true);
  assert.equal(ignored('!keep.log\n*.log', 'keep.log'), true, 'order matters');
});

test('an ignored parent directory cannot be re-included from below', () => {
  assert.equal(ignored('build/\n!build/keep.js', 'build/keep.js'), true, 'git won\'t re-include under an ignored parent');
});

test('escaped ! and # are literal', () => {
  assert.equal(ignored('\\!important', '!important'), true);
  assert.equal(ignored('\\#hash', '#hash'), true);
});

test('trailing spaces are stripped unless escaped', () => {
  assert.equal(ignored('foo   ', 'foo'), true);
});

test('no rules means nothing is ignored', () => {
  assert.equal(isIgnoredPath([], 'anything.ts'), false);
});

test('windows separators are normalized', () => {
  assert.equal(ignored('node_modules', 'src\\node_modules\\x.js'), true);
});