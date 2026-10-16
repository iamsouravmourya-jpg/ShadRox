import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Wand2
} from 'lucide-react';
import { maskFileWrites, renderMarkdownContent } from '../lib/markdown';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import { getRefineMode, REFINE_MODES } from '../lib/ai';
import { getProviderMeta, type ModelInfo, type ModelTier, type ProviderId } from '../lib/providers';
import type { ChatMessage, RefineMode, WorkspaceFile } from '../lib/types';
import type { CheckpointMeta } from '../lib/history';

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClearChat: () => void;
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
  onOpenSettings: () => void;
  attachedFileName: string | null;
  onAttachedFileChange: (fileName: string | null) => void;
  workspaceFiles: WorkspaceFile[];
  /** Snapshots taken before each reply, used by the per-message restore button. */
  checkpoints: CheckpointMeta[];
  onRestoreCheckpoint: (id: string) => void;
  restoringCheckpointId: string | null;
}

const TIER_STYLES: Record<ModelTier, string> = {
  free: 'text-emerald-400 border-emerald-900/60 bg-emerald-950/30',
  pro: 'text-amber-400 border-amber-900/60 bg-amber-950/30'
};

export function ChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  onStop,
  onClearChat,
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
  onOpenSettings,
  attachedFileName,
  onAttachedFileChange,
  workspaceFiles,
  checkpoints,
  onRestoreCheckpoint,
  restoringCheckpointId
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const speech = useSpeechRecognition('hi-IN');
  const activeMode = getRefineMode(refineMode);

  useEffect(() => {
    if (speech.transcript) onInputChange(speech.transcript);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.transcript]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const activeModel = models.find((model) => model.id === selectedModel) || null;
  const canSend = input.trim().length > 0 && !isGenerating;

  const groupedModels: Record<ModelTier, ModelInfo[]> = {
    free: models.filter((model) => model.tier === 'free'),
    pro: models.filter((model) => model.tier === 'pro')
  };

  return (
    <div className="h-full flex flex-col bg-black border-r border-neutral-900">
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-neutral-900">
        <button
          type="button"
          onClick={() => setIsModelMenuOpen((open) => !open)}
          disabled={models.length === 0}
          className="flex items-center gap-2 text-xs text-neutral-200 hover:text-white disabled:opacity-50 transition-colors cursor-pointer min-w-0"
        >
          <span className="truncate max-w-[180px]">{activeModel ? activeModel.label : 'No model — add a key'}</span>
          {activeModel && (
            <span className={`px-1.5 py-0.5 border text-[10px] uppercase tracking-wide ${TIER_STYLES[activeModel.tier]}`}>
              {activeModel.tier}
            </span>
          )}
          <ChevronDown className="w-3 h-3 shrink-0" />
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onClearChat}
            title="Clear chat"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="Settings"
            className="p-1.5 text-neutral-500 hover:text-white transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {isModelMenuOpen && (
        <div className="shrink-0 max-h-64 overflow-y-auto border-b border-neutral-900 bg-neutral-950">
          {models.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                setIsModelMenuOpen(false);
                onOpenSettings();
              }}
              className="w-full px-3 py-4 text-left text-xs text-neutral-400 hover:text-white cursor-pointer"
            >
              Koi model available nahi. Settings me apni key add karo.
            </button>
          ) : (
            (['free', 'pro'] as ModelTier[]).map((tier) =>
              groupedModels[tier].length === 0 ? null : (
                <div key={tier}>
                  <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">
                    {tier === 'free' ? 'Free models' : 'Pro models'}
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
                          {(model.contextWindow / 1000).toFixed(0)}k ctx
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

      {!hasKey && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="shrink-0 px-3 py-2 text-left text-[11px] text-amber-400/90 bg-amber-950/20 border-b border-amber-900/40 hover:bg-amber-950/40 transition-colors cursor-pointer"
        >
          BYOK: apni Groq ya Gemini key add karo, ya Devora key use karo →
        </button>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-xs text-neutral-600 leading-relaxed">
            <p className="text-neutral-400">Kaam shuru karo.</p>
            <p className="mt-2">Kisi bhi language me likho — Hindi, English, Hinglish. Devora use samajh kar structured prompt me badal deta hai.</p>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className="text-xs">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`text-[10px] uppercase tracking-wider ${message.role === 'user' ? 'text-neutral-500' : 'text-emerald-400'}`}>
                {message.role === 'user' ? 'You' : 'Devora'}
              </span>
              <span className="text-[10px] text-neutral-700">{message.timestamp}</span>
            </div>

            {message.refinedMeta && (
              <div className="mb-2 border border-neutral-900 bg-neutral-950 px-2.5 py-2 text-[11px] text-neutral-500">
                <div className="flex items-center gap-1.5 text-emerald-500/80">
                  <Sparkles className="w-3 h-3" />
                  <span className="uppercase tracking-wider text-[10px]">Prompt refined</span>
                </div>
                <div className="mt-1.5 text-neutral-400">Lang: {message.refinedMeta.detectedLanguage}</div>
                {message.refinedMeta.intent && <div className="text-neutral-400">Intent: {message.refinedMeta.intent}</div>}
                {message.refinedMeta.mode && (
                  <div className="text-neutral-400">Mode: {getRefineMode(message.refinedMeta.mode).label}</div>
                )}
              </div>
            )}

            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {message.attachments.map((name) => (
                  <span key={name} className="px-1.5 py-0.5 border border-neutral-800 text-[10px] text-neutral-400 font-mono">
                    {name}
                  </span>
                ))}
              </div>
            )}

            {message.role === 'user' ? (
              <p className="text-neutral-200 leading-relaxed whitespace-pre-wrap">{message.content}</p>
            ) : (
              <div>
                {message.content ? (
                  renderMarkdownContent(maskFileWrites(message.content, workspaceFiles))
                ) : message.streaming ? (
                  <span className="inline-flex items-center gap-2 text-neutral-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    soch raha hai...
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
                        title={`Is reply se pehle wala code wapas lao (${checkpoint.fileCount} files)`}
                        className="mt-1.5 flex items-center gap-1 text-[10px] text-neutral-500 hover:text-amber-400 disabled:opacity-40 transition-colors cursor-pointer"
                      >
                        {restoringCheckpointId === checkpoint.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3 h-3" />
                        )}
                        Restore code before this reply
                      </button>
                    );
                  })()}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-neutral-900 p-3">
        <div className="mb-2 flex items-center gap-1">
          {REFINE_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => onRefineModeChange(mode.id)}
              title={mode.hint}
              className={`px-2 py-1 border text-[10px] transition-colors cursor-pointer ${
                mode.id === refineMode
                  ? 'border-emerald-800/70 bg-emerald-950/30 text-emerald-300'
                  : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {mode.short}
            </button>
          ))}
          <span className="ml-1 truncate text-[10px] text-neutral-600">{activeMode.hint}</span>
        </div>

        {isRefining && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-emerald-400/80">
            <Loader2 className="w-3 h-3 animate-spin" />
            {refineStep || 'Prompt refine ho raha hai...'}
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

        <div className="border border-neutral-800 focus-within:border-neutral-600 transition-colors">
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
            placeholder="Kuch bhi likho ya bolo..."
            className="w-full resize-none bg-black text-xs text-neutral-100 px-3 py-2.5 outline-none placeholder:text-neutral-600"
          />

          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              {speech.isSupported && (
                <button
                  type="button"
                  onClick={() => (speech.isListening ? speech.stop() : speech.start())}
                  title={speech.isListening ? 'Stop voice input' : 'Voice input'}
                  className={`p-1.5 transition-colors cursor-pointer ${
                    speech.isListening ? 'text-red-400' : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  {speech.isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                </button>
              )}

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsAttachMenuOpen((open) => !open)}
                  disabled={workspaceFiles.length === 0}
                  title="Attach workspace file as context"
                  className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                {isAttachMenuOpen && (
                  <div className="absolute bottom-8 left-0 z-10 max-h-48 w-52 overflow-y-auto border border-neutral-800 bg-neutral-950">
                    {workspaceFiles.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => {
                          onAttachedFileChange(file.name);
                          setIsAttachMenuOpen(false);
                        }}
                        className="block w-full truncate px-3 py-1.5 text-left text-[11px] font-mono text-neutral-400 hover:bg-neutral-900 hover:text-white cursor-pointer"
                      >
                        {file.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={onRefinePrompt}
                disabled={!input.trim() || isRefining || isGenerating}
                title="Translate + refine prompt"
                className="flex items-center gap-1 p-1.5 text-neutral-500 hover:text-emerald-400 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <Wand2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {isGenerating ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-red-900/60 text-red-400 text-[11px] hover:bg-red-950/40 transition-colors cursor-pointer"
              >
                <Square className="w-3 h-3" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white text-black text-[11px] font-semibold disabled:opacity-40 hover:bg-neutral-200 transition-colors cursor-pointer"
              >
                <Send className="w-3 h-3" />
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
