import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bug, Code2, Eye, FolderOpen, Loader2, Save, Settings } from 'lucide-react';
import { DevoraLogo } from './components/Logo';
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
import { getSessionToken, setSessionToken } from './lib/storage';
import type {
  ChatMessage,
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

  // Move into the workspace automatically once a folder/files are mounted.
  useEffect(() => {
    if (workspace.workspace && activeStage === 'STAGE_2') setActiveStage('STAGE_3');
  }, [workspace.workspace, activeStage]);

  // Runtime errors reported by the sandboxed preview iframe.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; message?: string } | null;
      if (!data || data.source !== 'devora-preview') return;
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

  /**
   * Back leaves the editor. The workspace has to be closed too, otherwise the
   * auto-forward effect below (workspace mounted + STAGE_2) pushes the user
   * straight back into the editor and back never appears to work.
   */
  const handleBackToHub = useCallback(() => {
    workspace.closeWorkspace();
    setActiveStage('STAGE_2');
  }, [workspace]);

  const activeModel = useMemo(
    () => byok.models.find((model) => model.id === byok.selectedModel) ?? null,
    [byok.models, byok.selectedModel]
  );

  const files = workspace.files;
  const bundlable = useMemo(() => canBundle(files), [files]);

  // Bundle the project in the browser so React/TSX files actually run, and keep
  // the last good frame on screen while the next one compiles.
  useEffect(() => {
    if (!bundlable) {
      setBundleState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setBundleState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));

    const timer = window.setTimeout(async () => {
      try {
        const result = await bundleProject(files);
        if (cancelled) return;
        setBundleState({
          status: 'ready',
          html: bundleDocument(result, PREVIEW_ERROR_BRIDGE, PREVIEW_BASE_STYLE),
          label: `Running ${result.entry} — live project bundle`
        });
      } catch (error) {
        if (cancelled) return;
        setBundleState({ status: 'error', message: describeBundleError(error) });
      }
    }, 700);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [bundlable, files]);

  const staticPreview = useMemo(
    () => resolvePreviewDocument(workspace.files, workspace.activeFile ?? undefined),
    [workspace.files, workspace.activeFile]
  );

  /** A runnable bundle beats the static HTML/Markdown rendering. */
  const previewDocument = useMemo(() => {
    if (bundleState.status === 'ready') {
      return { html: bundleState.html, label: bundleState.label, source: 'bundle' };
    }
    return staticPreview;
  }, [bundleState, staticPreview]);

  const buildSystemInstruction = useCallback(
    (query: string, mode: RefineModeMeta): string => {
      const lines = [
        'You are Devora, an expert AI coding assistant embedded in a browser-based IDE.',
        'Answer in the same language the user writes in. Be concise, practical and code-first.',
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
          '- Always write the file name in the fence line exactly as shown above. This is how the change reaches the editor.',
          '- One block per file, with the exact file name from the list below.',
          '- Never write partial snippets, diffs, or "// rest unchanged" placeholders inside a path= block. Those blocks are written to disk verbatim.',
          '- A code block without a file name is treated as an example only, so use one when you mean "look at this, do not save it".',
          '- Only edit a file when the user actually asked for that change. If the request is just a question, reply in prose with no path= block.',
          '- Briefly explain what you changed before the code blocks.'
        );
      } else {
        lines.push(
          'PLAN MODE:',
          '- The user asked for planning and architecture only. Do NOT rewrite a file and do NOT output a path= code block.',
          '- Explain the approach, which files would change, the trade-offs and the order of work.',
          '- Short illustrative snippets are fine, but never present them as file rewrites.'
        );
      }

      if (workspace.files.length > 0) {
        // The budget comes from the selected model, so a small model is not
        // handed more code than it can actually read.
        const contextWindow = activeModel?.contextWindow || 32000;
        const budgetChars = Math.max(8000, Math.min(160000, Math.round(contextWindow * 2)));
        const retrieval = retrieveContext(workspace.files, query, budgetChars);

        lines.push(`Workspace: ${workspace.workspace?.name ?? 'untitled'} — ${workspace.files.length} file(s).`);
        lines.push(`REPO MAP (every file in this workspace):\n${retrieval.repoMap}`);

        const relevant = renderRetrievedContext(retrieval);
        if (relevant) {
          lines.push(`MOST RELEVANT CODE for this request (auto-selected):\n${relevant}`);
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
        lines.push(`Available local secrets (names only): ${secrets.map((secret) => secret.key).join(', ')}`);
      }
      if (workspace.dirtyFiles.length > 0) {
        lines.push(`Edited in the browser but not saved to disk yet: ${workspace.dirtyFiles.join(', ')}`);
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

    if (!byok.useDevoraKey && !byok.activeKey) {
      setIsGenerating(false);
      setMessages((previous) =>
        previous.map((message) =>
          message.id === modelMessage.id
            ? {
                ...message,
                streaming: false,
                content:
                  'Koi API key nahi mili. **Settings → Models & Keys** me apni Groq ya Gemini key daalo, ya "Devora ki shared key" on karo.'
              }
            : message
        )
      );
      setIsSettingsOpen(true);
      setSettingsTab('CHAT');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    let reply = '';
    let applied = false;

    /** Writes the files the assistant asked for, once the reply is complete. */
    const applyReplyPatches = () => {
      if (applied) return;
      applied = true;

      // Plan mode must never touch the workspace — that is the whole point.
      if (!mode.writesFiles) {
        if (extractFilePatches(reply, workspace.files).patches.length > 0) {
          setToast('Plan mode on tha — reply me file changes the, par apply nahi kiye.');
          window.setTimeout(() => setToast(null), 5000);
        }
        return;
      }

      const scan = extractFilePatches(reply, workspace.files);

      if (scan.patches.length === 0) {
        if (scan.unmapped > 0) {
          setToast(
            `Reply me ${scan.unmapped} code block tha par usme file ka naam nahi mila — isliye kuch save nahi hua.`
          );
          window.setTimeout(() => setToast(null), 6000);
        }
        return;
      }

      const result = workspace.applyFilePatches(scan.patches);
      const parts = [
        result.updated.length > 0 ? `${result.updated.join(', ')} update hua` : '',
        result.created.length > 0 ? `${result.created.join(', ')} nayi file bani` : ''
      ].filter(Boolean);
      if (parts.length === 0) return;

      setToast(parts.join(' • '));
      window.setTimeout(() => setToast(null), 4000);
    };

    // Snapshot the pre-change files so this reply can be undone from the chat.
    void workspace.markCheckpoint(modelMessage.id, text);

    try {
      await streamChat(
        {
          provider: byok.activeProvider,
          model: byok.selectedModel,
          apiKey: byok.useDevoraKey ? undefined : byok.activeKey,
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
                      content: message.content
                        ? `${message.content}\n\n_${error}_`
                        : `Request fail ho gayi: ${error}`
                    }
                  : message
              )
            )
        }
      );
    } finally {
      applyReplyPatches();
      setIsGenerating(false);
      abortRef.current = null;
    }
  }, [
    input,
    isGenerating,
    pendingRefine,
    attachedFileName,
    refineMode,
    messages,
    byok.useDevoraKey,
    byok.activeKey,
    byok.activeProvider,
    byok.selectedModel,
    buildSystemInstruction,
    workspace
  ]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    setMessages((previous) => previous.map((message) => (message.streaming ? { ...message, streaming: false } : message)));
  }, []);

  const handleClearChat = useCallback(() => {
    handleStop();
    setMessages([]);
  }, [handleStop]);

  const handleRefinePrompt = useCallback(async () => {
    const raw = input.trim();
    if (!raw || isRefining || isGenerating) return;

    setIsRefining(true);
    setRefineStep('Language detect ho rahi hai...');

    try {
      const refined = await refinePrompt({
        rawPrompt: raw,
        provider: byok.activeProvider,
        geminiKey: byok.apiKeyDraft.gemini || undefined,
        groqKey: byok.apiKeyDraft.groq || undefined,
        mode: refineMode,
        contextInfo: workspace.workspace ? `${workspace.workspace.name} (${workspace.files.length} files)` : 'New empty workspace'
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
      setToast('Prompt refine ho gaya');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Prompt refine fail hua');
    } finally {
      setIsRefining(false);
      setRefineStep('');
      window.setTimeout(() => setToast(null), 2600);
    }
  }, [
    input,
    isRefining,
    isGenerating,
    refineMode,
    byok.activeProvider,
    byok.apiKeyDraft,
    workspace.workspace,
    workspace.files
  ]);

  const handleRestoreCheckpoint = useCallback(
    async (id: string) => {
      setRestoringCheckpointId(id);
      try {
        const restored = await workspace.restoreCheckpoint(id);
        setToast(restored ? 'Purana code wapas aa gaya — disk par save karna ho to Save dabao.' : 'Restore nahi ho paya.');
      } finally {
        setRestoringCheckpointId(null);
        window.setTimeout(() => setToast(null), 4000);
      }
    },
    [workspace]
  );

  // Ctrl/Cmd+S writes the dirty files back to the user's disk.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      void workspace.saveAll();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace]);

  const handleNewFile = useCallback(() => {
    const name = window.prompt('Nayi file ka naam (jaise utils.ts)');
    if (name) workspace.createFile(name);
  }, [workspace]);

  const handleBugReport = useCallback(async () => {
    const diagnostics = [
      `Devora diagnostics — ${new Date().toISOString()}`,
      `Workspace: ${workspace.workspace?.name ?? 'none'} (${workspace.files.length} files)`,
      `Active file: ${workspace.activeFile?.name ?? 'none'}`,
      `Provider: ${byok.activeProvider}`,
      `Model: ${byok.selectedModel || 'none'}`,
      `Last preview error: ${runtimeError ?? 'none'}`,
      `User agent: ${navigator.userAgent}`
    ].join('\n');

    try {
      await navigator.clipboard.writeText(diagnostics);
      setToast('Diagnostics clipboard me copy ho gaye');
    } catch {
      setToast('Copy nahi ho paya');
    }
    window.setTimeout(() => setToast(null), 2600);
  }, [workspace.workspace, workspace.files, workspace.activeFile, byok.activeProvider, byok.selectedModel, runtimeError]);

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

  const hasKey = Boolean(byok.activeKey) || byok.useDevoraKey;

  return (
    <div className="w-full h-screen flex flex-col bg-black text-white overflow-hidden">
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={handleBackToHub}
            title="Back to workspace hub"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <DevoraLogo className="w-4 h-4" />
          <span className="text-xs font-semibold text-white truncate">
            {workspace.workspace?.name ?? 'Devora'}
          </span>
          <span className="hidden sm:inline text-[11px] text-neutral-600">{workspace.files.length} files</span>
          {workspace.dirtyFiles.length > 0 && (
            <span className="hidden sm:inline text-[10px] text-amber-400" title="Disk par abhi save nahi hua">
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
                title="Dirty files disk par save karo (Ctrl/Cmd+S)"
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-neutral-400 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
              >
                {workspace.isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save
              </button>
              <button
                type="button"
                onClick={() => workspace.setAutoSave(!workspace.autoSave)}
                title="Auto-save: edit hote hi disk par likh do (browser permission milne par)"
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
          <div className="flex items-center border border-neutral-800 mr-1">
            <button
              type="button"
              onClick={() => setActiveTab('CODE')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                activeTab === 'CODE' ? 'bg-white text-black' : 'text-neutral-500 hover:text-white'
              }`}
            >
              <Code2 className="w-3 h-3" />
              Code
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('PREVIEW')}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                activeTab === 'PREVIEW' ? 'bg-white text-black' : 'text-neutral-500 hover:text-white'
              }`}
            >
              <Eye className="w-3 h-3" />
              Preview
            </button>
          </div>
          <button
            type="button"
            onClick={handleBugReport}
            title="Copy diagnostics for a bug report"
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

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="w-full md:w-[35%] md:min-w-[320px] h-1/2 md:h-full min-h-0">
          <ChatPanel
            messages={messages}
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onStop={handleStop}
            onClearChat={handleClearChat}
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
            onOpenSettings={() => setIsSettingsOpen(true)}
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
              <p className="mt-3 text-xs text-neutral-500">Koi file open nahi hai.</p>
              <button
                type="button"
                onClick={handleBackToHub}
                className="mt-3 text-[11px] text-emerald-400 hover:text-emerald-300 cursor-pointer"
              >
                Folder ya files open karo
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
        useDevoraKey={byok.useDevoraKey}
        onUseDevoraKeyChange={byok.setUseDevoraKey}
        secrets={secrets}
        onSecretsChange={setSecrets}
        workspaceFiles={workspace.files}
      />

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 border border-neutral-800 bg-neutral-950 px-4 py-2 text-xs text-neutral-200">
          {toast}
        </div>
      )}
    </div>
  );
}
