import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthScreen } from './components/AuthScreen';
import { ChatPanel, type PinnedSymbol } from './components/ChatPanel';
import { PathPromptDialog, type PathPromptRequest } from './components/CodeEditor';
import { FeedbackPanel } from './components/FeedbackPanel';
import { JunkScannerPane } from './components/JunkScannerPane';
import { PreviewPane } from './components/PreviewPane';
import { QuickOpen } from './components/QuickOpen';
import { ScmPanel } from './components/ScmPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { Stage2Hub } from './components/Stage2Hub';
import { ActivityRail } from './components/workspace/ActivityRail';
import { EditorWorkspacePane } from './components/workspace/EditorWorkspacePane';
import { TaskInspectorDrawer } from './components/workspace/TaskInspectorDrawer';
import { WorkspaceHeader } from './components/workspace/WorkspaceHeader';
import { useAcceptance } from './hooks/useAcceptance';
import { useAuth } from './hooks/useAuth';
import { useByok } from './hooks/useByok';
import { useCapsules } from './hooks/useCapsules';
import { useContextBuilder } from './hooks/useContextBuilder';
import { useDebug } from './hooks/useDebug';
import { useDiagnostics } from './hooks/useDiagnostics';
import { useIntentGraph } from './hooks/useIntentGraph';
import { useLanguageActions } from './hooks/useLanguageActions';
import { useLocalPreviewController } from './hooks/useLocalPreviewController';
import { useOrchestrationController } from './hooks/useOrchestrationController';
import { useOutline } from './hooks/useOutline';
import { usePatchManager } from './hooks/usePatchManager';
import { usePluginAutomations } from './hooks/usePluginAutomations';
import { useRepoMapFiles } from './hooks/useRepoMap';
import { useSemanticTokens } from './hooks/useSemanticTokens';
import { useTaskGovernance } from './hooks/useTaskGovernance';
import { useWorkspace } from './hooks/useWorkspace';
import { setCodeIntelRoot } from './lib/agent/codeIntel';
import { setProjectMemoryRoot } from './lib/agent/projectMemory';
import { normalizePermissionMode, type PermissionMode } from './lib/agent/runPolicy';
import { ASK_USER_EVENT, ASK_USER_RESOLVED_EVENT, answerPendingQuestion, cancelPendingQuestion, type AskUserPrompt } from './lib/agent/subagent';
import type { AutomationDesktopApi } from './lib/appHelpers';
import { resumeSummary as backgroundResumeSummary } from './lib/autonomy/background';
import type { AcceptanceContract, BehaviorEvent } from './lib/behavior/types';
import { listOutcomes } from './lib/calibratedAuto/ledger';
import type { OutcomeRecord } from './lib/calibratedAuto/types';
import type { CapsuleSpend } from './lib/capsules/types';
import type { Command } from './lib/commands';
import { confirmAction } from './lib/confirm';
import { getDesktopBridge, type ShadRoxDesktopAPI, type UpdaterStatus } from './lib/desktop';
import { buildTsOverrides, isScriptFilePath } from './lib/diagnostics';
import type {
  ChatMessage,
  RecentEntry,
  RefineMode,
  RefinedPromptMeta,
  SecretItem,
  SettingsTab,
  Stage,
  ViewportSize
} from './lib/types';

export default function App() {
  const [activeStage, setActiveStage] = useState<Stage>('STAGE_2');

  const workspace = useWorkspace();
  const byok = useByok();
  const auth = useAuth();
  const files = workspace.files;
  const assets = workspace.assets;

  const [isPreviewOpen, setIsPreviewOpen] = useState(true);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(false);
  const [isScmPanelOpen, setIsScmPanelOpen] = useState(false);
  const [isJunkScannerOpen, setIsJunkScannerOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [diskToast, setDiskToast] = useState<string | null>(null);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isDebugPanelOpen, setIsDebugPanelOpen] = useState(false);
  const [showTaskInspector, setShowTaskInspector] = useState(false);
  const [behaviorEvents, setBehaviorEvents] = useState<BehaviorEvent[]>([]);
  const [behaviorContract, setBehaviorContract] = useState<AcceptanceContract | null>(null);
  const [calibratedOutcomes, setCalibratedOutcomes] = useState<OutcomeRecord[]>(() => listOutcomes());
  const [pendingCapsule, setPendingCapsule] = useState<{
    taskId: string;
    checkpointId: string;
    promptIntent: string;
    spend: CapsuleSpend | null;
    machineDeltaRef: string | null;
  } | null>(null);
  const [viewport, setViewport] = useState<ViewportSize>('desktop');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('CHAT');
  const [secrets, setSecrets] = useState<SecretItem[]>([]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [pinnedSymbols, setPinnedSymbols] = useState<PinnedSymbol[]>([]);
  const [pendingRefine, setPendingRefine] = useState<RefinedPromptMeta | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [updaterStatus, setUpdaterStatus] = useState<UpdaterStatus | null>(null);
  const [refineMode, setRefineMode] = useState<RefineMode>('code');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try {
      const stored = window.localStorage.getItem('shadrox.permissionMode');
      return stored === null ? 'agent' : normalizePermissionMode(stored);
    } catch {
      return 'agent';
    }
  });
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    try {
      window.localStorage.setItem('shadrox.permissionMode', mode);
    } catch {
      /* ignore */
    }
  }, []);

  const [quickOpenMode, setQuickOpenMode] = useState<'files' | 'content' | 'commands' | null>(null);
  const [askUserPrompt, setAskUserPrompt] = useState<AskUserPrompt | null>(null);
  const [newFilePathPrompt, setNewFilePathPrompt] = useState<PathPromptRequest | null>(null);

  const busyRef = useRef(false);
  const dirtyFilesRef = useRef<string[]>([]);
  dirtyFilesRef.current = [...workspace.dirtyFiles];

  const desktop = getDesktopBridge();
  const desktopBridge = desktop as (ShadRoxDesktopAPI & AutomationDesktopApi) | null;
  const nativeWorkspaceId = workspace.workspace?.nativeWorkspaceId ?? null;
  const activeFilePath = workspace.activeFile?.name ?? null;
  const workspaceRootPath = workspace.workspace?.path ?? null;

  useEffect(() => {
    const unsubscribe = desktopBridge?.onUpdaterStatus?.((status) => {
      setUpdaterStatus(status);
      if (status.state === 'available') setToast(`Update ${status.version} is available.`);
      if (status.state === 'ready') setToast(`Update ${status.version} is ready. Restart ShadRox when convenient.`);
      if (status.state === 'error') setToast('Update check failed. You can continue using this build.');
    });
    return unsubscribe;
  }, [desktopBridge]);

  const debug = useDebug(desktop, nativeWorkspaceId);
  const folderTree = workspace.workspace?.kind === 'folder' ? workspace.workspace.diskFileTree ?? [] : [];
  const repoMapFiles = useRepoMapFiles(nativeWorkspaceId, folderTree);
  const terminalAvailable = Boolean(desktop && nativeWorkspaceId);

  const headerFileLabel = workspace.workspace?.kind === 'folder'
    ? `${workspace.workspace.diskFileCount ?? workspace.files.length}${workspace.workspace.diskFileCountTruncated ? '+' : ''} files`
    : `${workspace.files.length} file${workspace.files.length === 1 ? '' : 's'}`;

  const capsules = useCapsules(workspaceRootPath);
  const intentFiles = useMemo(
    () => workspace.files.map((file) => ({ path: file.name, content: file.content })),
    [workspace.files]
  );
  const intent = useIntentGraph(workspaceRootPath, intentFiles);

  const debugBreakpointsEnabled = debug.config.configurations.length > 0;
  const debugPausedAt = useMemo(() => {
    const frame = debug.selectedFrame;
    if (debug.state.status !== 'stopped' || !frame?.file) return null;
    return { file: frame.file, line: frame.line ?? 1, column: frame.column };
  }, [debug.state.status, debug.selectedFrame]);

  const diagnosticsEnabled = Boolean(desktop && nativeWorkspaceId && workspace.workspace?.kind === 'folder');
  const diagnosticsOverrides = useMemo(
    () => buildTsOverrides(workspace.files, workspace.dirtyFiles),
    [workspace.files, workspace.dirtyFiles]
  );
  const diagnostics = useDiagnostics({
    enabled: diagnosticsEnabled,
    workspaceId: nativeWorkspaceId,
    rootPath: workspaceRootPath,
    overrides: diagnosticsOverrides,
    activeFilePath
  });
  const activeDiagnostics = useMemo(
    () => (activeFilePath ? diagnostics.forFile(activeFilePath) : []),
    [activeFilePath, diagnostics.forFile, diagnostics.byFile]
  );
  const outlineEnabled = diagnosticsEnabled && isScriptFilePath(activeFilePath);
  const outline = useOutline({
    enabled: outlineEnabled,
    workspaceId: nativeWorkspaceId,
    filePath: activeFilePath,
    overrides: diagnosticsOverrides
  });
  const activeSemanticTokens = useSemanticTokens({
    enabled: outlineEnabled,
    workspaceId: nativeWorkspaceId,
    filePath: activeFilePath,
    overrides: diagnosticsOverrides
  });

  const announce = useCallback((message: string, ms = 4500) => {
    setToast(message);
    window.setTimeout(() => setToast(null), ms);
  }, []);

  const openSettings = useCallback((tab: SettingsTab = 'CHAT') => {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }, []);

  const activeModel = useMemo(
    () => byok.models.find((model) => model.id === byok.selectedModel) ?? null,
    [byok.models, byok.selectedModel]
  );

  const pluginAutomations = usePluginAutomations({
    desktop,
    desktopBridge,
    nativeWorkspaceId,
    workspaceRootPath,
    activeKey: byok.activeKey,
    busyRef
  });

  const saveFilesAtomicWithHooks = useCallback(
    async (names: string[]) => {
      const outcome = await workspace.saveFilesAtomic(names);
      if (!outcome.failed && outcome.written > 0) pluginAutomations.handleFilesSaved(names);
      return outcome;
    },
    [workspace.saveFilesAtomic, pluginAutomations.handleFilesSaved]
  );

  const saveAllFiles = useCallback(async () => {
    const names = [...dirtyFilesRef.current];
    if (names.length > 0) {
      const outcome = await saveFilesAtomicWithHooks(names);
      if (outcome.failed) {
        announce(`Save failed — ${outcome.message ?? 'the disk write did not complete.'} Press Ctrl+S to try again.`, 7000);
      }
    }
    diagnostics.refresh();
  }, [announce, saveFilesAtomicWithHooks, diagnostics.refresh]);

  const localPreview = useLocalPreviewController({
    desktop,
    desktopBridge,
    nativeWorkspaceId,
    workspaceKind: workspace.workspace?.kind,
    files,
    activeFile: workspace.activeFile,
    assets,
    secrets,
    changeRevision: workspace.changeRevision,
    isPreviewOpen,
    setIsPreviewOpen,
    isPreviewFullscreen,
    setIsPreviewFullscreen
  });

  const acceptance = useAcceptance({
    bridge: desktop,
    workspaceId: nativeWorkspaceId,
    previewReady: localPreview.localRuntime.status === 'ready',
    contract: behaviorContract,
    setContract: setBehaviorContract
  });

  const contextBuilder = useContextBuilder({
    desktop,
    nativeWorkspaceId,
    workspace,
    byok,
    activeModel,
    attachedFiles,
    pinnedSymbols,
    secrets,
    previewDiagnostics: localPreview.previewDiagnostics,
    calibratedOutcomes,
    repoMapFiles,
    intentGetContext: intent.getContext,
    ruleDocsRef: pluginAutomations.ruleDocsRef,
    skillDocsRef: pluginAutomations.skillDocsRef
  });

  const languageActions = useLanguageActions({
    desktop,
    nativeWorkspaceId,
    workspace,
    activeFilePath,
    outlineEnabled,
    diagnosticsOverrides,
    saveFilesAtomicWithHooks,
    byok,
    setIsPreviewFullscreen,
    setIsPreviewOpen,
    setQuickOpenMode
  });

  const patchManager = usePatchManager({
    desktop,
    nativeWorkspaceId,
    workspace,
    previewStatus: localPreview.localRuntime.status,
    permissionMode,
    acceptance,
    saveFilesAtomicWithHooks,
    setMessages,
    setToast,
    announce
  });

  const orchestration = useOrchestrationController({
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
    patchSets: patchManager.patchSets,
    setPatchSets: patchManager.setPatchSets,
    applyPatchesFromReply: patchManager.applyPatchesFromReply,
    applyReviewSet: patchManager.applyReviewSet,
    planApprovalGateRef: patchManager.planApprovalGateRef,
    typeFixOffers: patchManager.typeFixOffers,
    setTypeFixOffers: patchManager.setTypeFixOffers,
    autoReaderModel: contextBuilder.autoReaderModel,
    runContextPicker: contextBuilder.runContextPicker,
    getWorkspaceManifest: contextBuilder.getWorkspaceManifest,
    buildSystemContext: contextBuilder.buildSystemContext,
    setContextManifest: contextBuilder.setContextManifest,
    routingNoteRef: contextBuilder.routingNoteRef,
    rulesNoteRef: contextBuilder.rulesNoteRef,
    mcpToolHandleRef: contextBuilder.mcpToolHandleRef,
    pluginsRef: pluginAutomations.pluginsRef,
    skillDocsRef: pluginAutomations.skillDocsRef,
    pendingPromptQueueRef: pluginAutomations.pendingPromptQueueRef,
    chatHookGuardRef: pluginAutomations.chatHookGuardRef,
    dispatchPluginActionRuns: pluginAutomations.dispatchPluginActionRuns,
    busyRef,
    setCalibratedOutcomes,
    setPendingCapsule,
    setToast,
    announce,
    openSettings,
    setIsSettingsOpen,
    setSettingsTab
  });

  const governance = useTaskGovernance({
    desktop,
    nativeWorkspaceId,
    workspaceRootPath,
    workspace,
    capsules,
    intent,
    acceptance,
    byok,
    saveFilesAtomicWithHooks,
    isGenerating: orchestration.isGenerating,
    chatDispatchLockRef: orchestration.chatDispatchLockRef,
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
  });

  useEffect(() => {
    setIsTerminalOpen(false);
    setIsPreviewFullscreen(false);
    setIsPreviewOpen(true);
    setIsSearchPanelOpen(false);
  }, [nativeWorkspaceId]);

  useEffect(() => {
    const onAsk = (event: Event) => {
      const prompt = (event as CustomEvent<AskUserPrompt>).detail;
      if (prompt && typeof prompt.id === 'string' && Array.isArray(prompt.options)) setAskUserPrompt(prompt);
    };
    const onResolved = () => setAskUserPrompt(null);
    window.addEventListener(ASK_USER_EVENT, onAsk);
    window.addEventListener(ASK_USER_RESOLVED_EVENT, onResolved);
    return () => {
      window.removeEventListener(ASK_USER_EVENT, onAsk);
      window.removeEventListener(ASK_USER_RESOLVED_EVENT, onResolved);
    };
  }, []);

  const handleAnswerAskUser = useCallback((id: string, answer: string | null) => {
    if (answer === null) cancelPendingQuestion(id);
    else answerPendingQuestion(id, answer);
    setAskUserPrompt(null);
  }, []);

  useEffect(() => {
    setCodeIntelRoot(workspaceRootPath);
    if (nativeWorkspaceId) setProjectMemoryRoot(nativeWorkspaceId, workspaceRootPath);
  }, [nativeWorkspaceId, workspaceRootPath]);

  useEffect(() => {
    if (!workspace.diskMessage) return;
    setDiskToast(workspace.diskMessage);
    const timer = window.setTimeout(() => setDiskToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [workspace.diskMessage]);

  useEffect(() => {
    if (workspace.workspace && activeStage === 'STAGE_2') setActiveStage('STAGE_3');
  }, [workspace.workspace, activeStage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 's') {
        if (!workspace.canWriteToDisk) return;
        event.preventDefault();
        if (workspace.dirtyFiles.length > 0 && !workspace.isSaving) void saveAllFiles();
        return;
      }
      if (key === 'p' && !event.shiftKey) {
        if (!workspace.workspace) return;
        event.preventDefault();
        setQuickOpenMode('files');
        return;
      }
      if (key === 'p' && event.shiftKey) {
        if (!workspace.workspace) return;
        event.preventDefault();
        setQuickOpenMode('commands');
        return;
      }
      if (key === 'f' && event.shiftKey) {
        if (!workspace.workspace) return;
        event.preventDefault();
        setIsPreviewFullscreen(false);
        setIsPreviewOpen(false);
        setIsSearchPanelOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace.canWriteToDisk, workspace.dirtyFiles.length, workspace.isSaving, saveAllFiles, workspace.workspace]);

  const handleBackToHub = useCallback(async () => {
    if (workspace.dirtyFiles.length > 0) {
      const proceed = await confirmAction({
        title: 'Leave this workspace?',
        body: `${workspace.dirtyFiles.length} file${workspace.dirtyFiles.length === 1 ? ' has' : 's have'} unsaved changes. Leaving discards those edits.`,
        confirmLabel: 'Leave and discard',
        tone: 'danger'
      });
      if (!proceed) return;
    }
    if (desktop && nativeWorkspaceId) void desktop.stopPreview(nativeWorkspaceId);
    workspace.closeWorkspace();
    setQuickOpenMode(null);
    languageActions.setRevealTarget(null);
    setActiveStage('STAGE_2');
  }, [desktop, nativeWorkspaceId, workspace, languageActions]);

  const hasUnsavedChanges = workspace.dirtyFiles.length > 0;

  useEffect(() => {
    const projectName = workspace.workspace?.name;
    document.title = projectName ? `${hasUnsavedChanges ? '● ' : ''}${projectName} — ShadRox` : 'ShadRox';
    if (desktop?.setDirty) void desktop.setDirty(hasUnsavedChanges).catch(() => {});
  }, [desktop, workspace.workspace?.name, hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleReopenRecent = useCallback(
    (entry: RecentEntry) => {
      void workspace.openRecent(entry);
    },
    [workspace]
  );

  const handleNewFile = useCallback(() => {
    setNewFilePathPrompt({
      title: 'New file',
      description: 'Path relative to the opened folder. Folders are created as needed.',
      initialValue: '',
      placeholder: 'src/utils/helper.ts',
      confirmLabel: 'Create file',
      onSubmit: (value) => {
        setNewFilePathPrompt(null);
        workspace.createFile(value, '// New file created in ShadRox\n');
      }
    });
  }, [workspace]);

  const commands = useMemo<Command[]>(() => {
    const entries: Command[] = [
      {
        id: 'file.quickOpen',
        title: 'Go to file…',
        category: 'Navigate',
        shortcut: 'Ctrl+P',
        keywords: 'quick open jump',
        run: () => setQuickOpenMode('files')
      },
      {
        id: 'file.searchInFiles',
        title: 'Search in files',
        category: 'Navigate',
        shortcut: 'Ctrl+Shift+F',
        keywords: 'find text workspace grep',
        run: () => {
          setIsPreviewFullscreen(false);
          setIsPreviewOpen(false);
          setIsSearchPanelOpen(true);
        }
      },
      {
        id: 'view.scm',
        title: 'Show Source Control',
        category: 'View',
        keywords: 'git changes stage commit branches',
        run: () => {
          setIsPreviewFullscreen(false);
          setIsPreviewOpen(false);
          setIsSearchPanelOpen(false);
          setIsScmPanelOpen(true);
        }
      },
      {
        id: 'view.splitEditor',
        title: 'Split Editor',
        category: 'View',
        keywords: 'editor group side by side',
        run: workspace.splitEditor
      },
      ...(workspace.editorGroups.length > 1 ? [{
        id: 'view.closeEditorGroup',
        title: 'Close Editor Group',
        category: 'View',
        keywords: 'editor split pane',
        run: () => workspace.closeEditorGroup(workspace.activeEditorGroup)
      }] : []),
      { id: 'view.code', title: 'Hide preview', category: 'View', run: () => setIsPreviewOpen(false) },
      { id: 'view.preview', title: 'Show preview', category: 'View', run: () => setIsPreviewOpen(true) },
      {
        id: 'view.terminal',
        title: 'Toggle terminal',
        category: 'View',
        keywords: 'shell console',
        run: () => setIsTerminalOpen((open) => !open)
      },
      {
        id: 'view.debug',
        title: 'Toggle debugger',
        category: 'View',
        keywords: 'debug breakpoints pause step dap',
        run: () => setIsDebugPanelOpen((open) => !open)
      },
      { id: 'chat.new', title: 'New chat', category: 'Chat', keywords: 'clear reset', run: orchestration.handleClearChat },
      {
        id: 'chat.regenerate',
        title: 'Regenerate last reply',
        category: 'Chat',
        keywords: 'retry again',
        run: orchestration.handleRegenerate
      },
      {
        id: 'workspace.settings',
        title: 'Open settings',
        category: 'Workspace',
        keywords: 'preferences provider key model',
        run: () => openSettings('CHAT')
      },
      {
        id: 'workspace.hub',
        title: 'Back to workspace hub',
        category: 'Workspace',
        keywords: 'home recents switch project',
        run: handleBackToHub
      }
    ];

    if (workspace.canWriteToDisk) {
      entries.unshift(
        {
          id: 'file.saveAll',
          title: 'Save all files',
          category: 'File',
          shortcut: 'Ctrl+S',
          keywords: 'write disk persist',
          run: () => void saveAllFiles()
        },
        { id: 'file.new', title: 'New file', category: 'File', keywords: 'create add', run: handleNewFile }
      );
    }

    if (localPreview.localPreviewAvailable) {
      entries.push({
        id: 'preview.run',
        title: 'Run preview',
        category: 'Preview',
        keywords: 'start serve launch',
        run: () => void localPreview.startLocalPreview()
      });
    }

    entries.push({
      id: 'preview.stop',
      title: 'Stop preview',
      category: 'Preview',
      keywords: 'kill halt',
      run: () => void localPreview.stopLocalPreview()
    });

    return entries;
  }, [
    workspace.canWriteToDisk,
    workspace.editorGroups.length,
    workspace.activeEditorGroup,
    workspace.splitEditor,
    workspace.closeEditorGroup,
    saveAllFiles,
    handleNewFile,
    orchestration.handleClearChat,
    orchestration.handleRegenerate,
    openSettings,
    handleBackToHub,
    localPreview.localPreviewAvailable,
    localPreview.startLocalPreview,
    localPreview.stopLocalPreview
  ]);

  const hasKey = Boolean(byok.activeKey);

  const settingsDrawer = (
    <SettingsDrawer
      isOpen={isSettingsOpen}
      activeTab={settingsTab}
      onTabChange={setSettingsTab}
      onClose={() => setIsSettingsOpen(false)}
      workspaceId={nativeWorkspaceId ?? undefined}
      workspaceRoot={workspaceRootPath ?? undefined}
      activeProvider={byok.activeProvider}
      onProviderChange={byok.changeProvider}
      baseUrl={byok.baseUrl}
      onBaseUrlChange={byok.setBaseUrl}
      extraModels={byok.extraModels}
      onExtraModelsChange={byok.setExtraModels}
      apiKeyDraft={byok.apiKeyDraft}
      onApiKeyDraftChange={byok.setApiKeyDraft}
      keyStatus={byok.keyStatus}
      onValidateKey={byok.validateKey}
      onForgetKey={byok.forgetKey}
      secrets={secrets}
      onSecretsChange={setSecrets}
      workspaceFiles={workspace.files}
      onGenerateCommitMessage={() => governance.handleGenerateCommitMessage()}
      isWritingCommitMessage={governance.isWritingCommitMessage}
    />
  );

  const searchPanel = (
    <QuickOpen
      mode="content"
      docked
      files={workspace.files}
      directoryPages={workspace.directoryPages}
      desktop={desktop}
      nativeWorkspaceId={nativeWorkspaceId}
      overrides={diagnosticsOverrides}
      onOpenFile={languageActions.handleQuickOpenFile}
      onOpenPath={(path, line, column) => void languageActions.handleOpenSearchHit(path, line, column)}
      onReplaceAll={workspace.canWriteToDisk ? languageActions.handleQuickReplaceAll : undefined}
      onClose={() => setIsSearchPanelOpen(false)}
    />
  );

  const scmPanel = (
    <ScmPanel
      desktop={desktop}
      workspaceId={nativeWorkspaceId}
      onClose={() => setIsScmPanelOpen(false)}
      onOpenFile={(path) => void languageActions.navigateToPath(path)}
      onGenerateCommitMessage={governance.handleGenerateCommitMessage}
      isWritingCommitMessage={governance.isWritingCommitMessage}
    />
  );

  const junkScannerPanel = desktop && nativeWorkspaceId ? (
    <JunkScannerPane
      desktop={desktop}
      workspaceId={nativeWorkspaceId}
      onClose={() => setIsJunkScannerOpen(false)}
    />
  ) : null;

  const previewPane = (
    <PreviewPane
      document={localPreview.previewDocument}
      capabilityMessage={localPreview.previewCapability}
      workspaceId={nativeWorkspaceId ?? undefined}
      backendEnabled={localPreview.localRuntime.status !== 'idle'}
      localPreviewAvailable={localPreview.localPreviewAvailable}
      localPreviewState={localPreview.localRuntime}
      localPreviewLogs={localPreview.localRuntimeLogs}
      previewProjects={localPreview.previewProjects}
      onChoosePreviewProject={localPreview.handleChoosePreviewProject}
      onCancelProjectSelection={localPreview.handleCancelProjectSelection}
      onStartLocalPreview={localPreview.handleStartLocalPreview}
      onStopLocalPreview={localPreview.handleStopLocalPreview}
      onClearLocalPreviewLogs={localPreview.handleClearLocalPreviewLogs}
      viewport={viewport}
      onViewportChange={setViewport}
      runtimeError={localPreview.runtimeError}
      onDismissError={localPreview.handleDismissPreviewError}
      onRuntimeError={localPreview.setRuntimeError}
      isBundling={localPreview.bundleState.status === 'loading'}
      bundleError={localPreview.bundleState.status === 'error' ? localPreview.bundleState.message : null}
      reloadKey={localPreview.previewSync.reloadKey}
      autoReload={localPreview.previewAutoReload}
      onToggleAutoReload={localPreview.togglePreviewAutoReload}
      lastReloadAt={localPreview.previewSync.lastReloadAt}
      onRevealSource={(target) => void languageActions.handleRevealSource(target)}
      onBehaviorEvent={governance.handleBehaviorEvent}
      onFramePaint={acceptance.onFramePaint}
      fullscreen={isPreviewFullscreen}
      onToggleFullscreen={localPreview.handleTogglePreviewFullscreen}
      onClose={localPreview.handleClosePreview}
    />
  );

  if (auth.status !== 'signed-in' && auth.status !== 'unconfigured') {
    return (
      <AuthScreen
        status={auth.status}
        busy={auth.busy}
        error={auth.error}
        onSignIn={() => void auth.signIn()}
      />
    );
  }

  if (activeStage === 'STAGE_2') {
    return (
      <>
        <Stage2Hub
          recents={workspace.recents}
          isBusy={workspace.isBusy}
          statusMessage={workspace.statusMessage}
          hasKey={hasKey}
          onOpenSettings={() => openSettings('CHAT')}
          onOpenFolder={workspace.openFolder}
          onOpenFiles={workspace.openFiles}
          onNewFile={() => void workspace.newFile()}
          onNewProject={(name) => void workspace.newProject(name)}
          onDroppedFiles={workspace.openDropped}
          onReopen={handleReopenRecent}
          onRemoveRecent={workspace.removeRecent}
          account={auth.user ? { email: auth.user.email, avatarUrl: auth.user.avatarUrl } : null}
          onSignOut={() => void auth.signOut()}
        />
        {settingsDrawer}
      </>
    );
  }

  return (
    <div className="w-full h-screen flex flex-col bg-base text-ink overflow-hidden border-b border-line">
      <WorkspaceHeader
        workspaceName={workspace.workspace?.name}
        workspaceKind={workspace.workspace?.kind}
        headerFileLabel={headerFileLabel}
        dirtyCount={workspace.dirtyFiles.length}
        isBusy={workspace.isBusy}
        updaterStatus={updaterStatus}
        canWriteToDisk={workspace.canWriteToDisk}
        autoSave={workspace.autoSave}
        onToggleAutoSave={() => workspace.setAutoSave(!workspace.autoSave)}
        terminalAvailable={terminalAvailable}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={() => setIsTerminalOpen((open) => !open)}
        onBackToHub={handleBackToHub}
        onOpenFeedback={() => setIsFeedbackOpen(true)}
        isSettingsOpen={isSettingsOpen}
        onToggleSettings={() => setIsSettingsOpen((open) => !open)}
      />

      {diskToast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line-2 bg-base-2/95 px-4 py-1.5 text-[11px] text-ink-2 shadow-2xl backdrop-blur-xl"
        >
          {diskToast}
        </div>
      )}

      {showTaskInspector && (
        <TaskInspectorDrawer
          workspaceRootPath={workspaceRootPath}
          capsules={capsules}
          intent={intent}
          acceptance={acceptance}
          previewReady={localPreview.localRuntime.status === 'ready'}
          behaviorEvents={behaviorEvents}
          behaviorContract={behaviorContract}
          calibratedOutcomes={calibratedOutcomes}
          calibratedProfiles={governance.calibratedProfiles}
          calibratedTaskType={governance.calibratedTaskType}
          calibratedRanking={governance.calibratedRanking}
          onClose={() => setShowTaskInspector(false)}
          onReplayCapsule={(id) => void governance.applyCapsulePlan(id, 'replay')}
          onRevertCapsule={(id) => void governance.applyCapsulePlan(id, 'revert')}
          onExportCapsules={() => void governance.handleCapsuleExport()}
          onImportCapsules={(data) => void governance.handleCapsuleImport(data)}
          onAddDecision={(decision) => void governance.handleAddDecision(decision)}
          onExportIntent={governance.handleIntentExport}
          onImportIntent={governance.handleIntentImport}
          onClearBehavior={governance.handleClearBehavior}
          onGenerateContract={governance.handleGenerateContract}
          onRunCheck={(phase) => void governance.handleRunCheck(phase)}
          onCalibratedTaskType={governance.setCalibratedTaskType}
          onPinModel={governance.pinCalibratedModel}
        />
      )}

      <div
        className="flex-1 min-h-0 flex flex-col md:grid"
        style={{ gridTemplateColumns: '48px minmax(0, 1fr) clamp(320px, 26vw, 376px)' }}
      >
        <ActivityRail
          hasDesktop={Boolean(desktop)}
          hasNativeWorkspace={Boolean(nativeWorkspaceId)}
          isPreviewOpen={isPreviewOpen}
          isSearchPanelOpen={isSearchPanelOpen}
          isJunkScannerOpen={isJunkScannerOpen}
          isScmPanelOpen={isScmPanelOpen}
          isDebugPanelOpen={isDebugPanelOpen}
          showTaskInspector={showTaskInspector}
          isAccountMenuOpen={isAccountMenuOpen}
          user={auth.user ?? null}
          onSelectWorkspaceView={() => {
            setIsPreviewFullscreen(false);
            setIsPreviewOpen(false);
            setIsSearchPanelOpen(false);
            setIsScmPanelOpen(false);
            setIsJunkScannerOpen(false);
          }}
          onSelectPreviewView={() => {
            setIsPreviewFullscreen(false);
            setIsPreviewOpen(true);
            setIsSearchPanelOpen(false);
            setIsScmPanelOpen(false);
            setIsJunkScannerOpen(false);
          }}
          onToggleSearchPanel={() => {
            setIsPreviewFullscreen(false);
            setIsPreviewOpen(false);
            setIsSearchPanelOpen((open) => !open);
            setIsScmPanelOpen(false);
            setIsJunkScannerOpen(false);
          }}
          onToggleJunkScanner={() => {
            setIsPreviewFullscreen(false);
            setIsPreviewOpen(false);
            setIsSearchPanelOpen(false);
            setIsScmPanelOpen(false);
            setIsJunkScannerOpen((open) => !open);
          }}
          onToggleScmPanel={() => {
            setIsPreviewFullscreen(false);
            setIsPreviewOpen(false);
            setIsSearchPanelOpen(false);
            setIsJunkScannerOpen(false);
            setIsScmPanelOpen((open) => !open);
          }}
          onToggleDebugPanel={() => setIsDebugPanelOpen((open) => !open)}
          onToggleTaskInspector={() => setShowTaskInspector((open) => !open)}
          onToggleAccountMenu={() => setIsAccountMenuOpen((open) => !open)}
          onCloseAccountMenu={() => setIsAccountMenuOpen(false)}
          onSignOut={() => void auth.signOut()}
        />

        <div className="order-last w-full md:w-auto md:min-w-0 h-1/2 md:h-full min-h-0 border-t border-line md:border-t-0 md:border-l">
          <ChatPanel
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSend={(pastedTexts) => orchestration.handleChatSend(undefined, pastedTexts)}
            queuedMessages={orchestration.queuedChatItems}
            onCancelQueuedMessage={orchestration.handleCancelQueuedChat}
            onStop={orchestration.handleStopAll}
            askUserPrompt={askUserPrompt}
            onAnswerAskUser={handleAnswerAskUser}
            onPauseOrchestration={orchestration.handlePauseOrchestration}
            onResumeOrchestration={orchestration.handleResumeOrchestration}
            onClearChat={orchestration.handleClearChat}
            isGenerating={orchestration.isGenerating}
            isRefining={governance.isRefining}
            refineStep={governance.refineStep}
            onRefinePrompt={governance.handleRefinePrompt}
            onUndoRefine={governance.handleUndoRefine}
            canUndoRefine={governance.canUndoRefine}
            refineMode={refineMode}
            onRefineModeChange={setRefineMode}
            permissionMode={permissionMode}
            onPermissionModeChange={handlePermissionModeChange}
            models={byok.models}
            selectedModel={byok.selectedModel}
            onSelectModel={byok.selectModel}
            hasKey={hasKey}
            onOpenSettings={openSettings}
            attachedFiles={attachedFiles}
            onAttachedFilesChange={setAttachedFiles}
            attachedImage={attachedImage}
            onAttachedImageChange={setAttachedImage}
            symbols={outline.symbols.map((symbol) => ({
              name: symbol.name,
              kind: symbol.kind,
              file: activeFilePath ?? workspace.activeFile?.name ?? '',
              line: symbol.line
            }))}
            pinnedSymbols={pinnedSymbols}
            onPinnedSymbolsChange={setPinnedSymbols}
            workspaceFiles={workspace.files}
            workspaceAllFiles={workspace.allFiles}
            skills={pluginAutomations.projectSkills}
            checkpoints={workspace.checkpoints}
            onRestoreCheckpoint={governance.handleRestoreCheckpoint}
            restoringCheckpointId={governance.restoringCheckpointId}
            activeCheckpointId={governance.activeCheckpointId}
            onShowCheckpoint={governance.setActiveCheckpointId}
            onCloseCheckpoint={() => governance.setActiveCheckpointId(null)}
            checkpointDiff={governance.checkpointDiff}
            checkpointDiffLoading={governance.checkpointDiffLoading}
            onExportDeltaReceipt={workspace.exportDeltaReceipt}
            patchSets={patchManager.patchSets}
            autoApplyChanges={patchManager.autoApplyChanges}
            onToggleAutoApply={patchManager.toggleAutoApplyChanges}
            autoContext={contextBuilder.autoContext}
            onToggleAutoContext={contextBuilder.toggleAutoContext}
            semanticRetrieval={contextBuilder.semanticRetrieval}
            semanticStatus={contextBuilder.semanticStatus}
            semanticChunkCount={contextBuilder.semanticChunkCount}
            onToggleSemanticRetrieval={contextBuilder.toggleSemanticRetrieval}
            repoMap={contextBuilder.sentRepoMap}
            repoMapLoading={repoMapFiles.loading && contextBuilder.sentRepoMap === ''}
            contextManifest={contextBuilder.contextManifest}
            onAcceptPatch={patchManager.acceptPatch}
            onRejectPatch={patchManager.rejectPatch}
            onAcceptAllPatches={patchManager.acceptAllPatches}
            onUndoPatch={patchManager.undoPatch}
            onApplyPatchHunks={patchManager.applyPatchHunks}
            typeFixCounts={Object.fromEntries(
              Object.entries(patchManager.typeFixOffers).map(([id, list]) => [id, list.length])
            )}
            onFixTypeErrors={orchestration.fixTypeErrors}
            onResume={(messageId) => void orchestration.handleResume(messageId)}
            backgroundResume={
              orchestration.resumeSnapshot
                ? {
                    summary: backgroundResumeSummary(orchestration.resumeSnapshot),
                    available: Boolean(
                      desktop &&
                        nativeWorkspaceId &&
                        workspaceRootPath &&
                        byok.activeKey &&
                        !orchestration.isGenerating &&
                        !orchestration.autonomy.isRunning &&
                        !orchestration.team.isRunning
                    ),
                    onResume: orchestration.handleResumeBackgroundRun,
                    onDismiss: orchestration.handleDismissBackgroundResume
                  }
                : null
            }
            contextNotice={orchestration.contextNotice}
            onDismissContextNotice={() => orchestration.setContextNotice(null)}
            onApprovePlan={patchManager.handleApprovePlan}
            onRejectPlan={patchManager.handleRejectPlan}
            activeStatusMessage={orchestration.activeStatusMessage}
          />
        </div>

        <EditorWorkspacePane
          isPreviewOpen={isPreviewOpen}
          isPreviewFullscreen={isPreviewFullscreen}
          previewPane={previewPane}
          workspace={workspace}
          desktop={desktop}
          nativeWorkspaceId={nativeWorkspaceId}
          conflictHunks={governance.conflictHunks}
          unmergedPaths={governance.unmergedPaths}
          onResolveConflicts={governance.resolveConflicts}
          onBackToHub={handleBackToHub}
          onNewFile={handleNewFile}
          onSaveAll={() => void saveAllFiles()}
          revealTarget={languageActions.revealTarget}
          editorAi={languageActions.editorAi}
          activeDiagnostics={activeDiagnostics}
          onDefinitionRequest={languageActions.handleDefinitionRequest}
          activeSemanticTokens={activeSemanticTokens}
          outlineEnabled={outlineEnabled}
          outline={outline}
          onSelectOutlineSymbol={languageActions.handleSelectOutlineSymbol}
          editorSymbols={languageActions.editorSymbols}
          editorQuickFixes={languageActions.editorQuickFixes}
          debug={debug}
          debugBreakpointsEnabled={debugBreakpointsEnabled}
          debugPausedAt={debugPausedAt}
          onNavigateToPath={(path, line, column) => void languageActions.navigateToPath(path, line, column)}
          sidebarPanel={isScmPanelOpen ? scmPanel : isSearchPanelOpen ? searchPanel : isJunkScannerOpen ? junkScannerPanel : undefined}
          isDebugPanelOpen={isDebugPanelOpen}
          onCloseDebugPanel={() => setIsDebugPanelOpen(false)}
          onAskAiToDebug={(summary) => setInput(summary)}
          isTerminalOpen={isTerminalOpen}
          terminalAvailable={terminalAvailable}
          onCloseTerminal={() => setIsTerminalOpen(false)}
        />
      </div>

      {isPreviewFullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-base">
          {previewPane}
        </div>
      )}

      {settingsDrawer}

      <FeedbackPanel isOpen={isFeedbackOpen} onClose={() => setIsFeedbackOpen(false)} />

      {quickOpenMode && (
        <QuickOpen
          mode={quickOpenMode}
          files={workspace.files}
          directoryPages={workspace.directoryPages}
          desktop={desktop}
          nativeWorkspaceId={nativeWorkspaceId}
          activeFilePath={activeFilePath}
          workspaceRootPath={workspaceRootPath}
          overrides={diagnosticsOverrides}
          commands={commands}
          onOpenFile={languageActions.handleQuickOpenFile}
          onOpenPath={(path, line, column) => void languageActions.handleOpenSearchHit(path, line, column)}
          onReplaceAll={workspace.canWriteToDisk ? languageActions.handleQuickReplaceAll : undefined}
          onClose={() => setQuickOpenMode(null)}
        />
      )}

      {newFilePathPrompt && (
        <PathPromptDialog request={newFilePathPrompt} onCancel={() => setNewFilePathPrompt(null)} />
      )}

      {toast && (
        <div className="fixed bottom-14 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-accent-line bg-surface/95 px-4 py-2 text-xs text-ink shadow-2xl backdrop-blur">
          {toast}
        </div>
      )}
    </div>
  );
}
