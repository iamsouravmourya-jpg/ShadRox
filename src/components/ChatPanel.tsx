import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileCode2,
  FileDiff,
  FileText,
  Loader2,
  MessageSquarePlus,
  Mic,
  MicOff,
  Paperclip,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Settings,
  Sparkles,
  Square,
  Undo2,
  Wand2,
  X,
  Zap
} from 'lucide-react';
import { maskFileWrites, renderMarkdownContent } from '../lib/markdown';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { getRefineMode, REFINE_MODES } from '../lib/ai';
import { getProviderMeta, type ModelInfo, type ModelTier } from '../lib/providers';
import { getMonthlyUsage, onQuotaChange, type UsageState } from '../lib/quota';
import { estimateTokens } from '../lib/toolUtils';
import { getPlanMeta, PLANS_LOCKED } from '../lib/plans';
import type { ChatMessage, PatchSet, PlanTier, RefineMode, SettingsTab, WorkspaceFile } from '../lib/types';
import type { CheckpointMeta } from '../lib/history';
import type { DesktopPreviewState, PreviewApprovalRequest } from '../lib/desktop';

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearChat?: () => void;
  onRegenerate?: () => void;
  canRegenerate?: boolean;
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
  patchSets: PatchSet[];
  autoApplyChanges: boolean;
  onToggleAutoApply: () => void;
  onAcceptPatch: (messageId: string, patchIndex: number) => void;
  onRejectPatch: (messageId: string, patchIndex: number) => void;
  onAcceptAllPatches: (messageId: string) => void;
  onUndoPatch: (messageId: string, patchIndex: number) => void;
  onResume: (messageId: string) => void;
  /** One-line notice when a request had to be degraded to fit the context window. */
  contextNotice?: string | null;
  onDismissContextNotice?: () => void;
}

const TIER_STYLES: Record<ModelTier, string> = {
  free: 'text-violet-300 border-violet-300/25 bg-violet-500/10',
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
  onClearChat,
  onRegenerate,
  canRegenerate = false,
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
  hasPreviewDiagnostics,
  patchSets,
  autoApplyChanges,
  onToggleAutoApply,
  onAcceptPatch,
  onRejectPatch,
  onAcceptAllPatches,
  onUndoPatch,
  onResume,
  contextNotice = null,
  onDismissContextNotice
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
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
  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'model')?.id ?? null;

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1600);
    } catch {
      /* clipboard is unavailable in some environments */
    }
  };

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
          pill: 'border-violet-300/25 bg-violet-500/[.07] text-violet-300 hover:border-violet-300/45',
          icon: 'text-violet-300'
        };

  const proPlan = getPlanMeta('pro');

  const groupedModels: Record<ModelTier, ModelInfo[]> = {
    free: models.filter((model) => model.tier === 'free'),
    pro: models.filter((model) => model.tier === 'pro')
  };

  const ActiveModeIcon = MODE_ICONS[refineMode] || Code2;

  return (
    <div className="h-full flex flex-col bg-ink-950 border-r border-white/[0.07] select-text">
      {/* Header */}
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-white/[0.07]">
        <button
          type="button"
          onClick={() => setIsModelMenuOpen((open) => !open)}
          disabled={models.length === 0}
          className="flex items-center gap-2 text-xs text-neutral-200 hover:text-white disabled:opacity-50 transition-colors cursor-pointer min-w-0"
        >
          <span className="truncate max-w-[150px]">{activeModel ? activeModel.label : 'Select Model'}</span>
          {activeModel && (
            <span className={`rounded px-1.5 py-0.5 border text-[10px] uppercase tracking-wide ${TIER_STYLES[activeModel.tier]}`}>
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
            className={`flex items-center gap-1 rounded-full px-2 py-1 border text-[10px] tracking-wide transition-colors cursor-pointer ${quotaTone.pill}`}
          >
            <Zap className={`w-3 h-3 ${quotaTone.icon}`} />
            <span className="font-mono">{usage.count}/{usage.isUnlimited ? '∞' : usage.limit}</span>
          </button>

          {plan === 'free' && !PLANS_LOCKED && (
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
            onClick={onClearChat}
            disabled={messages.length === 0 || isGenerating}
            title="Start a new chat"
            className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>

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
        <div className="shrink-0 max-h-64 overflow-y-auto border-b border-white/[0.07] bg-ink-950">
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
                      className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-white/[0.04] cursor-pointer ${
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
            <Sparkles className="w-6 h-6 text-violet-300/70 mb-2" />
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
                    className="rounded-md border border-white/[0.09] bg-white/[0.04] px-2 py-0.5 text-[10px] font-mono text-neutral-400"
                  >
                    {file}
                  </span>
                ))}
              </div>
            )}

            {message.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-violet-300/15 bg-violet-500/[.10] px-3.5 py-2.5 text-neutral-100 leading-relaxed whitespace-pre-wrap">
                {message.content}
              </div>
            ) : (
              <div className="max-w-[95%] text-neutral-200 leading-relaxed">
                {message.reasoning && (
                  <details
                    open={Boolean(message.streaming)}
                    className="mb-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-[11px] text-neutral-400"
                  >
                    <summary className="flex cursor-pointer items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
                      <Brain className="w-3 h-3" />
                      Reasoning
                      {message.streaming && <Loader2 className="w-3 h-3 animate-spin text-violet-300" />}
                    </summary>
                    <div className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-neutral-500">
                      {message.reasoning}
                    </div>
                  </details>
                )}

                {message.content ? (
                  renderMarkdownContent(maskFileWrites(message.content, workspaceFiles))
                ) : message.streaming ? (
                  <span className="inline-flex items-center gap-2 text-neutral-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-300" />
                    Thinking...
                  </span>
                ) : null}

                {(() => {
                  const patchSet = patchSets.find((set) => set.messageId === message.id);
                  if (!patchSet || message.streaming) return null;
                  const pendingCount = patchSet.patches.filter((patch) => patch.status === 'pending').length;
                  return (
                    <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 text-[11px]">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-neutral-300 font-medium">
                          <FileDiff className="w-3.5 h-3.5 text-violet-300 shrink-0" />
                          Changes · {patchSet.patches.length} file{patchSet.patches.length > 1 ? 's' : ''}
                        </div>
                        <div className="flex items-center gap-2">
                          <label
                            title="Apply AI file changes immediately instead of asking first"
                            className="flex items-center gap-1 text-[10px] text-neutral-500 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={autoApplyChanges}
                              onChange={onToggleAutoApply}
                              className="accent-violet-400 cursor-pointer"
                            />
                            Auto-apply
                          </label>
                          {pendingCount > 0 && (
                            <button
                              type="button"
                              onClick={() => onAcceptAllPatches(message.id)}
                              className="rounded-md border border-violet-300/25 bg-violet-500/[.12] px-2 py-0.5 text-[10px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/20 cursor-pointer"
                            >
                              Accept all
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="space-y-1">
                        {patchSet.patches.map((patch, index) => (
                          <div
                            key={`${patch.path}-${index}`}
                            className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-ink-950/60 px-2 py-1"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <FileCode2 className="w-3 h-3 text-neutral-500 shrink-0" />
                              <span className="font-mono truncate text-neutral-300">{patch.path}</span>
                              <span className="text-[9px] uppercase tracking-wide text-neutral-600 shrink-0">
                                {patch.kind === 'searchReplace' ? `${patch.blocks?.length ?? 0} s/r` : 'rewrite'}
                              </span>
                              {patch.failure && (
                                <span
                                  className="flex items-center gap-1 text-rose-400 min-w-0"
                                  title={patch.failure}
                                >
                                  <AlertTriangle className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{patch.failure}</span>
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {patch.status === 'pending' && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => onAcceptPatch(message.id, index)}
                                    title={`Apply changes to ${patch.path}`}
                                    className="flex items-center gap-1 rounded-md border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/10 cursor-pointer"
                                  >
                                    <Check className="w-3 h-3" />
                                    Accept
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => onRejectPatch(message.id, index)}
                                    title={`Skip changes to ${patch.path}`}
                                    className="flex items-center gap-1 rounded-md border border-white/[0.12] px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-white/[0.05] hover:text-neutral-200 cursor-pointer"
                                  >
                                    <X className="w-3 h-3" />
                                    Skip
                                  </button>
                                </>
                              )}
                              {patch.status === 'applied' && (
                                <>
                                  <span
                                    className={
                                      patch.disk === 'saved'
                                        ? 'flex items-center gap-1 text-emerald-400'
                                        : 'flex items-center gap-1 text-amber-400'
                                    }
                                    title={
                                      patch.disk === 'saved'
                                        ? 'Written to your file on disk'
                                        : patch.diskMessage ||
                                          'Saved in the editor buffer — not yet written to disk'
                                    }
                                  >
                                    <Check className="w-3 h-3" />
                                    {patch.disk === 'saved' ? 'Saved to disk' : 'Applied in editor'}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => onUndoPatch(message.id, index)}
                                    title={`Revert ${patch.path} to its previous content`}
                                    className="rounded-md border border-white/[0.12] p-0.5 text-neutral-400 transition-colors hover:border-amber-300/40 hover:text-amber-300 cursor-pointer"
                                  >
                                    <Undo2 className="w-3 h-3" />
                                  </button>
                                </>
                              )}
                              {patch.status === 'reverted' && (
                                <span className="text-neutral-500">
                                  {patch.disk === 'saved' ? 'Reverted on disk' : 'Reverted in editor'}
                                </span>
                              )}
                              {patch.status === 'rejected' && <span className="text-neutral-500">Skipped</span>}
                              {patch.status === 'failed' && (
                                <button
                                  type="button"
                                  onClick={() => onAcceptPatch(message.id, index)}
                                  className="rounded-md border border-white/[0.12] px-2 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-white/[0.05] cursor-pointer"
                                >
                                  Retry
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {!message.streaming && (message.content || message.id === lastAssistantId) && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-neutral-500">
                    {message.content && (
                      <button
                        type="button"
                        onClick={() => void copyMessage(message)}
                        title="Copy reply"
                        className="flex items-center gap-1 transition-colors hover:text-neutral-200 cursor-pointer"
                      >
                        {copiedMessageId === message.id ? (
                          <Check className="w-3 h-3 text-emerald-400" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                      </button>
                    )}
                    {message.id === lastAssistantId && canRegenerate && !isGenerating && (
                      <button
                        type="button"
                        onClick={onRegenerate}
                        title="Regenerate this reply"
                        className="flex items-center gap-1 transition-colors hover:text-neutral-200 cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Regenerate
                      </button>
                    )}
                    {message.resumable && !isGenerating && (
                      <button
                        type="button"
                        onClick={() => onResume(message.id)}
                        title="The stream was interrupted — continue this reply from where it stopped"
                        className="flex items-center gap-1 text-violet-300 transition-colors hover:text-violet-200 cursor-pointer"
                      >
                        <Play className="w-3 h-3" />
                        Resume reply
                      </button>
                    )}
                    {message.metrics && (message.metrics.tokens > 0 || message.metrics.firstTokenMs !== null) && (
                      <span
                        className="flex items-center gap-1 font-mono text-neutral-600"
                        title="Time to first token · total tokens · total duration"
                      >
                        <Zap className="w-3 h-3" />
                        {message.metrics.firstTokenMs !== null ? `${message.metrics.firstTokenMs}ms` : '—'}
                        {message.metrics.tokens > 0 ? ` · ${message.metrics.tokens} tok` : ''}
                        {message.metrics.durationMs ? ` · ${(message.metrics.durationMs / 1000).toFixed(1)}s` : ''}
                      </span>
                    )}
                  </div>
                )}

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
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[.06] p-3 text-[11px]">
            <div className="flex items-center gap-2 text-amber-300 font-semibold">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              Approve project setup
            </div>
            <p className="mt-2 text-neutral-300">
              ShadRox found <span className="font-mono text-white">{previewApproval.projectPath}</span> and wants to run:
            </p>
            <code className="mt-1 block break-all rounded-lg border border-white/[0.09] bg-ink-950/60 p-2 text-violet-200">
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
                className="rounded-lg border border-violet-300/25 bg-violet-500/[.12] px-3 py-1.5 text-violet-200 transition-colors hover:bg-violet-500/20 cursor-pointer"
              >
                Approve once &amp; run
              </button>
              <button
                type="button"
                onClick={onCancelPreviewApproval}
                className="rounded-lg border border-white/[0.12] px-3 py-1.5 text-neutral-300 transition-colors hover:bg-white/[0.05] cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/*
        Context-window degradation notice: one line, dismissible, and never a
        modal — the request still went through, the user just deserves to know
        what the model did not get to see.
      */}
      {contextNotice && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-amber-300/15 bg-amber-400/[0.06] px-3 py-1.5 text-[10.5px] text-amber-200/90"
        >
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={contextNotice}>
            {contextNotice}
          </span>
          <button
            type="button"
            onClick={onDismissContextNotice}
            aria-label="Dismiss context notice"
            className="rounded p-0.5 text-amber-200/60 transition-colors hover:text-white cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Input Area & Prompt Box */}
      <div className="shrink-0 border-t border-white/[0.07] p-3 bg-ink-950">
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
                className="rounded-lg border border-white/[0.09] px-2 py-1 text-[10px] text-neutral-300 transition-colors hover:border-red-500/40 hover:text-red-300 cursor-pointer"
              >
                Stop preview
              </button>
            ) : (
              <button
                type="button"
                onClick={onRunPreview}
                disabled={previewState.status === 'starting' || Boolean(previewApproval)}
                className="rounded-lg border border-violet-300/25 px-2 py-1 text-[10px] text-violet-200 transition-colors hover:bg-violet-500/[.12] disabled:opacity-40 cursor-pointer"
              >
                {previewState.status === 'starting' ? 'Checking project…' : 'Run preview'}
              </button>
            )}
          </div>
        </div>

        {/* Monthly Cap Warning Banner */}
        {usage.isCapReached && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-rose-500/25 bg-rose-500/[.07] p-2 text-[11px] text-rose-300">
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="truncate">Monthly cap reached ({usage.limit}/{usage.limit} msgs)</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenSettings('PLAN')}
              className="shrink-0 rounded-md bg-rose-500 px-2.5 py-0.5 text-[10px] font-semibold text-white transition-colors hover:bg-rose-400 cursor-pointer"
            >
              Settings
            </button>
          </div>
        )}

        {isRefining && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-violet-300/80">
            <Loader2 className="w-3 h-3 animate-spin" />
            {refineStep || 'Refining prompt...'}
          </div>
        )}

        {attachedFileName && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-white/[0.09] px-2.5 py-1.5 text-[11px] text-neutral-400">
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
        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.03] transition-colors focus-within:border-violet-300/40 focus-within:bg-white/[0.04]">
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
                ? 'Monthly message cap reached. Manage usage in Settings...'
                : 'Ask ShadRox to build, refactor, or explain code...'
            }
            disabled={usage.isCapReached}
            className="w-full resize-none rounded-2xl bg-transparent px-3.5 py-3 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-50"
          />

          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1.5">
              {/* Work Mode Dropdown (Replaces old template option with Code, Plan, Complex) */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsModeMenuOpen((open) => !open)}
                  title={`Active mode: ${activeMode.label} — ${activeMode.hint}`}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                    refineMode === 'plan'
                      ? 'border-amber-500/30 bg-amber-500/[.08] text-amber-300'
                      : refineMode === 'complex'
                        ? 'border-purple-400/30 bg-purple-500/[.10] text-purple-300'
                        : 'border-violet-300/30 bg-violet-500/10 text-violet-200'
                  }`}
                >
                  <ActiveModeIcon className="w-3.5 h-3.5" />
                  <span className="font-medium">Mode: {activeMode.short}</span>
                  <ChevronDown className="w-3 h-3 text-neutral-400" />
                </button>

                {isModeMenuOpen && (
                  <div className="absolute bottom-9 left-0 z-20 w-64 overflow-hidden rounded-xl border border-white/[0.09] bg-ink-900/95 py-1 shadow-2xl backdrop-blur-xl">
                    <div className="border-b border-white/[0.07] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral-500">
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
                          className={`w-full px-3 py-2 text-left flex items-start justify-between transition-colors hover:bg-white/[0.05] cursor-pointer ${
                            isSelected ? 'bg-violet-500/[.12] text-violet-100' : 'text-neutral-400'
                          }`}
                        >
                          <div className="flex items-start gap-2 min-w-0">
                            <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isSelected ? 'text-violet-300' : 'text-neutral-500'}`} />
                            <div>
                              <div className="text-xs font-medium text-neutral-200">{mode.label}</div>
                              <div className="text-[10px] text-neutral-500 leading-tight mt-0.5">{mode.hint}</div>
                            </div>
                          </div>
                          {isSelected && <Check className="w-3.5 h-3.5 text-violet-300 shrink-0 ml-2 mt-0.5" />}
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
                  <div className="absolute bottom-8 left-0 z-10 max-h-48 w-48 overflow-y-auto rounded-xl border border-white/[0.09] bg-ink-900/95 py-1 shadow-2xl backdrop-blur-xl">
                    {workspaceFiles.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => {
                          onAttachedFileChange(file.name);
                          setIsAttachMenuOpen(false);
                        }}
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-neutral-400 hover:bg-white/[0.04] hover:text-white cursor-pointer"
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
                  className="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-[11px] text-red-300 transition-colors hover:bg-red-500/10 cursor-pointer"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onSend()}
                  disabled={!canSend}
                  title={
                    usage.isCapReached
                      ? 'Monthly message cap reached. Manage usage in Settings.'
                      : 'Send message (Enter)'
                  }
                  className="flex items-center gap-1.5 rounded-lg bg-violet-300 px-3.5 py-1.5 text-[11px] font-semibold text-[#16121f] transition-colors hover:bg-violet-200 disabled:opacity-30 disabled:hover:bg-violet-300 cursor-pointer"
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
