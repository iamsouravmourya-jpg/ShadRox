import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  Code2,
  FileText,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  RotateCcw,
  Send,
  ShieldAlert,
  Settings,
  Sparkles,
  Square,
  Wand2,
  Zap
} from 'lucide-react';
import { maskFileWrites, renderMarkdownContent } from '../lib/markdown';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { getRefineMode, REFINE_MODES } from '../lib/ai';
import { getProviderMeta, type ModelInfo, type ModelTier } from '../lib/providers';
import { getMonthlyUsage, onQuotaChange, type UsageState } from '../lib/quota';
import { estimateTokens } from '../lib/toolUtils';
import { getPlanMeta } from '../lib/plans';
import type { ChatMessage, PlanTier, RefineMode, SettingsTab, WorkspaceFile } from '../lib/types';
import type { CheckpointMeta } from '../lib/history';
import type { DesktopPreviewState, PreviewApprovalRequest } from '../lib/desktop';

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearChat?: () => void;
  isGenerating: boolean;
  isRefining: boolean;
  refineStep: string;
  onRefinePrompt: () => void;
  refineMode: RefineMode;
  onRefineModeChange: (mode: RefineMode) => void;
  models: ModelInfo[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  hasKey: boolean;
  plan: PlanTier;
  onOpenSettings: (tab?: SettingsTab) => void;
  attachedFileName: string | null;
  onAttachedFileChange: (fileName: string | null) => void;
  workspaceFiles: WorkspaceFile[];
  checkpoints: CheckpointMeta[];
  onRestoreCheckpoint: (id: string) => void;
  restoringCheckpointId: string | null;
  previewApproval: PreviewApprovalRequest | null;
  onApprovePreview: () => void;
  onCancelPreviewApproval: () => void;
  onRunPreview: () => void;
  onStopPreview: () => void;
  previewState: DesktopPreviewState;
  hasPreviewDiagnostics: boolean;
}

const TIER_STYLES: Record<ModelTier, string> = {
  free: 'text-emerald-400 border-emerald-900/60 bg-emerald-950/30',
  pro: 'text-amber-400 border-amber-900/60 bg-amber-950/30'
};

const MODE_ICONS: Record<RefineMode, typeof Code2> = {
  code: Code2,
  plan: FileText,
  complex: Brain
};

export function ChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  onStop,
  isGenerating,
  isRefining,
  refineStep,
  onRefinePrompt,
  refineMode,
  onRefineModeChange,
  models,
  selectedModel,
  onSelectModel,
  hasKey,
  plan,
  onOpenSettings,
  attachedFileName,
  onAttachedFileChange,
  workspaceFiles,
  checkpoints,
  onRestoreCheckpoint,
  restoringCheckpointId,
  previewApproval,
  onApprovePreview,
  onCancelPreviewApproval,
  onRunPreview,
  onStopPreview,
  previewState,
  hasPreviewDiagnostics
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const speech = useSpeechRecognition('en-US');
  const activeMode = getRefineMode(refineMode);

  const [usage, setUsage] = useState<UsageState>(() => getMonthlyUsage(plan));

  useEffect(() => {
    setUsage(getMonthlyUsage(plan));
    return onQuotaChange(() => {
      setUsage(getMonthlyUsage(plan));
    });
  }, [plan]);

  useEffect(() => {
    if (speech.transcript) onInputChange(speech.transcript);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.transcript]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, previewApproval]);

  const activeModel = models.find((model) => model.id === selectedModel) || null;
  const canSend = input.trim().length > 0 && !isGenerating && !usage.isCapReached;

  const quotaTone = usage.isCapReached
    ? {
        pill: 'border-rose-900/70 bg-rose-950/40 text-rose-300',
        icon: 'text-rose-400'
      }
    : usage.percentage >= 70
      ? {
          pill: 'border-amber-900/60 bg-amber-950/30 text-amber-300',
          icon: 'text-amber-400'
        }
      : {
          pill: 'border-emerald-900/60 bg-emerald-950/20 text-emerald-400 hover:border-emerald-800/70',
          icon: 'text-emerald-400'
        };

  const proPlan = getPlanMeta('pro');

  const groupedModels: Record<ModelTier, ModelInfo[]> = {
    free: models.filter((model) => model.tier === 'free'),
    pro: models.filter((model) => model.tier === 'pro')
  };

  const ActiveModeIcon = MODE_ICONS[refineMode] || Code2;

  return (
    <div className="h-full flex flex-col bg-black border-r border-neutral-900 select-text">
      {/* Header */}
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
        <button
          type="button"
          onClick={() => setIsModelMenuOpen((open) => !open)}
          disabled={models.length === 0}
          className="flex items-center gap-2 text-xs text-neutral-200 hover:text-white disabled:opacity-50 transition-colors cursor-pointer min-w-0"
        >
          <span className="truncate max-w-[150px]">{activeModel ? activeModel.label : 'Select Model'}</span>
          {activeModel && (
            <span className={`px-1.5 py-0.5 border text-[10px] uppercase tracking-wide ${TIER_STYLES[activeModel.tier]}`}>
              {activeModel.tier}
            </span>
          )}
          <ChevronDown className="w-3 h-3 shrink-0 text-neutral-500" />
        </button>

        <div className="flex items-center gap-1.5">
          {/* Monthly Quota Indicator Pill */}
          <button
            type="button"
            onClick={() => onOpenSettings('PLAN')}
            title={
              usage.isUnlimited
                ? `Monthly chat quota: unlimited (${usage.count} messages used this month)`
                : `Monthly chat quota: ${usage.count}/${usage.limit} messages used (${usage.remaining} remaining this month)`
            }
            className={`flex items-center gap-1 px-2 py-1 border text-[10px] tracking-wide transition-colors cursor-pointer ${quotaTone.pill}`}
          >
            <Zap className={`w-3 h-3 ${quotaTone.icon}`} />
            <span className="font-mono">{usage.count}/{usage.isUnlimited ? '∞' : usage.limit}</span>
          </button>

          {plan === 'free' && (
            <button
              type="button"
              onClick={() => onOpenSettings('PLAN')}
              title={`Pro plan: ${proPlan.price} (GST included) — ${proPlan.monthlyCap} messages & shared key`}
              className="hidden sm:flex items-center gap-1 px-2 py-1 border border-amber-900/60 text-amber-400 text-[10px] uppercase tracking-wide hover:bg-amber-950/30 transition-colors cursor-pointer"
            >
              Upgrade
            </button>
          )}

          <button
            type="button"
            onClick={() => onOpenSettings()}
            title="Settings"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Model Selector Dropdown */}
      {isModelMenuOpen && (
        <div className="shrink-0 max-h-64 overflow-y-auto border-b border-neutral-900 bg-neutral-950">
          {models.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                setIsModelMenuOpen(false);
                onOpenSettings('CHAT');
              }}
              className="w-full px-3 py-4 text-left text-xs text-neutral-400 hover:text-white cursor-pointer"
            >
              No models available. Add your API key in Settings.
            </button>
          ) : (
            (['free', 'pro'] as ModelTier[]).map((tier) =>
              groupedModels[tier].length === 0 ? null : (
                <div key={tier}>
                  <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">
                    {tier === 'free' ? 'Free tier models' : 'Pro tier models'}
                  </div>
                  {groupedModels[tier].map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        onSelectModel(model.id);
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-neutral-900 cursor-pointer ${
                        model.id === selectedModel ? 'text-white' : 'text-neutral-400'
                      }`}
                    >
                      <span className="truncate">{model.label}</span>
                      {model.contextWindow && (
                        <span className="text-[10px] text-neutral-600 shrink-0">
                          {Math.round(model.contextWindow / 1000)}k ctx
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )
            )
          )}
        </div>
      )}

      {/* Messages Scroll Area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-xs">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-500">
            <Sparkles className="w-6 h-6 text-neutral-600 mb-2" />
            <p className="text-xs text-neutral-300 font-medium">ShadRox Assistant</p>
            <p className="mt-1 text-[11px] text-neutral-500 max-w-xs leading-relaxed">
              Describe what you want to build or change. ShadRox will inspect your workspace and directly apply patches.
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div className="flex items-center gap-1.5 mb-1 px-1 text-[10px] text-neutral-500">
              <span className="uppercase font-semibold tracking-wider">
                {message.role === 'user' ? 'You' : 'ShadRox'}
              </span>
              <span>·</span>
              <span>{message.timestamp}</span>
            </div>

            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {message.attachments.map((file) => (
                  <span
                    key={file}
                    className="border border-neutral-800 bg-neutral-950 px-2 py-0.5 text-[10px] font-mono text-neutral-400"
                  >
                    {file}
                  </span>
                ))}
              </div>
            )}

            {message.role === 'user' ? (
              <div className="max-w-[85%] border border-neutral-800 bg-neutral-950/80 px-3 py-2 text-neutral-200 leading-relaxed whitespace-pre-wrap">
                {message.content}
              </div>
            ) : (
              <div className="max-w-[95%] text-neutral-200 leading-relaxed">
                {message.content ? (
                  renderMarkdownContent(maskFileWrites(message.content, workspaceFiles))
                ) : message.streaming ? (
                  <span className="inline-flex items-center gap-2 text-neutral-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                    Thinking...
                  </span>
                ) : null}

                {!message.streaming &&
                  (() => {
                    const checkpoint = checkpoints.find((entry) => entry.messageId === message.id);
                    if (!checkpoint) return null;
                    return (
                      <button
                        type="button"
                        onClick={() => onRestoreCheckpoint(checkpoint.id)}
                        disabled={restoringCheckpointId === checkpoint.id}
                        title={`Restore workspace files before this reply (${checkpoint.fileCount} files)`}
                        className="mt-2 flex items-center gap-1 text-[10px] text-neutral-500 hover:text-amber-400 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        {restoringCheckpointId === checkpoint.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3 h-3" />
                        )}
                        Restore workspace before this reply
                      </button>
                    );
                  })()}
              </div>
            )}
          </div>
        ))}
        {previewApproval && (
          <div className="border border-amber-800/60 bg-amber-950/20 p-3 text-[11px]">
            <div className="flex items-center gap-2 text-amber-300 font-semibold">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              Approve project setup
            </div>
            <p className="mt-2 text-neutral-300">
              ShadRox found <span className="font-mono text-white">{previewApproval.projectPath}</span> and wants to run:
            </p>
            <code className="mt-1 block break-all border border-neutral-800 bg-black/60 p-2 text-emerald-300">
              {previewApproval.packageManager} run {previewApproval.scriptName}
              <span className="block mt-1 text-neutral-400">{previewApproval.scriptCommand}</span>
            </code>
            {previewApproval.missingDependencies.length > 0 ? (
              <p className="mt-2 text-neutral-300 break-words">
                Install {previewApproval.missingDependencies.length} missing package(s) first:{' '}
                <span className="font-mono text-neutral-100">
                  {previewApproval.missingDependencies.slice(0, 10).join(', ')}
                  {previewApproval.missingDependencies.length > 10 ? ', ...' : ''}
                </span>
              </p>
            ) : (
              <p className="mt-2 text-neutral-400">Use the dependencies already installed in this project.</p>
            )}
            <p className="mt-2 text-amber-200/80">
              Install hooks and project scripts can access files and the network with your account permissions. Approve only if you trust this project.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onApprovePreview}
                className="border border-emerald-800 bg-emerald-950/40 px-3 py-1.5 text-emerald-300 hover:bg-emerald-900/50 cursor-pointer"
              >
                Approve once &amp; run
              </button>
              <button
                type="button"
                onClick={onCancelPreviewApproval}
                className="border border-neutral-700 px-3 py-1.5 text-neutral-300 hover:bg-neutral-900 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Input Area & Prompt Box */}
      <div className="shrink-0 border-t border-neutral-900 p-3 bg-black">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px] text-neutral-500">
            {hasPreviewDiagnostics
              ? 'Recent preview + Console logs are included with your next chat message.'
              : 'Preview and Console are ready to inspect once a project runs.'}
          </div>
          <div className="flex shrink-0 gap-1">
            {previewState.status === 'ready' ? (
              <button
                type="button"
                onClick={onStopPreview}
                className="border border-neutral-800 px-2 py-1 text-[10px] text-neutral-300 hover:border-red-800 hover:text-red-300 cursor-pointer"
              >
                Stop preview
              </button>
            ) : (
              <button
                type="button"
                onClick={onRunPreview}
                disabled={previewState.status === 'starting' || Boolean(previewApproval)}
                className="border border-emerald-900/70 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-950/40 disabled:opacity-40 cursor-pointer"
              >
                {previewState.status === 'starting' ? 'Checking project…' : 'Run preview'}
              </button>
            )}
          </div>
        </div>

        {/* Monthly Cap Warning Banner */}
        {usage.isCapReached && (
          <div className="mb-2 p-2 border border-rose-900/70 bg-rose-950/30 text-[11px] text-rose-300 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="truncate">Monthly cap reached ({usage.limit}/{usage.limit} msgs)</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenSettings('PLAN')}
              className="shrink-0 px-2.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-semibold cursor-pointer"
            >
              Upgrade
            </button>
          </div>
        )}

        {isRefining && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-emerald-400/80">
            <Loader2 className="w-3 h-3 animate-spin" />
            {refineStep || 'Refining prompt...'}
          </div>
        )}

        {attachedFileName && (
          <div className="mb-2 flex items-center justify-between border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400">
            <span className="font-mono truncate">{attachedFileName}</span>
            <button
              type="button"
              onClick={() => onAttachedFileChange(null)}
              className="text-neutral-600 hover:text-white cursor-pointer"
            >
              remove
            </button>
          </div>
        )}

        {/* Prompt Input Box */}
        <div className="border border-neutral-800 focus-within:border-neutral-600 transition-colors bg-neutral-950/50">
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (canSend) onSend();
              }
            }}
            rows={3}
            placeholder={
              usage.isCapReached
                ? 'Monthly message cap reached. Upgrade in Settings to continue...'
                : 'Ask ShadRox to build, refactor, or explain code...'
            }
            disabled={usage.isCapReached}
            className="w-full resize-none bg-transparent text-xs text-neutral-100 px-3 py-2.5 outline-none placeholder:text-neutral-600 disabled:opacity-50"
          />

          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1.5">
              {/* Work Mode Dropdown (Replaces old template option with Code, Plan, Complex) */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsModeMenuOpen((open) => !open)}
                  title={`Active mode: ${activeMode.label} — ${activeMode.hint}`}
                  className={`flex items-center gap-1.5 px-2 py-1 border text-[11px] transition-colors cursor-pointer ${
                    refineMode === 'plan'
                      ? 'border-amber-800/70 bg-amber-950/30 text-amber-300'
                      : refineMode === 'complex'
                        ? 'border-purple-800/70 bg-purple-950/30 text-purple-300'
                        : 'border-emerald-800/70 bg-emerald-950/30 text-emerald-300'
                  }`}
                >
                  <ActiveModeIcon className="w-3.5 h-3.5" />
                  <span className="font-medium">Mode: {activeMode.short}</span>
                  <ChevronDown className="w-3 h-3 text-neutral-400" />
                </button>

                {isModeMenuOpen && (
                  <div className="absolute bottom-9 left-0 z-20 w-64 border border-neutral-800 bg-neutral-950 py-1 shadow-xl">
                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold tracking-wider text-neutral-500 border-b border-neutral-900">
                      Select Work Mode
                    </div>
                    {REFINE_MODES.map((mode) => {
                      const Icon = MODE_ICONS[mode.id];
                      const isSelected = mode.id === refineMode;
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => {
                            onRefineModeChange(mode.id);
                            setIsModeMenuOpen(false);
                          }}
                          className={`w-full px-3 py-2 text-left flex items-start justify-between hover:bg-neutral-900 transition-colors cursor-pointer ${
                            isSelected ? 'text-white bg-neutral-900/50' : 'text-neutral-400'
                          }`}
                        >
                          <div className="flex items-start gap-2 min-w-0">
                            <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isSelected ? 'text-emerald-400' : 'text-neutral-500'}`} />
                            <div>
                              <div className="text-xs font-medium text-neutral-200">{mode.label}</div>
                              <div className="text-[10px] text-neutral-500 leading-tight mt-0.5">{mode.hint}</div>
                            </div>
                          </div>
                          {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 ml-2 mt-0.5" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Attach File */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsAttachMenuOpen((open) => !open)}
                  disabled={workspaceFiles.length === 0}
                  title="Attach file context"
                  className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                {isAttachMenuOpen && (
                  <div className="absolute bottom-8 left-0 z-10 w-48 max-h-48 overflow-y-auto border border-neutral-800 bg-neutral-950 py-1 shadow-xl">
                    {workspaceFiles.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => {
                          onAttachedFileChange(file.name);
                          setIsAttachMenuOpen(false);
                        }}
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-900 hover:text-white cursor-pointer"
                      >
                        {file.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Speech to text */}
              {speech.isSupported && (
                <button
                  type="button"
                  onClick={() => (speech.isListening ? speech.stop() : speech.start())}
                  title={speech.isListening ? 'Stop recording voice' : 'Dictate with microphone'}
                  className={`p-1.5 transition-colors cursor-pointer ${
                    speech.isListening ? 'text-red-400 animate-pulse' : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  {speech.isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                </button>
              )}

              {/* Refine prompt button */}
              {hasKey && (
                <button
                  type="button"
                  onClick={onRefinePrompt}
                  disabled={!input.trim() || isRefining || isGenerating}
                  title="Auto-refine prompt with AI"
                  className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Right side: Token count & Send Button */}
            <div className="flex items-center gap-2">
              {input.length > 0 && (
                <span className="text-[10px] text-neutral-500 font-mono hidden sm:inline">
                  {input.length}c · ~{estimateTokens(input)} tok
                </span>
              )}

              {isGenerating ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-red-900/60 text-red-400 text-[11px] hover:bg-red-950/30 transition-colors cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onSend}
                  disabled={!canSend}
                  title={
                    usage.isCapReached
                      ? 'Monthly message cap reached. Upgrade to continue.'
                      : 'Send message (Enter)'
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-black text-[11px] font-semibold hover:bg-neutral-200 disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <Send className="w-3 h-3" />
                  Send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
