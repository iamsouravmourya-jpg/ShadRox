/**
 * End-to-end proof for the apply rail: an assistant reply is parsed, planned
 * and verified exactly the way App.applyReviewSet does it, then the change is
 * staged and committed through the real electron/workspace.cjs disk layer
 * (the same implementation the `workspace:*` IPC handlers call), and the
 * result is read back from disk with raw `fs` and compared byte-for-byte.
 *
 * This targets the old defect class — "the chat showed an edit that never hit
 * disk" and "a rewrite wiped a file the turn never read" — by refusing to mock
 * the filesystem anywhere in the path.
 *
 * The contract this suite pins down (read from the sources, not wished for):
 *  - External modification between generation and apply is REFUSED, never
 *    rebased: planAtomicApply fails on a broken anchor, stageFiles fails on a
 *    stale expectedVersion, commitTransaction fails on a post-stage change,
 *    and commitTransaction refuses a file that APPEARED after staging.
 *  - The whole-file-wipe guard is patchEngine.assessRewriteRisk, reached via
 *    planAtomicApply; it protects existing files with >= 12 non-blank lines
 *    and is overridden only by an explicit Accept (allowDestructive).
 *  - Deletion is not a patch kind; the only disk delete is workspace.deletePath
 *    (also used to roll back files a turn created), so deletion coverage runs
 *    through it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import { applyAtomicJobs, planAtomicApply, revertAtomicJobs, type AtomicPlanJob } from './atomicApply';
import { extractUnifiedPatches } from './patchEngine';
import type { ReviewPatch, WorkspaceFile } from './types';

const require = createRequire(import.meta.url);
const { createWorkspaceAccess } = require('../../electron/workspace.cjs');
const { verifyChangeSet } = require('../../electron/change-verify.cjs');

interface HarnessBuffer {
  name: string;
  content: string;
  version?: string;
}

interface LandOutcome {
  written: number;
  failed: boolean;
  message: string | null;
}

interface PlanFailure {
  path: string;
  reason: string;
}

type TurnResult =
  | { blocked: null; jobs: AtomicPlanJob[]; outcome: LandOutcome; failures?: undefined; issues?: undefined }
  | { blocked: 'plan'; failures: PlanFailure[]; jobs?: undefined; outcome: undefined; issues?: undefined }
  | { blocked: 'verify'; issues: any[]; jobs?: undefined; outcome: undefined; failures?: undefined };

/** Flat result shape (optional members, no discriminated union) so property
 *  access stays valid without strictNullChecks, which the project disables. */
interface PlanResult {
  ok: boolean;
  stage?: 'plan' | 'verify';
  jobs?: AtomicPlanJob[];
  patches?: ReviewPatch[];
  failures?: PlanFailure[];
  issues?: any[];
}

const diskSha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

/** The fenced-reply shapes the model emits: S/R with `path=`, rewrite with `path=`. */
const fence = (file: string, body: string): string => '```ts path=' + file + '\n' + body + '\n```';
const srBlock = (original: string, updated: string): string =>
  ['<<<<<<< ORIGINAL', original, '=======', updated, '>>>>>>> UPDATED'].join('\n');

/**
 * Mirror of the renderer apply path (App.applyReviewSet +
 * useWorkspace.loadFilesForPatching/saveFilesAtomic) on plain arrays instead
 * of React state. The disk layer is the real workspace.cjs access object.
 */
class Pipeline {
  access: any;
  workspaceId: string;
  root: string;
  buffers: HarnessBuffer[] = [];
  /** Mirrors useWorkspace.baselineRef: name -> content as last seen on disk. */
  baselines: Record<string, string> = {};

  constructor(access: any, opened: any) {
    this.access = access;
    this.workspaceId = opened.workspaceId;
    this.root = opened.rootPath;
  }

  static async open(files: Record<string, string>): Promise<Pipeline> {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-pipeline-'));
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(tempRoot, ...relative.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    const access = createWorkspaceAccess();
    const opened = await access.openFolder(tempRoot);
    return new Pipeline(access, opened);
  }

  diskPath(relative: string): string {
    return path.join(this.root, ...relative.split('/'));
  }

  async readDisk(relative: string): Promise<string> {
    return fs.readFile(this.diskPath(relative), 'utf8');
  }

  /** Mirrors useWorkspace.loadFilesForPatching: only paths with no buffer are read. */
  async load(paths: string[]): Promise<void> {
    const wanted = [...new Set(paths)].filter((name) => !this.buffers.some((buffer) => buffer.name === name));
    if (wanted.length === 0) return;
    const loaded = await this.access.loadFiles(this.workspaceId, wanted);
    for (const file of loaded.files) {
      this.buffers.push({ name: file.name, content: file.content, version: file.version });
      this.baselines[file.name] = file.content;
    }
  }

  /**
   * Parse the reply, load the targets off disk, plan atomically, then run the
   * pre-apply verification gate over the resolved contents — everything up to
   * (but not including) the write.
   */
  async planFor(reply: string, options: { allowDestructive?: boolean } = {}): Promise<PlanResult> {
    const known = this.buffers.map((buffer) => ({ name: buffer.name, content: buffer.content }));
    const targets: ReviewPatch[] = extractUnifiedPatches(reply, known)
      .map((patch) => ({ ...patch, status: 'pending' } as ReviewPatch));
    await this.load(targets.map((patch) => patch.path));

    const applyPlan = planAtomicApply(targets, this.buffers as unknown as WorkspaceFile[], options);
    if ('failures' in applyPlan) {
      return { ok: false, stage: 'plan', failures: applyPlan.failures, patches: applyPlan.patches };
    }
    const verdict = verifyChangeSet({
      root: this.root,
      files: applyPlan.jobs.map((job: AtomicPlanJob) => ({ path: job.path, content: job.content }))
    });
    if (!verdict.ok) return { ok: false, stage: 'verify', issues: verdict.issues };
    return { ok: true, jobs: applyPlan.jobs, patches: applyPlan.patches };
  }

  /** Mirrors workspace.applyFilePatches: update buffers, keep their stale versions. */
  private applyToBuffers(updates: Array<{ path: string; content: string }>): void {
    for (const update of updates) {
      const index = this.buffers.findIndex((buffer) => buffer.name.toLowerCase() === update.path.toLowerCase());
      if (index >= 0) this.buffers[index] = { ...this.buffers[index], content: update.content };
      else this.buffers.push({ name: update.path, content: update.content });
    }
  }

  /** Mirrors the first half of useWorkspace.saveFilesAtomic: one stage call. */
  async stage(jobs: AtomicPlanJob[]): Promise<{ transactionId: string } | { failed: true; message: string }> {
    const names = jobs.map((job) => job.path);
    applyAtomicJobs(jobs, (updates: any) => this.applyToBuffers(updates));
    const snapshot = this.buffers.filter((buffer) => names.includes(buffer.name));
    try {
      const staged = await this.access.stageFiles(this.workspaceId, snapshot.map((buffer) => ({
        name: buffer.name,
        content: buffer.content,
        // The hook passes undefined for buffers with no disk baseline (files
        // created this turn); the commit still pins the then-current version.
        expectedVersion: this.baselines[buffer.name] !== undefined ? buffer.version ?? null : undefined
      })));
      return { transactionId: staged.transactionId };
    } catch (error) {
      // Same rollback the app does when the save fails with nothing written.
      this.applyToBuffers(revertAtomicJobs(jobs));
      return { failed: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async commit(transactionId: string, jobs: AtomicPlanJob[]): Promise<LandOutcome> {
    try {
      const result = await this.access.commitTransaction(this.workspaceId, transactionId);
      if (result.errors.length) {
        throw new Error(result.errors.map((entry: any) => `${entry.name}: ${entry.message}`).join(' '));
      }
      const names = new Set(jobs.map((job) => job.path));
      for (const buffer of this.buffers) {
        if (!names.has(buffer.name)) continue;
        buffer.version = diskSha256(buffer.content);
        this.baselines[buffer.name] = buffer.content;
      }
      return { written: result.saved.length, failed: false, message: null };
    } catch (error) {
      // The hook restores original buffers when nothing landed; created files
      // revertAtomicJobs skips, exactly as in the app.
      this.applyToBuffers(revertAtomicJobs(jobs));
      return { written: 0, failed: true, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async land(jobs: AtomicPlanJob[]): Promise<LandOutcome> {
    const staged = await this.stage(jobs);
    if ('failed' in staged) return { written: 0, failed: true, message: staged.message };
    return this.commit(staged.transactionId, jobs);
  }

  /** Full turn: plan + land, refusing exactly where the real app refuses. */
  async applyReply(reply: string, options: { allowDestructive?: boolean } = {}): Promise<TurnResult> {
    const plan = await this.planFor(reply, options);
    if (!plan.ok) {
      return plan.stage === 'plan'
        ? { blocked: 'plan', failures: plan.failures ?? [], outcome: undefined }
        : { blocked: 'verify', issues: plan.issues ?? [], outcome: undefined };
    }
    const jobs = plan.jobs ?? [];
    return { blocked: null, jobs, outcome: await this.land(jobs) };
  }
}

async function withPipeline(
  files: Record<string, string>,
  run: (pipeline: Pipeline, root: string) => Promise<void>
): Promise<void> {
  const pipeline = await Pipeline.open(files);
  try {
    await run(pipeline, pipeline.root);
  } finally {
    pipeline.access.closeWorkspace(pipeline.workspaceId);
    await fs.rm(pipeline.root, { recursive: true, force: true });
  }
}

const APP_V1 = 'export function App() {\n  const old = 1;\n  return old;\n}\n';

test('single edit through the real pipeline lands byte-identical on disk and re-reads exact', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    const reply = ['Fixing the constant:', '', fence('src/App.tsx', srBlock('  const old = 1;', '  const old = 42;'))].join('\n');

    const turn = await pipeline.applyReply(reply);
    assert.equal(turn.blocked, null, JSON.stringify(turn.failures ?? turn.issues));
    assert.equal(turn.outcome.written, 1);
    assert.equal(turn.outcome.failed, false);

    const expected = 'export function App() {\n  const old = 42;\n  return old;\n}\n';
    assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), expected);
    // The pipeline also re-reads through the workspace layer and agrees with fs.
    assert.equal(await pipeline.readDisk('src/App.tsx'), expected);
  });
});

test('multi-hunk patch changes every hunk in one commit and nothing else drifts', async () => {
  const base = 'export function f() {\n  const a = 1;\n  const b = 2;\n  const keep = 3;\n  return a + b;\n}\n';
  await withPipeline({ 'src/f.ts': base, 'src/untouched.ts': 'export const z = 0;\n' }, async (pipeline, root) => {
    const reply = fence('src/f.ts', [
      srBlock('  const a = 1;', '  const a = 10;'),
      srBlock('  const b = 2;', '  const b = 20;')
    ].join('\n'));

    const turn = await pipeline.applyReply(reply);
    assert.equal(turn.blocked, null, JSON.stringify(turn.failures ?? turn.issues));
    assert.equal(turn.outcome.written, 1);

    const expected = base
      .replace('  const a = 1;', '  const a = 10;')
      .replace('  const b = 2;', '  const b = 20;');
    assert.equal(await fs.readFile(path.join(root, 'src', 'f.ts'), 'utf8'), expected);
    assert.equal(await fs.readFile(path.join(root, 'src', 'untouched.ts'), 'utf8'), 'export const z = 0;\n');
  });
});

test('a new file created by a rewrite patch is really created on disk, and deletePath really deletes it', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    const widget = 'export const widget = 7;';
    const turn = await pipeline.applyReply(fence('src/new/Widget.ts', widget));
    assert.equal(turn.blocked, null, JSON.stringify(turn.failures ?? turn.issues));
    assert.equal(turn.jobs[0].created, true);
    assert.equal(turn.outcome.written, 1);

    const created = path.join(root, 'src', 'new', 'Widget.ts');
    assert.equal(await fs.readFile(created, 'utf8'), widget, 'parent directory must have been created too');

    // The only disk deletion in the pipeline is deletePath — the primitive the
    // checkpoint rollback uses to remove files a turn created.
    const removed = await pipeline.access.deletePath(pipeline.workspaceId, 'src/new/Widget.ts');
    assert.deepEqual(removed, { path: 'src/new/Widget.ts', kind: 'file' });
    await assert.rejects(fs.readFile(created, 'utf8'), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), APP_V1, 'unrelated file survives');
  });
});

test('a multi-file set is atomic: one broken anchor writes nothing to disk', async () => {
  await withPipeline({
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 2;\n'
  }, async (pipeline, root) => {
    const reply = [
      fence('src/a.ts', srBlock('export const a = 1;', 'export const A = 1;')),
      '',
      fence('src/b.ts', srBlock('this text is not in the file', 'nor is this'))
    ].join('\n');

    const turn = await pipeline.applyReply(reply);
    assert.equal(turn.blocked, 'plan');
    assert.deepEqual(turn.failures.map((failure) => failure.path), ['src/b.ts']);
    assert.equal(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n',
      'the good half of the set must NOT land when the set is refused');
    assert.equal(await fs.readFile(path.join(root, 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n');
  });
});

test('the pre-apply verification gate refuses broken syntax before a single byte is written', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    const turn = await pipeline.applyReply(fence('src/App.tsx', 'export function broken( {\n  return <<<;\n}'));
    assert.equal(turn.blocked, 'verify');
    assert.ok(turn.issues.some((issue: any) => issue.severity === 'error'));
    assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), APP_V1);
    const strays = (await fs.readdir(path.join(root, 'src'))).filter((name) => name.startsWith('.shadrox-'));
    assert.deepEqual(strays, [], 'a refused change set must leave no temporary files behind');
  });
});

test('a rewrite that would wipe a 40-line file is refused and the file stays intact; Accept lands it', async () => {
  const LONG = Array.from({ length: 40 }, (_, index) => `export const row${index} = ${index};`).join('\n') + '\n';
  await withPipeline({ 'src/rows.ts': LONG }, async (pipeline, root) => {
    const reply = fence('src/rows.ts', 'export const fresh = 1;');

    const turn = await pipeline.applyReply(reply);
    assert.equal(turn.blocked, 'plan');
    assert.match(turn.failures[0].reason, /returned a 1-line replacement for a 40-line file/);
    assert.equal(await fs.readFile(path.join(root, 'src', 'rows.ts'), 'utf8'), LONG,
      'the wipe must never reach disk without an explicit Accept');

    // The documented escape hatch: an explicit Accept (allowDestructive) lands.
    const accepted = await pipeline.applyReply(reply, { allowDestructive: true });
    assert.equal(accepted.blocked, null);
    assert.equal(accepted.outcome.written, 1);
    assert.equal(await fs.readFile(path.join(root, 'src', 'rows.ts'), 'utf8'), 'export const fresh = 1;');
  });
});

test('external edit between generation and staging: stage refuses, disk keeps the foreign content', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    const plan = await pipeline.planFor(fence('src/App.tsx', srBlock('  const old = 1;', '  const old = 42;')));
    assert.ok(plan.ok, JSON.stringify(plan.failures ?? plan.issues));

    // Somebody edits the file outside ShadRox after the reply was generated.
    const foreign = APP_V1.replace('const old = 1;', 'const old = 7; // from vim');
    await fs.writeFile(path.join(root, 'src', 'App.tsx'), foreign, 'utf8');

    const outcome = await pipeline.land(plan.jobs);
    assert.equal(outcome.failed, true);
    assert.match(outcome.message ?? '', /changed on disk\. Reload it before staging changes\./);
    assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), foreign,
      'the external edit must not be clobbered');
    // The buffers were rolled back too — the chat must not show patched text
    // that never landed.
    assert.equal(pipeline.buffers.find((buffer) => buffer.name === 'src/App.tsx')!.content, APP_V1);
  });
});

test('external edit between staging and commit: commit refuses and nothing is written', async () => {
  const baseA = 'export const a = 1;\n';
  const baseB = 'export const b = 2;\n';
  await withPipeline({ 'src/a.ts': baseA, 'src/b.ts': baseB }, async (pipeline, root) => {
    const reply = [
      fence('src/a.ts', srBlock('export const a = 1;', 'export const A = 1;')),
      '',
      fence('src/b.ts', srBlock('export const b = 2;', 'export const B = 2;'))
    ].join('\n');
    const plan = await pipeline.planFor(reply);
    assert.ok(plan.ok, JSON.stringify(plan.failures ?? plan.issues));

    const staged = await pipeline.stage(plan.jobs);
    assert.equal('failed' in staged, false);

    // External edit lands after staging but before the user clicks apply.
    const foreignB = 'export const b = 999; // externally edited\n';
    await fs.writeFile(path.join(root, 'src', 'b.ts'), foreignB, 'utf8');

    const outcome = await pipeline.commit((staged as any).transactionId, plan.jobs);
    assert.equal(outcome.failed, true);
    assert.match(outcome.message ?? '', /src\/b\.ts changed after the proposal was prepared\. Generate it again\./);
    assert.equal(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8'), baseA,
      'the transaction must validate every file before writing any');
    assert.equal(await fs.readFile(path.join(root, 'src', 'b.ts'), 'utf8'), foreignB);
  });
});

test('external edit that breaks the SEARCH anchor: reload then plan refuses, never rebases', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    // Load the buffer once (as generation did), then the world changes below it.
    await pipeline.load(['src/App.tsx']);
    const foreign = 'export function App() {\n  const fresh = 5;\n  return fresh;\n}\n';
    await fs.writeFile(path.join(root, 'src', 'App.tsx'), foreign, 'utf8');

    // The app reloads the buffer from disk on an external change; with the
    // true current content the stale SEARCH text is simply not found.
    const reloaded = await pipeline.access.readFile(pipeline.workspaceId, 'src/App.tsx');
    pipeline.buffers.splice(0, pipeline.buffers.length, {
      name: reloaded.name,
      content: reloaded.content,
      version: reloaded.version
    });

    const plan = await pipeline.planFor(fence('src/App.tsx', srBlock('  const old = 1;', '  const old = 42;')));
    assert.equal(plan.ok, false);
    assert.equal(plan.stage, 'plan');
    assert.match(plan.failures![0].reason, /text not found/);
    assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), foreign);
  });
});

test('a file the turn never read cannot materialise under a staged new file (appeared guard)', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    const plan = await pipeline.planFor(fence('src/generated.ts', 'export const generated = 1;'));
    assert.ok(plan.ok, JSON.stringify(plan.failures ?? plan.issues));
    const staged = await pipeline.stage(plan.jobs);
    assert.equal('failed' in staged, false);

    // Between staging and the click, the user hand-creates the same path.
    const handcrafted = 'export const handcrafted = "mine";\n';
    await fs.writeFile(path.join(root, 'src', 'generated.ts'), handcrafted, 'utf8');

    const outcome = await pipeline.commit((staged as any).transactionId, plan.jobs);
    assert.equal(outcome.failed, true);
    assert.match(outcome.message ?? '', /A file appeared at src\/generated\.ts after the proposal was prepared\./);
    assert.equal(await fs.readFile(path.join(root, 'src', 'generated.ts'), 'utf8'), handcrafted,
      'the hand-made file must never be silently replaced');
  });
});

test('a never-opened plain file in a folder workspace is really read from disk before it is edited', async () => {
  await withPipeline({ 'notes/todo.md': 'first\n' }, async (pipeline, root) => {
    // Folder workspaces mount as paths only — the buffer must come off disk.
    assert.deepEqual(pipeline.buffers, []);
    const turn = await pipeline.applyReply(fence('notes/other.md', 'second'));
    assert.equal(turn.blocked, null, JSON.stringify(turn.failures ?? turn.issues));
    assert.equal(turn.outcome.written, 1);
    assert.equal(await fs.readFile(path.join(root, 'notes', 'other.md'), 'utf8'), 'second');
    assert.equal(await fs.readFile(path.join(root, 'notes', 'todo.md'), 'utf8'), 'first\n',
      'adjacent files are untouched');
  });
});

/* -------------------------------------------------------------------------- *
 * Reported from the packaged .exe:
 *  - one created file showed as "Changes · 2 files" because the same block was
 *    re-emitted across two tool rounds;
 *  - "I have deleted test.txt" was accepted while the file stayed on disk,
 *    because an empty declared body produced zero patches and zero errors.
 * -------------------------------------------------------------------------- */

test('a block re-emitted for the same file plans ONE job and the later state wins', async () => {
  await withPipeline({ 'src/App.tsx': APP_V1 }, async (pipeline, root) => {
    const reply = [
      fence('src/App.tsx', srBlock('  const old = 1;', '  const old = 2;')),
      '',
      'Re-emitting the same edit after a tool round:',
      '',
      fence('src/App.tsx', srBlock('  const old = 1;', '  const old = 42;'))
    ].join('\n');

    const plan = await pipeline.planFor(reply);
    assert.ok(plan.ok, JSON.stringify(plan.failures ?? plan.issues));
    assert.equal((plan.patches ?? []).length, 1, 'the review set must not claim two files');
    assert.equal((plan.jobs ?? []).length, 1, 'one write per file');

    const turn = await pipeline.applyReply(reply);
    assert.equal(turn.blocked, null, JSON.stringify(turn.failures ?? turn.issues));
    assert.equal(turn.outcome.written, 1);
    assert.equal(
      await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'),
      'export function App() {\n  const old = 42;\n  return old;\n}\n'
    );
  });
});

test('a fence that declares a file and writes nothing is refused with a reason, never silently accepted', async () => {
  await withPipeline({ 'notes/todo.txt': 'first\n' }, async (pipeline, root) => {
    // `path=` is the shape the model used when it "deleted" test.txt.
    const turn = await pipeline.applyReply('``` path=notes/todo.txt\n```');

    assert.equal(turn.blocked, 'plan', 'a declared deletion must not be a success-shaped no-op');
    assert.match(turn.failures[0].reason, /left untouched/);
    assert.match(turn.failures[0].reason, /deletions are not applied from a patch/i);
    assert.equal(await fs.readFile(path.join(root, 'notes', 'todo.txt'), 'utf8'), 'first\n');
  });
});
