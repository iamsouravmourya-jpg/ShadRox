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

test('reports how far the branch sits from its upstream instead of looking clean', () => {
  const ahead = parseGitStatus('## mission/big-leap...origin/mission/big-leap [ahead 3]\0M  a.ts\0');
  assert.equal(ahead.branch, 'mission/big-leap');
  assert.equal(ahead.upstream, 'origin/mission/big-leap');
  assert.equal(ahead.ahead, 3);
  assert.equal(ahead.behind, 0);
  assert.equal(ahead.detached, false);

  const both = parseGitStatus('## main...origin/main [behind 2, ahead 7]\0');
  assert.equal(both.ahead, 7);
  assert.equal(both.behind, 2);

  const clean = parseGitStatus('## main...origin/main\0');
  assert.equal(clean.ahead, 0);
  assert.equal(clean.behind, 0);
  assert.equal(clean.upstream, 'origin/main');
});

test('names no branch and no upstream while HEAD is detached', () => {
  const detached = parseGitStatus('## HEAD (no branch)\0M  a.ts\0');
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, '');
  assert.equal(detached.upstream, null);

  const unborn = parseGitStatus('## No commits yet on main\0?? a.ts\0');
  assert.equal(unborn.branch, 'main');
  assert.equal(unborn.upstream, null);
});

test('rejects absolute and traversing Git paths and deduplicates safe paths', () => {
  assert.deepEqual(validateGitPaths(['src/a.ts', 'src/a.ts', 'folder\\b.ts']), ['src/a.ts', 'folder/b.ts']);
  assert.throws(() => validateGitPaths(['../outside']));
  assert.throws(() => validateGitPaths(['C:\\outside']));
  assert.throws(() => validateGitPaths([':(exclude)src/a.ts']));
  assert.throws(() => validateGitPaths([':/secrets']));
});

test('sanitizes and bounds commit messages and rejects invalid branch names', () => {
  assert.equal(sanitizeCommitMessage(' hello\nworld\t '), 'helloworld');
  assert.equal(sanitizeCommitMessage('x'.repeat(600)).length, 500);
  assert.throws(() => sanitizeCommitMessage('\n\t'));
  assert.throws(() => validateBranchName('--upload'));
  assert.equal(validateBranchName('feature/safe'), 'feature/safe');
});
