import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bug, Code2, Eye, FolderOpen, Loader2, Save, Settings } from 'lucide-react';
import { ShadRoxLogo } from './components/Logo';
import { Stage1Auth } from './components/Stage1Auth';
import { Stage2Hub } from './components/Stage2Hub';
import { CodeEditor } from './components/CodeEditor';
import { PreviewPane } from './components/PreviewPane';
import { ChatPanel } from './components/ChatPanel';
import { SettingsDrawer } from './components/SettingsDrawer';
import { useWorkspace } from './hooks/useWorkspace';
import { useByok } from './hooks/useByok';
import { getRefineMode, refinePrompt, streamChat, type ChatTurn, type RefineModeMeta } from './lib/ai';
import { bundleDocument, bundleProject, canBundle, describeBundleError } from './lib/bundler';
import { extractFilePatches } from './lib/markdown';
import { PREVIEW_BASE_STYLE, PREVIEW_ERROR_BRIDGE, previewCapabilityMessage, resolvePreviewDocument } from './lib/preview';
import { renderRetrievedContext, retrieveContext } from './lib/retrieval';
import { getPlan, getSessionToken, setPlan as persistPlan, setSessionToken } from './lib/storage';
import { getMonthlyUsage, recordMessageSent } from './lib/quota';
import type {
  ChatMessage,
  PlanTier,
  RecentEntry,
  RefineMode,
  RefinedPromptMeta,
  SecretItem,
  SettingsTab,
  Stage,
  TabType,
  ViewportSize
} from './lib/types';

/** Result of the esbuild-wasm compile that powers the live preview. */
type BundleState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; html: string; label: string }
  | { status: 'error'; message: string };

function formatTime(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function App() {
  const [activeStage, setActiveStage] = useState<Stage>(() => (getSessionToken() ? 'STAGE_2' : 'STAGE_1'));
  const [isSigningIn, setIsSigningIn] = useState(false);

  const workspace = useWorkspace();
  const byok = useByok();

  const [activeTab, setActiveTab] = useState<TabType>('CODE');
  const [viewport, setViewport] = useState<ViewportSize>('desktop');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('CHAT');
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [plan, setPlan] = useState<PlanTier>(() => getPlan());

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null);
  const [pendingRefine, setPendingRefine] = useState<RefinedPromptMeta | null>(null);
  const [isRefining, setIsRefining] = useState(false);
  const [refineStep, setRefineStep] = useState('');
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refineMode, setRefineMode] = useState<RefineMode>('code');
  const [restoringCheckpointId, setRestoringCheckpointId] = useState<string | null>(null);
  const [bundleState, setBundleState] = useState<BundleState>({ status: 'idle' });

  const abortRef = useRef<AbortController | null>(null);

  const openSettings = useCallback((tab: SettingsTab = 'CHAT') => {
    setSettingsTab(tab);
    setIsSettingsOpen(true);
  }, []);

  const changePlan = useCallback((next: PlanTier) => {
    setPlan(next);
    persistPlan(next);
  }, []);

  // Move into the workspace automatically once a folder/files are mounted.
  useEffect(() => {
    if (workspace.workspace && activeStage === 'STAGE_2') setActiveStage('STAGE_3');
  }, [workspace.workspace, activeStage]);

  // Runtime errors reported by the sandboxed preview iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; message?: string } | null;
      if (!data || data.source !== 'shadrox-preview') return;
      if (data.type === 'error' || data.type === 'console-error') {
        setRuntimeError(data.message || 'Runtime error');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const handleSignIn = useCallback(() => {
    setIsSigningIn(true);
    window.setTimeout(() => {
      setSessionToken(`demo-${Date.now()}`);
      setActiveStage('STAGE_2');
      setIsSigningIn(false);
    }, 350);
  }, []);

  const handleReopenRecent = useCallback(
    (entry: RecentEntry) => {
      void workspace.openRecent(entry);
    },
    [workspace]
  );

  const handleBackToHub = useCallback(() => {
    workspace.closeWorkspace();
    setActiveStage('STAGE_2');
  }, [workspace]);

  const activeModel = useMemo(
    () => byok.models.find((model) => model.id === byok.selectedModel) ?? null,
    [byok.models, byok.selectedModel]
  );

  const files = workspace.files;
  const assets = workspace.assets;
  const bundlable = useMemo(() => canBundle(files), [files]);

  // Next-Level bundle with virtual secrets injection
  useEffect(() => {
    if (!bundlable) {
      setBundleState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setBundleState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));

    const timer = window.setTimeout(async () => {
      try {
        const result = await bundleProject(files, secrets, assets);
        if (cancelled) return;
        setBundleState({
          status: 'ready',
          html: bundleDocument(result, PREVIEW_ERROR_BRIDGE, PREVIEW_BASE_STYLE, secrets),
          label: `Running ${result.entry} — live project bundle`
        });
      } catch (error) {
        if (cancelled) return;
        setBundleState({ status: 'error', message: describeBundleError(error) });
      }
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bundlable, files, secrets, assets]);

  const staticPreview = useMemo(
    () => resolvePreviewDocument(workspace.files, workspace.activeFile ?? undefined, assets),
    [workspace.files, workspace.activeFile, assets]
  );

  const previewDocument = useMemo(() => {
    if (bundleState.status === 'ready') {
      return { html: bundleState.html, label: bundleState.label, source: 'bundle', stackType: 'Live React Bundle' };
    }
    return staticPreview;
  }, [bundleState, staticPreview]);

  const buildSystemInstruction = useCallback(
    (query: string, mode: RefineModeMeta): string => {
      const lines = [
        'You are ShadRox, an expert AI software engineer embedded in a browser-based IDE.',
        'Answer concisely, practically, and code-first. Respond in English.',
        ''
      ];

      if (mode.writesFiles) {
        lines.push(
          'FILE EDIT PROTOCOL:',
          '- Decide which file to change from the user request and the real file names listed below. Never invent a path.',
          '- To change a file, output a fenced code block whose info line names that exact file, and put the COMPLETE new file content in the body:',
          '```tsx path=src/App.tsx',
          '// full file contents, nothing omitted',
          '```',
          '- Always write the file name in the fence line exactly as shown above. This is how changes reach the editor.',
          '- One block per file, with the exact file name from the workspace.',
          '- Never write partial snippets or placeholders inside a path= block.',
          '- Briefly explain changes before outputting code blocks.'
        );
      } else {
        lines.push(
          'PLAN MODE:',
          '- The user requested architecture planning and review only. Do NOT rewrite files and do NOT output a path= block.',
          '- Explain the architecture, changes required, trade-offs, and order of work.'
        );
      }

      if (workspace.files.length > 0) {
        const contextWindow = activeModel?.contextWindow || 32000;
        const budgetChars = Math.max(8000, Math.min(160000, Math.round(contextWindow * 2)));
        const retrieval = retrieveContext(workspace.files, query, budgetChars);

        lines.push(`Workspace: ${workspace.workspace?.name ?? 'ShadRox'} — ${workspace.files.length} file(s).`);
        lines.push(`REPO MAP (all files in workspace):\n${retrieval.repoMap}`);

        const relevant = renderRetrievedContext(retrieval);
        if (relevant) {
          lines.push(`RELEVANT CONTEXT (auto-retrieved):\n${relevant}`);
        }
      }

      if (workspace.activeFile) {
        lines.push(
          `Active file (${workspace.activeFile.name}):\n\`\`\`${workspace.activeFile.language}\n${workspace.activeFile.content.slice(0, 12000)}\n\`\`\``
        );
      }
      if (attachedFileName) {
        const attached = workspace.files.find((file) => file.name === attachedFileName);
        if (attached) {
          lines.push(`Attached file (${attached.name}):\n\`\`\`${attached.language}\n${attached.content.slice(0, 12000)}\n\`\`\``);
        }
      }
      if (secrets.length > 0) {
        lines.push(`Active runtime secrets: ${secrets.map((secret) => secret.key).join(', ')}`);
      }
      if (workspace.dirtyFiles.length > 0) {
        lines.push(`Unsaved modified files: ${workspace.dirtyFiles.join(', ')}`);
      }

      return lines.join('\n\n');
    },
    [
      workspace.workspace,
      workspace.files,
      workspace.activeFile,
      workspace.dirtyFiles,
      attachedFileName,
      secrets,
      activeModel
    ]
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isGenerating) return;

    const quota = getMonthlyUsage(plan);
    if (quota.isCapReached) {
      setToast(`Monthly message cap reached (${quota.limit}/${quota.limit} msgs). Upgrade in Settings.`);
      openSettings('PLAN');
      return;
    }

    const mode = getRefineMode(refineMode);
    const timestamp = formatTime();
    const userMessage: ChatMessage = {
      id: makeId('user'),
      role: 'user',
      content: text,
      timestamp,
      refinedMeta: pendingRefine ? { ...pendingRefine, mode: refineMode } : undefined,
      attachments: attachedFileName ? [attachedFileName] : undefined
    };

    const modelMessage: ChatMessage = {
      id: makeId('model'),
      role: 'model',
      content: '',
      timestamp,
      streaming: true
    };

    const history: ChatTurn[] = messages
      .filter((message) => !message.streaming && message.content.trim())
      .map((message) => ({
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content
      }));
    history.push({ role: 'user', content: text });

    setMessages((previous) => [...previous, userMessage, modelMessage]);
    setInput('');
    setPendingRefine(null);
    setAttachedFileName(null);
    setIsGenerating(true);

    if (!byok.useShadRoxKey && !byok.activeKey) {
      setIsGenerating(false);
      setMessages((previous) =>
        previous.map((message) =>
          message.id === modelMessage.id
            ? {
                ...message,
                streaming: false,
                content:
                  'No API key found. Add your Google Gemini or Groq key in **Settings → Models & Keys**, or enable "ShadRox Shared Key".'
              }
            : message
        )
      );
      setIsSettingsOpen(true);
      setSettingsTab('CHAT');
      return;
    }

    recordMessageSent();

    const controller = new AbortController();
    abortRef.current = controller;

    let reply = '';
    let applied = false;

    const applyReplyPatches = () => {
      if (applied) return;
      applied = true;

      if (!mode.writesFiles) {
        if (extractFilePatches(reply, workspace.files).patches.length > 0) {
          setToast('Plan mode active — file modifications were not applied.');
          window.setTimeout(() => setToast(null), 5000);
        }
        return;
      }

      const scan = extractFilePatches(reply, workspace.files);

      if (scan.patches.length === 0) {
        if (scan.unmapped > 0) {
          setToast('Response contained code blocks without explicit file paths — changes were not applied.');
          window.setTimeout(() => setToast(null), 6000);
        }
        return;
      }

      const result = workspace.applyFilePatches(scan.patches);
      const parts = [
        result.updated.length > 0 ? `${result.updated.join(', ')} updated` : '',
        result.created.length > 0 ? `${result.created.join(', ')} created` : ''
      ].filter(Boolean);
      if (parts.length === 0) return;

      setToast(parts.join(' • '));
      window.setTimeout(() => setToast(null), 4000);
    };

    void workspace.markCheckpoint(modelMessage.id, text);

    try {
      await streamChat(
        {
          provider: byok.activeProvider,
          model: byok.selectedModel,
          apiKey: byok.useShadRoxKey ? undefined : byok.activeKey,
          messages: history,
          systemInstruction: buildSystemInstruction(text, mode),
          thinking: mode.thinking,
          signal: controller.signal
        },
        {
          onDelta: (chunk) => {
            reply += chunk;
            setMessages((previous) =>
              previous.map((message) =>
                message.id === modelMessage.id ? { ...message, content: message.content + chunk } : message
              )
            );
          },
          onDone: () =>
            setMessages((previous) =>
              previous.map((message) =>
                message.id === modelMessage.id ? { ...message, streaming: false } : message
              )
            ),
          onError: (error) =>
            setMessages((previous) =>
              previous.map((message) =>
                message.id === modelMessage.id
                  ? {
                      ...message,
                      streaming: false,
                      content: `**Generation Error:** ${error}\n\nCheck your key or model selection in Settings.`
                    }
                  : message
              )
            )
        }
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessages((previous) =>
        previous.map((message) =>
          message.id === modelMessage.id
            ? {
                ...message,
                streaming: false,
                content: `**Request Failed:** ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            : message
        )
      );
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
      applyReplyPatches();
    }
  }, [
    input,
    isGenerating,
    plan,
    openSettings,
    refineMode,
    pendingRefine,
    attachedFileName,
    messages,
    byok.useShadRoxKey,
    byok.activeKey,
    byok.activeProvider,
    byok.selectedModel,
    workspace,
    buildSystemInstruction
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
  }, []);

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
  }, [input, isRefining, isGenerating, byok.apiKeyDraft, byok.activeProvider, workspace.files.length, workspace.activeFile, refineMode]);

  const handleRestoreCheckpoint = useCallback(
    async (checkpointId: string) => {
      setRestoringCheckpointId(checkpointId);
      const ok = await workspace.restoreCheckpoint(checkpointId);
      setRestoringCheckpointId(null);
      if (ok) {
        setToast('Workspace restored to checkpoint state');
        window.setTimeout(() => setToast(null), 3000);
      }
    },
    [workspace]
  );

  const handleNewFile = useCallback(() => {
    const name = window.prompt('Enter file name (e.g. src/utils/helper.ts):');
    if (!name || !name.trim()) return;
    workspace.createFile(name.trim(), '// New file created in ShadRox\n');
  }, [workspace]);

  const handleBugReport = useCallback(() => {
    const report = {
      timestamp: new Date().toISOString(),
      provider: byok.activeProvider,
      model: byok.selectedModel,
      filesCount: workspace.files.length,
      dirtyCount: workspace.dirtyFiles.length,
      platform: navigator.userAgent
    };
    navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
    setToast('Diagnostics copied to clipboard');
    window.setTimeout(() => setToast(null), 2500);
  }, [byok.activeProvider, byok.selectedModel, workspace.files.length, workspace.dirtyFiles.length]);

  if (activeStage === 'STAGE_1') {
    return <Stage1Auth onSignIn={handleSignIn} isSigningIn={isSigningIn} />;
  }

  if (activeStage === 'STAGE_2') {
    return (
      <Stage2Hub
        recents={workspace.recents}
        isBusy={workspace.isBusy}
        statusMessage={workspace.statusMessage}
        onOpenFolder={workspace.openFolder}
        onOpenFiles={workspace.openFiles}
        onDroppedFiles={workspace.openDropped}
        onReopen={handleReopenRecent}
      />
    );
  }

  const hasKey = Boolean(byok.activeKey) || byok.useShadRoxKey;

  return (
    <div className="w-full h-screen flex flex-col bg-black text-white overflow-hidden">
      {/* Top Header */}
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900 bg-neutral-950">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={handleBackToHub}
            title="Back to Workspace Hub"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <ShadRoxLogo className="w-4 h-4 text-emerald-400" />
          <span className="text-xs font-semibold text-white truncate">
            {workspace.workspace?.name ?? 'ShadRox'}
          </span>
          <span className="hidden sm:inline text-[11px] text-neutral-600 font-mono">
            {workspace.files.length} files
          </span>
          {workspace.dirtyFiles.length > 0 && (
            <span className="hidden sm:inline text-[10px] text-amber-400 font-mono" title="Unsaved changes">
              {workspace.dirtyFiles.length} unsaved
            </span>
          )}
          {workspace.isBusy && <Loader2 className="w-3 h-3 animate-spin text-neutral-500" />}
        </div>

        <div className="flex items-center gap-1">
          {workspace.canWriteToDisk && (
            <>
              <button
                type="button"
                onClick={() => void workspace.saveAll()}
                disabled={workspace.dirtyFiles.length === 0 || workspace.isSaving}
                title="Save modified files to disk (Ctrl/Cmd+S)"
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-neutral-400 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
              >
                {workspace.isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save
              </button>
              <button
                type="button"
                onClick={() => workspace.setAutoSave(!workspace.autoSave)}
                title="Auto-save to disk on edit"
                className={`px-2 py-1 border text-[10px] uppercase tracking-wide transition-colors cursor-pointer ${
                  workspace.autoSave
                    ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-400'
                    : 'border-neutral-800 text-neutral-500 hover:text-white'
                }`}
              >
                Auto-save {workspace.autoSave ? 'on' : 'off'}
              </button>
            </>
          )}

          {/* Code vs Preview Tab Switcher */}
          <div className="flex items-center border border-neutral-800 mr-1">
            <button
              type="button"
              onClick={() => setActiveTab('CODE')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                activeTab === 'CODE' ? 'bg-white text-black font-semibold' : 'text-neutral-500 hover:text-white'
              }`}
            >
              <Code2 className="w-3 h-3" />
              Code
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('PREVIEW')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                activeTab === 'PREVIEW' ? 'bg-white text-black font-semibold' : 'text-neutral-500 hover:text-white'
              }`}
            >
              <Eye className="w-3 h-3" />
              Preview
            </button>
          </div>

          <button
            type="button"
            onClick={handleBugReport}
            title="Copy system diagnostics"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <Bug className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            title="Settings"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {workspace.diskMessage && (
        <div className="shrink-0 px-3 py-1.5 border-b border-neutral-900 bg-neutral-950 text-[11px] text-neutral-400">
          {workspace.diskMessage}
        </div>
      )}

      {/* Main Split Layout: Left ChatPanel, Right CodeEditor / PreviewPane */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="w-full md:w-[35%] md:min-w-[320px] h-1/2 md:h-full min-h-0">
          <ChatPanel
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={isGenerating}
            isRefining={isRefining}
            refineStep={refineStep}
            onRefinePrompt={handleRefinePrompt}
            refineMode={refineMode}
            onRefineModeChange={setRefineMode}
            models={byok.models}
            selectedModel={byok.selectedModel}
            onSelectModel={byok.selectModel}
            hasKey={hasKey}
            plan={plan}
            onOpenSettings={openSettings}
            attachedFileName={attachedFileName}
            onAttachedFileChange={setAttachedFileName}
            workspaceFiles={workspace.files}
            checkpoints={workspace.checkpoints}
            onRestoreCheckpoint={handleRestoreCheckpoint}
            restoringCheckpointId={restoringCheckpointId}
          />
        </div>

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {workspace.files.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
              <FolderOpen className="w-6 h-6 text-neutral-700" />
              <p className="mt-3 text-xs text-neutral-400">No files open in workspace.</p>
              <button
                type="button"
                onClick={handleBackToHub}
                className="mt-3 text-[11px] text-emerald-400 hover:text-emerald-300 cursor-pointer"
              >
                Open folder or files
              </button>
            </div>
          ) : activeTab === 'CODE' ? (
            <CodeEditor
              files={workspace.files}
              activeFileIndex={workspace.activeFileIndex}
              dirtyFiles={workspace.dirtyFiles}
              canWriteToDisk={workspace.canWriteToDisk}
              isSaving={workspace.isSaving}
              onSelectFile={workspace.selectFile}
              onCloseFile={workspace.closeFile}
              onChangeContent={workspace.updateActiveContent}
              onDeleteFile={workspace.deleteFile}
              onNewFile={handleNewFile}
              onSaveAll={() => void workspace.saveAll()}
              workspaceName={workspace.workspace?.name}
            />
          ) : (
            <PreviewPane
              document={previewDocument}
              capabilityMessage={previewCapabilityMessage(workspace.activeFile ?? undefined)}
              viewport={viewport}
              onViewportChange={setViewport}
              runtimeError={runtimeError}
              onDismissError={() => setRuntimeError(null)}
              isBundling={bundleState.status === 'loading'}
              bundleError={bundleState.status === 'error' ? bundleState.message : null}
            />
          )}
        </div>
      </div>

      <SettingsDrawer
        isOpen={isSettingsOpen}
        activeTab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setIsSettingsOpen(false)}
        activeProvider={byok.activeProvider}
        onProviderChange={byok.changeProvider}
        apiKeyDraft={byok.apiKeyDraft}
        onApiKeyDraftChange={byok.setApiKeyDraft}
        keyStatus={byok.keyStatus}
        onValidateKey={byok.validateKey}
        onForgetKey={byok.forgetKey}
        models={byok.models}
        selectedModel={byok.selectedModel}
        onSelectModel={byok.selectModel}
        temperature={byok.temperature}
        onTemperatureChange={byok.setTemperature}
        useShadRoxKey={byok.useShadRoxKey}
        onUseShadRoxKeyChange={byok.setUseShadRoxKey}
        plan={plan}
        onPlanChange={changePlan}
        secrets={secrets}
        onSecretsChange={setSecrets}
        workspaceFiles={workspace.files}
      />

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs text-neutral-200 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
