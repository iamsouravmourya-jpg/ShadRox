import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { PinnedSymbol } from '../components/ChatPanel';
import { refinePrompt } from '../lib/ai';
import { generateAcceptanceContract } from '../lib/behavior/contract';
import { appendBehaviorEvent } from '../lib/behavior/recorder';
import type { AcceptanceContract, BehaviorEvent } from '../lib/behavior/types';
import { routeProfiles } from '../lib/calibratedAuto/ledger';
import { listPreferences, setPreferredModel, type ModelPreferences } from '../lib/calibratedAuto/preferences';
import { rankModels } from '../lib/calibratedAuto/router';
import type { CalibratedTaskType, OutcomeRecord } from '../lib/calibratedAuto/types';
import { collectCommitContext, generateCommitMessage } from '../lib/commitMessage';
import { hasConflictMarkers, parseConflicts, resolveConflictFile, type ConflictChoice } from '../lib/conflicts';
import type { ShadRoxDesktopAPI } from '../lib/desktop';
import { restoreDraft } from '../lib/promptTemplates';
import type { ModelInfo, ProviderId } from '../lib/providers';
import type { ChatMessage, RefineMode, RefinedPromptMeta } from '../lib/types';
import type { useAcceptance } from './useAcceptance';
import type { SaveOutcome, useWorkspace } from './useWorkspace';

export interface UseTaskGovernanceOptions {
  desktop: ShadRoxDesktopAPI | null;
  nativeWorkspaceId: string | null;
  workspace: ReturnType<typeof useWorkspace>;
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
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setToast: (message: string | null) => void;
  announce: (message: string, ms?: number) => void;
}

export function useTaskGovernance({
  desktop,
  nativeWorkspaceId,
  workspace,
  acceptance,
  byok,
  saveFilesAtomicWithHooks,
  isGenerating,
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
  setToast,
  announce
}: UseTaskGovernanceOptions) {
  const [calibratedTaskType, setCalibratedTaskType] = useState<CalibratedTaskType>('chat');
  const [modelPins, setModelPins] = useState<ModelPreferences>(() => listPreferences());
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

  return {
    calibratedTaskType,
    setCalibratedTaskType,
    calibratedProfiles,
    calibratedRanking,
    pinCalibratedModel,
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
    handleBehaviorEvent,
    handleGenerateContract,
    handleClearBehavior,
    handleRunCheck
  };
}
