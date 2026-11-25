import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { isProtectedAgentWritePath } from '../lib/agents/applyPolicy';
import { undoVerdict } from '../lib/agents/scopePreserve';
import { holdReplyApply, type PermissionMode } from '../lib/agent/runPolicy';
import { listPendingOverrides, stagePendingChange } from '../lib/agent/pendingChanges';
import type { RefineModeMeta } from '../lib/ai';
import type { ReviewSetOutcome } from '../lib/appHelpers';
import { applyAtomicJobs, planAtomicApply, revertAtomicJobs, type AtomicPlanJob } from '../lib/atomicApply';
import { planAutoImportFixes } from '../lib/autoFix';
import { acceptanceOutcome, describeEvidence } from '../lib/behavior/verification';
import { NO_APPLY } from '../lib/calibratedAuto/evidence';
import type { ApplyOutcome, IntroducedDiagnostics, VerificationCard } from '../lib/calibratedAuto/evidence';
import type { DesktopDiagnostic, DiagnosticsResult, ShadRoxDesktopAPI } from '../lib/desktop';
import { normalizeSlashes, warnBridgeError } from '../lib/diagnostics';
import { acceptedContent, acceptedReplacementBlocks, computeHunks } from '../lib/editor/hunks';
import { extractFilePatches } from '../lib/markdown';
import { extractUnifiedPatches } from '../lib/patchEngine';
import type { ChatMessage, PatchSet, ReviewPatch } from '../lib/types';
import { filterIntroducedDiagnostics, selectFixableDiagnostics } from '../lib/typeErrorRefine';
import type { useAcceptance } from './useAcceptance';
import type { SaveOutcome, useWorkspace } from './useWorkspace';

export interface UsePatchManagerOptions {
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  workspace: ReturnType<typeof useWorkspace>;
  previewStatus: string;
  permissionMode: PermissionMode;
  acceptance: ReturnType<typeof useAcceptance>;
  saveFilesAtomicWithHooks: (names: string[]) => Promise<SaveOutcome>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setToast: (message: string | null) => void;
  announce: (message: string, ms?: number) => void;
}

export function usePatchManager({
  desktop,
  nativeWorkspaceId,
  workspace,
  previewStatus,
  permissionMode,
  acceptance,
  saveFilesAtomicWithHooks,
  setMessages,
  setToast,
  announce
}: UsePatchManagerOptions) {
  const [patchSets, setPatchSets] = useState<PatchSet[]>([]);
  /** Type errors an applied change introduced, per assistant message, offered as a one-click fix. */
  const [typeFixOffers, setTypeFixOffers] = useState<Record<string, DesktopDiagnostic[]>>({});
  const [autoApplyChanges, setAutoApplyChanges] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('shadrox.autoApplyChanges') === 'on';
    } catch {
      return false;
    }
  });
  // A prompt asking for a plan is a request to review it first: auto-apply must
  // not write files behind an Approve button the user has not pressed yet.
  const planApprovalGateRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const gate = planApprovalGateRef.current;
    return () => {
      gate.clear();
    };
  }, [nativeWorkspaceId]);

  const toggleAutoApplyChanges = useCallback(() => {
    setAutoApplyChanges((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem('shadrox.autoApplyChanges', next ? 'on' : 'off');
      } catch {
        /* localStorage unavailable */
      }
      return next;
    });
  }, []);

  /**
   * Runs the language service after a change set lands. Missing names that
   * resolve to exactly one workspace export are imported deterministically
   * (no model call); anything still broken is offered as a one-click fix.
   */
  const healAfterApply = useCallback(
    async (
      messageId: string,
      applied: string[],
      jobs: AtomicPlanJob[],
      before: Promise<DiagnosticsResult | null>,
      stageOnly = false
    ): Promise<{ ran: boolean; introduced: number }> => {
      if (!desktop || !nativeWorkspaceId || applied.length === 0) return { ran: false, introduced: 0 };
      try {
        const beforeResult = await before;
        const merged = new Map(workspace.files.map((file) => [file.name, file.content] as const));
        jobs.forEach((job) => merged.set(job.path, job.content));
        const files = Array.from(merged, ([name, content]) => ({ name, content }));

        const initialOverrides = stageOnly ? listPendingOverrides(nativeWorkspaceId) : undefined;
        let after = await desktop.diagnostics(
          nativeWorkspaceId,
          initialOverrides && initialOverrides.length > 0 ? initialOverrides : undefined
        );
        const firstPass = filterIntroducedDiagnostics(
          beforeResult?.diagnostics ?? [],
          after.diagnostics,
          applied
        );
        const importPlan = planAutoImportFixes(firstPass, files);
        if (importPlan.patches.length > 0) {
          const buffers = workspace.applyFilePatches(importPlan.patches);
          const names = [...buffers.updated, ...buffers.created];
          if (stageOnly) {
            for (const patch of importPlan.patches) {
              const existingFile = workspace.files.find((f) => normalizeSlashes(f.name).toLowerCase() === normalizeSlashes(patch.path).toLowerCase());
              stagePendingChange(nativeWorkspaceId, {
                path: patch.path,
                content: patch.content,
                originalContent: existingFile?.content ?? null,
                originalVersion: existingFile?.version ?? null,
                created: !existingFile
              });
            }
            importPlan.patches.forEach((patch) => merged.set(patch.path, patch.content));
            const nextOverrides = listPendingOverrides(nativeWorkspaceId);
            after = await desktop.diagnostics(nativeWorkspaceId, nextOverrides.length > 0 ? nextOverrides : undefined);
            announce(
              `Auto-imported ${importPlan.resolved.length} missing symbol${importPlan.resolved.length === 1 ? '' : 's'} (staged).`,
              4500
            );
          } else {
            const healed = names.length > 0
              ? await saveFilesAtomicWithHooks(names)
              : { written: 0, failed: false, message: null };
            if (healed.written > 0) {
              importPlan.patches.forEach((patch) => merged.set(patch.path, patch.content));
              after = await desktop.diagnostics(nativeWorkspaceId);
              announce(
                `Auto-imported ${importPlan.resolved.length} missing symbol${importPlan.resolved.length === 1 ? '' : 's'}.`,
                4500
              );
            }
          }
        }

        const introducedList = filterIntroducedDiagnostics(
          beforeResult?.diagnostics ?? [],
          after.diagnostics,
          applied
        );
        const remaining = selectFixableDiagnostics(introducedList);
        if (remaining.length > 0) {
          setTypeFixOffers((previous) => ({ ...previous, [messageId]: remaining }));
        }
        return { ran: true, introduced: introducedList.length };
      } catch (error) {
        warnBridgeError('auto-fix', error);
        return { ran: false, introduced: 0 };
      }
    },
    [desktop, nativeWorkspaceId, workspace, announce, saveFilesAtomicWithHooks]
  );

  /**
   * Applies a review set as one unit: every pending patch is resolved against
   * the live buffers first, the proposed contents are statically verified, and
   * only then are buffers written and saved through one transactional disk call.
   */
  const applyReviewSet = useCallback(
    async (
      messageId: string,
      patches: ReviewPatch[],
      options: { allowDestructive?: boolean; verify?: boolean; onlyIndex?: number; onlyIndexes?: number[]; stageOnly?: boolean } = {}
    ): Promise<ReviewSetOutcome> => {
      const indexes = options.onlyIndexes
        ?? (options.onlyIndex === undefined
          ? patches.map((_, index) => index)
          : [options.onlyIndex]);
      const targets = indexes
        .map((index) => patches[index])
        .filter((patch): patch is ReviewPatch => Boolean(patch));
      if (targets.length === 0) return { applied: [], failures: [] };

      const beforeDiagnostics = desktop && nativeWorkspaceId
        ? desktop.diagnostics(nativeWorkspaceId).catch(() => null)
        : Promise.resolve(null);

      const commit = (next: ReviewPatch[]) =>
        setPatchSets((previous) =>
          previous.map((set) =>
            set.messageId === messageId
              ? {
                  ...set,
                  patches: set.patches.map((patch, index) => {
                    const targetIndex = indexes.indexOf(index);
                    return targetIndex >= 0 ? next[targetIndex] ?? patch : patch;
                  })
                }
              : set
          )
        );
      const failedWith = (reason: string) =>
        targets.map((patch) => ({ ...patch, status: 'failed' as const, failure: reason }));

      const buffersForPlan = await workspace.loadFilesForPatching(targets.map((patch) => patch.path));
      const applyPlan = planAtomicApply(targets, buffersForPlan, {
        allowDestructive: options.allowDestructive
      });
      let changeSetVerdict: { ok: boolean; checked: number; issues: Array<{ code: string }>; skipped: string[] } | null = null;
      let verification: VerificationCard | null = null;
      let diagnostics: IntroducedDiagnostics | null = null;

      if (!('failures' in applyPlan)) {
        if (options.verify !== false && desktop && nativeWorkspaceId) {
          try {
            const verdict = await desktop.verifyChangeSet(
              nativeWorkspaceId,
              applyPlan.jobs.map((job) => ({ path: job.path, content: job.content }))
            );
            changeSetVerdict = verdict;
            if (!verdict.ok) {
              const first = verdict.issues.find((issue) => issue.severity === 'error') ?? verdict.issues[0];
              commit(failedWith('Blocked by pre-apply verification'));
              announce(
                first
                  ? `Not applied — ${first.path}:${first.line + 1} ${first.message}`
                  : 'Not applied — the change set failed verification.',
                7000
              );
              return {
                applied: [],
                failures: targets.map((patch) => `${patch.path}: blocked by pre-apply verification`),
                verification: {
                  passed: false,
                  checks: [{ name: 'Static syntax validation', ok: false, details: first ? `${first.path}:${first.line + 1} ${first.message}` : 'the change set failed verification' }]
                }
              };
            }
          } catch (error) {
            warnBridgeError('verify-change-set', error);
            commit(failedWith('Could not verify the change set'));
            announce('Not applied — the change set could not be verified.', 6000);
            return { applied: [], failures: targets.map((patch) => `${patch.path}: the change set could not be verified`) };
          }
        }
      }

      if ('failures' in applyPlan) {
        commit(applyPlan.patches);
        announce(
          `Not applied — ${applyPlan.failures.slice(0, 2).map((failure) => `${failure.path}: ${failure.reason.split(/\r?\n/)[0]}`).join(' · ')}`,
          7000
        );
        return {
          applied: [],
          failures: applyPlan.failures.map((failure) => `${failure.path}: ${failure.reason}`),
          verification: {
            passed: false,
            checks: [{ name: 'Patch mapping', ok: false, details: applyPlan.failures[0]?.reason }]
          }
        };
      }

      const acceptanceContract = acceptance.contract;
      const wantsAcceptance = acceptanceContract !== null && previewStatus === 'ready';
      if (wantsAcceptance && acceptanceContract.baseline.evidence === null) {
        await acceptance.run('baseline');
      }
      const paintBeforeWrite = acceptance.paintToken();

      const jobs = applyPlan.jobs;
        const applied = applyAtomicJobs(jobs, (updates) => workspace.applyFilePatches(updates));
        const withLanded = applyPlan.patches.map((patch) =>
          patch.status === 'applied' && applied.includes(patch.path)
            ? { ...patch, landed: patch.path }
            : patch
        );
        commit(withLanded);

        let outcome: SaveOutcome;
        if (options.stageOnly) {
          for (const job of jobs) {
            const existingFile = buffersForPlan.find((f) => normalizeSlashes(f.name).toLowerCase() === normalizeSlashes(job.path).toLowerCase());
            stagePendingChange(nativeWorkspaceId, {
              path: job.path,
              content: job.content,
              originalContent: job.created ? null : (job.originalContent ?? existingFile?.content ?? null),
              originalVersion: existingFile?.version ?? null,
              created: job.created
            });
          }
          outcome = {
            written: 0,
            failed: false,
            message: `${applied.length} file${applied.length === 1 ? '' : 's'} staged in Pending Changes (Auto-Save OFF).`
          };
        } else {
          outcome = await saveFilesAtomicWithHooks(applied);
        }
        if (outcome.failed && outcome.written === 0) {
          workspace.applyFilePatches(revertAtomicJobs(jobs));
          const reverted = withLanded.map((patch) => {
            if (!patch.landed || !applied.includes(patch.landed)) return patch;
            const job = jobs.find((candidate) => candidate.path === patch.landed);
            if (job?.created) {
              return {
                ...patch,
                status: 'failed' as const,
                disk: 'failed' as const,
                failure: 'Rolled back on disk',
                diskMessage: outcome.message ?? undefined
              };
            }
            return { ...patch, status: 'reverted' as const, disk: 'failed' as const, diskMessage: outcome.message ?? undefined };
          });
          commit(reverted);
          announce(outcome.message ?? 'The change set was not saved and was rolled back.', 7000);
          return {
            applied: [],
            failures: applied.map((path) => `${path}: the change set was rolled back — ${outcome.message ?? 'not saved'}`)
          };
        }

        const disk: ReviewPatch['disk'] = outcome.written > 0 ? 'saved' : 'buffer';
        commit(withLanded.map((patch) =>
          patch.landed ? { ...patch, disk, diskMessage: outcome.message ?? undefined } : patch
        ));
        announce(
          outcome.written > 0
            ? `${outcome.written} file${outcome.written === 1 ? '' : 's'} applied as one change set.`
            : outcome.message ?? 'Applied in the editor only — the files were not saved to disk.',
          outcome.written > 0 || options.stageOnly ? 3500 : 6000
        );
        if (applied.length > 0) {
          const staticChecksPassed = changeSetVerdict?.ok === true;
          const boundariesPassed = changeSetVerdict !== null &&
            !changeSetVerdict.issues.some((issue) => issue.code === 'PATH_OUTSIDE_WORKSPACE');
          const uniqueApplied = new Set(applied.map((item) => item.toLowerCase())).size;
          const diskSavePassed = !outcome.failed && outcome.written === uniqueApplied;
          let acceptanceRow: { name: string; ok: boolean; details?: string } | null = null;
          if (wantsAcceptance && outcome.written > 0) {
            const post = await acceptance.run('postPatch', { repaintFrom: paintBeforeWrite });
            if (post.evidence && post.contract) {
              const outcomeState = acceptanceOutcome(post.contract);
              if (post.evidence.result !== 'unverified') {
                acceptanceRow = {
                  name: 'Preview acceptance',
                  ok: post.evidence.result === 'passed',
                  details: `${outcomeState.summary} Baseline: ${describeEvidence(post.contract.baseline.evidence)}.`
                };
              }
            }
          }
          const checks = [
            {
              name: 'Static syntax validation',
              ok: staticChecksPassed,
              details: changeSetVerdict
                ? `${changeSetVerdict.checked} supported file(s) checked; ${changeSetVerdict.skipped.length} skipped`
                : 'Not run'
            },
            {
              name: 'Workspace boundary check',
              ok: boundariesPassed,
              details: changeSetVerdict ? 'No path escaped the opened workspace' : 'Not run'
            },
            {
              name: 'Disk persistence',
              ok: diskSavePassed,
              details: diskSavePassed
                ? `${outcome.written} file(s) confirmed saved`
                : `${outcome.written} of ${uniqueApplied} file(s) saved${outcome.message ? `: ${outcome.message}` : ''}`
            },
            ...(acceptanceRow ? [acceptanceRow] : [])
          ];
          const passed = checks.every((check) => check.ok);
          verification = { passed, checks };
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === messageId
                ? {
                    ...msg,
                    verificationResult: {
                      passed,
                      checks,
                      summary: passed
                        ? `${outcome.written} file(s) saved and checked`
                        : `Failed: ${checks.filter((check) => !check.ok).map((check) => check.name).join(', ')}`
                    }
                  }
                : msg
            )
          );
          const createdPaths = jobs.filter((job) => job.created).map((job) => job.path);
          if (createdPaths.length > 0) {
            for (const directory of new Set(createdPaths.map((path) => path.split('/').slice(0, -1).join('/')))) {
              void workspace.loadDirectory(directory);
            }
          }
          diagnostics = await healAfterApply(messageId, applied, jobs, beforeDiagnostics, Boolean(options.stageOnly));
        }
        return {
          applied,
          failures: [],
          ...(verification ? { verification } : {}),
          ...(diagnostics ? { diagnostics } : {})
        };
      },
    [workspace, desktop, nativeWorkspaceId, announce, healAfterApply, saveFilesAtomicWithHooks, acceptance, previewStatus, setMessages]
  );

  const acceptPatch = useCallback(
    (messageId: string, patchIndex: number) => {
      const set = patchSets.find((entry) => entry.messageId === messageId);
      const patch = set?.patches[patchIndex];
      if (!set || !patch || patch.status === 'applied' || patch.status === 'rejected') return;
      void applyReviewSet(messageId, set.patches, { allowDestructive: true, onlyIndex: patchIndex });
    },
    [patchSets, applyReviewSet]
  );

  const acceptAllPatches = useCallback(
    (messageId: string) => {
      const set = patchSets.find((entry) => entry.messageId === messageId);
      if (!set) return;
      void applyReviewSet(messageId, set.patches, { allowDestructive: true });
    },
    [patchSets, applyReviewSet]
  );

  const handleApprovePlan = useCallback(
    (messageId: string) => {
      planApprovalGateRef.current.delete(messageId);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                planApproval: msg.planApproval
                  ? { ...msg.planApproval, status: 'approved' }
                  : { status: 'approved', planSummary: 'Plan approved by user' }
              }
            : msg
        )
      );
      acceptAllPatches(messageId);
      announce('Proposed plan changes accepted.', 4000);
    },
    [acceptAllPatches, announce, setMessages]
  );

  const handleRejectPlan = useCallback(
    (messageId: string) => {
      planApprovalGateRef.current.delete(messageId);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                planApproval: msg.planApproval
                  ? { ...msg.planApproval, status: 'rejected' }
                  : { status: 'rejected', planSummary: 'Plan rejected by user' }
              }
            : msg
        )
      );
      setPatchSets((prev) =>
        prev.map((entry) =>
          entry.messageId === messageId
            ? {
                ...entry,
                patches: entry.patches.map((p) =>
                  p.status === 'pending' ? { ...p, status: 'rejected' as const } : p
                )
              }
            : entry
        )
      );
      announce('Proposed plan changes rejected. Pending changes skipped.', 4000);
    },
    [announce, setMessages]
  );

  const applyPatchHunks = useCallback(
    (messageId: string, patchIndex: number, acceptedIds: string[]) => {
      const set = patchSets.find((entry) => entry.messageId === messageId);
      const patch = set?.patches[patchIndex];
      if (!set || !patch || patch.status !== 'pending') return;

      if (patch.kind === 'searchReplace') {
        if (acceptedIds.length === 0) {
          announce('Select at least one hunk to apply.', 4000);
          return;
        }
        const result = acceptedReplacementBlocks(patch.blocks ?? [], acceptedIds);
        if (result.unknownIds.length > 0) {
          announce('This change set changed since the preview — open the review again.', 6000);
          return;
        }
        if (result.blocks.length === 0) {
          announce('Nothing to apply — the accepted hunks already match the original text.', 4000);
          return;
        }
        const patches = set.patches.map((candidate, index) =>
          index === patchIndex ? { ...candidate, blocks: result.blocks } : candidate
        );
        void applyReviewSet(messageId, patches, { allowDestructive: true, onlyIndex: patchIndex });
        return;
      }

      const target = normalizeSlashes(patch.path).toLowerCase();
      const before = workspace.files.find(
        (file) => normalizeSlashes(file.name).toLowerCase() === target
      )?.content;
      if (before === undefined) return;

      const hunks = computeHunks(before, patch.content ?? '');
      const accepted = new Set(acceptedIds);
      const known = new Set(hunks.map((hunk) => hunk.id));
      if (acceptedIds.length === 0) {
        announce('Select at least one hunk to apply.', 4000);
        return;
      }
      if ([...accepted].some((id) => !known.has(id))) {
        announce('This file changed since the preview — open the review again.', 6000);
        return;
      }

      const merged = acceptedContent(before, hunks, accepted);
      if (merged === before) {
        announce('Nothing to apply — the accepted hunks already match the file.', 4000);
        return;
      }

      const patches = set.patches.map((candidate, index) =>
        index === patchIndex ? { ...candidate, content: merged } : candidate
      );
      void applyReviewSet(messageId, patches, { allowDestructive: true, onlyIndex: patchIndex });
    },
    [patchSets, workspace.files, applyReviewSet, announce]
  );

  const rejectPatch = useCallback((messageId: string, patchIndex: number) => {
    setPatchSets((previous) =>
      previous.map((entry) =>
        entry.messageId !== messageId
          ? entry
          : {
              ...entry,
              patches: entry.patches.map((candidate, index) =>
                index === patchIndex ? { ...candidate, status: 'rejected' as const } : candidate
              )
            }
      )
    );
  }, []);

  const undoPatch = useCallback(
    (messageId: string, patchIndex: number) => {
      const set = patchSets.find((entry) => entry.messageId === messageId);
      const patch = set?.patches[patchIndex];
      if (!patch || patch.status !== 'applied' || patch.originalContent === undefined) return;
      if (patch.appliedContent !== undefined) {
        const live = workspace.files.find(
          (file) => file.name.replace(/\\/g, '/').toLowerCase() === patch.path.replace(/\\/g, '/').toLowerCase()
        );
        const verdict = undoVerdict(
          { path: patch.path, baseContent: patch.appliedContent, stage: 'pre-apply' },
          { exists: Boolean(live), content: live?.content ?? '' }
        );
        if (verdict !== 'safe') {
          announce(
            verdict === 'missing'
              ? `Cannot undo ${patch.path}: the file is no longer open, so there is nothing to restore onto.`
              : `Not undone — ${patch.path} has newer edits since this change landed. Revert or reconcile them first; undoing now would discard that work.`,
            7000
          );
          return;
        }
      }
      const result = workspace.applyFilePatches([{ path: patch.path, content: patch.originalContent }]);
      const landed = result.updated[0] ?? result.created[0] ?? patch.landed;
      const reverted = { ...patch, status: 'reverted' as const, landed };
      setPatchSets((previous) =>
        previous.map((entry) =>
          entry.messageId !== messageId
            ? entry
            : {
                ...entry,
                patches: entry.patches.map((candidate, index) =>
                  index === patchIndex ? reverted : candidate
                )
              }
        )
      );
      void saveFilesAtomicWithHooks([landed]).then((outcome) => {
        if (outcome.written === 0) {
          announce(outcome.message ?? 'Reverted in the editor, but the file was not saved.', 5000);
        }
      });
    },
    [patchSets, workspace, announce, saveFilesAtomicWithHooks]
  );

  const applyPatchesFromReply = useCallback(
    async (
      messageId: string,
      fullReply: string,
      mode: RefineModeMeta,
      options: {
        replace?: boolean;
        merge?: { staged: ReviewPatch[] };
        onFailures?: (failures: string[]) => void | Promise<void>;
        onUnmapped?: () => void | Promise<void>;
      } = {}
    ): Promise<ApplyOutcome> => {
      if (!options.replace && !options.merge && patchSets.some((set) => set.messageId === messageId)) return NO_APPLY;

      if (!mode.writesFiles) {
        if (extractFilePatches(fullReply, workspace.files).patches.length > 0) {
          setToast('Plan mode active — file modifications were not applied.');
          window.setTimeout(() => setToast(null), 5000);
        }
        return NO_APPLY;
      }

      const extractedPatches = extractUnifiedPatches(fullReply, workspace.files);
      const blockedPaths = extractedPatches
        .filter((patch) => isProtectedAgentWritePath(patch.path))
        .map((patch) => `${patch.path}: agent edits to plugin and automation manifests are blocked.`);
      const patches = extractedPatches.filter((patch) => !isProtectedAgentWritePath(patch.path));
      if (blockedPaths.length > 0) {
        setToast(blockedPaths[0]);
        window.setTimeout(() => setToast(null), 6000);
      }

      if (patches.length === 0) {
        if (blockedPaths.length > 0) await options.onFailures?.(blockedPaths);
        const looksLikeEdit = fullReply.includes('<<<<<<< ORIGINAL') || fullReply.includes('*** Begin Patch');
        if (looksLikeEdit) {
          if (options.onUnmapped) {
            await options.onUnmapped();
            return { ...NO_APPLY, editAttempted: true };
          }
          setToast('The reply contained edit blocks, but none could be applied — nothing was changed.');
          window.setTimeout(() => setToast(null), 6000);
        }
        return { ...NO_APPLY, editAttempted: looksLikeEdit };
      }

      const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      let review: ReviewPatch[];
      let applyIndexes: number[] | undefined;
      if (options.merge) {
        review = [...options.merge.staged];
        applyIndexes = [];
        for (const patch of patches) {
          const existing = review.findIndex((entry) => pathKey(entry.path) === pathKey(patch.path));
          if (existing >= 0) {
            const prior = review[existing];
            const sameChange = prior.kind === patch.kind && (patch.kind === 'rewrite'
              ? prior.content === patch.content
              : JSON.stringify(prior.blocks) === JSON.stringify(patch.blocks));
            if (sameChange && prior.status === 'applied') continue;
          }
          const entry: ReviewPatch = {
            path: existing >= 0 ? review[existing].path : patch.path,
            kind: patch.kind,
            blocks: patch.kind === 'searchReplace' ? patch.blocks : undefined,
            content: patch.kind === 'rewrite' ? patch.content : undefined,
            status: 'pending'
          };
          if (existing >= 0) review[existing] = entry;
          else review.push(entry);
          applyIndexes.push(existing >= 0 ? existing : review.length - 1);
        }
        options.merge.staged = review;
        if (applyIndexes.length === 0) return NO_APPLY;
      } else {
        review = patches.map((patch) => ({
          path: patch.path,
          kind: patch.kind,
          blocks: patch.kind === 'searchReplace' ? patch.blocks : undefined,
          content: patch.kind === 'rewrite' ? patch.content : undefined,
          status: 'pending'
        }));
      }

      setPatchSets((previous) => (options.replace || options.merge
        ? [...previous.filter((set) => set.messageId !== messageId), { messageId, patches: review }]
        : [...previous, { messageId, patches: review }]));

      const hold = holdReplyApply({
        autoApplyChanges,
        awaitingPlanApproval: planApprovalGateRef.current.has(messageId),
        permissionMode
      });
      if (hold === 'auto-apply-off') return NO_APPLY;
      if (hold === 'plan-approval') {
        setToast('Plan is waiting for approval — changes are staged, not applied.');
        window.setTimeout(() => setToast(null), 4000);
        return NO_APPLY;
      }
      if (hold === 'permission-mode') {
        setToast(`${permissionMode === 'plan' ? 'Plan' : 'Ask'} mode active — changes are staged for review, not applied.`);
        window.setTimeout(() => setToast(null), 5000);
        return NO_APPLY;
      }

      setToast(`Verifying ${applyIndexes ? applyIndexes.length : review.length} file(s)…`);
      window.setTimeout(() => setToast(null), 4000);
      const outcome = await applyReviewSet(messageId, review, {
        ...(applyIndexes ? { onlyIndexes: applyIndexes } : {}),
        stageOnly: !workspace.autoSave
      });
      const failures = [...blockedPaths, ...outcome.failures];
      if (failures.length > 0) await options.onFailures?.(failures);
      return {
        editAttempted: true,
        filesWritten: outcome.applied.length,
        patchFailures: outcome.failures,
        verification: outcome.verification ?? null,
        diagnostics: outcome.diagnostics ?? null
      };
    },
    [patchSets, workspace, autoApplyChanges, permissionMode, applyReviewSet, setToast]
  );

  return {
    patchSets,
    setPatchSets,
    typeFixOffers,
    setTypeFixOffers,
    autoApplyChanges,
    toggleAutoApplyChanges,
    planApprovalGateRef,
    applyReviewSet,
    acceptPatch,
    acceptAllPatches,
    handleApprovePlan,
    handleRejectPlan,
    applyPatchHunks,
    rejectPatch,
    undoPatch,
    applyPatchesFromReply
  };
}
