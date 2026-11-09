import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Hex } from '../proof/ledger';
import { resolveReplay, resolveRevert } from './sandbox';
import { CAPSULE_FORMAT, CAPSULE_VERSION, type CapsuleFileDiff, type ChangeCapsule } from './types';

function makeCapsule(diffs: CapsuleFileDiff[]): ChangeCapsule {
  return {
    format: CAPSULE_FORMAT,
    version: CAPSULE_VERSION,
    id: 'cap-test',
    taskId: 'task-test',
    workspaceRoot: '/ws',
    createdAt: 1,
    status: 'captured',
    promptIntent: 'test intent',
    baseHashes: {},
    diffs,
    verification: [],
    spend: null,
    machineDeltaRef: null,
    redaction: { redacted: false, fields: [], count: 0 },
    selfHash: ''
  };
}

async function editedDiff(path: string, before: string, after: string): Promise<CapsuleFileDiff> {
  return {
    path,
    kind: 'edited',
    beforeHash: await sha256Hex(before),
    afterHash: await sha256Hex(after),
    before,
    after
  };
}

async function createdDiff(path: string, after: string): Promise<CapsuleFileDiff> {
  return { path, kind: 'created', beforeHash: null, afterHash: await sha256Hex(after), before: null, after };
}

async function deletedDiff(path: string, before: string): Promise<CapsuleFileDiff> {
  return { path, kind: 'deleted', beforeHash: await sha256Hex(before), afterHash: null, before, after: null };
}

test('replay applies an edited diff when current content matches the base hash', async () => {
  const before = 'const a = 1;\n';
  const after = 'const a = 2;\n';
  const capsule = makeCapsule([await editedDiff('src/a.ts', before, after)]);
  const plan = await resolveReplay(capsule, [{ path: 'src/a.ts', content: before }]);

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].path, 'src/a.ts');
  assert.equal(plan.jobs[0].content, after);
  assert.equal(plan.jobs[0].originalContent, before);
  assert.equal(plan.jobs[0].created, false);
});

test('replay refuses an edited diff when current content diverged from the base', async () => {
  const capsule = makeCapsule([await editedDiff('src/a.ts', 'base\n', 'after\n')]);
  const plan = await resolveReplay(capsule, [{ path: 'src/a.ts', content: 'manual edit\n' }]);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].path, 'src/a.ts');
  assert.equal(plan.conflicts[0].reason, 'BASE_DIVERGED');
});

test('revert restores the base of an edited diff when current matches the post hash', async () => {
  const before = 'const a = 1;\n';
  const after = 'const a = 2;\n';
  const capsule = makeCapsule([await editedDiff('src/a.ts', before, after)]);
  const plan = await resolveRevert(capsule, [{ path: 'src/a.ts', content: after }]);

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].content, before);
  assert.equal(plan.jobs[0].originalContent, after);
  assert.equal(plan.jobs[0].created, false);
});

test('revert refuses an edited diff when current content diverged from the post', async () => {
  const capsule = makeCapsule([await editedDiff('src/a.ts', 'base\n', 'after\n')]);
  const plan = await resolveRevert(capsule, [{ path: 'src/a.ts', content: 'newer manual edit\n' }]);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, 'BASE_DIVERGED');
});

test('replay creates a file that is currently absent', async () => {
  const after = 'new file\n';
  const capsule = makeCapsule([await createdDiff('src/new.ts', after)]);
  const plan = await resolveReplay(capsule, []);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].path, 'src/new.ts');
  assert.equal(plan.jobs[0].content, after);
  assert.equal(plan.jobs[0].originalContent, '');
  assert.equal(plan.jobs[0].created, true);
});

test('replay refuses to clobber a created file that already exists with different content', async () => {
  const capsule = makeCapsule([await createdDiff('src/new.ts', 'task output\n')]);
  const plan = await resolveReplay(capsule, [{ path: 'src/new.ts', content: 'user content\n' }]);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, 'BASE_DIVERGED');
});

test('replay skips a created file already present with the post content', async () => {
  const after = 'task output\n';
  const capsule = makeCapsule([await createdDiff('src/new.ts', after)]);
  const plan = await resolveReplay(capsule, [{ path: 'src/new.ts', content: after }]);

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.jobs, []);
  assert.deepEqual(plan.conflicts, []);
});

test('revert re-creates a deleted file from its base content', async () => {
  const before = 'original\n';
  const capsule = makeCapsule([await deletedDiff('src/gone.ts', before)]);
  const plan = await resolveRevert(capsule, []);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].path, 'src/gone.ts');
  assert.equal(plan.jobs[0].content, before);
  assert.equal(plan.jobs[0].originalContent, '');
  assert.equal(plan.jobs[0].created, true);
});

test('replay rejects an unsafe traversal path with zero jobs', async () => {
  const capsule = makeCapsule([await editedDiff('../evil', 'base\n', 'after\n')]);
  const plan = await resolveReplay(capsule, [{ path: '../evil', content: 'base\n' }]);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, 'PATH_UNSAFE');
});

test('replay rejects an empty path with PATH_UNSAFE', async () => {
  const capsule = makeCapsule([await createdDiff('', 'x\n')]);
  const plan = await resolveReplay(capsule, []);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, 'PATH_UNSAFE');
});

test('a single diverged file empties the entire replay plan', async () => {
  const clean = await editedDiff('src/clean.ts', 'base\n', 'after\n');
  const diverged = await editedDiff('src/dirty.ts', 'base\n', 'after\n');
  const capsule = makeCapsule([clean, diverged]);
  const plan = await resolveReplay(capsule, [
    { path: 'src/clean.ts', content: 'base\n' },
    { path: 'src/dirty.ts', content: 'manual\n' }
  ]);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].path, 'src/dirty.ts');
  assert.equal(plan.conflicts[0].reason, 'BASE_DIVERGED');
});

test('replay deletes a file whose current content matches the base', async () => {
  const before = 'to delete\n';
  const capsule = makeCapsule([await deletedDiff('src/del.ts', before)]);
  const plan = await resolveReplay(capsule, [{ path: 'src/del.ts', content: before }]);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].content, '');
  assert.equal(plan.jobs[0].originalContent, before);
  assert.equal(plan.jobs[0].created, false);
});

test('replay reports FILE_MISSING when an edited file is absent', async () => {
  const capsule = makeCapsule([await editedDiff('src/missing.ts', 'base\n', 'after\n')]);
  const plan = await resolveReplay(capsule, []);

  assert.equal(plan.ok, false);
  assert.deepEqual(plan.jobs, []);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].reason, 'FILE_MISSING');
});

test('revert deletes a created file still holding the task output', async () => {
  const after = 'task output\n';
  const capsule = makeCapsule([await createdDiff('src/new.ts', after)]);
  const plan = await resolveRevert(capsule, [{ path: 'src/new.ts', content: after }]);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].content, '');
  assert.equal(plan.jobs[0].originalContent, after);
  assert.equal(plan.jobs[0].created, false);
});

test('replay normalizes backslash and ./ paths when matching current files', async () => {
  const before = 'base\n';
  const after = 'after\n';
  const capsule = makeCapsule([await editedDiff('src\\a.ts', before, after)]);
  const plan = await resolveReplay(capsule, [{ path: './src/a.ts', content: before }]);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].path, 'src/a.ts');
  assert.equal(plan.jobs[0].content, after);
});
