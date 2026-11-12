/**
 * The apply rail, outside React.
 *
 * `applyPipeline.e2e.test.ts` used to own this class. It is the same sequence
 * the renderer runs on every edit turn — parse the reply, load the targets off
 * disk, plan atomically, pass the pre-apply verification gate, stage, commit —
 * mirrored on plain arrays instead of component state, against the real
 * `workspace.cjs` disk layer with the filesystem nowhere mocked. The benchmark
 * runner grades an agent's reply through exactly this path, so the number it
 * reports and the write the user gets cannot drift apart, which is why the
 * harness lives here rather than in one test file.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { applyAtomicJobs, planAtomicApply, revertAtomicJobs, type AtomicPlanJob } from '../atomicApply';
import { expectedDiskVersion } from '../saveVersions';
import { extractUnifiedPatches } from '../patchEngine';
import type { ReviewPatch, WorkspaceFile } from '../types';

const require = createRequire(import.meta.url);
const { createWorkspaceAccess } = require('../../../electron/workspace.cjs');
const { verifyChangeSet } = require('../../../electron/change-verify.cjs');

export type { AtomicPlanJob };

export interface HarnessBuffer {
  name: string;
  content: string;
  version?: string;
}

export interface LandOutcome {
  written: number;
  failed: boolean;
  message: string | null;
}

export interface PlanFailure {
  path: string;
  reason: string;
}

/** Flat shape again: with strictNullChecks off, a `blocked: null` member is not
 *  a discriminant the compiler can narrow on, so callers read optional members
 *  directly instead of splitting the union. */
export interface TurnResult {
  blocked: 'plan' | 'verify' | null;
  jobs?: AtomicPlanJob[];
  outcome?: LandOutcome;
  failures?: PlanFailure[];
  issues?: any[];
}

/** Flat result shape (optional members, no discriminated union) so property
 *  access stays valid without strictNullChecks, which the project disables. */
export interface PlanResult {
  ok: boolean;
  stage?: 'plan' | 'verify';
  jobs?: AtomicPlanJob[];
  patches?: ReviewPatch[];
  failures?: PlanFailure[];
  issues?: any[];
}

export const diskSha256 = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex');

/** The fenced-reply shapes the model emits: S/R with `path=`, rewrite with `path=`. */
export const fence = (file: string, body: string): string => '```ts path=' + file + '\n' + body + '\n```';
export const srBlock = (original: string, updated: string): string =>
  ['<<<<<<< ORIGINAL', original, '=======', updated, '>>>>>>> UPDATED'].join('\n');

export class Pipeline {
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
      const staged = await this.access.stageFiles(this.workspaceId, await Promise.all(snapshot.map(async (buffer) => ({
        name: buffer.name,
        content: buffer.content,
        // Mirrors useWorkspace.saveFilesAtomic through expectedDiskVersion: an
        // unknown baseline skips the stage-time comparison, and a buffer with no
        // remembered disk version — every checkpoint restore — pins the content
        // the app last knew was out there instead of claiming the file is absent.
        expectedVersion: await expectedDiskVersion(buffer, this.baselines[buffer.name])
      }))));
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

export async function withPipeline<T>(
  files: Record<string, string>,
  run: (pipeline: Pipeline, root: string) => Promise<T>
): Promise<T> {
  const pipeline = await Pipeline.open(files);
  try {
    return await run(pipeline, pipeline.root);
  } finally {
    pipeline.access.closeWorkspace(pipeline.workspaceId);
    await fs.rm(pipeline.root, { recursive: true, force: true });
  }
}
