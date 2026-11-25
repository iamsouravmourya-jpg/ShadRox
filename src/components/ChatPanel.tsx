import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  FileDiff,
  FileText,
  KeyRound,
  Loader2,
  ListTree,
  MessageSquarePlus,
  Paperclip,
  Pause,
  Play,
  Clock,
  Image,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  Undo2,
  Wand2,
  X,
  Zap
} from 'lucide-react';
import { maskFileWrites, renderMarkdownContent, type PatchWriteOutcome } from '../lib/markdown';
import { type ModelInfo, type ModelTier } from '../lib/providers';
import { computeHunks, groupedHunkId, hunkStats } from '../lib/editor/hunks';
import type { Skill } from '../lib/skills';
import { contextManifestTotals, shouldSubmitOnEnter, type ContextManifest } from '../lib/contextManifest';
import type { ChatMessage, ExternalFileAttachment, PatchSet, RefineMode, SemanticStatus, SettingsTab, WorkspaceFile } from '../lib/types';
import type { CheckpointMeta } from '../lib/history';
import { ShadRoxLogo } from './Logo';
import { ChatEmptyState } from './chat/ChatEmptyState';
import {
  CollapsiblePatchFailurePill,
  OrchestrationCard,
  SelfHealingProofCard,
  StreamingResponseFooter,
  TaskPlanView,
  ThinkingTrace,
  ToolActivityFeed,
  SubagentActivityFeed,
  type SubagentActivityItem,
  VerificationOutcomeBanner,
  WorkingResponseSkeleton
} from './chat/AssistantActivityView';
import { appendMentionTrigger, computeComposerHeight, describeLivePhase, formatTurnElapsed, stripTrailingMention } from './chat/chatUx';
import { SUBAGENT_EVENT, type SubagentProgress } from '../lib/agent/subagent';
import { loadWorkspaceUiState, saveWorkspaceSubagents } from '../lib/workspaceStateStore';

/** A symbol the user pinned with `@`, sent as an explicit context marker. */
export interface PinnedSymbol {
  name: string;
  file: string;
  line?: number;
}

/** A symbol the active file offers to the `@` picker. */
export interface MentionSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
}

interface MentionItem {
  id: string;
  kind: 'file' | 'symbol';
  label: string;
  file: string;
  line?: number;
  symbolKind?: string;
}

/** A long paste captured as a .txt attachment instead of flooding the composer. */
export interface PastedText {
  id: string;
  name: string;
  content: string;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: (pastedTexts?: PastedText[], externalAttachments?: ExternalFileAttachment[]) => void;
  userFirstName?: string | null;
  workspaceKey?: string | null;
  restorableMessageIds?: ReadonlySet<string>;
  restorableCheckpointTooltips?: Readonly<Record<string, string>>;
  onRestorePromptCheckpoint?: (userMessageId: string) => void;
  queuedMessages?: Array<{ id: string; text: string }>;
  onCancelQueuedMessage?: (id: string) => void;
  onStop: () => void;
  /** Halts an in-flight run at its next boundary, leaving it resumable. */
  onPauseOrchestration?: () => void;
  /** Continues a paused run from the milestones it already paid for. */
  onResumeOrchestration?: (messageId: string) => void;
  onClearChat?: () => void;
  isGenerating: boolean;
  isRefining: boolean;
  refineStep: string;
  onRefinePrompt: () => void;
  /** S18: restore the pre-refinement draft; shown only while the refined text is still in the box. */
  onUndoRefine?: () => void;
  canUndoRefine?: boolean;
  refineMode: RefineMode;
  onRefineModeChange: (mode: RefineMode) => void;
  models: ModelInfo[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  hasKey: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
  attachedFiles: string[];
  onAttachedFilesChange: (fileNames: string[]) => void;
  attachedImage: string | null;
  onAttachedImageChange: (image: string | null) => void;
  /** Symbols from the active file; choosing one pins it and attaches its file. */
  symbols?: MentionSymbol[];
  pinnedSymbols: PinnedSymbol[];
  onPinnedSymbolsChange: (symbols: PinnedSymbol[]) => void;
  workspaceFiles: WorkspaceFile[];
  /** Every file in the folder tree, not just the open tabs: powers @-mention and attach. */
  workspaceAllFiles?: Array<{ name: string }>;
  checkpoints: CheckpointMeta[];
  onRestoreCheckpoint: (id: string) => void;
  restoringCheckpointId: string | null;
  patchSets: PatchSet[];
  autoApplyChanges: boolean;
  onToggleAutoApply: () => void;
  /** Auto: a cheap model picks which files to read, the answer model reads them. */
  autoContext: boolean;
  onToggleAutoContext: () => void;
  /** Local-embedding re-rank: BM25 shortlist, embeddings order the top hits. */
  semanticRetrieval: boolean;
  semanticStatus: SemanticStatus;
  semanticChunkCount: number;
  onToggleSemanticRetrieval: () => void;
  /** The repo map that accompanies a request, shown so the user can audit it. */
  repoMap?: string;
  /** True while the first bounded read of a newly opened folder is running. */
  repoMapLoading?: boolean;
  /** The exact sources and token cost of the last sent request (S05). */
  contextManifest?: ContextManifest | null;
  /** `.shadrox/skills/*.md` of the opened folder; typed as `/name` in the composer. */
  skills?: Skill[];
  onAcceptPatch: (messageId: string, patchIndex: number) => void;
  onRejectPatch: (messageId: string, patchIndex: number) => void;
  onAcceptAllPatches: (messageId: string) => void;
  onUndoPatch: (messageId: string, patchIndex: number) => void;
  /** Applies only the accepted hunks of a pending rewrite, in file order. */
  onApplyPatchHunks: (messageId: string, patchIndex: number, acceptedIds: string[]) => void;
  /** Type errors the applied change set introduced, keyed by assistant message. */
  typeFixCounts?: Record<string, number>;
  onFixTypeErrors?: (messageId: string) => void;
  onResume: (messageId: string) => void;
  /** A run interrupted by the previous app close; null when nothing is restorable. */
  backgroundResume?: {
    summary: string;
    /** False when a key, folder or idle engine is missing right now. */
    available: boolean;
    onResume: () => void;
    onDismiss: () => void;
  } | null;
  /** One-line notice when a request had to be degraded to fit the context window. */
  contextNotice?: string | null;
  onDismissContextNotice?: () => void;
  /** Callback when user approves a multi-step plan proposal. */
  onApprovePlan?: (messageId: string) => void;
  /** Callback when user rejects a plan proposal. */
  onRejectPlan?: (messageId: string) => void;
  /** Real-time status string emitted while the agent is planning, reading, editing, or testing. */
  activeStatusMessage?: string | null;
  /** A pending ask_user question: the tool loop is paused until the user picks or dismisses. */
  askUserPrompt?: { id: string; question: string; options: string[] } | null;
  /** answer=null dismisses the question (the agent proceeds with a stated assumption). */
  onAnswerAskUser?: (id: string, answer: string | null) => void;
}

// The tier describes what the *provider* charges the user's own key, never a
// ShadRox plan — ShadRox bills nothing.
const TIER_GROUP_LABEL: Record<ModelTier, string> = {
  free: 'Free on your key',
  own: 'Your endpoint',
  pro: 'Paid on your key'
};

/** A long paste is captured as a .txt attachment instead of flooding the composer. */
const PASTE_AS_FILE_CHARS = 4000;
const PASTE_AS_FILE_LINES = 60;

/**
 * The honest one-line provenance for an answer (S10): the route the request
 * asked for, and the model the provider said it served when that differed.
 * A served identity is only shown when the provider actually reported one —
 * never inferred from the request.
 */
function describeAnswerRoute(metrics: NonNullable<ChatMessage['metrics']>, models: ModelInfo[]): string {
  const requested = metrics.model
    ? models.find((model) => model.id === metrics.model)?.label ?? metrics.model
    : null;
  if (!requested) return 'Served model not recorded';
  if (metrics.servedModel && metrics.servedModel !== metrics.model) {
    const served = models.find((model) => model.id === metrics.servedModel)?.label ?? metrics.servedModel;
    return `${requested} → ${served}`;
  }
  return requested;
}



/** The slash form of a skill name; matches how the send path resolves `/name`. */
function skillKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

/** Workspace paths may differ in case or slash direction from the patch path. */
function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase() ===
    right.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

interface PatchHunkReviewProps {
  sections: Array<{
    key: string;
    label?: string;
    before: string;
    after: string;
    groupIndex?: number;
  }>;
  onApply: (acceptedIds: string[]) => void;
}

/**
 * Hunk-by-hunk review for rewrites and search/replace blocks. Accepted ids are
 * grouped only for search/replace so each block can be merged independently.
 */
function PatchHunkReview({ sections, onApply }: PatchHunkReviewProps) {
  const groupedSections = useMemo(
    () => sections.map((section) => ({
      ...section,
      beforeLines: section.before.split('\n'),
      hunks: computeHunks(section.before, section.after).map((hunk) => ({
        ...hunk,
        reviewId: section.groupIndex === undefined ? hunk.id : groupedHunkId(section.groupIndex, hunk.id)
      }))
    })).filter((section) => section.hunks.length > 0),
    [sections]
  );
  const hunks = useMemo(() => groupedSections.flatMap((section) => section.hunks), [groupedSections]);
  const [rejected, setRejected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [open, setOpen] = useState(false);

  const acceptedIds = useMemo(
    () => hunks.filter((hunk) => !rejected.has(hunk.reviewId)).map((hunk) => hunk.reviewId),
    [hunks, rejected]
  );
  const stats = useMemo(
    () => groupedSections.reduce((total, section) => {
      const current = hunkStats(section.hunks);
      return { added: total.added + current.added, removed: total.removed + current.removed };
    }, { added: 0, removed: 0 }),
    [groupedSections]
  );

  if (hunks.length === 0) return null;
  const rejectedCount = hunks.length - acceptedIds.length;

  const toggle = (id: string) =>
    setRejected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="border-t border-line px-2 pb-1.5 pt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-[10px] text-ink-3 transition-colors hover:text-ink-2 cursor-pointer"
      >
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="font-medium">Review hunks</span>
        <span className="text-ok/90">+{stats.added}</span>
        <span className="text-danger/90">−{stats.removed}</span>
        <span className="text-ink-5">
          {hunks.length} hunk{hunks.length === 1 ? '' : 's'}
          {rejectedCount > 0 ? ` · ${rejectedCount} rejected` : ''}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {groupedSections.map((section) => (
            <div key={section.key} className="space-y-1.5">
              {section.label && (
                <div className="px-1 text-[10px] font-medium text-ink-4">{section.label}</div>
              )}
              {section.hunks.map((hunk) => {
                const isRejected = rejected.has(hunk.reviewId);
                const removed = hunk.beforeEnd - hunk.beforeStart;
            return (
              <div
                key={hunk.reviewId}
                className={`overflow-hidden rounded-md border ${
                  isRejected ? 'border-line opacity-50' : 'border-line-2'
                }`}
              >
                <div className="flex items-center justify-between gap-2 px-1.5 py-1">
                  <span className="font-mono text-[10px] text-ink-4">
                    line {hunk.beforeStart + 1}
                    {removed > 0 ? ` · −${removed}` : ''}
                    {hunk.afterLines.length > 0 ? ` +${hunk.afterLines.length}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(hunk.reviewId)}
                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer ${
                      isRejected
                        ? 'border-line-2 text-ink-3 hover:text-ink-2'
                        : 'border-ok/30 text-ok hover:bg-ok/10'
                    }`}
                  >
                    {isRejected ? <X className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                    {isRejected ? 'Rejected' : 'Accepted'}
                  </button>
                </div>
                <div className="max-h-40 overflow-auto px-1.5 pb-1.5 font-mono text-[10px] leading-relaxed">
                  {section.beforeLines.slice(hunk.beforeStart, hunk.beforeEnd).map((line, index) => (
                    <div key={`removed-${index}`} className="flex gap-1.5 whitespace-pre text-danger/90">
                      <span className="w-2 shrink-0 select-none text-danger/60">−</span>
                      <span>{line || ' '}</span>
                    </div>
                  ))}
                  {hunk.afterLines.map((line, index) => (
                    <div key={`added-${index}`} className="flex gap-1.5 whitespace-pre text-ok/90">
                      <span className="w-2 shrink-0 select-none text-ok/60">+</span>
                      <span>{line || ' '}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
              })}
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRejected(new Set())}
                className="text-[10px] text-ink-4 transition-colors hover:text-ink-3 cursor-pointer"
              >
                Accept all
              </button>
              <button
                type="button"
                onClick={() => setRejected(new Set(hunks.map((hunk) => hunk.reviewId)))}
                className="text-[10px] text-ink-4 transition-colors hover:text-ink-3 cursor-pointer"
              >
                Reject all
              </button>
            </div>
            <button
              type="button"
              disabled={acceptedIds.length === 0}
              onClick={() => onApply(acceptedIds)}
              className="rounded-md border border-accent-line bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent transition-colors hover:bg-accent-strong/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              Apply{' '}
              {acceptedIds.length === hunks.length
                ? 'all'
                : `${acceptedIds.length} hunk${acceptedIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  messages,
  input,
  onInputChange,
  onSend,
  userFirstName = null,
  workspaceKey = null,
  restorableMessageIds,
  restorableCheckpointTooltips,
  onRestorePromptCheckpoint,
  queuedMessages = [],
  onCancelQueuedMessage,
  onStop,
  onPauseOrchestration,
  onResumeOrchestration,
  onClearChat,
  isGenerating,
  isRefining,
  refineStep,
  onRefinePrompt,
  onUndoRefine,
  canUndoRefine = false,
  models,
  selectedModel,
  onSelectModel,
  hasKey,
  onOpenSettings,
  attachedFiles,
  onAttachedFilesChange,
  attachedImage,
  onAttachedImageChange,
  symbols = [],
  pinnedSymbols,
  onPinnedSymbolsChange,
  workspaceFiles,
  workspaceAllFiles = [],
  checkpoints,
  onRestoreCheckpoint,
  restoringCheckpointId,
  patchSets,
  autoApplyChanges,
  onToggleAutoApply,
  autoContext,
  semanticRetrieval,
  semanticStatus,
  semanticChunkCount,
  onToggleSemanticRetrieval,
  repoMap = '',
  repoMapLoading = false,
  contextManifest = null,
  skills = [],
  onToggleAutoContext,
  onAcceptPatch,
  onRejectPatch,
  onAcceptAllPatches,
  onUndoPatch,
  onApplyPatchHunks,
  typeFixCounts,
  onFixTypeErrors,
  onResume,
  backgroundResume = null,
  contextNotice = null,
  onDismissContextNotice,
  onApprovePlan,
  onRejectPlan,
  activeStatusMessage = null,
  askUserPrompt = null,
  onAnswerAskUser
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelSearchInputRef = useRef<HTMLInputElement>(null);
  const externalFileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [expandedPatchFailures, setExpandedPatchFailures] = useState<Record<string, boolean>>({});
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const [externalAttachments, setExternalAttachments] = useState<ExternalFileAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!isModelMenuOpen) {
      setModelSearchQuery('');
      return;
    }
    setModelSearchQuery('');
    const frame = requestAnimationFrame(() => modelSearchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isModelMenuOpen]);

  /** `/name` in the composer completes workspace skills when `.shadrox/skills/*.md` exist. */
  const typedSlashName = /^\/([\w.-]*)$/.exec(input)?.[1]?.toLowerCase() ?? null;
  const skillMatches = useMemo(() => {
    if (typedSlashName === null || slashDismissed || skills.length === 0) return [];
    const ordered = [...skills].sort((a, b) => skillKey(a.name).localeCompare(skillKey(b.name)));
    if (typedSlashName === '') return ordered.slice(0, 8);
    return ordered.filter((skill) => skillKey(skill.name).startsWith(typedSlashName)).slice(0, 8);
  }, [typedSlashName, slashDismissed, skills]);

  /** Insert a picked folder skill name into the composer. */
  const acceptSkillOption = (skill: Skill) => {
    handleInputChange(`/${skillKey(skill.name)} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  /** One dismissal path for every chat popover: outside click and Escape. */
  useEffect(() => {
    if (!isModelMenuOpen && !isContextOpen) return;
    const inside = (ref: { current: HTMLElement | null }, target: EventTarget | null) =>
      Boolean(ref.current && target instanceof Node && ref.current.contains(target));
    const closeOthers = (event: PointerEvent) => {
      if (!inside(modelMenuRef, event.target) && !inside(modelTriggerRef, event.target)) setIsModelMenuOpen(false);
      if (!inside(contextMenuRef, event.target)) setIsContextOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsModelMenuOpen(false);
      setIsContextOpen(false);
    };
    document.addEventListener('pointerdown', closeOthers);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOthers);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isModelMenuOpen, isContextOpen]);

  useEffect(() => {
    // Streaming rewrites `messages` on every delta; without this the pane
    // yanks the reader back down whenever they scroll up mid-reply.
    if (!stickToBottomRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const { height, overflowY } = computeComposerHeight(el.scrollHeight);
    el.style.height = `${height}px`;
    el.style.overflowY = overflowY;
  }, [input]);

  const activeModel = models.find((model) => model.id === selectedModel) || null;
  const hasDraft = input.trim().length > 0 || pastedTexts.length > 0 || externalAttachments.length > 0;
  const canSend = hasDraft && !isGenerating;
  const canQueue = hasDraft && isGenerating;
  const manifestTotals = contextManifest ? contextManifestTotals(contextManifest) : null;
  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'model')?.id ?? null;
  const streamingAssistant = [...messages].reverse().find((message) => message.role === 'model' && message.streaming) ?? null;
  const hasStreamingTimer = Boolean(streamingAssistant?.startedAt);
  const [turnNow, setTurnNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasStreamingTimer) return;
    setTurnNow(Date.now());
    const id = window.setInterval(() => setTurnNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [hasStreamingTimer]);

  // Live subagent scouts (SUBAGENT_EVENT): persisted per assistant message in
  // workspace-indexed storage so completed 2-agent parallel grids survive restarts.
  const targetAssistantIdRef = useRef<string | null>(lastAssistantId);
  targetAssistantIdRef.current = streamingAssistant?.id ?? lastAssistantId;
  const workspaceKeyRef = useRef<string | null>(workspaceKey);
  workspaceKeyRef.current = workspaceKey;
  const prevWorkspaceKeyRef = useRef<string | null>(workspaceKey);
  const prevMessageIdsRef = useRef<string[]>([]);
  const [subagentsByMessage, setSubagentsByMessage] = useState<Record<string, SubagentActivityItem[]>>({});

  useEffect(() => {
    setSubagentsByMessage({});
    if (!workspaceKey) return;
    let cancelled = false;
    void loadWorkspaceUiState(workspaceKey).then((loaded) => {
      if (cancelled || workspaceKeyRef.current !== workspaceKey) return;
      if (Object.keys(loaded.subagentsByMessage).length === 0) return;
      setSubagentsByMessage((previous) => ({
        ...loaded.subagentsByMessage,
        ...previous
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceKey]);

  useEffect(() => {
    const switchedWorkspace = prevWorkspaceKeyRef.current !== workspaceKey;
    prevWorkspaceKeyRef.current = workspaceKey;

    const prevIds = prevMessageIdsRef.current;
    const nextIds = messages.map((message) => message.id);
    prevMessageIdsRef.current = nextIds;

    if (switchedWorkspace) {
      return;
    }

    if (prevIds.length > 0 && nextIds.length === 0) {
      setSubagentsByMessage({});
      if (workspaceKeyRef.current) {
        void saveWorkspaceSubagents(workspaceKeyRef.current, {});
      }
      return;
    }

    if (nextIds.length === 0) return;
    const nextSet = new Set(nextIds);
    const hadRemovedMessage = prevIds.some((id) => !nextSet.has(id));
    const embeddedEntries = messages.filter(
      (message) => Array.isArray(message.subagents) && message.subagents.length > 0
    );

    if (!hadRemovedMessage && embeddedEntries.length === 0) return;
    setSubagentsByMessage((previous) => {
      let changed = false;
      const next: Record<string, SubagentActivityItem[]> = {};
      for (const [msgId, items] of Object.entries(previous)) {
        if (nextSet.has(msgId)) {
          next[msgId] = items;
        } else {
          changed = true;
        }
      }
      for (const message of embeddedEntries) {
        if (!next[message.id] && message.subagents) {
          next[message.id] = message.subagents;
          changed = true;
        }
      }
      if (!changed) return previous;
      if (hadRemovedMessage && workspaceKeyRef.current) {
        void saveWorkspaceSubagents(workspaceKeyRef.current, next);
      }
      return next;
    });
  }, [messages, workspaceKey]);

  useEffect(() => {
    const onSubagent = (event: Event) => {
      const detail = (event as CustomEvent<SubagentProgress>).detail;
      if (!detail || typeof detail.id !== 'string') return;
      const item: SubagentActivityItem = {
        id: detail.id,
        index: detail.index,
        title: detail.title,
        label: detail.label,
        status: detail.status,
        currentAction: detail.currentAction,
        stepsCount: detail.stepsCount,
        summary: detail.summary
      };
      setSubagentsByMessage((previous) => {
        const existingMsgId = Object.keys(previous).find((msgId) =>
          previous[msgId].some((entry) => entry.id === detail.id)
        );
        const targetId = existingMsgId ?? targetAssistantIdRef.current;
        if (!targetId) return previous;
        const currentList = previous[targetId] ?? [];
        const existingIndex = currentList.findIndex((entry) => entry.id === detail.id);
        const nextList =
          existingIndex >= 0
            ? currentList.map((entry, idx) => (idx === existingIndex ? item : entry))
            : [...currentList, item];
        const nextMap = { ...previous, [targetId]: nextList };
        if (workspaceKeyRef.current) {
          void saveWorkspaceSubagents(workspaceKeyRef.current, nextMap);
        }
        return nextMap;
      });
    };
    window.addEventListener(SUBAGENT_EVENT, onSubagent);
    return () => window.removeEventListener(SUBAGENT_EVENT, onSubagent);
  }, []);

  /**
   * @-mention picker: files and the active file's symbols. A symbol is pinned
   * as a named context marker and its file is attached, so the model gets both
   * the request ("look at this symbol") and the source that defines it.
   */
  const mentionMatches = useMemo<MentionItem[]>(() => {
    if (mentionQuery === null) return [];
    const query = mentionQuery.toLowerCase();
    const attached = new Set(attachedFiles);
    const pinned = new Set(pinnedSymbols.map((symbol) => `${symbol.name}:${symbol.file}`));
    const items: MentionItem[] = [];

    for (const symbol of symbols) {
      if (pinned.has(`${symbol.name}:${symbol.file}`)) continue;
      if (!symbol.name.toLowerCase().includes(query)) continue;
      items.push({
        id: `symbol:${symbol.name}:${symbol.file}`,
        kind: 'symbol',
        label: symbol.name,
        file: symbol.file,
        line: symbol.line,
        symbolKind: symbol.kind
      });
    }

    const mentionFiles = workspaceAllFiles.length > 0 ? workspaceAllFiles : workspaceFiles;
    for (const file of mentionFiles) {
      if (attached.has(file.name) || !file.name.toLowerCase().includes(query)) continue;
      items.push({ id: `file:${file.name}`, kind: 'file', label: file.name, file: file.name });
    }

    const rank = (item: MentionItem) => (item.label.toLowerCase().startsWith(query) ? 0 : 1);
    return items.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).slice(0, 8);
  }, [mentionQuery, workspaceFiles, workspaceAllFiles, attachedFiles, symbols, pinnedSymbols]);
  const activeMention = mentionMatches.length > 0
    ? mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)]
    : null;

  const closeMention = () => {
    setMentionQuery(null);
    setMentionIndex(0);
  };

  const handleInputChange = (value: string) => {
    onInputChange(value);
    setSlashDismissed(false);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const addMention = (item: MentionItem) => {
    if (!attachedFiles.includes(item.file)) {
      onAttachedFilesChange([...new Set([...attachedFiles, item.file])]);
    }
    if (item.kind === 'symbol') {
      onPinnedSymbolsChange([
        ...pinnedSymbols.filter((symbol) => !(symbol.name === item.label && symbol.file === item.file)),
        { name: item.label, file: item.file, line: item.line }
      ]);
    }
    onInputChange(stripTrailingMention(input));
    closeMention();
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const triggerMentionButton = () => {
    if (mentionQuery !== null) {
      closeMention();
    } else {
      handleInputChange(appendMentionTrigger(input));
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const scrollToLatest = () => {
    stickToBottomRef.current = true;
    setIsScrolledUp(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  /**
   * A long paste becomes a named `.txt` attachment so the composer stays short.
   * Names are unique even for two pastes inside the same second.
   */
  const addPastedText = (content: string) => {
    setPastedTexts((current) => {
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      let name = `pasted-${stamp}.txt`;
      let counter = 2;
      while (current.some((entry) => entry.name === name)) {
        name = `pasted-${stamp}-${counter}.txt`;
        counter += 1;
      }
      const id = crypto.randomUUID?.() ?? `paste-${Date.now()}`;
      return [...current, { id, name, content }];
    });
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items ?? []);
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        if (file.size > 10 * 1024 * 1024) {
          onAttachedImageChange(null);
          setAttachmentNotice('Pasted image exceeds the 10 MB limit.');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            setAttachmentNotice(null);
            onAttachedImageChange(reader.result);
          }
        };
        reader.readAsDataURL(file);
        return;
      }
    }
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    const isLong = text.length >= PASTE_AS_FILE_CHARS || text.split('\n').length >= PASTE_AS_FILE_LINES;
    if (!isLong) return;
    event.preventDefault();
    addPastedText(text);
  };

  /** One send path so long pastes and external files travel with the message they belong to. */
  const submitDraft = () => {
    const outgoing = pastedTexts;
    const outgoingExternal = externalAttachments;
    setPastedTexts([]);
    setExternalAttachments([]);
    setAttachmentNotice(null);
    onSend(
      outgoing.length > 0 ? outgoing : undefined,
      outgoingExternal.length > 0 ? outgoingExternal : undefined
    );
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1600);
    } catch {
      /* clipboard is unavailable in some environments */
    }
  };

  const normalizedModelSearch = modelSearchQuery.trim().toLowerCase();
  const filteredModels = normalizedModelSearch
    ? models.filter(
        (model) =>
          model.label.toLowerCase().includes(normalizedModelSearch)
          || model.id.toLowerCase().includes(normalizedModelSearch)
          || model.provider.toLowerCase().includes(normalizedModelSearch)
      )
    : models;

  const groupedModels: Record<ModelTier, ModelInfo[]> = {
    free: filteredModels.filter((model) => model.tier === 'free'),
    own: filteredModels.filter((model) => model.tier === 'own'),
    pro: filteredModels.filter((model) => model.tier === 'pro')
  };


  return (
    <div className="relative h-full flex flex-col bg-base select-text">
      {/* Header */}
      <header className="h-12 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-line bg-surface/95 backdrop-blur-xl">
        <button
          type="button"
          ref={modelTriggerRef}
          onClick={() => setIsModelMenuOpen((open) => !open)}
          title={activeModel ? activeModel.label : 'Select Model or add an API key'}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
            isModelMenuOpen
              ? 'border-accent-line bg-accent-soft text-ink'
              : 'border-line bg-surface text-ink hover:border-line-2 hover:bg-surface-2'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate font-medium">
            {activeModel ? activeModel.label : 'Select Model'}
          </span>
          <ChevronDown className={`ml-auto w-3.5 h-3.5 shrink-0 text-ink-3 transition-transform ${isModelMenuOpen ? 'rotate-180' : ''}`} />
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {/* One product state: your own key, nothing billed by ShadRox. */}
          <button
            type="button"
            onClick={() => onOpenSettings('CHAT')}
            title="ShadRox bills nothing — every token is paid to the provider key you saved in Settings."
            className={`flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 text-[10.5px] font-medium tracking-wide transition-colors cursor-pointer ${
              hasKey
                ? 'border-line bg-surface text-ink-3 hover:border-line-2 hover:text-ink'
                : 'border-accent-line bg-accent-soft text-accent hover:bg-accent-strong/20'
            }`}
          >
            <KeyRound className="w-3 h-3 shrink-0" />
            <span className="font-mono">BYOK</span>
          </button>

          <div ref={contextMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setIsContextOpen((open) => !open)}
              aria-label="What the model can see"
              title="What the model can see: repo map, retrieval mode and pinned context"
              className={`flex h-7 w-7 items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                isContextOpen
                  ? 'border-accent-line bg-accent-soft text-accent'
                  : 'border-transparent text-ink-4 hover:border-line hover:bg-surface-2 hover:text-ink'
              }`}
            >
              <ListTree className="w-3.5 h-3.5" />
            </button>
            {isContextOpen && (
              <div className="absolute right-0 top-9 z-30 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-sheet)]">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-ink-4">
                    What the model can see
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsContextOpen(false)}
                    className="rounded p-0.5 text-ink-4 hover:text-ink cursor-pointer"
                    aria-label="Close context details"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="space-y-1.5 border-b border-line px-3 py-2 text-[11px]">
                  <div className="flex items-center justify-between text-ink-3">
                    <span>Files indexed</span>
                    <span className="font-mono tabular-nums text-ink-2">{workspaceFiles.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-ink-3">
                    <span>Pinned context</span>
                    <span className="font-mono tabular-nums text-ink-2">{attachedFiles.length + pinnedSymbols.length}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-ink-3">
                    <span>Retrieval</span>
                    <span className="text-right text-ink-2">
                      {semanticStatus === 'ready'
                        ? `BM25 + embeddings · ${semanticChunkCount} chunks`
                        : semanticStatus === 'checking'
                          ? 'Checking embeddings…'
                          : semanticStatus === 'unavailable'
                            ? 'BM25 only — embeddings unavailable'
                            : 'BM25 only'}
                    </span>
                  </div>
                </div>
                {contextManifest && manifestTotals && (
                  <div className="border-b border-line px-3 py-2">
                    <div className="mb-1 flex items-center justify-between">
                      <p className="text-[10px] uppercase tracking-wider text-ink-4">Request manifest</p>
                      <span className="font-mono tabular-nums text-[10px] text-ink-3">
                        {manifestTotals.files} file(s) · ~{manifestTotals.tokens.toLocaleString('en-US')} tok
                      </span>
                    </div>
                    {(manifestTotals.missing > 0 || manifestTotals.stale > 0 || manifestTotals.truncated > 0) && (
                      <p className="mb-1 text-[10px] text-warn/90">
                        {[
                          manifestTotals.missing > 0 ? `missing: ${contextManifest.missing.join(', ')}` : '',
                          manifestTotals.stale > 0 ? `${manifestTotals.stale} stale` : '',
                          manifestTotals.truncated > 0 ? `${manifestTotals.truncated} truncated` : ''
                        ].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {contextManifest.sources.length === 0 ? (
                      <p className="text-[10px] text-ink-4">No sources resolved for this request.</p>
                    ) : (
                      <ul className="max-h-40 space-y-0.5 overflow-auto">
                        {contextManifest.sources.slice(0, 24).map((source) => (
                          <li
                            key={`${source.kind}:${source.path}`}
                            className="flex items-center justify-between gap-2 font-mono text-[10px]"
                            title={`${source.reason} — ${source.path}`}
                          >
                            <span className="min-w-0 truncate text-ink-2">{source.path}</span>
                            <span className="shrink-0 text-ink-4">{source.kind}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {contextManifest.deduped > 0 && (
                      <p className="mt-1 text-[10px] text-ink-4">
                        {contextManifest.deduped} overlapping source(s) merged.
                      </p>
                    )}
                  </div>
                )}
                <div className="px-3 py-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-ink-4">Repo map sent with each request</p>
                  {repoMap ? (
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-3">
                      {repoMap}
                    </pre>
                  ) : repoMapLoading ? (
                    <p className="text-[11px] text-ink-4">Reading the folder once to build the map…</p>
                  ) : (
                    <p className="text-[11px] text-ink-4">Open a folder or attach a file to build a map.</p>
                  )}
                  <p className="mt-2 text-[10px] text-ink-4">
                    Attach a file or pin a symbol with <span className="font-mono text-ink-2">@</span> to force it into context.
                  </p>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClearChat}
            disabled={messages.length === 0 || isGenerating}
            aria-label="Start a new chat"
            title="Start a new chat"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-ink-4 hover:border-line hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:border-transparent transition-colors cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Model Selector Popover */}
      {isModelMenuOpen && (
        <div
          ref={modelMenuRef}
          className="absolute left-3 right-3 top-[52px] z-30 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sheet)]"
        >
          {models.length === 0 ? (
            <div className="p-3.5 space-y-2.5">
              <p className="text-xs leading-relaxed text-ink-3">
                No models active yet. Add your provider API key — or a custom OpenAI-compatible endpoint — in Settings.
              </p>
              <button
                type="button"
                onClick={() => {
                  setIsModelMenuOpen(false);
                  onOpenSettings('CHAT');
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent-strong px-3 py-1.5 text-[11px] font-semibold text-white transition-opacity hover:opacity-90"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Open API key settings
              </button>
            </div>
          ) : (
            <>
              <div className="sticky top-0 z-10 border-b border-line bg-surface p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4" />
                  <input
                    ref={modelSearchInputRef}
                    value={modelSearchQuery}
                    onChange={(event) => setModelSearchQuery(event.target.value)}
                    placeholder="Search models..."
                    spellCheck={false}
                    aria-label="Search models"
                    className="w-full rounded-lg border border-line bg-base py-1.5 pl-8 pr-7 text-xs text-ink outline-none placeholder:text-ink-4 focus:border-accent-line"
                  />
                  {modelSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setModelSearchQuery('')}
                      aria-label="Clear model search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink cursor-pointer"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              {filteredModels.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-ink-4">
                  No models match “{modelSearchQuery.trim()}”.
                </p>
              ) : (
                (['free', 'own', 'pro'] as ModelTier[]).map((tier) =>
                  groupedModels[tier].length === 0 ? null : (
                    <div key={tier} className="py-1">
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
                        {TIER_GROUP_LABEL[tier]}
                      </div>
                      {groupedModels[tier].map((model) => {
                        const active = model.id === selectedModel;
                        return (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              onSelectModel(model.id);
                              setIsModelMenuOpen(false);
                            }}
                            className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-2 cursor-pointer ${
                              active ? 'bg-accent-soft/60 text-ink font-medium' : 'text-ink-2'
                            }`}
                          >
                            <span className="min-w-0 truncate">{model.label}</span>
                            <span className="flex shrink-0 items-center gap-2">
                              {model.contextWindow && (
                                <span className="font-mono text-[10px] tabular-nums text-ink-4">
                                  {Math.round(model.contextWindow / 1000)}k
                                </span>
                              )}
                              {active && <Check className="h-3.5 w-3.5 text-accent" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )
                )
              )}
              <div className="border-t border-line px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsModelMenuOpen(false);
                    onOpenSettings('CHAT');
                  }}
                  className="flex w-full cursor-pointer items-center justify-between text-[11px] text-ink-3 transition-colors hover:text-accent"
                >
                  <span>Configure keys &amp; endpoints</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-5 text-[12.5px]"
        onScroll={(event) => {
          const el = event.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          stickToBottomRef.current = nearBottom;
          setIsScrolledUp(!nearBottom && messages.length > 0);
        }}
      >
        {backgroundResume && (
          <div className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-warn">Background run paused</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-warn/80">
                  {backgroundResume.summary} Interrupted when the app closed.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={backgroundResume.onResume}
                  disabled={!backgroundResume.available}
                  title={
                    backgroundResume.available
                      ? 'Continue the stored goal in the autonomy engine'
                      : 'A key, an open folder and an idle engine are required to resume'
                  }
                  className="flex items-center gap-1 rounded-md border border-warn/30 px-2 py-0.5 text-[10px] text-warn transition-colors hover:bg-warn/10 disabled:opacity-40 cursor-pointer"
                >
                  <Play className="h-2.5 w-2.5" />
                  Resume
                </button>
                <button
                  type="button"
                  onClick={backgroundResume.onDismiss}
                  title="Forget this interrupted run"
                  className="flex items-center gap-1 rounded-md border border-line-2 px-2 py-0.5 text-[10px] text-ink-3 transition-colors hover:bg-overlay cursor-pointer"
                >
                  <X className="h-2.5 w-2.5" />
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <ChatEmptyState
            hasKey={hasKey}
            userFirstName={userFirstName}
            onOpenSettings={() => onOpenSettings('CHAT')}
            onSelectStarter={(prompt) => {
              handleInputChange(prompt);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          />
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            {message.role === 'user' && (
              <div className="flex items-center gap-1.5 mb-1 px-1 text-[10px] text-ink-4">
                <span className="uppercase font-semibold tracking-wider">You</span>
                <span>·</span>
                <span className="font-mono tabular-nums">{message.timestamp}</span>
                {restorableMessageIds?.has(message.id) && onRestorePromptCheckpoint && (() => {
                  const restoreTooltip =
                    restorableCheckpointTooltips?.[message.id] ??
                    'Restore workspace files to before this prompt';
                  return (
                    <span className="group/restore relative ml-1 inline-flex">
                      <button
                        type="button"
                        disabled={isGenerating}
                        onClick={() => onRestorePromptCheckpoint(message.id)}
                        title={restoreTooltip}
                        aria-label={`Restore (${restoreTooltip})`}
                        className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3 transition-colors hover:border-accent-line hover:text-accent disabled:opacity-40 cursor-pointer"
                      >
                        <RotateCcw className="h-2.5 w-2.5" />
                        Restore
                      </button>
                      <span
                        role="tooltip"
                        className="pointer-events-none absolute right-0 top-full z-20 mt-1.5 whitespace-nowrap rounded-md border border-line-2 bg-surface px-2 py-1 font-mono text-[10px] text-ink-2 opacity-0 shadow-[var(--shadow-panel)] transition-opacity duration-150 group-hover/restore:opacity-100 group-focus-within/restore:opacity-100"
                      >
                        {restoreTooltip}
                      </span>
                    </span>
                  );
                })()}
              </div>
            )}

            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {message.attachments.map((file) => (
                  <span
                    key={file}
                    className="rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] font-mono text-ink-3"
                  >
                    {file}
                  </span>
                ))}
              </div>
            )}
            {message.attachedImage && (
              <img
                src={message.attachedImage}
                alt="Attached photo"
                className="mb-1.5 max-h-40 max-w-[75%] rounded-lg border border-line object-contain"
              />
            )}

            {message.role === 'user' ? (
              <div className="max-w-[88%] rounded-2xl rounded-br-sm border border-accent-line bg-accent-soft/85 px-3.5 py-2.5 text-[12.5px] text-ink leading-relaxed whitespace-pre-wrap shadow-[0_4px_20px_-8px_var(--glow)]">
                {message.content}
              </div>
            ) : (
              <div
                className={`w-full max-w-[98%] overflow-hidden rounded-2xl border bg-surface/95 shadow-[var(--shadow-panel)] transition-colors ${
                  message.streaming ? 'border-accent-line shadow-[0_0_24px_-10px_var(--glow)]' : 'border-line'
                }`}
              >
                {message.streaming && (
                  <div className="h-0.5 w-full bg-gradient-to-r from-[var(--accent)]/70 via-[var(--cool)]/60 to-[var(--accent)]/70" />
                )}
                <div className="px-3.5 pb-3 pt-3">
                  <div className="mb-2.5 flex items-center gap-2 border-b border-line/70 pb-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded-md border border-line bg-base">
                      <ShadRoxLogo className="size-3.5" />
                    </span>
                    <span className="text-[11.5px] font-semibold tracking-tight text-ink">ShadRox</span>
                    <span className="font-mono tabular-nums text-[10px] text-ink-4">{message.timestamp}</span>
                    {(() => {
                      const elapsedLabel = message.streaming && message.startedAt
                        ? formatTurnElapsed(Math.max(0, turnNow - message.startedAt))
                        : formatTurnElapsed(message.durationMs ?? message.metrics?.durationMs ?? undefined);
                      if (!elapsedLabel) return null;
                      return (
                        <span
                          title={message.streaming ? 'Elapsed turn time' : 'Total turn completion time'}
                          className="inline-flex items-center gap-1 rounded border border-line bg-base px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-ink-3"
                        >
                          <Clock className="h-2.5 w-2.5 text-ink-4" />
                          {elapsedLabel}
                        </span>
                      );
                    })()}
                    {message.streaming && (
                      <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] font-medium text-accent">
                        <Loader2 className="size-3 animate-spin" />
                        {message.content ? 'Writing…' : 'Working…'}
                      </span>
                    )}
                  </div>
                {message.orchestration && (
                  <OrchestrationCard
                    message={message}
                    onStop={onStop}
                    onPause={onPauseOrchestration}
                    onResume={onResumeOrchestration}
                  />
                )}

                {message.taskPlan && message.taskPlan.length > 0 && (
                  <TaskPlanView
                    plan={message.taskPlan}
                    streaming={message.streaming}
                    approval={message.planApproval}
                    onApprove={onApprovePlan ? () => onApprovePlan(message.id) : undefined}
                    onReject={onRejectPlan ? () => onRejectPlan(message.id) : undefined}
                  />
                )}

                {message.toolActivity && message.toolActivity.length > 0 && (
                  <ToolActivityFeed
                    tools={message.toolActivity}
                    streaming={message.streaming}
                    turnDurationMs={message.durationMs}
                    turnStartedAt={message.startedAt}
                  />
                )}

                {(subagentsByMessage[message.id]?.length ?? 0) > 0 && (
                  <SubagentActivityFeed
                    items={subagentsByMessage[message.id]}
                    streaming={message.streaming}
                  />
                )}

                {message.verificationResult && (
                  <VerificationOutcomeBanner result={message.verificationResult} />
                )}

                {message.selfHealingProof && (
                  <SelfHealingProofCard
                    proof={message.selfHealingProof}
                    checkpointAvailable={Boolean(
                      message.selfHealingProof.checkpointId
                      && checkpoints.some((entry) => entry.id === message.selfHealingProof?.checkpointId)
                    )}
                    restoring={restoringCheckpointId === message.selfHealingProof.checkpointId}
                    onUndo={onRestoreCheckpoint}
                  />
                )}

                {message.reasoning && (
                  <ThinkingTrace reasoning={message.reasoning} streaming={message.streaming} durationMs={message.durationMs} />
                )}

                {(() => {
                  const livePhase = message.streaming
                    ? describeLivePhase({
                        activeStatusMessage: message.id === lastAssistantId ? activeStatusMessage : null,
                        hasContent: Boolean(message.content),
                        latestToolLabel: message.toolActivity?.at(-1)?.label ?? null,
                        hasReasoning: Boolean(message.reasoning)
                      })
                    : '';
                  if (!message.content) {
                    return message.streaming ? <WorkingResponseSkeleton phase={livePhase} /> : null;
                  }
                  // A bullet may only claim what actually happened to the write:
                  // the patch set's status is the truth, the reply shape is not.
                  const patchSet = patchSets.find((set) => set.messageId === message.id);
                  const outcomeFor = (path: string): PatchWriteOutcome => {
                    if (message.streaming) return 'streaming';
                    const rows = patchSet?.patches.filter((patch) => samePath(patch.path, path)) ?? [];
                    if (rows.length > 0) {
                      if (rows.some((row) => row.status === 'failed')) return 'failed';
                      if (rows.some((row) => row.status === 'pending')) return 'pending';
                      if (rows.some((row) => row.status === 'applied')) return 'applied';
                      if (rows.every((row) => row.status === 'rejected')) return 'skipped';
                      return 'reverted';
                    }
                    const recorded = Object.entries(message.writeOutcomes ?? {}).find(([stored]) => samePath(stored, path));
                    if (recorded) return recorded[1];
                    // Old history has no outcome record; claiming "not applied"
                    // for it would be the same lie in the other direction.
                    return message.restored ? 'historic' : 'unapplied';
                  };
                  return (
                    <>
                      {renderMarkdownContent(maskFileWrites(message.content, workspaceFiles, outcomeFor))}
                      {message.streaming && (
                        <StreamingResponseFooter phase={livePhase} onStop={onStop} />
                      )}
                    </>
                  );
                })()}

                {(() => {
                  const patchSet = patchSets.find((set) => set.messageId === message.id);
                  if (!patchSet || message.streaming) return null;
                  const pendingCount = patchSet.patches.filter((patch) => patch.status === 'pending').length;
                  const fileCount = new Set(patchSet.patches.map((patch) => patch.path.toLowerCase())).size;
                  const editCount = patchSet.patches.length;
                  return (
                    <div className="mt-2 rounded-xl border border-line bg-overlay p-2.5 text-[11px]">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-ink-3 font-medium">
                          <FileDiff className="w-3.5 h-3.5 text-accent shrink-0" />
                          Changes · {fileCount} file{fileCount === 1 ? '' : 's'}
                          {editCount > fileCount ? ` · ${editCount} edits` : ''}
                        </div>
                        <div className="flex items-center gap-2">
                          <label
                            title="Apply AI file changes immediately instead of asking first"
                            className="flex items-center gap-1 text-[10px] text-ink-4 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={autoApplyChanges}
                              onChange={onToggleAutoApply}
                              className="accent-[var(--accent)] cursor-pointer"
                            />
                            Auto-apply
                          </label>
                          {typeFixCounts?.[message.id] ? (
                            <button
                              type="button"
                              onClick={() => onFixTypeErrors?.(message.id)}
                              title="Ask the model to fix only the type errors this apply introduced"
                              className="rounded-md border border-warn/30 bg-warn/10 px-2 py-0.5 text-[10px] font-semibold text-warn transition-colors hover:bg-warn/20 cursor-pointer"
                            >
                              Fix {typeFixCounts[message.id]} type error{typeFixCounts[message.id] === 1 ? '' : 's'}
                            </button>
                          ) : null}
                          {pendingCount > 0 && (
                            <button
                              type="button"
                              onClick={() => onAcceptAllPatches(message.id)}
                              className="rounded-md border border-accent-line bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent transition-colors hover:bg-accent-strong/20 cursor-pointer"
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
                            className="rounded-lg border border-line bg-base/60"
                          >
                            <div className="flex items-center justify-between gap-2 px-2 py-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <FileCode2 className="w-3 h-3 text-ink-4 shrink-0" />
                                <span className="font-mono truncate text-ink-3">{patch.path}</span>
                                <span className="text-[9px] uppercase tracking-wide text-ink-5 shrink-0">
                                  {patch.kind === 'searchReplace' ? `${patch.blocks?.length ?? 0} s/r` : 'rewrite'}
                                </span>
                                {patch.failure && (
                                  <CollapsiblePatchFailurePill
                                    failure={patch.failure}
                                    filePath={patch.path}
                                    expanded={Boolean(expandedPatchFailures[`failure:${message.id}:${index}`])}
                                    onToggle={() =>
                                      setExpandedPatchFailures((prev) => ({
                                        ...prev,
                                        [`failure:${message.id}:${index}`]: !prev[`failure:${message.id}:${index}`]
                                      }))
                                    }
                                  />
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {patch.status === 'pending' && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => onAcceptPatch(message.id, index)}
                                      title={`Apply changes to ${patch.path}`}
                                      className="flex items-center gap-1 rounded-md border border-ok/30 px-2 py-0.5 text-[10px] font-medium text-ok transition-colors hover:bg-ok/10 cursor-pointer"
                                    >
                                      <Check className="w-3 h-3" />
                                      Accept
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => onRejectPatch(message.id, index)}
                                      title={`Skip changes to ${patch.path}`}
                                      className="flex items-center gap-1 rounded-md border border-line-2 px-2 py-0.5 text-[10px] text-ink-3 transition-colors hover:bg-overlay hover:text-ink-2 cursor-pointer"
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
                                          ? 'flex items-center gap-1 text-ok'
                                          : 'flex items-center gap-1 text-warn'
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
                                      className="rounded-md border border-line-2 p-0.5 text-ink-3 transition-colors hover:border-warn/30 hover:text-warn cursor-pointer"
                                    >
                                      <Undo2 className="w-3 h-3" />
                                    </button>
                                  </>
                                )}
                                {patch.status === 'reverted' && (
                                  <span className="text-ink-4">
                                    {patch.disk === 'saved' ? 'Reverted on disk' : 'Reverted in editor'}
                                  </span>
                                )}
                                {patch.status === 'rejected' && <span className="text-ink-4">Skipped</span>}
                                {patch.status === 'failed' && (
                                  <button
                                    type="button"
                                    onClick={() => onAcceptPatch(message.id, index)}
                                    className="rounded-md border border-line-2 px-2 py-0.5 text-[10px] text-ink-3 transition-colors hover:bg-overlay cursor-pointer"
                                  >
                                    Retry
                                  </button>
                                )}
                              </div>
                            </div>
                            {patch.failure && expandedPatchFailures[`failure:${message.id}:${index}`] && (
                              <pre className="mx-2 mb-2 max-h-40 overflow-auto rounded-md border border-danger/25 bg-danger/5 p-2 font-mono text-[10px] leading-relaxed text-danger whitespace-pre-wrap break-words">
                                {patch.failure}
                              </pre>
                            )}
                            {patch.status === 'pending' && (
                              <PatchHunkReview
                                sections={
                                  patch.kind === 'rewrite'
                                    ? [{
                                        key: 'rewrite',
                                        before: workspaceFiles.find((file) => samePath(file.name, patch.path))?.content ?? '',
                                        after: patch.content ?? ''
                                      }]
                                    : (patch.blocks ?? []).map((block, blockIndex) => ({
                                        key: `block-${blockIndex}`,
                                        label: `Replacement block ${blockIndex + 1}`,
                                        before: block.original,
                                        after: block.updated,
                                        groupIndex: blockIndex
                                      }))
                                }
                                onApply={(acceptedIds) => onApplyPatchHunks(message.id, index, acceptedIds)}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {!message.streaming && (message.content || message.id === lastAssistantId) && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-2 text-[10px] text-ink-4">
                    {message.content && (
                      <button
                        type="button"
                        onClick={() => void copyMessage(message)}
                        title="Copy reply"
                        className="flex items-center gap-1 transition-colors hover:text-ink-2 cursor-pointer"
                      >
                        {copiedMessageId === message.id ? (
                          <Check className="w-3 h-3 text-ok" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                      </button>
                    )}
                    {message.resumable && !isGenerating && (
                      <button
                        type="button"
                        onClick={() => onResume(message.id)}
                        title="The stream was interrupted — continue this reply from where it stopped"
                        className="flex items-center gap-1 text-accent transition-colors hover:text-accent cursor-pointer"
                      >
                        <Play className="w-3 h-3" />
                        Resume reply
                      </button>
                    )}
                    {message.metrics?.model && (
                      <details className="font-mono text-ink-5">
                        <summary className="flex cursor-pointer items-center gap-1">
                          <Zap className="w-3 h-3" />
                          Route
                        </summary>
                        <span
                          className="mt-1 block"
                          title="Route model · attempts · duration"
                        >
                          {describeAnswerRoute(message.metrics, models)}
                          {message.metrics.attempts && message.metrics.attempts > 1 ? ` · ${message.metrics.attempts} attempts` : ''}
                          {message.metrics.firstTokenMs !== null ? ` · ${message.metrics.firstTokenMs}ms` : ''}
                          {message.metrics.durationMs ? ` · ${(message.metrics.durationMs / 1000).toFixed(1)}s` : ''}
                        </span>
                      </details>
                    )}
                  </div>
                )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {isScrolledUp && messages.length > 0 && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label="Scroll to latest message"
          className="absolute bottom-3 right-4 z-10 flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-ink shadow-[var(--shadow-panel)] transition-colors hover:border-accent-line hover:text-accent"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          <span>Latest</span>
        </button>
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
          className="flex shrink-0 items-center gap-2 border-t border-warn/30 bg-warn/10 px-3 py-1.5 text-[10.5px] text-warn/90"
        >
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={contextNotice}>
            {contextNotice}
          </span>
          <button
            type="button"
            onClick={onDismissContextNotice}
            aria-label="Dismiss context notice"
            className="rounded p-0.5 text-warn/60 transition-colors hover:text-ink cursor-pointer"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Input Area & Prompt Box */}
      <div className="shrink-0 border-t border-line bg-base px-3 pb-2.5 pt-2.5">

        {/* ask_user: the tool loop is paused on this question until a pick or dismiss. */}
        {askUserPrompt && onAnswerAskUser && (
          <div className="mb-2 rounded-xl border border-accent-line bg-surface px-3 py-2.5 shadow-[var(--shadow-panel)]" role="dialog" aria-label="Agent question">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[12px] font-medium leading-snug text-ink">{askUserPrompt.question}</p>
              <button
                type="button"
                onClick={() => onAnswerAskUser(askUserPrompt.id, null)}
                aria-label="Dismiss question and let the agent decide"
                className="shrink-0 rounded-md p-0.5 text-ink-4 hover:text-ink cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {askUserPrompt.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onAnswerAskUser(askUserPrompt.id, option)}
                  className="rounded-lg border border-accent-line bg-accent-soft px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-accent-strong/20 cursor-pointer"
                >
                  {option}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-ink-4">
              The agent is paused until you choose. Dismissing lets it proceed with a stated assumption.
            </p>
          </div>
        )}

        {/* Live Agent Phase / Activity Status */}
        {activeStatusMessage && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-accent-line bg-accent-soft px-2.5 py-1.5 text-[11px] text-accent">
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
              <span className="truncate font-mono text-[10.5px] text-accent">
                {activeStatusMessage}
              </span>
            </div>
            {onStop && isGenerating && (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 rounded-md border border-danger/30 px-2 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/10 cursor-pointer shrink-0"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            )}
          </div>
        )}

        {isRefining && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-accent">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{refineStep || 'Refining prompt…'}</span>
          </div>
        )}

        {attachedImage && (
          <div className="mb-2 flex items-center gap-2">
            <div className="relative shrink-0">
              <img
                src={attachedImage}
                alt="Attached photo preview"
                className="h-11 w-11 rounded-lg border border-line object-cover"
              />
              <button
                type="button"
                onClick={() => onAttachedImageChange(null)}
                aria-label="Remove attached photo"
                className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-surface p-0.5 text-ink-3 hover:text-ink cursor-pointer shadow-sm"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

        {attachmentNotice && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
            <span className="min-w-0 truncate">{attachmentNotice}</span>
            <button
              type="button"
              onClick={() => setAttachmentNotice(null)}
              aria-label="Dismiss attachment notice"
              className="shrink-0 text-warn/70 hover:text-ink cursor-pointer"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {externalAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {externalAttachments.map((entry) => (
              <span
                key={entry.id}
                title={entry.name}
                className="flex max-w-full items-center gap-1 rounded-lg border border-accent-line bg-accent-soft px-2 py-1 text-[11px] text-ink-2"
              >
                <FileText className="h-3 w-3 shrink-0 text-accent" />
                <span className="truncate font-mono">{entry.name}</span>
                <span className="shrink-0 font-mono tabular-nums text-[10px] text-ink-4">
                  ~{Math.max(1, Math.round(entry.size / 1024))} KB
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${entry.name}`}
                  onClick={() => setExternalAttachments((current) => current.filter((item) => item.id !== entry.id))}
                  className="ml-0.5 text-ink-4 hover:text-ink cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {pastedTexts.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <div className="flex flex-wrap gap-1.5">
              {pastedTexts.map((entry) => (
                <span
                  key={entry.id}
                  title={entry.name}
                  className="flex max-w-full items-center gap-1 rounded-lg border border-accent-line bg-accent-soft px-2 py-1 text-[11px] text-ink-2"
                >
                  <FileText className="h-3 w-3 shrink-0 text-accent" />
                  <span className="truncate font-mono">{entry.name}</span>
                  <span className="shrink-0 font-mono tabular-nums text-[10px] text-ink-4">
                    ~{Math.max(1, Math.round(entry.content.length / 1024))} KB
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => setPastedTexts((current) => current.filter((item) => item.id !== entry.id))}
                    className="ml-0.5 text-ink-4 hover:text-ink cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <p className="text-[10px] text-ink-4">Pasted as a .txt attachment — the chat stays short.</p>
          </div>
        )}

        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((name) => (
              <span
                key={name}
                className="flex max-w-full items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-ink-2"
              >
                {/\.(mdx?|txt|rst)$/i.test(name) ? (
                  <FileText className="h-3 w-3 shrink-0 text-accent" />
                ) : (
                  <FileCode2 className="h-3 w-3 shrink-0 text-accent" />
                )}
                <span className="truncate font-mono">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => onAttachedFilesChange(attachedFiles.filter((file) => file !== name))}
                  className="ml-0.5 text-ink-4 hover:text-ink cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {pinnedSymbols.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pinnedSymbols.map((symbol) => (
              <span
                key={`${symbol.name}:${symbol.file}`}
                title={`${symbol.file}${symbol.line !== undefined ? `:${symbol.line + 1}` : ''}`}
                className="flex max-w-full items-center gap-1 rounded-lg border border-accent-line bg-accent-soft px-2 py-1 text-[11px] text-accent"
              >
                <Code2 className="h-3 w-3 shrink-0 text-accent" />
                <span className="truncate font-mono">{symbol.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${symbol.name}`}
                  onClick={() =>
                    onPinnedSymbolsChange(
                      pinnedSymbols.filter((entry) => !(entry.name === symbol.name && entry.file === symbol.file))
                    )
                  }
                  className="ml-0.5 text-accent/70 hover:text-ink cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="mb-2 rounded-xl border border-line bg-surface px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-ink-4">
              <span>Queued messages</span>
              <span className="font-mono tabular-nums">{queuedMessages.length}/5</span>
            </div>
            <ol className="space-y-1">
              {queuedMessages.map((message, index) => (
                <li key={message.id} className="flex items-center gap-2 text-[11px] text-ink-2">
                  <span className="shrink-0 font-mono text-ink-4">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{message.text}</span>
                  {onCancelQueuedMessage && (
                    <button
                      type="button"
                      onClick={() => onCancelQueuedMessage(message.id)}
                      aria-label={`Cancel queued message ${index + 1}`}
                      className="shrink-0 text-ink-4 transition-colors hover:text-danger cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Prompt Input Box */}
        <div
          ref={composerBoxRef}
          className="relative rounded-2xl border border-line-2 bg-surface/95 shadow-[var(--shadow-panel)] transition-all focus-within:border-accent-line focus-within:shadow-[0_0_0_1px_var(--accent-line),0_12px_28px_-12px_var(--glow)]"
        >
          {skillMatches.length > 0 && (
            <div className="absolute bottom-full left-1 right-1 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-sheet)]">
              <div className="border-b border-line px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-4">
                Workspace skills
              </div>
              {skillMatches.map((skill) => (
                <button
                  key={skill.path}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptSkillOption(skill);
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors cursor-pointer text-ink-2 hover:bg-surface-2 hover:text-ink"
                >
                  <span className="shrink-0 font-mono text-[11px] font-medium text-accent">/{skillKey(skill.name)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">
                    {skill.description || skill.whenToUse || 'no description'}
                  </span>
                </button>
              ))}
              <div className="border-t border-line px-3 py-1 text-[10px] text-ink-4">
                Tab inserts the first · Esc hides
              </div>
            </div>
          )}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-1 right-1 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[var(--shadow-sheet)]">
              <div className="border-b border-line px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-4">
                Attach a file or pin a symbol
              </div>
              {mentionMatches.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-ink-4">
                  Nothing matches “{mentionQuery}”.
                </p>
              ) : (
                mentionMatches.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      addMention(item);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors cursor-pointer ${
                      item.id === activeMention?.id
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                    }`}
                  >
                    {item.kind === 'symbol' ? (
                      <Code2 className="h-3.5 w-3.5 shrink-0 text-accent" />
                    ) : /\.(mdx?|txt|rst)$/i.test(item.file) ? (
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.label}</span>
                    {item.kind === 'symbol' && (
                      <span className="shrink-0 truncate font-mono text-[10px] text-ink-4">
                        {item.file}:{(item.line ?? 0) + 1}
                      </span>
                    )}
                  </button>
                ))
              )}
              <div className="border-t border-line px-3 py-1 text-[10px] text-ink-4">
                ↑↓ choose · Enter attach · Esc close
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => handleInputChange(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (skillMatches.length > 0) {
                if (event.key === 'Tab') {
                  event.preventDefault();
                  acceptSkillOption(skillMatches[0]);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (mentionQuery !== null && mentionMatches.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionMatches.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMentionIndex((index) => (index - 1 + mentionMatches.length) % mentionMatches.length);
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (activeMention) addMention(activeMention);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeMention();
                  return;
                }
              }
              if (shouldSubmitOnEnter({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing })) {
                event.preventDefault();
                if (canSend || canQueue) submitDraft();
              }
            }}
            rows={2}
            placeholder="Ask ShadRox to build, refactor, or explain code… (@ to attach a file or symbol)"
            className="block w-full min-h-[58px] resize-none rounded-t-2xl bg-transparent px-3.5 pt-3 pb-2 text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
          />

          <div className="flex items-center justify-between gap-2 border-t border-line/70 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-0.5 sm:gap-1">

              {/* Quick trigger for @ mentions */}
              <button
                type="button"
                onClick={triggerMentionButton}
                aria-label="Mention file or symbol"
                title="Mention a file or symbol (@)"
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors cursor-pointer ${
                  mentionQuery !== null
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-4 hover:bg-overlay hover:text-ink'
                }`}
              >
                <AtSign className="h-3.5 w-3.5" />
              </button>

              {/* Attach External File(s) from OS */}
              <div className="relative flex items-center gap-1">
                <input
                  ref={externalFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={async (event) => {
                    const selected = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    if (selected.length === 0) return;
                    const maxBytes = 512 * 1024;
                    const accepted: ExternalFileAttachment[] = [];
                    const skipped: string[] = [];
                    for (const file of selected) {
                      if (file.size > maxBytes) {
                        skipped.push(`${file.name} (>512 KB)`);
                        continue;
                      }
                      try {
                        const content = await file.text();
                        if (content.includes('\u0000')) {
                          skipped.push(`${file.name} (binary)`);
                          continue;
                        }
                        accepted.push({
                          id: crypto.randomUUID?.() ?? `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                          name: file.name,
                          content,
                          size: file.size
                        });
                      } catch {
                        skipped.push(file.name);
                      }
                    }
                    if (accepted.length > 0) {
                      setExternalAttachments((current) => [...current, ...accepted]);
                    }
                    setAttachmentNotice(
                      skipped.length > 0 ? `Skipped external file(s): ${skipped.join(', ')}` : null
                    );
                  }}
                />
                <button
                  type="button"
                  onClick={() => externalFileInputRef.current?.click()}
                  aria-label="Attach external file"
                  title="Attach external file(s) from your computer"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:bg-overlay hover:text-ink transition-colors cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    if (!file.type.startsWith('image/')) return;
                    if (file.size > 10 * 1024 * 1024) {
                      onAttachedImageChange(null);
                      setAttachmentNotice('Selected image exceeds the 10 MB limit.');
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                      if (typeof reader.result === 'string') {
                        setAttachmentNotice(null);
                        onAttachedImageChange(reader.result);
                      }
                    };
                    reader.readAsDataURL(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  aria-label="Attach one photo"
                  title="Attach one photo"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:bg-overlay hover:text-ink transition-colors cursor-pointer"
                >
                  <Image className="h-3.5 w-3.5" />
                </button>
              </div>

              {hasKey && input.trim().length > 0 && !isGenerating && (
                <button
                  type="button"
                  onClick={onRefinePrompt}
                  disabled={isRefining}
                  aria-label="Refine prompt"
                  title="Refine prompt structure without changing your intent"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:bg-overlay hover:text-accent disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Wand2 className="h-3.5 w-3.5" />
                </button>
              )}

              {/* S18: undo a refinement, restoring the draft the user actually typed */}
              {canUndoRefine && onUndoRefine && (
                <button
                  type="button"
                  onClick={onUndoRefine}
                  aria-label="Restore original prompt"
                  title="Restore the prompt you typed before refining"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:bg-overlay hover:text-ink transition-colors cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Right side: Send / Queue / Stop Button */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {isGenerating ? (
                <>
                  <button
                    type="button"
                    onClick={submitDraft}
                    disabled={!canQueue || queuedMessages.length >= 5}
                    title="Queue this message after the current task"
                    className="flex h-7 whitespace-nowrap items-center gap-1.5 rounded-lg border border-accent-line px-2.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent-soft disabled:opacity-30 cursor-pointer"
                  >
                    <MessageSquarePlus className="w-3 h-3" />
                    Queue
                  </button>
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex h-7 whitespace-nowrap items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 text-[11px] font-medium text-danger transition-colors hover:bg-danger/15 cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    Stop
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={submitDraft}
                  disabled={!canSend}
                  title="Send message (Enter)"
                  className="flex h-7 whitespace-nowrap items-center gap-1.5 rounded-lg bg-accent-strong px-3.5 text-[11px] font-semibold text-white shadow-[0_2px_12px_var(--glow)] transition-all hover:brightness-110 disabled:opacity-35 disabled:shadow-none cursor-pointer"
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
