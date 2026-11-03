'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseGitBranches,
  parseGitStatus,
  sanitizeCommitMessage,
  validateBranchName,
  validateGitPaths
} = require('./git-scm.cjs');

test('parses staged, unstaged, untracked, and renamed porcelain paths', () => {
  const parsed = parseGitStatus('## main...origin/main\0M  staged.ts\0 M changed.ts\0?? new file.ts\0R  new.ts\0old.ts\0');
  assert.equal(parsed.branch, 'main');
  assert.deepEqual(parsed.changes, [
    { status: 'M ', path: 'staged.ts', staged: true, unstaged: false, untracked: false },
    { status: ' M', path: 'changed.ts', staged: false, unstaged: true, untracked: false },
    { status: '??', path: 'new file.ts', staged: false, unstaged: true, untracked: true },
    { status: 'R ', path: 'new.ts', oldPath: 'old.ts', staged: true, unstaged: false, untracked: false }
  ]);
});

test('parses local branch metadata without losing commit subjects', () => {
  assert.deepEqual(
    parseGitBranches('* main 0123456789abcdef first commit message\n  feature/test abcdef0123456789 another message\n'),
    [
      { name: 'main', current: true, lastCommit: '0123456789abcdef', message: 'first commit message' },
      { name: 'feature/test', current: false, lastCommit: 'abcdef0123456789', message: 'another message' }
    ]
  );
});

test('rejects absolute and traversing Git paths and deduplicates safe paths', () => {
  assert.deepEqual(validateGitPaths(['src/a.ts', 'src/a.ts', 'folder\\b.ts']), ['src/a.ts', 'folder/b.ts']);
  assert.throws(() => validateGitPaths(['../outside']));
  assert.throws(() => validateGitPaths(['C:\\outside']));
});

test('sanitizes and bounds commit messages and rejects invalid branch names', () => {
  assert.equal(sanitizeCommitMessage(' hello\nworld\t '), 'helloworld');
  assert.equal(sanitizeCommitMessage('x'.repeat(600)).length, 500);
  assert.throws(() => sanitizeCommitMessage('\n\t'));
  assert.throws(() => validateBranchName('--upload'));
  assert.equal(validateBranchName('feature/safe'), 'feature/safe');
});
