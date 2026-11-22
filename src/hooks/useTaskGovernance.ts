import { useCallback, useEffect, useMemo, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { PinnedSymbol } from '../components/ChatPanel';
import { refinePrompt } from '../lib/ai';
import { makeId } from '../lib/appHelpers';
import { applyAtomicJobs, revertAtomicJobs, type AtomicPlanJob } from '../lib/atomicApply';
import { generateAcceptanceContract } from '../lib/behavior/contract';
import { appendBehaviorEvent } from '../lib/behavior/recorder';
import type { AcceptanceContract, BehaviorEvent } from '../lib/behavior/types';
import { routeProfiles } from '../lib/calibratedAuto/ledger';
import { listPreferences, setPreferredModel, type ModelPreferences } from '../lib/calibratedAuto/preferences';
import { rankModels } from '../lib/calibratedAuto/router';
import type { CalibratedTaskType, OutcomeRecord } from '../lib/calibratedAuto/types';
import { getCapsule } from '../lib/capsules/store';
import type { CapsuleSpend } from '../lib/capsules/types';
import type { CheckpointDiff } from '../lib/checkpointDiff';
import { collectCommitContext, generateCommitMessage } from '../lib/commitMessage';
import { hasConflictMarkers, parseConflicts, resolveConflictFile, type ConflictChoice } from '../lib/conflicts';
import type { ShadRoxDesktopAPI } from '../lib/desktop';
import { loadCheckpointFiles } from '../lib/history';
import type { DecisionInput } from '../lib/intent/types';
import { restoreDraft } from '../lib/promptTemplates';
import type { ModelInfo, ProviderId } from '../lib/providers';
import { globalRepairSession } from '../lib/repairSession';
import type { ChatMessage, RefineMode, RefinedPromptMeta } from '../lib/types';
import type { useAcceptance } from './useAcceptance';
import type { useCapsules } from './useCapsules';
import type { useIntentGraph } from './useIntentGraph';
import type { SaveOutcome, useWorkspace } from './useWorkspace';

export interface UseTaskGovernanceOptions {
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  workspaceRootPath: string | null;
  workspace: ReturnType<typeof useWorkspace>;
  capsules: ReturnType<typeof useCapsules>;
  intent: ReturnType<typeof useIntentGraph>;
  acceptance: ReturnType<typeof useAcceptance>;
  byok: {
    activeProvider: ProviderId;
    baseUrl: string;
    selectedModel: string;
    activeKey: string;
    models: ModelInfo[];
    apiKeyDraft: { gemini: string; groq: string; custom: string };
  };
  saveFilesAtomicWithHooks: (names: string[]) => Promise<SaveOutcome>;
  isGenerating: boolean;
  chatDispatchLockRef: MutableRefObject<boolean>;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  refineMode: RefineMode;
  attachedFiles: string[];
  pinnedSymbols: PinnedSymbol[];
  pendingRefine: RefinedPromptMeta | null;
  setPendingRefine: Dispatch<SetStateAction<RefinedPromptMeta | null>>;
  behaviorEvents: BehaviorEvent[];
  setBehaviorEvents: Dispatch<SetStateAction<BehaviorEvent[]>>;
  behaviorContract: AcceptanceContract | null;
  setBehaviorContract: Dispatch<SetStateAction<AcceptanceContract | null>>;
  calibratedOutcomes: OutcomeRecord[];
  pendingCapsule: {
    taskId: string;
    checkpointId: string;
    promptIntent: string;
    spend: CapsuleSpend | null;
    machineDeltaRef: string | null;
  } | null;
  setPendingCapsule: Dispatch<SetStateAction<{
    taskId: string;
    checkpointId: string;
    promptIntent: string;
    spend: CapsuleSpend | null;
    machineDeltaRef: string | null;
  } | null>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setToast: (message: string | null) => void;
  announce: (message: string, ms?: number) => void;
}

export function useTaskGovernance({
  desktop,
  nativeWorkspaceId,
  workspaceRootPath,
  workspace,
  capsules,
  intent,
  acceptance,
  byok,
  saveFilesAtomicWithHooks,
  isGenerating,
  chatDispatchLockRef,
  input,
  setInput,
  refineMode,
  attachedFiles,
  pinnedSymbols,
  pendingRefine,
  setPendingRefine,
  behaviorEvents,
  setBehaviorEvents,
  behaviorContract,
  setBehaviorContract,
  calibratedOutcomes,
  pendingCapsule,
  setPendingCapsule,
  setMessages,
  setToast,
  announce
}: UseTaskGovernanceOptions) {
  const [calibratedTaskType, setCalibratedTaskType] = useState<CalibratedTaskType>('chat');
  const [modelPins, setModelPins] = useState<ModelPreferences>(() => listPreferences());
  const [restoringCheckpointId, setRestoringCheckpointId] = useState<string | null>(null);
  const [activeCheckpointId, setActiveCheckpointId] = useState<string | null>(null);
  const [checkpointDiff, setCheckpointDiff] = useState<CheckpointDiff | null>(null);
  const [checkpointDiffLoading, setCheckpointDiffLoading] = useState(false);
  const [checkpointNonce, setCheckpointNonce] = useState(0);
  const [unmergedPaths, setUnmergedPaths] = useState<string[]>([]);
  const [isWritingCommitMessage, setIsWritingCommitMessage] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const [refineStep, setRefineStep] = useState('');

  const calibratedProfiles = useMemo(
    () => routeProfiles(calibratedTaskType),
    [calibratedTaskType, calibratedOutcomes, modelPins]
  );
  const calibratedRanking = useMemo(
    () => rankModels({ taskType: calibratedTaskType, models: byok.models.map((model) => model.id) }),
    [calibratedTaskType, byok.models, calibratedOutcomes, modelPins]
  );

  const pinCalibratedModel = useCallback((taskType: CalibratedTaskType, model: string | null) => {
    setModelPins(setPreferredModel(taskType, model));
  }, []);

  const handleGenerateCommitMessage = useCallback(async () => {
    if (isWritingCommitMessage) return '';
    setIsWritingCommitMessage(true);
    try {
      const source = await collectCommitContext(nativeWorkspaceId, workspace.dirtyFiles, workspace.files);
      return await generateCommitMessage(source, {
        provider: byok.activeProvider,
        baseUrl: byok.baseUrl,
        model: byok.selectedModel,
        apiKey: byok.activeKey
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Commit message generation failed.');
      window.setTimeout(() => setToast(null), 4500);
      return '';
    } finally {
      setIsWritingCommitMessage(false);
    }
  }, [isWritingCommitMessage, nativeWorkspaceId, workspace.dirtyFiles, workspace.files, byok.activeProvider, byok.baseUrl, byok.selectedModel, byok.activeKey, setToast]);

  const handleBehaviorEvent = useCallback((event: BehaviorEvent) => {
    setBehaviorEvents((previous) => appendBehaviorEvent(previous, event));
  }, []);

  const handleGenerateContract = useCallback(() => {
    setBehaviorContract(generateAcceptanceContract(behaviorEvents));
  }, [behaviorEvents]);

  const handleClearBehavior = useCallback(() => {
    setBehaviorEvents([]);
    setBehaviorContract(null);
  }, []);

  const handleRunCheck = useCallback(async (phase: 'baseline' | 'postPatch') => {
    const result = await acceptance.run(phase);
    announce(result.message, 7000);
  }, [acceptance, announce]);

  const applyCapsulePlan = useCallback(async (id: string, mode: 'replay' | 'revert') => {
    const folder = workspace.workspace;
    if (!folder || folder.kind !== 'folder') {
      announce('Open a folder workspace to replay or revert a capsule.', 5000);
      return;
    }
    if (isGenerating) {
      announce('Finish the current turn before replaying or reverting a capsule.', 5000);
      return;
    }
    const currentFiles = workspace.files.map((file) => ({ path: file.name, content: file.content }));
    const plan = mode === 'replay'
      ? await capsules.planReplay(id, currentFiles)
      : await capsules.planRevert(id, currentFiles);
    if (!plan.ok) {
      announce(
        `Capsule ${mode} refused — ${plan.conflicts.slice(0, 3).map((conflict) => `${conflict.path}: ${conflict.reason}`).join(' · ')}. No files changed.`,
        7000
      );
      return;
    }
    if (plan.jobs.length === 0) {
      announce('This capsule has no changes to apply.', 4000);
      return;
    }
    const capsule = await getCapsule(id);
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const kindByPath = new Map((capsule?.diffs ?? []).map((diff) => [normalize(diff.path), diff.kind]));
    const writeJobs: AtomicPlanJob[] = [];
    const deletePaths: string[] = [];
    for (const job of plan.jobs) {
      const kind = kindByPath.get(normalize(job.path));
      const isDelete = (mode === 'replay' && kind === 'deleted') || (mode === 'revert' && kind === 'created');
      if (isDelete) deletePaths.push(job.path);
      else writeJobs.push(job);
    }
    const checkpointId = await workspace.markCheckpoint(makeId('capsule'), `Capsule ${mode}`, true, true);
    try {
      const editPaths = writeJobs.filter((job) => !job.created).map((job) => job.path);
      if (editPaths.length > 0) await workspace.loadFilesForPatching(editPaths);
      const applied = applyAtomicJobs(writeJobs, (updates) => workspace.applyFilePatches(updates));
      for (const path of deletePaths) await workspace.deleteWorkspaceEntry(path);
      const createdPaths = writeJobs.filter((job) => job.created).map((job) => job.path);
      if (createdPaths.length > 0) await workspace.noteCheckpointCreated(createdPaths);
      let diskNote = 'Applied in the editor only — save to write to disk.';
      if (applied.length > 0 && workspace.canWriteToDisk) {
        const outcome = await saveFilesAtomicWithHooks(applied);
        if (outcome.failed && outcome.written === 0) {
          workspace.applyFilePatches(revertAtomicJobs(writeJobs));
          announce(outcome.message ?? 'The capsule change was not saved and was rolled back.', 7000);
          return;
        }
        diskNote = outcome.written > 0
          ? `${outcome.written} file${outcome.written === 1 ? '' : 's'} written to disk.`
          : outcome.message ?? diskNote;
      }
      announce(
        `Capsule ${mode}: ${applied.length} file${applied.length === 1 ? '' : 's'} updated${deletePaths.length > 0 ? `, ${deletePaths.length} deleted` : ''}. ${diskNote}`,
        5000
      );
    } finally {
      await workspace.finishMachineCheckpoint(checkpointId);
    }
  }, [workspace, capsules, announce, saveFilesAtomicWithHooks, isGenerating]);

  const handleCapsuleExport = useCallback(async () => {
    const exported = await capsules.exportJson();
    if (exported.capsules.length === 0) {
      announce('No capsules to export yet.', 4000);
      return;
    }
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `shadrox-capsules-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    announce(`Exported ${exported.capsules.length} capsule${exported.capsules.length === 1 ? '' : 's'}.`, 4000);
  }, [capsules, announce]);

  const handleCapsuleImport = useCallback(async (data: unknown) => {
    const result = await capsules.importJson(data);
    if (result.imported === 0 && result.errors.length > 0) {
      announce(`Capsule import failed — ${result.errors[0]}`, 6000);
      return;
    }
    announce(
      `Imported ${result.imported} capsule${result.imported === 1 ? '' : 's'}${result.skipped > 0 ? `, ${result.skipped} skipped` : ''}.`,
      5000
    );
  }, [capsules, announce]);

  const handleAddDecision = useCallback(async (inputDecision: DecisionInput) => {
    const decision = await intent.addDecision(inputDecision);
    if (!decision) {
      announce('The decision was not saved — this workspace cannot write local storage.', 5000);
      return;
    }
    const governed = Object.keys(inputDecision.baseHashes).length;
    announce(
      governed === 0
        ? 'Saved. None of its files are indexed yet, so it will read as unverified until one is open.'
        : `Saved. It now tracks ${governed} file${governed === 1 ? '' : 's'} for change.`,
      4500
    );
  }, [intent, announce]);

  const handleIntentExport = useCallback(() => {
    const exported = intent.exportJson();
    if (exported.decisions.length === 0) {
      announce('No intent decisions to export yet.', 4000);
      return;
    }
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `shadrox-intent-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    announce(`Exported ${exported.decisions.length} intent decision${exported.decisions.length === 1 ? '' : 's'}.`, 4000);
  }, [intent, announce]);

  const handleIntentImport = useCallback((data: unknown) => {
    const result = intent.importJson(data);
    announce(
      result.imported > 0
        ? `Imported ${result.imported} intent decision${result.imported === 1 ? '' : 's'}.`
        : `Intent import failed — ${result.errors[0] ?? 'nothing new to import'}`,
      5000
    );
  }, [intent, announce]);

  useEffect(() => {
    if (!pendingCapsule || !workspaceRootPath) return;
    const request = pendingCapsule;
    setPendingCapsule(null);
    const postFiles = workspace.files.map((file) => ({ path: file.name, content: file.content }));
    void (async () => {
      try {
        const baseFiles = await loadCheckpointFiles(request.checkpointId);
        await capsules.capture({
          taskId: request.taskId,
          workspaceRoot: workspaceRootPath,
          promptIntent: request.promptIntent,
          baseFiles: (baseFiles ?? []).map((file) => ({ path: file.name, content: file.content })),
          postFiles,
          spend: request.spend,
          machineDeltaRef: request.machineDeltaRef,
          status: 'applied'
        });
      } catch {
        // Capsule capture is best-effort and must never surface as a turn error.
      }
    })();
  }, [pendingCapsule, workspaceRootPath, workspace.files, capsules.capture]);

  const conflictHunks = useMemo(() => {
    const file = workspace.activeFile;
    if (!file || !hasConflictMarkers(file.content)) return [];
    return parseConflicts(file.content).hunks;
  }, [workspace.activeFile]);

  useEffect(() => {
    if (!desktop || !nativeWorkspaceId || conflictHunks.length === 0) {
      if (unmergedPaths.length > 0) setUnmergedPaths([]);
      return;
    }
    let cancelled = false;
    void desktop
      .gitConflicts(nativeWorkspaceId)
      .then((result) => {
        if (!cancelled) setUnmergedPaths(result.paths);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [desktop, nativeWorkspaceId, conflictHunks.length, unmergedPaths.length]);

  const resolveConflicts = useCallback(
    (choice: ConflictChoice) => {
      const file = workspace.activeFile;
      if (!file) return;
      const parsed = parseConflicts(file.content);
      if (parsed.hunks.length === 0) return;
      const resolved = resolveConflictFile(
        file.content,
        parsed.hunks.map(() => choice)
      );
      if (resolved.unresolved > 0) {
        announce('Some conflict hunks could not be parsed; fix those markers by hand.', 6000);
        return;
      }
      const result = workspace.applyFilePatches([{ path: file.name, content: resolved.content }]);
      const landed = result.updated[0] ?? result.created[0] ?? file.name;
      void saveFilesAtomicWithHooks([landed]).then((outcome) => {
        announce(
          outcome.written > 0
            ? `Resolved ${parsed.hunks.length} conflict${parsed.hunks.length === 1 ? '' : 's'} in ${file.name}.`
            : outcome.message ?? 'Resolved in the editor, but the file was not saved.',
          5000
        );
      });
    },
    [workspace, announce, saveFilesAtomicWithHooks]
  );

  const handleRefinePrompt = useCallback(async () => {
    const raw = input.trim();
    if (!raw || isRefining || isGenerating) return;

    setIsRefining(true);
    setRefineStep('Analyzing prompt structure...');

    try {
      const refined = await refinePrompt({
        rawPrompt: raw,
        geminiKey: byok.apiKeyDraft.gemini,
        groqKey: byok.apiKeyDraft.groq,
        customKey: byok.apiKeyDraft.custom,
        baseUrl: byok.baseUrl,
        model: byok.selectedModel,
        provider: byok.activeProvider,
        contextInfo: `Workspace has ${workspace.files.length} file(s). Active file: ${workspace.activeFile?.name || 'none'}.`,
        mode: refineMode
      });

      setInput(refined.refinedPrompt);
      setPendingRefine({
        original: raw,
        detectedLanguage: refined.detectedLanguage,
        translated: refined.translatedText,
        intent: refined.intent,
        refinedPrompt: refined.refinedPrompt,
        mode: refineMode
      });
      setToast('Prompt refined with engineering context');
      window.setTimeout(() => setToast(null), 3000);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Prompt refinement failed');
      window.setTimeout(() => setToast(null), 4000);
    } finally {
      setIsRefining(false);
      setRefineStep('');
    }
  }, [input, isRefining, isGenerating, byok.apiKeyDraft, byok.activeProvider, byok.baseUrl, byok.selectedModel, workspace.files.length, workspace.activeFile, refineMode, setInput, setPendingRefine, setToast]);

  const canUndoRefine = input.length > 0 && Boolean(pendingRefine?.refinedPrompt) && input === pendingRefine?.refinedPrompt;

  const handleUndoRefine = useCallback(() => {
    if (!pendingRefine) return;
    const restored = restoreDraft({
      text: pendingRefine.original,
      mode: refineMode,
      targets: [...attachedFiles, ...pinnedSymbols.map((symbol) => symbol.file)]
    });
    setInput(restored.text);
    setPendingRefine(null);
  }, [pendingRefine, refineMode, attachedFiles, pinnedSymbols, setInput, setPendingRefine]);

  const handleRestoreCheckpoint = useCallback(
    async (checkpointId: string) => {
      if (chatDispatchLockRef.current) return;
      setRestoringCheckpointId(checkpointId);
      try {
        const result = await workspace.restoreCheckpoint(checkpointId);
        if (result.ok) {
          const rejected = globalRepairSession.rejectForCheckpoint(
            checkpointId,
            `Restored checkpoint ${checkpointId}; the failing state was rewound.`
          );
          if (rejected.length > 0) {
            setMessages((previous) => previous.map((message) => {
              const proof = message.selfHealingProof;
              if (!proof) return message;
              const updated = rejected.find((receipt) => receipt.id === proof.id);
              return updated ? { ...message, selfHealingProof: updated } : message;
            }));
          }
          setCheckpointNonce((previous) => previous + 1);
          const isMachine = Boolean(workspace.checkpoints.find((entry) => entry.id === checkpointId)?.machine);
          setToast(isMachine
            ? result.partial
              ? 'Rewind was partial: the captured files came back on disk, but some steps did not finish — see the timeline limits.'
              : 'Captured changes rewound on disk. See timeline for limits.'
            : 'Editor buffers restored; save to persist them on disk.');
          window.setTimeout(() => setToast(null), 3000);
        }
      } finally { setRestoringCheckpointId(null); }
    },
    [workspace, chatDispatchLockRef, setMessages, setToast]
  );

  useEffect(() => {
    if (activeCheckpointId) void workspace.inspectMachineCheckpoint(activeCheckpointId);
  }, [activeCheckpointId, checkpointNonce, workspace.inspectMachineCheckpoint]);

  useEffect(() => {
    if (!activeCheckpointId || !workspace.checkpoints.some((entry) => entry.id === activeCheckpointId)) {
      setCheckpointDiff(null);
      return;
    }
    let cancelled = false;
    setCheckpointDiffLoading(true);
    void workspace
      .previewCheckpointDiff(activeCheckpointId)
      .then((result) => {
        if (!cancelled) setCheckpointDiff(result);
      })
      .catch(() => {
        if (!cancelled) setCheckpointDiff(null);
      })
      .finally(() => {
        if (!cancelled) setCheckpointDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCheckpointId, checkpointNonce, workspace]);

  return {
    calibratedTaskType,
    setCalibratedTaskType,
    calibratedProfiles,
    calibratedRanking,
    pinCalibratedModel,
    restoringCheckpointId,
    activeCheckpointId,
    setActiveCheckpointId,
    checkpointDiff,
    checkpointDiffLoading,
    unmergedPaths,
    conflictHunks,
    resolveConflicts,
    isWritingCommitMessage,
    handleGenerateCommitMessage,
    isRefining,
    refineStep,
    handleRefinePrompt,
    canUndoRefine,
    handleUndoRefine,
    handleRestoreCheckpoint,
    handleBehaviorEvent,
    handleGenerateContract,
    handleClearBehavior,
    handleRunCheck,
    applyCapsulePlan,
    handleCapsuleExport,
    handleCapsuleImport,
    handleAddDecision,
    handleIntentExport,
    handleIntentImport
  };
}
