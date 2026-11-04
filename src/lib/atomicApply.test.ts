import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAtomicJobs,
  planAtomicApply,
  revertAtomicJobs,
  type AtomicPlan,
  type AtomicPlanFailure
} from './atomicApply';
import type { ReviewPatch, WorkspaceFile } from './types';

const file = (name: string, content: string): WorkspaceFile => ({ name, content, language: 'typescript' });

const rewrite = (path: string, content: string): ReviewPatch => ({ path, kind: 'rewrite', content, status: 'pending' });

const searchReplace = (path: string, original: string, updated: string): ReviewPatch => ({
  path,
  kind: 'searchReplace',
  blocks: [{ original, updated }],
  status: 'pending'
});

const failuresOf = (plan: AtomicPlan): AtomicPlanFailure[] => ('failures' in plan ? plan.failures : []);

const LONG_FILE = Array.from({ length: 40 }, (_, index) => `<div class="row-${index}"></div>`).join('\n');

test('one unresolved block empties the whole plan', () => {
  const files = [file('src/a.ts', 'const a = 1;\n'), file('src/b.ts', 'const b = 2;\n')];
  const plan = planAtomicApply(
    [searchReplace('src/a.ts', 'const a = 1;', 'const A = 1;'), searchReplace('src/b.ts', 'does not exist', 'x')],
    files
  );

  assert.equal(plan.ok, false);
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.patches[0].status, 'pending');
  assert.equal(plan.patches[1].status, 'failed');
  assert.match(plan.patches[1].failure ?? '', /^Blocked: src\/b\.ts: block 1: text not found/);
  assert.deepEqual(failuresOf(plan).map((failure) => failure.path), ['src/b.ts']);
});

test('an ambiguous block is reported as the first blocker', () => {
  const plan = planAtomicApply([searchReplace('src/a.ts', 'x(1);', 'y(1);')], [file('src/a.ts', 'x(1);\nx(1);\n')]);

  assert.equal(plan.ok, false);
  assert.equal(plan.jobs.length, 0);
  assert.match(plan.patches[0].failure ?? '', /matches 2 places/);
});

test('a rewrite that erases an existing file is blocked unless destructive edits are allowed', () => {
  const files = [file('src/big.ts', LONG_FILE)];
  const patch = rewrite('src/big.ts', '<div>new</div>\n<script>submit()</script>');

  const blocked = planAtomicApply([patch], files);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.jobs.length, 0);
  assert.match(blocked.patches[0].failure ?? '', /^Blocked: src\/big\.ts: the model returned a 2-line replacement/);
  assert.doesNotMatch(blocked.patches[0].failure ?? '', /src\/big\.ts: src\/big\.ts:/);

  const allowed = planAtomicApply([patch], files, { allowDestructive: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.jobs.length, 1);
  assert.equal(allowed.jobs[0].created, false);
  assert.equal(allowed.jobs[0].content, '<div>new</div>\n<script>submit()</script>');
  assert.equal(allowed.jobs[0].originalContent, LONG_FILE);
});

test('a rewrite to empty content is blocked as a whole-file wipe', () => {
  // The classic defect shape: a reply "clears" a 40-line file by rewriting it
  // to nothing. The plan must refuse it, and the refusal must be reversible —
  // an explicit Accept still lets the user truncate their own file.
  const files = [file('src/big.ts', LONG_FILE)];
  const blocked = planAtomicApply([rewrite('src/big.ts', '')], files);
  assert.equal(blocked.ok, false);
  assert.match(blocked.patches[0].failure ?? '', /returned a 0-line replacement for a 40-line file/);

  const accepted = planAtomicApply([rewrite('src/big.ts', '')], files, { allowDestructive: true });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.jobs[0].content, '');
  assert.equal(accepted.jobs[0].originalContent, LONG_FILE);
});

test('the wipe guard starts at 12 non-blank lines, documenting the real threshold', () => {
  const eleven = Array.from({ length: 11 }, (_, index) => `const v${index} = ${index};`).join('\n');
  const twelve = `${eleven}\nconst v11 = 11;`;

  // Below the threshold an emptied small file is a legitimate trim, not a
  // wipe; at it, the guard fires. Pinning the boundary keeps the threshold
  // from silently drifting.
  assert.equal(planAtomicApply([rewrite('small.ts', '')], [file('small.ts', eleven)]).ok, true);
  const guarded = planAtomicApply([rewrite('big.ts', '')], [file('big.ts', twelve)]);
  assert.equal(guarded.ok, false);
  assert.match(guarded.patches[0].failure ?? '', /0-line replacement for a 12-line file/);
});

test('a fully resolvable set becomes one job per pending patch', () => {
  const files = [
    file('src/a.ts', 'const a = 1;\n'),
    file('src/b.ts', 'const b = 2;\nconst keep = 3;\n'),
    file('src/c.ts', 'one\ntwo\n')
  ];
  const plan = planAtomicApply(
    [
      searchReplace('src/a.ts', 'const a = 1;', 'const A = 1;'),
      rewrite('src/b.ts', 'const b = 22;\nconst keep = 3;\n'),
      searchReplace('SRC/C.TS', 'two', 'TWO')
    ],
    files
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 3);
  assert.deepEqual(plan.jobs.map((job) => job.path), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(plan.jobs[0].content, 'const A = 1;\n');
  assert.equal(plan.jobs[0].originalContent, 'const a = 1;\n');
  assert.equal(plan.jobs[2].content, 'one\nTWO\n');
  assert.ok(plan.jobs.every((job) => !job.created));
  assert.deepEqual(plan.patches.map((patch) => patch.status), ['applied', 'applied', 'applied']);
  assert.equal(plan.patches[0].originalContent, 'const a = 1;\n');
});

test('a rewrite of an absent file is a created job with nothing to restore', () => {
  const plan = planAtomicApply([rewrite('src/new.ts', 'export const x = 1;\n')], [file('src/a.ts', '')]);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].created, true);
  assert.equal(plan.jobs[0].originalContent, '');
  assert.equal(plan.patches[0].status, 'applied');
});

test('a search/replace for an absent file fails instead of inventing content', () => {
  const plan = planAtomicApply([searchReplace('src/ghost.ts', 'const a = 1;', 'const A = 1;')], []);

  assert.equal(plan.ok, false);
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.patches[0].status, 'failed');
  assert.match(plan.patches[0].failure ?? '', /^Blocked: src\/ghost\.ts: file is not in the workspace/);
});

test('reverting the jobs restores originals and skips created files', () => {
  const files = [file('src/a.ts', 'const a = 1;\n'), file('src/b.ts', 'const b = 2;\n')];
  const plan = planAtomicApply(
    [
      searchReplace('src/a.ts', 'const a = 1;', 'const A = 1;'),
      rewrite('src/b.ts', 'const b = 22;\n'),
      rewrite('src/new.ts', 'export const x = 1;\n')
    ],
    files
  );

  assert.equal(plan.ok, true);
  assert.deepEqual(revertAtomicJobs(plan.jobs), [
    { path: 'src/a.ts', content: 'const a = 1;\n' },
    { path: 'src/b.ts', content: 'const b = 2;\n' }
  ]);
});

test('applying the jobs is a single call carrying every update', () => {
  const files = [file('src/a.ts', 'const a = 1;\n'), file('src/b.ts', 'const b = 2;\n')];
  const plan = planAtomicApply(
    [searchReplace('src/a.ts', 'const a = 1;', 'const A = 1;'), rewrite('src/new.ts', 'export const x = 1;\n')],
    files
  );
  assert.equal(plan.ok, true);

  const calls: unknown[] = [];
  const applied = applyAtomicJobs(plan.jobs, (updates) => {
    calls.push(updates);
    return { updated: [], created: [], unchanged: [] };
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    { path: 'src/a.ts', content: 'const A = 1;\n' },
    { path: 'src/new.ts', content: 'export const x = 1;\n' }
  ]);
  assert.deepEqual(applied, ['src/a.ts', 'src/new.ts']);
});

test('patches that already left review are left untouched by the plan', () => {
  const files = [file('src/a.ts', 'const a = 1;\n'), file('src/b.ts', 'const b = 2;\n')];
  const rejected: ReviewPatch = { ...rewrite('src/b.ts', 'const B = 2;\n'), status: 'rejected' };
  const applied: ReviewPatch = { ...rewrite('src/b.ts', 'const B = 2;\n'), status: 'applied', originalContent: 'old' };
  const plan = planAtomicApply([searchReplace('src/a.ts', 'const a = 1;', 'const A = 1;'), rejected, applied], files);

  assert.equal(plan.ok, true);
  assert.equal(plan.jobs.length, 1);
  assert.deepEqual(plan.patches.map((patch) => patch.status), ['applied', 'rejected', 'applied']);
  assert.equal(plan.patches[2].originalContent, 'old');
});
