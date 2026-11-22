import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { PastedText, PinnedSymbol } from '../components/ChatPanel';
import { commandApprovalNotice } from '../lib/agent/commandGuard';
import { computeLoopContextBudgetChars } from '../lib/agent/loopContext';
import type { McpToolHandle } from '../lib/agent/mcpTools';
import type { PermissionMode } from '../lib/agent/runPolicy';
import { DEFAULT_MAX_TOOL_ROUNDS, runToolRounds } from '../lib/agent/toolLoop';
import { parseToolBlocks, repairAndParseNativeToolArgs, stripToolBlocks } from '../lib/agent/toolProtocol';
import type { WorkspaceToolContext } from '../lib/agent/toolGatekeeper';
import { nativeToolDefinitions, summarizeCall } from '../lib/agent/tools';
import { inferMilestoneCategory } from '../lib/autonomy/milestoneVerifier';
import { isRetryableCoordinatorError, withCoordinatorBackoff } from '../lib/agents/coordinatorResilience';
import { selectTaskMetrics } from '../lib/agents/runView';
import { executedToolCallCount, runAgentTurn } from '../lib/agents/turnRunner';
import { retryCheck } from '../lib/agents/scopePreserve';
import { getRefineMode, streamChat, type ChatTurn, type RefineModeMeta } from '../lib/ai';
import { betaLogger } from '../lib/betaLogger';
import {
  createBackgroundStore,
  formatTime,
  makeId,
  orchestrationStatusOfRun,
  sameWorkspaceRoot,
  settleRestoredOrchestration,
  summarizeWriteOutcomes,
  type ActiveOrchestration,
  type AutomationDesktopApi,
  type OrchestrationStatus,
  type PickerReport,
  type QueuedChatDraft,
  type ReviewSetOutcome
} from '../lib/appHelpers';
import {
  canResume as canResumeBackgroundRun,
  createBackgroundSnapshot,
  loadSnapshots,
  pruneSnapshots,
  settleInterrupted,
  type BackgroundRunSnapshot,
  type BackgroundRunSource
} from '../lib/autonomy/background';
import type { AutonomyHost } from '../lib/autonomy/ports';
import { browserRunStore } from '../lib/autonomy/runStore';
import { DEFAULT_RUN_BUDGET, type CommandOutcome, type TurnRequest, type TurnResult } from '../lib/autonomy/types';
import { DEFAULT_TEAM_BUDGET } from '../lib/agents/types';
import { outcomeOfReader, outcomeOfTurn, testRunsFrom, type ApplyOutcome } from '../lib/calibratedAuto/evidence';
import { recordOutcome } from '../lib/calibratedAuto/ledger';
import type { OutcomeRecord } from '../lib/calibratedAuto/types';
import { expandChatMentions } from '../lib/chat/contextMentions';
import { clearConversation, getHistoryStore, loadConversation, saveConversation, shouldSkipHistoryWrite } from '../lib/chatHistory';
import { dequeueChatItem, enqueueChatItem, MAX_QUEUED_CHAT_MESSAGES, removeQueuedChatItem } from '../lib/chatQueue';
import { compactHistory } from '../lib/compaction';
import { contextFitNotice, fitChatRequest, type ChatRequestFit, type SystemContext } from '../lib/contextBudget';
import type { ContextManifest } from '../lib/contextManifest';
import type { DesktopDiagnostic, ShadRoxDesktopAPI } from '../lib/desktop';
import { normalizeSlashes, warnBridgeError } from '../lib/diagnostics';
import { dedupePaths } from '../lib/paths';
import { decideOrchestration } from '../lib/orchestrate';
import { DEFAULT_MAX_OUTPUT, modelSupportsVision, resolveBudgetCapabilities, resolveContextWindow } from '../lib/modelCapabilities';
import { extractUnifiedPatches } from '../lib/patchEngine';
import { selectHooks, type LoadedPlugin, type PluginActionRun } from '../lib/plugins';
import { globalRepairSession } from '../lib/repairSession';
import { createRequestEnvelope, describeEnvelopeDrift, envelopeDrift } from '../lib/requestEnvelope';
import { renderSkill, skillInvocation, type Skill } from '../lib/skills';
import { getSessionStore, syncInterruptedSnapshot, takeRestorableSnapshot, type RestoredConversation } from '../lib/streamSnapshot';
import type { AttemptRecord } from '../lib/taskUsage';
import { buildTypeFixPrompt } from '../lib/typeErrorRefine';
import type { ModelInfo, ProviderId } from '../lib/providers';
import type { ChatMessage, PatchSet, RefineMode, RefinedPromptMeta, ReviewPatch, SettingsTab } from '../lib/types';
import { useAutonomyRun } from './useAutonomyRun';
import { useTeamRun } from './useTeamRun';
import type { useWorkspace } from './useWorkspace';

export interface UseOrchestrationControllerOptions {
  desktop: ShadRoxDesktopAPI | null;
  desktopBridge: (ShadRoxDesktopAPI & AutomationDesktopApi) | null;
  nativeWorkspaceId: string | null;
  workspaceRootPath: string | null;
  workspace: ReturnType<typeof useWorkspace>;
  diagnosticsOverrides: Array<{ path: string; content: string }>;
  byok: {
    activeKey: string;
    activeProvider: ProviderId;
    baseUrl: string;
    models: ModelInfo[];
    selectedModel: string;
    temperature: number;
  };
  activeModel: ModelInfo | null;
  permissionMode: PermissionMode;
  refineMode: RefineMode;
  setRefineMode: (mode: RefineMode) => void;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  attachedFiles: string[];
  setAttachedFiles: Dispatch<SetStateAction<string[]>>;
  attachedImage: string | null;
  setAttachedImage: Dispatch<SetStateAction<string | null>>;
  pinnedSymbols: PinnedSymbol[];
  setPinnedSymbols: Dispatch<SetStateAction<PinnedSymbol[]>>;
  pendingRefine: RefinedPromptMeta | null;
  setPendingRefine: Dispatch<SetStateAction<RefinedPromptMeta | null>>;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  patchSets: PatchSet[];
  setPatchSets: Dispatch<SetStateAction<PatchSet[]>>;
  applyPatchesFromReply: (
    messageId: string,
    fullReply: string,
    mode: RefineModeMeta,
    options?: {
      replace?: boolean;
      merge?: { staged: ReviewPatch[] };
      onFailures?: (failures: string[]) => void | Promise<void>;
      onUnmapped?: () => void | Promise<void>;
    }
  ) => Promise<ApplyOutcome>;
  applyReviewSet: (
    messageId: string,
    patches: ReviewPatch[],
    options?: { allowDestructive?: boolean; verify?: boolean; onlyIndex?: number; onlyIndexes?: number[] }
  ) => Promise<ReviewSetOutcome>;
  planApprovalGateRef: MutableRefObject<Set<string>>;
  typeFixOffers: Record<string, DesktopDiagnostic[]>;
  setTypeFixOffers: Dispatch<SetStateAction<Record<string, DesktopDiagnostic[]>>>;
  autoReaderModel: (query: string, role: 'edit' | 'chatter') => string | null;
  runContextPicker: (readerModel: string, report?: PickerReport) => (shortlist: string[], query: string) => Promise<string[]>;
  getWorkspaceManifest: () => Promise<string | null>;
  buildSystemContext: (
    query: string,
    mode: RefineModeMeta,
    picker?: (shortlist: string[], query: string) => Promise<string[]>,
    contextSelection?: {
      attachedFiles?: string[];
      pinnedSymbols?: PinnedSymbol[];
      toolContext?: WorkspaceToolContext;
    }
  ) => Promise<SystemContext>;
  setContextManifest: (manifest: ContextManifest | null) => void;
  routingNoteRef: MutableRefObject<string>;
  rulesNoteRef: MutableRefObject<string>;
  mcpToolHandleRef: MutableRefObject<McpToolHandle | null>;
  pluginsRef: MutableRefObject<LoadedPlugin[]>;
  skillDocsRef: MutableRefObject<Skill[]>;
  pendingPromptQueueRef: MutableRefObject<string[]>;
  chatHookGuardRef: MutableRefObject<boolean>;
  dispatchPluginActionRuns: (runs: PluginActionRun[]) => void;
  busyRef: MutableRefObject<boolean>;
  setCalibratedOutcomes: Dispatch<SetStateAction<OutcomeRecord[]>>;
  setPendingCapsule: Dispatch<SetStateAction<{
    taskId: string;
    checkpointId: string;
    promptIntent: string;
    spend: null;
    machineDeltaRef: string | null;
  } | null>>;
  setToast: (message: string | null) => void;
  announce: (message: string, ms?: number) => void;
  openSettings: (tab?: SettingsTab) => void;
  setIsSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  getToolContext?: () => Promise<WorkspaceToolContext> | WorkspaceToolContext;
}

export function useOrchestrationController({
  desktop,
  desktopBridge,
  nativeWorkspaceId,
  workspaceRootPath,
  workspace,
  diagnosticsOverrides,
  byok,
  activeModel,
  permissionMode,
  refineMode,
  setRefineMode,
  input,
  setInput,
  attachedFiles,
  setAttachedFiles,
  attachedImage,
  setAttachedImage,
  pinnedSymbols,
  setPinnedSymbols,
  pendingRefine,
  setPendingRefine,
  messages,
  setMessages,
  patchSets,
  setPatchSets,
  applyPatchesFromReply,
  applyReviewSet,
  planApprovalGateRef,
  typeFixOffers,
  setTypeFixOffers,
  autoReaderModel,
  runContextPicker,
  getWorkspaceManifest,
  buildSystemContext,
  setContextManifest,
  routingNoteRef,
  rulesNoteRef,
  mcpToolHandleRef,
  pluginsRef,
  skillDocsRef,
  pendingPromptQueueRef,
  chatHookGuardRef,
  dispatchPluginActionRuns,
  busyRef,
  setCalibratedOutcomes,
  setPendingCapsule,
  setToast,
  announce,
  openSettings,
  setIsSettingsOpen,
  setSettingsTab,
  getToolContext
}: UseOrchestrationControllerOptions) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [queuedChatItems, setQueuedChatItems] = useState<QueuedChatDraft[]>([]);
  const queuedChatItemsRef = useRef<QueuedChatDraft[]>([]);
  const chatDispatchLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const [activeStatusMessage, setActiveStatusMessage] = useState<string | null>(null);
  const [resumePrefixes, setResumePrefixes] = useState<Record<string, string>>({});

  const snapshotStore = useMemo(() => createBackgroundStore(), []);
  const [resumeSnapshot, setResumeSnapshot] = useState<BackgroundRunSnapshot | null>(null);
  const trackedRunRef = useRef<{ kind: 'autonomy' | 'team'; goal: string } | null>(null);
  const orchestrationRef = useRef<ActiveOrchestration | null>(null);

  const saveBackgroundSnapshot = useCallback(
    (source: BackgroundRunSource) => {
      try {
        snapshotStore.save(createBackgroundSnapshot(source));
      } catch (error) {
        warnBridgeError('background-snapshot', error);
      }
    },
    [snapshotStore]
  );

  useEffect(() => {
    trackedRunRef.current = null;
    if (!workspaceRootPath) {
      setResumeSnapshot(null);
      return;
    }
    let candidate: BackgroundRunSnapshot | null = null;
    for (const snapshot of loadSnapshots(snapshotStore)) {
      if (!sameWorkspaceRoot(snapshot.workspaceRoot, workspaceRootPath)) continue;
      if (snapshot.status === 'running') {
        const settled = settleInterrupted(snapshot);
        snapshotStore.save(settled);
        if (!candidate && canResumeBackgroundRun(settled, workspaceRootPath).ok) candidate = settled;
        continue;
      }
      if (!candidate && canResumeBackgroundRun(snapshot, workspaceRootPath).ok) candidate = snapshot;
    }
    pruneSnapshots(snapshotStore);
    setResumeSnapshot(candidate);
  }, [workspaceRootPath, snapshotStore]);

  const restoreWorkspaceId = workspace.workspace?.id ?? null;
  const historyStore = useRef(getHistoryStore()).current;
  const snapshotConsumedFor = useRef(new Set<string>());
  const lastWorkspaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!restoreWorkspaceId) return;

    let restored: RestoredConversation | null = null;
    if (!snapshotConsumedFor.current.has(restoreWorkspaceId)) {
      snapshotConsumedFor.current.add(restoreWorkspaceId);
      restored = takeRestorableSnapshot(getSessionStore(), { workspaceId: restoreWorkspaceId });
    }
    if (restored) {
      setMessages(settleRestoredOrchestration(restored.messages));
      setResumePrefixes({ [restored.interruptedId]: restored.prefix });
      setRefineMode(restored.refineMode);
      return;
    }
    setMessages(settleRestoredOrchestration(loadConversation(historyStore, restoreWorkspaceId) ?? []));
  }, [historyStore, restoreWorkspaceId, setMessages, setRefineMode]);

  useEffect(() => {
    if (!restoreWorkspaceId || shouldSkipHistoryWrite(messages)) return;
    const withOutcomes = messages.map((message) => {
      const set = patchSets.find((entry) => entry.messageId === message.id);
      if (!set || set.patches.length === 0) return message;
      return { ...message, writeOutcomes: { ...message.writeOutcomes, ...summarizeWriteOutcomes(set.patches) } };
    });
    saveConversation(historyStore, restoreWorkspaceId, withOutcomes);
  }, [historyStore, messages, patchSets, restoreWorkspaceId]);

  useEffect(() => {
    if (restoreWorkspaceId) lastWorkspaceIdRef.current = restoreWorkspaceId;
    const result = syncInterruptedSnapshot(getSessionStore(), {
      messages,
      prefixes: resumePrefixes,
      refineMode,
      workspaceId: restoreWorkspaceId ?? lastWorkspaceIdRef.current
    });
    if (result.prefixes !== resumePrefixes) setResumePrefixes(result.prefixes);
  }, [messages, resumePrefixes, refineMode, restoreWorkspaceId]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleSend = useCallback(async (
    rawText?: string,
    historyOverride?: ChatTurn[],
    submission?: QueuedChatDraft
  ) => {
    const typed = (typeof rawText === 'string' ? rawText : input).trim();
    if (!typed || isGenerating) return;
    const requestFiles = submission?.attachedFiles ?? attachedFiles;
    const requestSymbols = submission?.pinnedSymbols ?? pinnedSymbols;
    const requestRefineMode = submission?.refineMode ?? refineMode;
    const requestPendingRefine = submission ? submission.pendingRefine : pendingRefine;
    const requestImage = submission?.attachedImage ?? attachedImage;
    const requestPastes = submission?.pastedTexts ?? [];
    if (requestImage && !modelSupportsVision(byok.activeProvider, byok.selectedModel)) {
      setToast('This model does not advertise photo support. Choose a vision-capable model or remove the photo.');
      window.setTimeout(() => setToast(null), 5000);
      return;
    }

    const invocation = skillInvocation(typed, skillDocsRef.current);
    const text = invocation
      ? (() => {
        const rendered = renderSkill(invocation.skill, invocation.args, workspace.activeFile
          ? { path: workspace.activeFile.name, content: workspace.activeFile.content }
          : undefined);
        return invocation.args && !invocation.skill.body.includes('{args}')
          ? `${rendered}\n\nThe user added: ${invocation.args}`
          : rendered;
      })()
      : typed;
    if (invocation) announce(`Expanded the ${invocation.skill.name} skill this folder keeps.`, 4000);

    const ownsDispatchLock = !chatDispatchLockRef.current;
    if (ownsDispatchLock) chatDispatchLockRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setInput('');
    setPendingRefine(null);
    setAttachedFiles([]);
    setAttachedImage(null);
    setPinnedSymbols([]);

    const mode = getRefineMode(requestRefineMode);
    const timestamp = formatTime();
    const userMessageId = makeId('user');
    const requestEnvelope = submission?.envelope ?? createRequestEnvelope({
      id: userMessageId,
      workspaceId: nativeWorkspaceId,
      prompt: text,
      targets: [
        ...requestFiles,
        ...requestSymbols.map((symbol) => `${symbol.name} (${symbol.file})`)
      ],
      permissionMode,
      refineMode: requestRefineMode,
      provider: byok.activeProvider,
      model: byok.selectedModel
    });
    const userMessage: ChatMessage = {
      id: userMessageId,
      role: 'user',
      content: typed,
      timestamp,
      refinedMeta: requestPendingRefine ? { ...requestPendingRefine, mode: requestRefineMode } : undefined,
      attachedImage: requestImage ?? undefined,
      envelope: requestEnvelope,
      attachments:
        requestFiles.length > 0 || requestPastes.length > 0 || requestSymbols.length > 0
          ? [
              ...requestFiles,
              ...requestPastes.map((paste) => `${paste.name} · pasted text`),
              ...requestSymbols.map((symbol) => `${symbol.name} (${symbol.file})`)
            ]
          : undefined
    };

    const modelMessage: ChatMessage = {
      id: makeId('model'),
      role: 'model',
      content: '',
      timestamp,
      streaming: true
    };

    const contextWindow =
      activeModel?.contextWindow || resolveContextWindow(byok.activeProvider, byok.selectedModel);

    const toTurn = (message: { role: string; content: string }): ChatTurn => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content
    });
    let history: ChatTurn[];
    let folded: string[] = [];
    if (historyOverride) {
      history = [...historyOverride];
    } else {
      const archived = messages.filter((message) => !message.streaming && message.content.trim());
      const result = compactHistory(archived, {
        contextWindow,
        patchedMessageIds: new Set(
          patchSets
            .filter((set) => set.patches.some((patch) => patch.status === 'pending' || patch.status === 'failed'))
            .map((set) => set.messageId)
        )
      });
      history = result.messages.map(toTurn);
      folded = result.folds;
    }
    history.push({
      role: 'user',
      content: await expandChatMentions(text, {
        files: workspace.files,
        bridge: desktopBridge,
        workspaceId: nativeWorkspaceId
      }),
      ...(requestImage ? { imageData: requestImage } : {})
    });
    routingNoteRef.current = '';
    const readerModel = autoReaderModel(text, mode.writesFiles ? 'edit' : 'chatter');
    const pickerReport: PickerReport = { model: readerModel ?? '', ran: false, shortlist: 0, answered: false, picked: 0, durationMs: 0 };
    let fit: ChatRequestFit;
    const baseToolContext = getToolContext ? await getToolContext() : undefined;
    const toolContext =
      baseToolContext && !mode.writesFiles
        ? { ...baseToolContext, isReadOnlyTurn: true, hasMutatedFiles: false, touchedFiles: [] as string[] }
        : baseToolContext;
    const nativeTools = nativeToolDefinitions(Boolean(nativeWorkspaceId), toolContext);
    try {
      const systemContext = await buildSystemContext(
        text,
        mode,
        readerModel ? runContextPicker(readerModel, pickerReport) : undefined,
        { attachedFiles: requestFiles, pinnedSymbols: requestSymbols, toolContext }
      );
      if (systemContext.manifest) setContextManifest(systemContext.manifest);
      fit = fitChatRequest({
        contextWindow,
        messages: history,
        system: systemContext,
        maxOutput: resolveBudgetCapabilities(byok.activeProvider, byok.selectedModel).maxOutput ?? DEFAULT_MAX_OUTPUT,
        extraInputChars: JSON.stringify(nativeTools).length + 2048 + history.length * 64
      });
    } catch (error) {
      if (abortRef.current === controller) abortRef.current = null;
      if (ownsDispatchLock) chatDispatchLockRef.current = false;
      if (!controller.signal.aborted) {
        setInput((current) => current.trim() ? current : typed);
        setAttachedFiles((current) => current.length > 0 ? current : requestFiles);
        setPinnedSymbols((current) => current.length > 0 ? current : requestSymbols);
        setPendingRefine((current) => current ?? requestPendingRefine);
      }
      throw error;
    }
    if (controller.signal.aborted) {
      if (ownsDispatchLock) chatDispatchLockRef.current = false;
      return;
    }

    const answerModel = byok.selectedModel;

    const autoNotes: string[] = [];
    if (readerModel) autoNotes.push(`${readerModel} picked the files`);
    setContextNotice(
      [
        contextFitNotice(fit, answerModel) ?? '',
        autoNotes.length ? `Auto: ${autoNotes.join(', ')}.` : '',
        routingNoteRef.current,
        folded.length ? `Compacted: ${folded.join(', ')}.` : '',
        rulesNoteRef.current
      ]
        .filter(Boolean)
        .join('\n')
    );

    setMessages((previous) => [...previous, userMessage, modelMessage]);
    setIsGenerating(true);

    if (!byok.activeKey) {
      setIsGenerating(false);
      if (abortRef.current === controller) abortRef.current = null;
      chatDispatchLockRef.current = false;
      setMessages((previous) =>
        previous.map((message) =>
          message.id === modelMessage.id
            ? {
                ...message,
                streaming: false,
                content:
                  'No API key found. Add your Google Gemini, Groq, or OpenAI-compatible custom endpoint key in **Settings → Models & Keys** to start chatting.'
              }
            : message
        )
      );
      setIsSettingsOpen(true);
      setSettingsTab('CHAT');
      return;
    }
    let reply = '';
    let applied = false;
    let streamCompleted = false;
    let appliedReplyChars = 0;
    const stagedRoundPatches: { staged: ReviewPatch[] } = { staged: [] };
    let runRepair: (failures: string[]) => Promise<void> = async () => {};
    let runUnmappedRepair: () => Promise<void> = async () => {};

    const applyReport: ApplyOutcome = {
      editAttempted: false,
      filesWritten: 0,
      patchFailures: [],
      verification: null,
      diagnostics: null
    };
    const mergeApply = (next: ApplyOutcome) => {
      applyReport.editAttempted = applyReport.editAttempted || next.editAttempted;
      applyReport.filesWritten += next.filesWritten;
      applyReport.patchFailures = [...applyReport.patchFailures, ...next.patchFailures];
      if (next.verification) applyReport.verification = next.verification;
      if (next.diagnostics) applyReport.diagnostics = next.diagnostics;
    };

    const turnSignals = {
      activity: [] as import('../lib/calibratedAuto/evidence').TurnToolCall[],
      blocked: null as string | null,
      streamError: null as string | null,
      answerEmpty: true
    };

    const applyReplyPatches = async () => {
      if (applied) return;
      applied = true;
      const remaining = reply.slice(appliedReplyChars);
      if (appliedReplyChars > 0 && !remaining.trim()) return;
      mergeApply(await applyPatchesFromReply(modelMessage.id, remaining, mode, {
        ...(appliedReplyChars > 0 ? { merge: stagedRoundPatches } : {}),
        onFailures: runRepair,
        onUnmapped: runUnmappedRepair
      }));
    };

    const markInterrupted = (error: string) => {
      if (!reply.trim()) {
        const lower = error.toLowerCase();
        const hint = /api key|authenticate|unauthorized|invalid.*key|permission denied|\b401\b|\b403\b/.test(lower)
          ? 'Check your key or model selection in Settings.'
          : /rate.?limit|quota|too many requests|\b429\b/.test(lower)
            ? 'Limits are usually per model — switch models in Settings or retry in a minute.'
            : 'Retry, or switch the model in Settings if it keeps happening.';
        setMessages((previous) =>
          previous.map((message) =>
            message.id === modelMessage.id
              ? {
                  ...message,
                  streaming: false,
                  content: `**Generation Error:** ${error}\n\n${hint}`
                }
              : message
          )
        );
        return;
      }
      setMessages((previous) =>
        previous.map((message) =>
          message.id === modelMessage.id
            ? { ...message, streaming: false, resumable: true }
            : message
        )
      );
      setResumePrefixes((previous) => ({ ...previous, [modelMessage.id]: reply }));
    };

    const machineCheckpoint = await workspace.markCheckpoint(modelMessage.id, text);
    globalRepairSession.beginTurn(machineCheckpoint);

    const turnUsage = {
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      durationMs: 0,
      firstTokenMs: null as number | null
    };

    const turnAttempts: AttemptRecord[] = [];
    const recordAttempt = (record: AttemptRecord) => { turnAttempts.push(record); };
    let repairRoundSeq = DEFAULT_MAX_TOOL_ROUNDS + 100;

    const streamOnce = async (loopMessages: ChatTurn[], round: number): Promise<{ text: string; error: string | null }> => {
      let roundText = '';
      let roundError: string | null = null;
      let roundTruncated = false;
      const roundStartedAt = Date.now();
      const paint = (partial: string) => {
        const separator = reply && partial ? '\n\n' : '';
        setMessages((previous) => previous.map((message) => (
          message.id === modelMessage.id ? { ...message, content: `${reply}${separator}${partial}` } : message
        )));
      };
      try {
        await streamChat(
          {
            provider: byok.activeProvider,
            baseUrl: byok.baseUrl,
            model: answerModel,
            apiKey: byok.activeKey,
            messages: loopMessages,
            systemInstruction: fit.systemInstruction,
            temperature: byok.temperature,
            thinking: mode.thinking,
            signal: controller.signal,
            toolDefinitions: nativeTools
          },
          {
            onDelta: (chunk) => {
              roundText += chunk;
              paint(stripToolBlocks(roundText));
            },
            onReasoning: (chunk) => {
              setMessages((previous) => previous.map((message) => (
                message.id === modelMessage.id ? { ...message, reasoning: (message.reasoning ?? '') + chunk } : message
              )));
            },
            onToolCalls: (calls) => {
              const normalized = calls.map((call) => ({
                name: call.name,
                args: repairAndParseNativeToolArgs(call.arguments)
              }));
              const serialized = JSON.stringify(normalized).replaceAll('`', '\\u0060');
              roundText += `${roundText ? '\n\n' : ''}\`\`\`shadrox:tools\n${serialized}\n\`\`\``;
              paint(stripToolBlocks(roundText));
            },
            onDone: (info) => {
              turnUsage.tokens += info.tokens;
              turnUsage.inputTokens += info.inputTokens ?? 0;
              turnUsage.outputTokens += info.outputTokens ?? 0;
              turnUsage.cachedTokens += info.cachedInputTokens ?? 0;
              turnUsage.durationMs += info.durationMs ?? 0;
              if (turnUsage.firstTokenMs === null) turnUsage.firstTokenMs = info.firstTokenMs ?? null;
              const finish = (info.finishReason ?? '').toLowerCase();
              if (info.truncated === true || finish === 'length' || finish === 'max_tokens') {
                roundTruncated = true;
                announce('The model hit its output limit — this part of the reply is incomplete.', 6000);
              }
              if (info.droppedFeatures && info.droppedFeatures.length > 0) {
                announce(`The provider dropped unsupported request features: ${info.droppedFeatures.join(', ')}.`, 6000);
              }
              const attemptId = `${modelMessage.id}:answer:${round}`;
              recordAttempt({
                taskId: modelMessage.id,
                attemptId,
                role: 'answer',
                provider: byok.activeProvider,
                requestedModel: answerModel,
                servedModel: info.servedModel ?? null,
                state: info.incomplete || roundTruncated ? 'incomplete' : 'completed',
                usageSource: info.usageSource ?? (Number.isFinite(info.inputTokens) && Number.isFinite(info.outputTokens) ? 'provider' : 'unknown'),
                inputTokens: info.inputTokens ?? null,
                outputTokens: info.outputTokens ?? null,
                cachedInputTokens: info.cachedInputTokens ?? null,
                durationMs: info.durationMs ?? null,
                startedAt: roundStartedAt,
                reason: 'answer route'
              });
            },
            onError: (error) => { roundError = error; }
          }
        );
      } catch (error) {
        if (!controller.signal.aborted) roundError = error instanceof Error ? error.message : 'Unknown error';
      }
      const visible = stripToolBlocks(roundText);
      if (visible) reply = `${reply}${reply ? '\n\n' : ''}${visible}`;
      paint('');
      if (roundTruncated && !roundError && !controller.signal.aborted) {
        const fenceStart = roundText.lastIndexOf('```path=');
        if (fenceStart >= 0) {
          const lineEnd = roundText.indexOf('\n', fenceStart);
          const path = roundText.slice(fenceStart + '```path='.length, lineEnd < 0 ? roundText.length : lineEnd).trim();
          const body = lineEnd < 0 ? '' : roundText.slice(lineEnd + 1);
          const closed = /(?:^|\n)[ \t]*```[ \t]*\r?(?:\n|$)/.test(body);
          if (path && !closed) {
            await runRepair([`${path}: the edit block was cut off by the output limit before it was complete`]);
          }
        }
        roundError = 'The model hit its output limit mid-reply — the answer is incomplete. Press Resume to continue it.';
      }
      return { text: roundText, error: roundError };
    };

    let repairUsed = false;
    runRepair = async (failures: string[]) => {
      if (repairUsed || controller.signal.aborted || failures.length === 0) return;
      repairUsed = true;
      abortRef.current = controller;
      setIsGenerating(true);
      try {
        const paths = [...new Set(failures.map((failure) => failure.split(':')[0].trim()).filter(Boolean))];
        const answerBeforeRepair = reply;
        announce('Some edits did not land — re-reading those files and retrying once.', 5000);
        const mounted = await workspace.loadFilesForPatching(paths);
        const bodies = mounted.map((file) => {
          const truncated = file.content.length > 12_000;
          return `—— ${file.name} ——\n${truncated ? `${file.content.slice(0, 12_000)}\n[… truncated]` : file.content}`;
        }).join('\n\n');
        const ask = [
          'The change set you just wrote did not land. Reasons:',
          ...failures.map((failure) => `- ${failure}`),
          '',
          'Exact current content of the files involved:',
          bodies || '(those files could not be read — say so instead of guessing)',
          '',
          'Re-send ONLY the blocks that failed. Copy ORIGINAL line for line from the content above, including its indentation, and add enough surrounding lines that each ORIGINAL appears exactly once. Output the blocks and nothing else.'
        ].join('\n');
        const repair = await streamOnce([
          ...fit.messages,
          { role: 'assistant', content: answerBeforeRepair },
          { role: 'user', content: ask }
        ], repairRoundSeq++);
        const corrected = stripToolBlocks(repair.text);
        if (!controller.signal.aborted && corrected.trim()) {
          mergeApply(await applyPatchesFromReply(modelMessage.id, corrected, mode,
            stagedRoundPatches.staged.length > 0 ? { merge: stagedRoundPatches } : { replace: true }));
        }
      } finally {
        setIsGenerating(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    };

    let unmappedRepairUsed = false;
    runUnmappedRepair = async () => {
      if (unmappedRepairUsed || repairUsed || controller.signal.aborted) return;
      unmappedRepairUsed = true;
      abortRef.current = controller;
      setIsGenerating(true);
      try {
        const answerBeforeRepair = reply;
        announce('The edit did not name a file, so nothing was applied — retrying once with the path.', 5000);
        const correction = await streamOnce([
          ...fit.messages,
          { role: 'assistant', content: answerBeforeRepair },
          {
            role: 'user',
            content:
              'Your last reply contained SEARCH/REPLACE blocks but their fence line had no file path, so nothing was applied. ' +
              'Re-send the same change with the exact workspace-relative path in the fence info line of every block, for example ' +
              '```path=src/App.tsx followed by the ORIGINAL/UPDATED block. Output only the corrected code block(s) and nothing else.'
          }
        ], repairRoundSeq++);
        const corrected = stripToolBlocks(correction.text);
        if (!controller.signal.aborted && corrected.trim()) {
          mergeApply(await applyPatchesFromReply(modelMessage.id, corrected, mode,
            stagedRoundPatches.staged.length > 0 ? { merge: stagedRoundPatches } : { replace: true }));
        }
      } finally {
        setIsGenerating(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    };

    const applyRoundPatches = async (roundText: string) => {
      try {
        const visible = stripToolBlocks(roundText);
        if (visible.trim()) {
          mergeApply(await applyPatchesFromReply(modelMessage.id, visible, mode, {
            merge: stagedRoundPatches,
            onFailures: runRepair,
            onUnmapped: runUnmappedRepair
          }));
        }
      } catch {
        // The final pass still reports what did not land.
      } finally {
        appliedReplyChars = reply.length;
      }
    };

    try {
      const loop = await runToolRounds({
        messages: fit.messages,
        workspaceId: nativeWorkspaceId,
        maxRounds: DEFAULT_MAX_TOOL_ROUNDS,
        external: mcpToolHandleRef.current ?? undefined,
        aborted: () => controller.signal.aborted,
        policy: { mode: submission?.envelope?.permissionMode ?? permissionMode },
        signal: controller.signal,
        onAttempt: recordAttempt,
        loopContextBudgetChars: computeLoopContextBudgetChars(
          contextWindow,
          resolveBudgetCapabilities(byok.activeProvider, byok.selectedModel).maxOutput ?? DEFAULT_MAX_OUTPUT,
          fit.systemInstruction?.length ?? 0
        ),
        stream: streamOnce,
        applyRoundPatches,
        onRound: (_round, text) => {
          const asked = parseToolBlocks(text).flatMap((block) => block.calls);
          if (asked.length === 0) return;
          setMessages((previous) => previous.map((message) => (
            message.id === modelMessage.id
              ? {
                  ...message,
                  toolActivity: asked.map((call) => ({
                    name: call.name,
                    label: summarizeCall(call),
                    ok: true,
                    stage: call.name.includes('read') || call.name.includes('list') ? 'reading' : 'planning'
                  }))
                }
              : message
          )));
        },
        onPlan: (taskPlan) => {
          const allFiles = Array.from(new Set(taskPlan.flatMap((t) => t.files ?? [])));
          const needsApproval = taskPlan.length > 2 || allFiles.length > 1;
          if (needsApproval) planApprovalGateRef.current.add(modelMessage.id);
          setMessages((previous) => previous.map((message) => (
            message.id === modelMessage.id
              ? {
                  ...message,
                  taskPlan,
                  planApproval: needsApproval && !message.planApproval
                    ? {
                        status: 'pending',
                        planSummary: `Multi-step plan proposed: ${taskPlan.length} steps touching ${allFiles.length > 0 ? allFiles.join(', ') : 'workspace'}`,
                        targetFiles: allFiles
                      }
                    : message.planApproval
                }
              : message
          )));
        },
        onStatus: (status) => {
          setActiveStatusMessage(status);
          setMessages((previous) => previous.map((message) => (
            message.id === modelMessage.id ? { ...message, activeStatus: status } : message
          )));
        }
      });
      if (loop.error && !controller.signal.aborted) {
        markInterrupted(loop.error);
        turnSignals.streamError = loop.error;
      } else {
        const answer = reply || loop.text;
        turnSignals.activity = loop.activity;
        turnSignals.blocked = loop.finish?.blocked ?? null;
        turnSignals.answerEmpty = !answer.trim();
        const closedPlan = loop.plan.length > 0 && !loop.finish?.blocked
          ? loop.plan.map((task) => (
              task.status === 'pending' || task.status === 'doing'
                ? { ...task, status: 'done' as const }
                : task
            ))
          : loop.plan;
        const answerAttempts = turnAttempts.filter((attempt) => attempt.role === 'answer');
        const lastAnswerAttempt = answerAttempts[answerAttempts.length - 1];
        const usageState: 'measured' | 'estimated' | 'pending' = turnAttempts.length === 0
          ? 'pending'
          : turnAttempts.some((attempt) => attempt.usageSource === 'unknown' || attempt.inputTokens === null || attempt.outputTokens === null)
            ? 'pending'
            : turnAttempts.some((attempt) => attempt.usageSource === 'estimated')
              ? 'estimated'
              : 'measured';
        setMessages((previous) => previous.map((message) => (
          message.id === modelMessage.id
            ? {
                ...message,
                streaming: false,
                content: loop.finish?.blocked
                  ? `${answer}\n\n> Stopped early: ${loop.finish.blocked}`
                  : answer,
                toolActivity: loop.activity.length > 0 ? loop.activity : undefined,
                toolRounds: loop.rounds,
                taskPlan: closedPlan.length > 0 ? closedPlan : undefined,
                finishedWith: loop.finish ?? undefined,
                selfHealingProof: loop.failureProof
                  ? globalRepairSession.attachCheckpoint(loop.failureProof.id, machineCheckpoint) ?? loop.failureProof
                  : message.selfHealingProof,
                metrics: {
                  tokens: turnUsage.tokens,
                  inputTokens: turnUsage.inputTokens,
                  outputTokens: turnUsage.outputTokens,
                  cachedTokens: turnUsage.cachedTokens || undefined,
                  model: answerModel,
                  servedModel: lastAnswerAttempt?.servedModel ?? null,
                  usageState,
                  attempts: turnAttempts.length,
                  firstTokenMs: turnUsage.firstTokenMs,
                  durationMs: turnUsage.durationMs
                }
              }
            : message
        )));
        streamCompleted = !controller.signal.aborted && !loop.error;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Unknown error';
      turnSignals.streamError = message;
      markInterrupted(message);
    } finally {
      try { if (streamCompleted) await applyReplyPatches(); }
      finally {
        await workspace.finishMachineCheckpoint(machineCheckpoint);
        globalRepairSession.endTurn();
        if (streamCompleted && machineCheckpoint && workspaceRootPath) {
          setPendingCapsule({
            taskId: modelMessage.id,
            checkpointId: machineCheckpoint,
            promptIntent: text,
            spend: null,
            machineDeltaRef: machineCheckpoint
          });
        }
        const turnEnded = (streamCompleted || turnSignals.streamError !== null) && !controller.signal.aborted;
        if (turnEnded) {
          const repairIterations = turnAttempts.length > 1 ? turnAttempts.length - 1 : 0;
          const outcome = recordOutcome({
            ...outcomeOfTurn({
              prompt: text,
              writesFiles: mode.writesFiles,
              editAttempted: applyReport.editAttempted,
              filesWritten: applyReport.filesWritten,
              patchFailures: applyReport.patchFailures,
              verification: applyReport.verification,
              diagnostics: applyReport.diagnostics,
              testRuns: testRunsFrom(turnSignals.activity),
              blocked: turnSignals.blocked,
              streamError: turnSignals.streamError,
              answerEmpty: turnSignals.answerEmpty,
              repairIterations
            }),
            route: 'writer',
            model: answerModel,
            repairIterations,
            inputTokens: turnUsage.inputTokens,
            outputTokens: turnUsage.outputTokens,
            latencyMs: turnUsage.durationMs
          });
          setCalibratedOutcomes((previous) => [outcome, ...previous].slice(0, 500));
          if (pickerReport.ran) {
            const readerOutcome = recordOutcome({
              ...outcomeOfReader({
                shortlist: pickerReport.shortlist,
                answered: pickerReport.answered,
                picked: pickerReport.picked
              }),
              route: 'reader',
              model: pickerReport.model,
              repairIterations: 0,
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: pickerReport.durationMs
            });
            setCalibratedOutcomes((previous) => [readerOutcome, ...previous].slice(0, 500));
          }
        }
        setIsGenerating(false);
        setActiveStatusMessage(null);
        chatDispatchLockRef.current = false;
        abortRef.current = null;
      }
    }
  }, [
    input,
    isGenerating,
    refineMode,
    permissionMode,
    pendingRefine,
    attachedFiles,
    attachedImage,
    pinnedSymbols,
    messages,
    patchSets,
    autoReaderModel,
    runContextPicker,
    byok,
    workspace,
    desktopBridge,
    nativeWorkspaceId,
    workspaceRootPath,
    activeModel,
    applyPatchesFromReply,
    planApprovalGateRef,
    announce,
    buildSystemContext,
    setContextManifest,
    routingNoteRef,
    rulesNoteRef,
    mcpToolHandleRef,
    skillDocsRef,
    setInput,
    setPendingRefine,
    setAttachedFiles,
    setAttachedImage,
    setPinnedSymbols,
    setMessages,
    setCalibratedOutcomes,
    setPendingCapsule,
    setToast,
    setIsSettingsOpen,
    setSettingsTab
  ]);

  const runStore = useMemo(() => browserRunStore(), []);

  const autonomyCheckpoint = useCallback(
    (goal: string) => workspace.markCheckpoint(makeId('run'), `Run: ${goal}`, false, false, false),
    [workspace]
  );

  const askPlanText = useCallback(
    async (prompt: string): Promise<string> => {
      if (!byok.activeKey) {
        throw new Error('No API key found. Add one in Settings → Models & Keys.');
      }
      let text = '';
      let streamError: string | null = null;
      const controller = new AbortController();
      await streamChat(
        {
          provider: byok.activeProvider,
          baseUrl: byok.baseUrl,
          model: byok.selectedModel,
          apiKey: byok.activeKey,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          signal: controller.signal
        },
        {
          onDelta: (chunk) => {
            text += chunk;
          },
          onError: (message) => {
            streamError = message || 'Upstream planner stream error';
          }
        }
      ).catch((cause: unknown) => {
        if (!streamError) {
          streamError = cause instanceof Error ? cause.message : String(cause);
        }
      });
      if (streamError) throw new Error(streamError);
      if (!text.trim()) throw new Error('The planner returned an empty response.');
      return text;
    },
    [byok.activeKey, byok.activeProvider, byok.baseUrl, byok.selectedModel]
  );

  const runAutonomousTurn = useCallback(
    async (request: TurnRequest): Promise<TurnResult> => {
      if (!byok.activeKey) {
        throw new Error('No API key found. Add one in Settings → Models & Keys.');
      }
      const mode = getRefineMode('code');
      const instruction = request.feedbackText
        ? `${request.milestone.instruction}\n\n${request.feedbackText}`
        : request.milestone.instruction;

      const contextWindow =
        activeModel?.contextWindow || resolveContextWindow(byok.activeProvider, byok.selectedModel);
      const milestoneCategory = inferMilestoneCategory(request.milestone);
      const isReadOnlyMilestone = milestoneCategory === 'read_only' || milestoneCategory === 'checkpoint';
      const baseToolContext = getToolContext ? await getToolContext() : undefined;
      const toolContext = baseToolContext
        ? {
            ...baseToolContext,
            ...(isReadOnlyMilestone ? { isReadOnlyTurn: true, hasMutatedFiles: false, touchedFiles: [] as string[] } : {})
          }
        : undefined;
      const nativeTools = nativeToolDefinitions(Boolean(nativeWorkspaceId), toolContext);
      const system = await buildSystemContext(instruction, mode, undefined, { toolContext });
      const fit = fitChatRequest({
        contextWindow,
        messages: [{ role: 'user', content: instruction }],
        system,
        maxOutput: resolveBudgetCapabilities(byok.activeProvider, byok.selectedModel).maxOutput ?? DEFAULT_MAX_OUTPUT,
        extraInputChars: JSON.stringify(nativeTools).length + 2048
      });
      const runPolicy = { mode: permissionMode };
      const runId = makeId('run');
      const requireFileMutation = milestoneCategory === 'file_mutation' && request.milestone.expectedFiles.length > 0;
      const machineCheckpoint = await workspace.markCheckpoint(runId, instruction);
      try {
        const outcome = await runAgentTurn({
          instruction,
          expectedFiles: request.milestone.expectedFiles,
          applyPolicy: request.applyPolicy,
          checkpointBacked: true,
          requireFileMutation,
          signal: request.signal,
          systemInstruction: fit.systemInstruction,
          maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
          policy: runPolicy,
          loopContextBudgetChars: computeLoopContextBudgetChars(
            contextWindow,
            resolveBudgetCapabilities(byok.activeProvider, byok.selectedModel).maxOutput ?? DEFAULT_MAX_OUTPUT,
            fit.systemInstruction?.length ?? 0
          ),
          ports: {
            workspaceId: nativeWorkspaceId,
            external: mcpToolHandleRef.current ?? undefined,
            buildMessages: () => fit.messages,
            runToolRounds,
            extractPatches: (text) => extractUnifiedPatches(text, workspace.files),
            readFile: async (path) => {
              const canonical = normalizeSlashes(path).toLowerCase();
              const isDirty = workspace.dirtyFiles.some((name) => normalizeSlashes(name).toLowerCase() === canonical);
              const buffered = workspace.files.find((file) => normalizeSlashes(file.name).toLowerCase() === canonical);
              if (isDirty && buffered) return buffered.content;
              if (desktop && nativeWorkspaceId) {
                try {
                  return (await desktop.readFile(nativeWorkspaceId, path)).content;
                } catch {
                  return null;
                }
              }
              return buffered ? buffered.content : null;
            },
            writePatches: async (patches) => {
              const review: ReviewPatch[] = patches.map((patch) => ({
                path: patch.path,
                kind: patch.kind,
                blocks: patch.kind === 'searchReplace' ? patch.blocks : undefined,
                content: patch.kind === 'rewrite' ? patch.content : undefined,
                status: 'pending'
              }));
              return applyReviewSet(makeId('run'), review, { allowDestructive: true });
            },
            stream: async (loopMessages) => {
              let text = '';
              let error: string | null = null;
              try {
                const attemptResult = await withCoordinatorBackoff(
                  async () => {
                    let roundText = '';
                    let streamErr: string | null = null;
                    await streamChat({
                      provider: byok.activeProvider,
                      baseUrl: byok.baseUrl,
                      model: byok.selectedModel,
                      apiKey: byok.activeKey,
                      messages: loopMessages,
                      systemInstruction: fit.systemInstruction,
                      temperature: byok.temperature,
                      thinking: mode.thinking,
                      signal: request.signal,
                      toolDefinitions: nativeTools
                    }, {
                      onDelta: (chunk) => { roundText += chunk; },
                      onToolCalls: (calls) => {
                        const normalized = calls.map((call) => ({
                          name: call.name,
                          args: repairAndParseNativeToolArgs(call.arguments)
                        }));
                        const serialized = JSON.stringify(normalized).replaceAll('`', '\\u0060');
                        roundText += `${roundText ? '\n\n' : ''}\`\`\`shadrox:tools\n${serialized}\n\`\`\``;
                      },
                      onError: (message) => { streamErr = message; }
                    });
                    if (streamErr) {
                      if (isRetryableCoordinatorError(streamErr)) {
                        throw new Error(streamErr);
                      }
                      return { text: roundText, error: streamErr };
                    }
                    return { text: roundText, error: null };
                  },
                  { signal: request.signal }
                );
                text = attemptResult.text;
                error = attemptResult.error;
              } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause);
              }
              return { text, error };
            }
          }
        });
        const touchedFiles = dedupePaths([...outcome.applied, ...(outcome.toolChangedPaths ?? [])]);
        betaLogger.record({
          level: outcome.error ? 'error' : 'info',
          source: 'autonomy',
          event: outcome.error ? 'turn_error' : 'turn_complete',
          message: outcome.error
            ? `Autonomous turn failed: ${outcome.error}`
            : `Autonomous turn completed (${touchedFiles.length} file(s) touched).`,
          meta: {
            touchedCount: touchedFiles.length,
            toolEventCount: outcome.toolEvents?.length ?? 0,
            aborted: outcome.aborted
          }
        });
        return {
          reply: outcome.reply,
          patchesApplied: touchedFiles.length,
          patchFailures: outcome.error ? [...outcome.patchFailures, outcome.error] : outcome.patchFailures,
          aborted: outcome.aborted || Boolean(outcome.error),
          stopped: outcome.stopped,
          filesRead: outcome.filesRead,
          touchedFiles,
          pendingReview: outcome.pendingReview,
          changedFiles: outcome.changedFiles,
          failureProof: outcome.failureProof,
          toolEvents: outcome.toolEvents,
          toolCalls: executedToolCallCount(outcome.toolActivity)
        };
      } finally { await workspace.finishMachineCheckpoint(machineCheckpoint); }
    },
    [
      byok.activeKey,
      byok.activeProvider,
      byok.baseUrl,
      byok.selectedModel,
      byok.temperature,
      permissionMode,
      activeModel,
      buildSystemContext,
      getToolContext,
      mcpToolHandleRef,
      workspace,
      desktop,
      nativeWorkspaceId,
      applyReviewSet
    ]
  );

  const autonomyHost = useMemo<AutonomyHost>(
    () => ({
      runTurn: runAutonomousTurn,
      getDiagnostics: async (files) => {
        if (!desktop || !nativeWorkspaceId) return null;
        const result = await desktop.diagnostics(nativeWorkspaceId, diagnosticsOverrides, files);
        return result.diagnostics;
      },
      readFile: async (path) => {
        const canonical = normalizeSlashes(path).toLowerCase();
        const isDirty = workspace.dirtyFiles.some((name) => normalizeSlashes(name).toLowerCase() === canonical);
        const buffered = workspace.files.find((file) => normalizeSlashes(file.name).toLowerCase() === canonical);
        if (isDirty && buffered) return buffered.content;
        if (desktop && nativeWorkspaceId) {
          try {
            return (await desktop.readFile(nativeWorkspaceId, path)).content;
          } catch {
            return null;
          }
        }
        return buffered ? buffered.content : null;
      },
      getExportedContracts: async (paths) => {
        if (!desktop || !nativeWorkspaceId || paths.length === 0) return null;
        return desktop.exportedContracts(nativeWorkspaceId, paths, diagnosticsOverrides);
      },
      getWorkspaceManifest,
      listFiles: () => {
        const tree = workspace.workspace?.diskFileTree;
        if (tree && tree.length > 0) return tree.map((entry) => entry.path);
        return workspace.files.map((file) => file.name);
      },
      askPlan: askPlanText,
      runCommand: async (argv: string): Promise<CommandOutcome> => {
        if (!desktop || !nativeWorkspaceId) {
          return {
            argv,
            exitCode: null,
            stdoutTail: '',
            stderrTail: '',
            timedOut: false,
            declinedReason: 'No folder is open, so no terminal is available.'
          };
        }
        const result = await desktop.runCommand(nativeWorkspaceId, argv, commandApprovalNotice(argv));
        if (result.deniedReason) {
          return {
            argv,
            exitCode: null,
            stdoutTail: result.stdout,
            stderrTail: result.stderr,
            timedOut: false,
            declinedReason: result.deniedReason
          };
        }
        return {
          argv,
          exitCode: result.exitCode,
          stdoutTail: result.stdout,
          stderrTail: result.stderr,
          timedOut: result.timedOut === true
        };
      }
    }),
    [
      runAutonomousTurn,
      askPlanText,
      desktop,
      nativeWorkspaceId,
      diagnosticsOverrides,
      getWorkspaceManifest,
      workspace.workspace?.diskFileTree,
      workspace.dirtyFiles,
      workspace.files
    ]
  );

  const autonomy = useAutonomyRun({
    host: autonomyHost,
    rootPath: workspaceRootPath,
    store: runStore,
    onCheckpoint: autonomyCheckpoint,
    onRollback: workspace.rollbackToCheckpoint,
    budget: DEFAULT_RUN_BUDGET
  });

  const team = useTeamRun({
    host: autonomyHost,
    rootPath: workspaceRootPath,
    budget: DEFAULT_TEAM_BUDGET,
    provider: byok.activeProvider,
    isFreeTier: activeModel?.tier === 'free',
    onCheckpoint: async (goal) => {
      await autonomyCheckpoint(goal);
    }
  });

  busyRef.current = isGenerating || autonomy.isRunning || team.isRunning;

  useEffect(() => {
    const tracked = trackedRunRef.current;
    if (!tracked || !workspaceRootPath) return;
    if (tracked.kind === 'autonomy' && autonomy.state && autonomy.state.goal === tracked.goal) {
      saveBackgroundSnapshot({
        workspaceRoot: workspaceRootPath,
        goal: autonomy.state.goal,
        id: autonomy.state.id,
        mode: 'autonomy',
        status: autonomy.state.status,
        startedAt: autonomy.state.startedAt,
        updatedAt: Date.now(),
        milestones: autonomy.state.milestones,
        error: autonomy.state.error
      });
      return;
    }
    if (tracked.kind === 'team' && team.state && team.state.goal === tracked.goal) {
      saveBackgroundSnapshot({
        workspaceRoot: workspaceRootPath,
        goal: team.state.goal,
        id: team.state.id,
        mode: 'team',
        status: team.state.status,
        startedAt: team.state.startedAt,
        updatedAt: Date.now(),
        tasks: team.state.tasks,
        error: team.state.error
      });
    }
  }, [autonomy.state, team.state, workspaceRootPath, saveBackgroundSnapshot]);

  const patchOrchestration = useCallback(
    (
      messageId: string,
      patch: (
        current: NonNullable<ChatMessage['orchestration']>
      ) => Partial<NonNullable<ChatMessage['orchestration']>>
    ) => {
      setMessages((previous) =>
        previous.map((message) =>
          message.id === messageId && message.orchestration
            ? { ...message, orchestration: { ...message.orchestration, ...patch(message.orchestration) } }
            : message
        )
      );
    },
    [setMessages]
  );

  useEffect(() => {
    const active = orchestrationRef.current;
    if (!active) return;
    const log = active.kind === 'autonomy' ? autonomy.log : team.log;
    if (log.length === 0) return;
    patchOrchestration(active.messageId, () => ({ progress: log.slice(-8) }));
  }, [autonomy.log, team.log, patchOrchestration]);

  useEffect(() => {
    const active = orchestrationRef.current;
    if (!active) return;

    const running = active.kind === 'autonomy' ? autonomy.isRunning : team.isRunning;
    if (running) {
      active.seenRunning = true;
      return;
    }

    const state = active.kind === 'autonomy' ? autonomy.state : team.state;
    const matches = Boolean(
      state &&
        state.goal === active.goal &&
        (active.resumed || state.startedAt >= active.startedAt - 1_000)
    );
    if (!active.seenRunning && !matches) return;

    const status: OrchestrationStatus = !matches
      ? 'failed'
      : orchestrationStatusOfRun(state!.status, running);

    let content: string;
    let detail: string;
    if (active.kind === 'autonomy') {
      const milestones = autonomy.state?.milestones ?? [];
      const metrics = selectTaskMetrics(milestones);
      const touched = milestones.filter((milestone) =>
        milestone.attempts.some((attempt) => attempt.patchesApplied > 0)
      ).length;
      const tally = metrics.tallyText;
      detail = matches
        ? `${tally}${touched ? ` · ${touched} touched files` : ''}`
        : 'The run did not start.';
      content = !matches
        ? 'The autonomous run could not start. Check the key and folder, then try again.'
        : status === 'done'
          ? `Autonomous run finished: **${tally}**.`
          : status === 'stopped'
            ? `Autonomous run stopped. **${tally}** had settled.`
            : status === 'paused'
              ? `Autonomous run paused after **${tally}**. Resume continues from the milestone it left off at.`
              : `Autonomous run failed${autonomy.state?.error ? `: ${autonomy.state.error.replace(/\.$/, '')}` : ''}.`;
    } else {
      const tasks = team.state?.tasks ?? [];
      const metrics = selectTaskMetrics(tasks);
      const tally = metrics.tallyText;
      detail = matches
        ? tally
        : 'The team did not start.';
      content = !matches
        ? 'The agent team could not start. Check the key and folder, then try again.'
        : status === 'done'
          ? `Agent team finished: **${tally}**.`
          : status === 'stopped'
            ? `Agent team stopped. **${tally}** had settled.`
            : status === 'paused'
              ? `Agent team paused after **${tally}**. A team plans once, so continuing means starting the goal again.`
              : `Agent team failed${team.state?.error ? `: ${team.state.error.replace(/\.$/, '')}` : ''}.`;
    }

    setMessages((previous) =>
      previous.map((message) =>
        message.id === active.messageId && message.orchestration
          ? {
              ...message,
              streaming: false,
              content,
              orchestration: {
                ...message.orchestration,
                status,
                detail,
                summaryReport: active.kind === 'team' ? team.state?.summaryReport : undefined
              }
            }
          : message
      )
    );
    orchestrationRef.current = null;
    setIsGenerating(false);
    chatDispatchLockRef.current = false;
  }, [
    autonomy.isRunning,
    autonomy.state,
    team.isRunning,
    team.state,
    patchOrchestration,
    setMessages
  ]);

  const handleChatSend = useCallback((queuedSubmission?: QueuedChatDraft, pastedTextsOverride?: PastedText[]) => {
    const draftPastes = queuedSubmission?.pastedTexts ?? pastedTextsOverride ?? [];
    const draftText = (queuedSubmission?.text ?? input).trim()
      || (draftPastes.length > 0 ? 'Use the pasted text.' : '');
    if (!draftText) return;
    const modelText = draftPastes.length === 0
      ? draftText
      : `${draftText}\n\n${draftPastes
        .map((paste) => `<pasted-text name="${paste.name}">\n${paste.content}\n</pasted-text>`)
        .join('\n\n')}`;
    const draftFiles = [...(queuedSubmission?.attachedFiles ?? attachedFiles)];
    const draftImage = queuedSubmission?.attachedImage ?? attachedImage;
    const draftSymbols = [...(queuedSubmission?.pinnedSymbols ?? pinnedSymbols)];
    const draftRefineMode = queuedSubmission?.refineMode ?? refineMode;
    const draftPendingRefine = queuedSubmission
      ? queuedSubmission.pendingRefine
      : pendingRefine ? { ...pendingRefine } : null;
    const submissionId = queuedSubmission?.id ?? makeId('queued-chat');
    const submission: QueuedChatDraft = {
      id: submissionId,
      text: draftText,
      attachedFiles: draftFiles,
      attachedImage: draftImage,
      pastedTexts: draftPastes,
      pinnedSymbols: draftSymbols,
      pendingRefine: draftPendingRefine,
      refineMode: draftRefineMode,
      envelope: queuedSubmission?.envelope ?? createRequestEnvelope({
        id: submissionId,
        workspaceId: nativeWorkspaceId,
        prompt: draftText,
        targets: [
          ...draftFiles,
          ...draftSymbols.map((symbol) => `${symbol.name} (${symbol.file})`)
        ],
        permissionMode,
        refineMode: draftRefineMode,
        provider: byok.activeProvider,
        model: byok.selectedModel
      })
    };
    const text = submission.text;
    const frozen = submission;

    const busy = chatDispatchLockRef.current
      || isGenerating
      || autonomy.isRunning
      || team.isRunning
      || Boolean(orchestrationRef.current);
    if (busy) {
      const result = enqueueChatItem(queuedChatItemsRef.current, frozen);
      if (!result.accepted) {
        setToast(`Queue is full (${MAX_QUEUED_CHAT_MESSAGES} messages). Cancel one queued message before adding another.`);
        return;
      }
      queuedChatItemsRef.current = result.queue;
      setQueuedChatItems(result.queue);
      setInput('');
      setPendingRefine(null);
      setAttachedFiles([]);
      setAttachedImage(null);
      setPinnedSymbols([]);
      return;
    }

    const decision = decideOrchestration({
      prompt: modelText,
      mode: submission.refineMode,
      workspaceFileCount: workspace.workspace?.diskFileTree?.length ?? workspace.files.length,
      hasKey: Boolean(byok.activeKey),
      canRun: Boolean(desktop && nativeWorkspaceId && workspaceRootPath),
      busy: autonomy.isRunning || team.isRunning
    });

    chatDispatchLockRef.current = true;
    if (!chatHookGuardRef.current && desktop && nativeWorkspaceId && (byok.activeKey)) {
      dispatchPluginActionRuns(selectHooks(pluginsRef.current, 'onChatSend'));
    }

    if (decision.kind === 'chat') {
      void handleSend(modelText, undefined, frozen).finally(() => {
        chatDispatchLockRef.current = false;
      }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        setToast(`Message could not start: ${reason}`);
        window.setTimeout(() => setToast(null), 5000);
      });
      return;
    }

    const timestamp = formatTime();
    const kind = decision.kind;
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: text,
      timestamp,
      refinedMeta: submission.pendingRefine
        ? { ...submission.pendingRefine, mode: submission.refineMode }
        : undefined,
      envelope: submission.envelope,
      attachments:
        submission.attachedFiles.length > 0
        || submission.pastedTexts.length > 0
        || submission.pinnedSymbols.length > 0
          ? [
              ...submission.attachedFiles,
              ...submission.pastedTexts.map((paste) => `${paste.name} · pasted text`),
              ...submission.pinnedSymbols.map((symbol) => `${symbol.name} (${symbol.file})`)
            ]
          : undefined
    };
    const modelMessage: ChatMessage = {
      id: makeId('model'),
      role: 'model',
      content: '',
      timestamp,
      streaming: true,
      orchestration: {
        kind,
        status: 'planning',
        reason: decision.reason,
        progress: []
      }
    };

    setMessages((previous) => [
      ...previous.map((message) =>
        message.orchestration?.status === 'paused'
          ? {
              ...message,
              orchestration: {
                ...message.orchestration,
                status: 'stopped' as const,
                detail: 'Not resumable: a newer run replaced it.'
              }
            }
          : message
      ),
      userMessage,
      modelMessage
    ]);
    setInput('');
    setPendingRefine(null);
    setAttachedFiles([]);
    setPinnedSymbols([]);
    setIsGenerating(true);
    orchestrationRef.current = {
      messageId: modelMessage.id,
      goal: modelText,
      startedAt: Date.now(),
      kind,
      seenRunning: false
    };
    trackedRunRef.current = { kind, goal: modelText };

    if (kind === 'team') team.start(modelText);
    else autonomy.start(modelText);
  }, [
    input,
    isGenerating,
    refineMode,
    permissionMode,
    workspace.workspace?.diskFileTree?.length,
    workspace.files.length,
    byok.activeKey,
    byok.activeProvider,
    byok.selectedModel,
    desktop,
    nativeWorkspaceId,
    workspaceRootPath,
    autonomy,
    team,
    handleSend,
    pendingRefine,
    attachedFiles,
    attachedImage,
    pinnedSymbols,
    dispatchPluginActionRuns,
    pluginsRef,
    chatHookGuardRef,
    setMessages,
    setInput,
    setPendingRefine,
    setAttachedFiles,
    setAttachedImage,
    setPinnedSymbols,
    setToast
  ]);

  const handleCancelQueuedChat = useCallback((id: string) => {
    const queue = removeQueuedChatItem(queuedChatItemsRef.current, id);
    queuedChatItemsRef.current = queue;
    setQueuedChatItems(queue);
  }, []);

  useEffect(() => {
    if (
      isGenerating
      || autonomy.isRunning
      || team.isRunning
      || chatDispatchLockRef.current
      || orchestrationRef.current
    ) return;
    const result = dequeueChatItem(queuedChatItemsRef.current);
    if (!result.item) return;
    queuedChatItemsRef.current = result.queue;
    setQueuedChatItems(result.queue);
    const frozen = result.item.envelope;
    const current = createRequestEnvelope({
      id: frozen.id,
      workspaceId: nativeWorkspaceId,
      prompt: frozen.prompt,
      targets: frozen.targets,
      permissionMode,
      refineMode: result.item.refineMode,
      provider: byok.activeProvider,
      model: byok.selectedModel
    });
    const drift = envelopeDrift(frozen, current);
    if (drift.includes('workspace')) {
      setToast(`A queued request was written for a different workspace, so it was not sent. Re-send it here to run it (${describeEnvelopeDrift(drift)}).`);
      window.setTimeout(() => setToast(null), 6000);
      return;
    }
    const moved = drift.filter((entry) => entry !== 'workspace');
    if (moved.length > 0) {
      setToast(`Your queued request ran with the settings it was sent with — ${describeEnvelopeDrift(moved)} since then.`);
      window.setTimeout(() => setToast(null), 6000);
    }
    handleChatSend(result.item);
  }, [isGenerating, autonomy.isRunning, team.isRunning, queuedChatItems, handleChatSend, nativeWorkspaceId, permissionMode, byok.activeProvider, byok.selectedModel, setToast]);

  const handleResumeBackgroundRun = useCallback(() => {
    const snapshot = resumeSnapshot;
    if (!snapshot) return;
    if (isGenerating || autonomy.isRunning || team.isRunning) return;
    if (!desktop || !nativeWorkspaceId || !workspaceRootPath) return;
    if (!byok.activeKey) {
      openSettings('CHAT');
      return;
    }
    if (!canResumeBackgroundRun(snapshot, workspaceRootPath).ok) {
      snapshotStore.remove(snapshot.runId);
      setResumeSnapshot(null);
      return;
    }

    snapshotStore.remove(snapshot.runId);
    setResumeSnapshot(null);
    const modelMessage: ChatMessage = {
      id: makeId('model'),
      role: 'model',
      content: '',
      timestamp: formatTime(),
      streaming: true,
      orchestration: {
        kind: 'autonomy',
        status: 'planning',
        reason: 'Resuming the run that the previous app session left paused.',
        progress: []
      }
    };
    setMessages((previous) => [...previous, modelMessage]);
    setIsGenerating(true);
    orchestrationRef.current = {
      messageId: modelMessage.id,
      goal: snapshot.goal,
      startedAt: Date.now(),
      kind: 'autonomy',
      seenRunning: false,
      resumed: true
    };
    trackedRunRef.current = { kind: 'autonomy', goal: snapshot.goal };
    if (autonomy.state && autonomy.state.goal === snapshot.goal && autonomy.state.milestones.length > 0) {
      autonomy.resume();
    } else {
      autonomy.start(snapshot.goal);
    }
  }, [
    resumeSnapshot,
    isGenerating,
    autonomy,
    team,
    desktop,
    nativeWorkspaceId,
    workspaceRootPath,
    byok.activeKey,
    openSettings,
    snapshotStore,
    setMessages
  ]);

  const handleDismissBackgroundResume = useCallback(() => {
    if (resumeSnapshot) snapshotStore.remove(resumeSnapshot.runId);
    setResumeSnapshot(null);
  }, [resumeSnapshot, snapshotStore]);

  useEffect(() => {
    if (isGenerating || autonomy.isRunning || team.isRunning) return;
    if (pendingPromptQueueRef.current.length === 0) return;
    if (!byok.activeKey) {
      pendingPromptQueueRef.current = [];
      return;
    }
    const next = pendingPromptQueueRef.current.shift();
    if (!next) return;
    chatHookGuardRef.current = true;
    void handleSend(next).finally(() => {
      chatHookGuardRef.current = false;
    });
  }, [isGenerating, autonomy.isRunning, team.isRunning, byok.activeKey, handleSend, pendingPromptQueueRef, chatHookGuardRef]);

  const fixTypeErrors = useCallback(
    (messageId: string) => {
      const diagnostics = typeFixOffers[messageId];
      if (!diagnostics?.length) return;
      const prompt = buildTypeFixPrompt({
        files: workspace.files.map((file) => ({ name: file.name, content: file.content })),
        diagnostics
      });
      if (!prompt) return;
      setTypeFixOffers((previous) => {
        const next = { ...previous };
        delete next[messageId];
        return next;
      });
      void handleSend(`${prompt.system}\n\n${prompt.user}`);
    },
    [typeFixOffers, workspace.files, handleSend, setTypeFixOffers]
  );

  const handleClearChat = useCallback(() => {
    const active = orchestrationRef.current;
    if (active) {
      if (active.kind === 'autonomy') autonomy.stop();
      else team.stop();
      orchestrationRef.current = null;
      chatDispatchLockRef.current = false;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    if (isGenerating) setIsGenerating(false);
    queuedChatItemsRef.current = [];
    setQueuedChatItems([]);
    setMessages([]);
    setPatchSets([]);
    setResumePrefixes({});
    setPendingRefine(null);
    setAttachedFiles([]);
    setPinnedSymbols([]);
    if (restoreWorkspaceId) clearConversation(historyStore, restoreWorkspaceId);
    setToast('Started a new chat.');
    window.setTimeout(() => setToast(null), 2500);
  }, [
    autonomy,
    team,
    historyStore,
    isGenerating,
    restoreWorkspaceId,
    setMessages,
    setPatchSets,
    setPendingRefine,
    setAttachedFiles,
    setPinnedSymbols,
    setToast
  ]);

  const handleRegenerate = useCallback(() => {
    if (isGenerating) return;
    let lastModelIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'model') {
        lastModelIndex = index;
        break;
      }
    }
    if (lastModelIndex <= 0) return;

    let lastUserIndex = -1;
    for (let index = lastModelIndex - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex < 0) return;

    const lastUser = messages[lastUserIndex];
    const frozen = lastUser.envelope;
    if (frozen) {
      const current = createRequestEnvelope({
        id: frozen.id,
        workspaceId: nativeWorkspaceId,
        prompt: frozen.prompt,
        targets: frozen.targets,
        permissionMode,
        refineMode: frozen.refineMode,
        provider: byok.activeProvider,
        model: byok.selectedModel
      });
      const check = retryCheck(frozen, current);
      const blocking = check.drift.filter((entry) => entry === 'workspace');
      if (blocking.length > 0) {
        setToast(`Regenerate would rebind this request (${describeEnvelopeDrift(blocking)}). Send it again as a new request instead.`);
        window.setTimeout(() => setToast(null), 6000);
        return;
      }
      if (check.drift.length > 0) {
        setToast(`Regenerating with your current settings — ${describeEnvelopeDrift(check.drift)} since the original request.`);
        window.setTimeout(() => setToast(null), 6000);
      }
    }
    const baseMessages = messages.slice(0, lastUserIndex);
    const history: ChatTurn[] = baseMessages
      .filter((message) => !message.streaming && message.content.trim())
      .map((message) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content
      }));

    setMessages(baseMessages);
    setPendingRefine(null);
    void handleSend(lastUser.content, history);
  }, [handleSend, isGenerating, messages, nativeWorkspaceId, permissionMode, byok.activeProvider, byok.selectedModel, setMessages, setPendingRefine, setToast]);

  const handleResume = useCallback(
    async (messageId: string) => {
      if (isGenerating) return;
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return;
      const target = messages[index];
      const prefix = (resumePrefixes[messageId] || target.content || '').trim();
      if (!prefix) return;

      const origin = messages.slice(0, index).reverse().find((message) => message.role === 'user');
      const frozenResume = origin?.envelope;
      if (frozenResume) {
        const now = createRequestEnvelope({
          id: frozenResume.id,
          workspaceId: nativeWorkspaceId,
          prompt: frozenResume.prompt,
          targets: frozenResume.targets,
          permissionMode,
          refineMode,
          provider: byok.activeProvider,
          model: byok.selectedModel
        });
        const resumeCheck = retryCheck(frozenResume, now);
        const blockingResume = resumeCheck.drift.filter((entry) => entry === 'workspace');
        if (blockingResume.length > 0) {
          setToast(`Resume would rebind this request (${describeEnvelopeDrift(blockingResume)}). Send it again as a new request instead.`);
          window.setTimeout(() => setToast(null), 6000);
          return;
        }
        if (resumeCheck.drift.length > 0) {
          setToast(`Resuming with your current settings — ${describeEnvelopeDrift(resumeCheck.drift)} since the original request.`);
          window.setTimeout(() => setToast(null), 6000);
        }
      }

      const mode = getRefineMode(refineMode);
      const history: ChatTurn[] = messages
        .slice(0, index)
        .filter((message) => !message.streaming && message.content.trim())
        .map((message) => ({
          role: message.role === 'user' ? 'user' : 'assistant',
          content: message.content
        }));

      const contextWindow =
        activeModel?.contextWindow || resolveContextWindow(byok.activeProvider, byok.selectedModel);
      const lastPrompt = [...history].reverse().find((turn) => turn.role === 'user')?.content ?? '';
      const fit = fitChatRequest({
        contextWindow,
        messages: history,
        system: await buildSystemContext(lastPrompt, mode),
        maxOutput: resolveBudgetCapabilities(byok.activeProvider, byok.selectedModel).maxOutput ?? DEFAULT_MAX_OUTPUT
      });
      setContextNotice(contextFitNotice(fit, byok.selectedModel));

      setMessages((previous) =>
        previous.map((message) =>
          message.id === messageId ? { ...message, streaming: true, resumable: false } : message
        )
      );
      setIsGenerating(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let fullReply = prefix;
      let streamCompleted = false;

      try {
        await streamChat(
          {
            provider: byok.activeProvider,
            baseUrl: byok.baseUrl,
            model: byok.selectedModel,
            apiKey: byok.activeKey,
            messages: fit.messages,
            systemInstruction: fit.systemInstruction,
            temperature: byok.temperature,
            thinking: mode.thinking,
            signal: controller.signal,
            resumePrefix: prefix
          },
          {
            onDelta: (chunk) => {
              if (!chunk) return;
              fullReply += chunk;
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === messageId ? { ...message, content: message.content + chunk } : message
                )
              );
            },
            onDone: (info) => {
              streamCompleted = true;
              setResumePrefixes((previous) => {
                const next = { ...previous };
                delete next[messageId];
                return next;
              });
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === messageId
                    ? {
                        ...message,
                        streaming: false,
                        resumable: false,
                        metrics: {
                          tokens: info.tokens,
                          inputTokens: info.inputTokens,
                          outputTokens: info.outputTokens,
                          model: info.model,
                          servedModel: info.servedModel ?? null,
                          usageState: Number.isFinite(info.inputTokens) && Number.isFinite(info.outputTokens) ? 'measured' : 'pending',
                          attempts: 1,
                          firstTokenMs: info.firstTokenMs ?? null,
                          durationMs: info.durationMs ?? null
                        }
                      }
                    : message
                )
              );
            },
            onError: () => {
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === messageId ? { ...message, streaming: false, resumable: true } : message
                )
              );
              setResumePrefixes((previous) => ({ ...previous, [messageId]: fullReply }));
            }
          }
        );
      } catch {
        if (!controller.signal.aborted) {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === messageId ? { ...message, streaming: false, resumable: true } : message
            )
          );
        }
      } finally {
        setIsGenerating(false);
        abortRef.current = null;
        if (streamCompleted) applyPatchesFromReply(messageId, fullReply, mode);
      }
    },
    [
      isGenerating,
      messages,
      resumePrefixes,
      refineMode,
      byok.activeKey,
      byok.activeProvider,
      byok.baseUrl,
      byok.selectedModel,
      byok.temperature,
      activeModel,
      applyPatchesFromReply,
      buildSystemContext,
      nativeWorkspaceId,
      permissionMode,
      setMessages,
      setToast
    ]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    setMessages((previous) =>
      previous.map((message) => message.streaming
        ? { ...message, streaming: false, resumable: false, content: message.content || 'Generation stopped.' }
        : message)
    );
  }, [setMessages]);

  const handleStopAll = useCallback(() => {
    const active = orchestrationRef.current;
    if (active) {
      if (active.kind === 'autonomy') autonomy.stop();
      else team.stop();
      setMessages((previous) =>
        previous.map((message) =>
          message.id === active.messageId && message.orchestration
            ? {
                ...message,
                streaming: false,
                content:
                  message.content ||
                  (active.kind === 'team' ? 'Agent team stopped.' : 'Autonomous run stopped.'),
                orchestration: {
                  ...message.orchestration,
                  status: 'stopped',
                  detail: 'Stopped by you.'
                }
              }
            : message
        )
      );
      orchestrationRef.current = null;
      chatDispatchLockRef.current = false;
    }
    handleStop();
  }, [autonomy, team, handleStop, setMessages]);

  const handlePauseOrchestration = useCallback(() => {
    const active = orchestrationRef.current;
    if (!active) return;
    if (active.kind === 'autonomy') autonomy.pause();
    else team.pause();
  }, [autonomy, team]);

  const handleResumeOrchestration = useCallback((messageId: string) => {
    const paused = autonomy.state;
    if (!paused || paused.status !== 'paused' || paused.milestones.length === 0) return;
    if (isGenerating || autonomy.isRunning || team.isRunning) return;
    if (!desktop || !nativeWorkspaceId || !workspaceRootPath) {
      setToast('A paused run continues in the folder it started in.');
      window.setTimeout(() => setToast(null), 5000);
      return;
    }
    if (!byok.activeKey) {
      openSettings('CHAT');
      return;
    }

    setMessages((previous) =>
      previous.map((message) =>
        message.id === messageId && message.orchestration
          ? {
              ...message,
              streaming: true,
              content: '',
              orchestration: {
                ...message.orchestration,
                status: 'running',
                detail: 'Resuming from the milestone it paused at.'
              }
            }
          : message
      )
    );
    setIsGenerating(true);
    chatDispatchLockRef.current = true;
    orchestrationRef.current = {
      messageId,
      goal: paused.goal,
      startedAt: Date.now(),
      kind: 'autonomy',
      seenRunning: false,
      resumed: true
    };
    trackedRunRef.current = { kind: 'autonomy', goal: paused.goal };
    autonomy.resume();
  }, [
    autonomy,
    team,
    isGenerating,
    desktop,
    nativeWorkspaceId,
    workspaceRootPath,
    byok.activeKey,
    openSettings,
    setMessages,
    setToast
  ]);

  return {
    isGenerating,
    queuedChatItems,
    contextNotice,
    setContextNotice,
    activeStatusMessage,
    resumeSnapshot,
    autonomy,
    team,
    chatDispatchLockRef,
    handleSend,
    handleChatSend,
    handleCancelQueuedChat,
    handleClearChat,
    handleRegenerate,
    handleResume,
    handleStopAll,
    handlePauseOrchestration,
    handleResumeOrchestration,
    handleResumeBackgroundRun,
    handleDismissBackgroundResume,
    fixTypeErrors
  };
}
