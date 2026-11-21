import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
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
  History,
  Image,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Undo2,
  Users,
  X,
  Zap
} from 'lucide-react';
import { maskFileWrites, renderMarkdownContent, type PatchWriteOutcome } from '../lib/markdown';
import type { PermissionMode } from '../lib/agent/runPolicy';
import { getProviderMeta, type ModelInfo, type ModelTier } from '../lib/providers';
import { estimateTokens } from '../lib/toolUtils';
import { computeHunks, groupedHunkId, hunkStats } from '../lib/editor/hunks';
import type { Skill } from '../lib/skills';
import { contextManifestTotals, shouldSubmitOnEnter, type ContextManifest } from '../lib/contextManifest';
import { applyTemplate, PROMPT_TEMPLATES } from '../lib/promptTemplates';
import type { ChatMessage, PatchSet, RefineMode, SemanticStatus, SettingsTab, WorkspaceFile } from '../lib/types';
import type { CheckpointMeta } from '../lib/history';
import type { CheckpointDiff } from '../lib/checkpointDiff';
import { dedupePaths } from '../lib/paths';
import { TimelineSlider } from './TimelineSlider';
import { ShadRoxLogo } from './Logo';

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
  onSend: (pastedTexts?: PastedText[]) => void;
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
  /** Ask / Plan / Agent — the execution capability boundary for the next turn. */
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
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
  /** Opening a checkpoint previews the restore instead of performing it. */
  activeCheckpointId: string | null;
  onShowCheckpoint: (id: string) => void;
  onCloseCheckpoint: () => void;
  checkpointDiff: CheckpointDiff | null;
  checkpointDiffLoading: boolean;
  onExportDeltaReceipt?: (checkpointId: string) => Promise<string>;
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

const TIER_STYLES: Record<ModelTier, string> = {
  free: 'text-accent border-accent-line bg-accent-soft',
  own: 'text-cool border-cool/30 bg-cool-soft',
  pro: 'text-warn border-warn/30 bg-warn/10'
};

// The tier describes what the *provider* charges the user's own key, never a
// ShadRox plan — ShadRox bills nothing.
const TIER_GROUP_LABEL: Record<ModelTier, string> = {
  free: 'Free on your key',
  own: 'Your endpoint',
  pro: 'Paid on your key'
};

const TIER_BADGE_LABEL: Record<ModelTier, string> = {
  free: 'free on key',
  own: 'your key',
  pro: 'paid on key'
};

/** A long paste is captured as a .txt attachment instead of flooding the composer. */
const PASTE_AS_FILE_CHARS = 4000;
const PASTE_AS_FILE_LINES = 60;

/**
 * The permission modes shown in the composer. This is the capability boundary,
 * not a reasoning level: Ask and Plan never mutate the workspace, Agent may.
 */
const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; hint: string; icon: typeof Code2 }> = [
  {
    id: 'ask',
    label: 'Ask',
    hint: 'Read-only answers. The assistant may read files but never edit or run anything.',
    icon: MessageSquarePlus
  },
  {
    id: 'plan',
    label: 'Plan',
    hint: 'Read-only planning and architecture. No edits, no commands.',
    icon: FileText
  },
  {
    id: 'agent',
    label: 'Agent',
    hint: 'Full agent: may edit files and run commands you approve.',
    icon: Zap
  }
];

const PERMISSION_BUTTON_STYLE: Record<PermissionMode, string> = {
  ask: 'border-cool/30 bg-cool-soft text-cool',
  plan: 'border-warn/30 bg-warn/10 text-warn',
  agent: 'border-accent-line bg-accent-soft text-accent'
};

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

// Keyed loosely so a card persisted by an older build (with a status this one
// no longer knows) still renders: the lookup below falls back to 'stopped'.
const ORCHESTRATION_STATUS: Record<string, { label: string; tone: string }> = {
  planning: { label: 'planning', tone: 'text-accent border-accent-line bg-accent-soft' },
  running: { label: 'working', tone: 'text-accent border-accent-line bg-accent-soft' },
  done: { label: 'done', tone: 'text-ok border-ok/30 bg-ok/10' },
  failed: { label: 'failed', tone: 'text-danger border-danger/30 bg-danger/10' },
  stopped: { label: 'stopped', tone: 'text-ink-3 border-line-2 bg-overlay' },
  paused: { label: 'paused', tone: 'text-cool border-cool/30 bg-cool-soft' }
};

/** The chat-inline trace of an automatic run or team with Executive Summary Report. */
function OrchestrationCard({
  message,
  onStop,
  onPause,
  onResume
}: {
  message: ChatMessage;
  onStop: () => void;
  onPause?: () => void;
  onResume?: (messageId: string) => void;
}) {
  const orchestration = message.orchestration;
  if (!orchestration) return null;
  const Icon = orchestration.kind === 'team' ? Users : Bot;
  const status = ORCHESTRATION_STATUS[orchestration.status] ?? ORCHESTRATION_STATUS.stopped;
  const active = orchestration.status === 'planning' || orchestration.status === 'running';
  const report = orchestration.summaryReport;

  return (
    <div className="mb-2.5 rounded-xl border border-line bg-overlay p-3 text-[11px]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="grid size-6 shrink-0 place-items-center rounded-md border border-accent-line bg-accent-soft">
            <Icon className="h-3.5 w-3.5 text-accent" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink-2">
              {orchestration.kind === 'team' ? 'Autonomous Specialist Team' : 'Autonomous Agent Run'}
              {active && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
              <span className={`rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide ${status.tone}`}>
                {status.label}
              </span>
            </div>
            {orchestration.detail && (
              <p className="text-[10.5px] text-ink-3 mt-0.5 font-mono">{orchestration.detail}</p>
            )}
          </div>
        </div>
        {active && (
          <div className="flex shrink-0 items-center gap-1.5">
            {onPause && (
              <button
                type="button"
                onClick={onPause}
                title={
                  orchestration.kind === 'autonomy'
                    ? 'Pause at the next milestone. The run keeps its progress and can be resumed.'
                    : 'Pause at the next task. A team plans once, so this halts the run rather than continuing it later.'
                }
                className="flex cursor-pointer items-center gap-1 rounded-md border border-cool/30 px-2 py-0.5 text-[10px] text-cool transition-colors hover:bg-cool-soft"
              >
                <Pause className="h-2.5 w-2.5" />
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              className="flex cursor-pointer items-center gap-1 rounded-md border border-danger/30 px-2 py-0.5 text-[10px] text-danger transition-colors hover:bg-danger/10"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              Stop
            </button>
          </div>
        )}
        {orchestration.status === 'paused' && onResume && orchestration.kind === 'autonomy' && (
          <button
            type="button"
            onClick={() => onResume(message.id)}
            title="Continue from the milestone this run paused at. Already-passed milestones are not paid for again."
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-ok/30 px-2 py-0.5 text-[10px] text-ok transition-colors hover:bg-ok/10"
          >
            <Play className="h-2.5 w-2.5 fill-current" />
            Resume
          </button>
        )}
      </div>

      {/* Structured Executive Summary Report */}
      {report && (() => {
        const dedupedFiles = dedupePaths(report.filesModified);
        const failedOrIncomplete =
          orchestration.status === 'failed' ||
          report.mergeVerdict === 'broken' ||
          report.mergeVerdict === 'conflicts' ||
          (report.totalTasks > 0 && report.tasksCompleted < report.totalTasks);
        const cardTone = orchestration.status === 'failed' || report.mergeVerdict === 'broken'
          ? 'border-danger/30 bg-danger/10'
          : failedOrIncomplete
            ? 'border-warn/30 bg-warn/10'
            : 'border-ok/30 bg-ok/10';
        const headerTone = orchestration.status === 'failed' || report.mergeVerdict === 'broken'
          ? 'text-danger'
          : failedOrIncomplete
            ? 'text-warn'
            : 'text-ok';
        const borderTone = orchestration.status === 'failed' || report.mergeVerdict === 'broken'
          ? 'border-danger/30'
          : failedOrIncomplete
            ? 'border-warn/30'
            : 'border-ok/30';
        const mergeBadgeTone =
          report.mergeVerdict === 'clean'
            ? 'border-ok/30 bg-ok/10 text-ok'
            : report.mergeVerdict === 'broken' || report.mergeVerdict === 'conflicts'
              ? 'border-danger/30 bg-danger/10 text-danger'
              : 'border-warn/30 bg-warn/10 text-warn';

        return (
          <div className={`mt-3 rounded-lg border p-2.5 space-y-2 ${cardTone}`}>
            <div className={`flex flex-wrap items-center justify-between gap-2 border-b pb-1.5 ${borderTone}`}>
              <span className={`font-semibold text-xs flex items-center gap-1.5 ${headerTone}`}>
                {failedOrIncomplete
                  ? <AlertTriangle className={`w-3.5 h-3.5 ${headerTone}`} />
                  : <Check className={`w-3.5 h-3.5 ${headerTone}`} />}
                Executive Summary Report
              </span>
              <div className="flex items-center gap-1.5">
                {report.mergeVerdict && (
                  <span className={`rounded-full border px-1.5 py-px font-mono text-[9px] uppercase ${mergeBadgeTone}`}>
                    Integration: {report.mergeVerdict}
                  </span>
                )}
                <span className={`font-mono text-[9.5px] ${headerTone}`}>
                  {report.tasksCompleted}/{report.totalTasks} tasks passed
                </span>
              </div>
            </div>
            <p className="text-[10.5px] text-ink-2 leading-relaxed">{report.overview}</p>
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-ink-3 pt-1">
              <div className="rounded bg-base/30 p-1.5 border border-line">
                <span className="text-ink-4 block text-[9px] uppercase">Files Modified</span>
                <span className={`${headerTone} font-bold`}>{dedupedFiles.length} file(s)</span>
              </div>
              <div className="rounded bg-base/30 p-1.5 border border-line">
                <span className="text-ink-4 block text-[9px] uppercase">Tests Executed</span>
                <span className="text-accent font-bold">{report.testsPassed ?? 0} / {report.testsRun ?? 0}</span>
              </div>
            </div>
            {dedupedFiles.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-1">
                {dedupedFiles.map((file) => (
                  <span key={file} className="rounded bg-overlay border border-line px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
                    {file}
                  </span>
                ))}
              </div>
            )}
            {report.openIssues && report.openIssues.length > 0 && (
              <div className={`mt-1 border-t pt-1 text-[10px] text-warn font-mono space-y-0.5 ${borderTone}`}>
                <span className="text-ink-4 uppercase text-[9px]">Open Follow-ups:</span>
                {report.openIssues.map((issue, idx) => (
                  <div key={idx}>• {issue}</div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {orchestration.progress && orchestration.progress.length > 0 && (
        <details className="mt-2 pl-8">
          <summary className="cursor-pointer text-[10px] font-mono text-ink-4 hover:text-ink-3">
            Execution trace ({orchestration.progress.length} logs)
          </summary>
          <div className="mt-1.5 max-h-36 space-y-0.5 overflow-y-auto rounded bg-base/80 p-2 font-mono text-[9.5px] text-ink-3 border border-line">
            {orchestration.progress.map((line, index) => (
              <div key={`${index}-${line}`} className="break-words">
                {line}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function ThinkingTrace({ reasoning, streaming }: { reasoning: string; streaming?: boolean }) {
  const [open, setOpen] = useState(Boolean(streaming));
  const wordCount = useMemo(() => reasoning.trim().split(/\s+/).filter(Boolean).length, [reasoning]);

  // The trace is for watching the thought happen; once the answer lands it
  // folds away so the reply, not the scaffolding, owns the chat.
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);

  return (
    <div className="mb-2.5 rounded-xl border border-accent-line bg-accent-soft p-2.5 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Brain className="w-3.5 h-3.5 text-accent shrink-0" />
          <span className="font-semibold text-accent text-xs">
            {streaming ? 'Deep Reasoning in Progress…' : 'Deep Reasoning Trace'}
          </span>
          <span className="text-[10px] text-ink-4 font-mono">
            · {wordCount} words
          </span>
          {streaming && <Loader2 className="w-3 h-3 animate-spin text-accent ml-1" />}
        </div>
        <ChevronRight className={`w-3.5 h-3.5 text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 pt-2 border-t border-accent-line max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-ink-3 bg-base/30 p-2 rounded">
          {reasoning}
        </div>
      )}
    </div>
  );
}

function SelfHealingProofCard({
  proof,
  checkpointAvailable,
  restoring,
  onUndo
}: {
  proof: import('../lib/repairProof').FailureReceipt;
  checkpointAvailable: boolean;
  restoring: boolean;
  onUndo: (checkpointId: string) => void;
}) {
  const isHealed = proof.status === 'verified_healed';
  const isRejected = proof.status === 'rejected';
  const checkpointId = proof.checkpointId;
  const surface = isHealed
    ? 'border-ok/30 bg-ok/10'
    : isRejected
      ? 'border-warn/30 bg-warn/10'
      : 'border-danger/30 bg-danger/10';
  const badge = isHealed
    ? 'border-ok/30 bg-ok/10 text-ok'
    : isRejected
      ? 'border-warn/30 bg-warn/10 text-warn'
      : 'border-danger/30 bg-danger/10 text-danger';

  return (
    <div className={`mb-2.5 rounded-xl border p-3 text-[11px] ${surface}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`grid size-6 shrink-0 place-items-center rounded-md border ${isHealed ? 'border-ok/30 bg-ok/10 text-ok' : isRejected ? 'border-warn/30 bg-warn/10 text-warn' : 'border-danger/30 bg-danger/10 text-danger'}`}>
            <ShieldCheck className="h-3.5 w-3.5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink-2">
              <span>Self-Healing Proof</span>
              <span className={`rounded-full border px-1.5 py-px text-[9px] uppercase font-mono tracking-wide ${badge}`}>
                {proof.status.replace('_', ' ')}
              </span>
              <span className="text-[10px] text-ink-4 font-mono">[{proof.source.toUpperCase()}]</span>
            </div>
            <p className="text-[10.5px] text-ink-3 mt-0.5 font-mono truncate max-w-[20rem]" title={proof.target}>
              {proof.target}
            </p>
          </div>
        </div>
      </div>

      {proof.errorMessage && (
        <div className="mt-2 text-[10.5px] font-mono text-ink-3 bg-base/40 rounded p-2 border border-line">
          {proof.errorMessage}
        </div>
      )}
      {checkpointId && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-[10px] font-mono text-ink-4" title={checkpointId}>
            Checkpoint {checkpointId}
          </p>
          {checkpointAvailable && proof.status !== 'rejected' && (
            <button
              type="button"
              onClick={() => onUndo(checkpointId)}
              disabled={restoring}
              title="Restore the workspace to this turn's checkpoint"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-line bg-overlay px-2 py-1 text-[10px] font-mono text-ink-3 transition-colors hover:border-danger/30 hover:text-danger disabled:cursor-wait disabled:opacity-60"
            >
              <Undo2 className="h-3 w-3" />
              {restoring ? 'Restoring…' : 'Undo this turn'}
            </button>
          )}
        </div>
      )}

      {proof.verificationEvidence && (
        <div className={`mt-2 text-[10px] font-mono flex items-center gap-1 ${isHealed ? 'text-ok' : isRejected ? 'text-warn/90' : 'text-danger'}`}>
          <Check className="h-3 w-3 shrink-0" />
          <span>{proof.verificationEvidence}</span>
        </div>
      )}

      {(proof.stackTrace || (proof.diagnostics && proof.diagnostics.length > 0)) && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[10px] font-mono text-ink-4 hover:text-ink-3">
            View captured failure evidence
          </summary>
          <div className="mt-1.5 max-h-32 overflow-y-auto rounded bg-base/80 p-2 font-mono text-[9px] text-ink-3 border border-line">
            {proof.stackTrace && <div className="whitespace-pre-wrap">{proof.stackTrace}</div>}
            {proof.diagnostics && proof.diagnostics.map((d, i) => (
              <div key={i} className="text-danger">{d.file}:{d.line} - {d.message}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// --- Agent UX components (Devin / Cursor / Zed style) -----------------------

interface ToolCardProps {
  tool: NonNullable<ChatMessage['toolActivity']>[number];
}

function ToolCard({ tool }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const stage = tool.stage ?? (tool.ok ? (tool.name.includes('read') || tool.name.includes('list') ? 'reading' : 'completed') : 'failed');
  
  const stageStyles: Record<string, { label: string; tone: string }> = {
    reading: { label: 'READ', tone: 'text-cool border-cool/30 bg-cool-soft' },
    planning: { label: 'PLAN', tone: 'text-accent border-accent-line bg-accent-soft' },
    editing: { label: 'EDIT', tone: 'text-warn border-warn/30 bg-warn/10' },
    checking: { label: 'CHECK', tone: 'text-cool border-cool/30 bg-cool-soft' },
    completed: { label: 'DONE', tone: 'text-ok border-ok/30 bg-ok/10' },
    failed: { label: 'FAIL', tone: 'text-danger border-danger/30 bg-danger/10' }
  };
  const config = tool.refused
    ? { label: 'HELD', tone: 'text-warn border-warn/30 bg-warn/10' }
    : stageStyles[stage] || { label: 'TOOL', tone: 'text-ink-3 border-line-2 bg-overlay' };

  return (
    <div className="rounded-lg border border-line bg-base/80 transition-colors hover:border-line-2">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-mono font-semibold tracking-wider border ${config.tone}`}>
            {config.label}
          </span>
          <span className="font-mono text-ink-3 truncate" title={tool.label}>
            {tool.label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-ink-4 font-mono text-[10px]">
          {typeof tool.durationMs === 'number' && (
            <span className="flex items-center gap-0.5 text-ink-4">
              <Clock className="w-2.5 h-2.5" />
              {tool.durationMs}ms
            </span>
          )}
          {tool.refused ? (
            <AlertCircle className="w-3.5 h-3.5 text-warn" />
          ) : tool.ok ? (
            <Check className="w-3.5 h-3.5 text-ok" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 text-danger" />
          )}
          <ChevronRight className={`w-3 h-3 text-ink-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-line bg-base/30 p-2.5 space-y-2 text-[10.5px]">
          {tool.error && (
            <div className="rounded border border-danger/30 bg-danger/10 p-2 text-danger font-mono break-all">
              {tool.error}
            </div>
          )}
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-ink-4 mb-1 font-semibold">Arguments</p>
              <pre className="max-h-36 overflow-y-auto rounded bg-base-2/90 p-2 font-mono text-ink-3 leading-relaxed break-all whitespace-pre-wrap">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-ink-4 mb-1 font-semibold">Output</p>
              <pre className="max-h-44 overflow-y-auto rounded bg-base-2/90 p-2 font-mono text-ink-3 leading-relaxed break-all whitespace-pre-wrap">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolActivityFeed({ tools, streaming }: { tools: NonNullable<ChatMessage['toolActivity']>; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const totalDuration = tools.reduce((acc, t) => acc + (t.durationMs ?? 0), 0);
  const failedCount = tools.filter((t) => !t.ok && !t.refused).length;
  const heldCount = tools.filter((t) => t.refused).length;

  return (
    <div className="mb-2 rounded-xl border border-line bg-overlay px-2.5 py-2 text-[11px]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="grid size-5 place-items-center rounded-md border border-accent-line bg-accent-soft text-accent">
            <ListTree className="w-3 h-3" />
          </span>
          <span className="font-medium text-ink-2">
            Agent Operations · {tools.length} step{tools.length === 1 ? '' : 's'}
          </span>
          {failedCount > 0 && (
            <span className="rounded-full border border-danger/30 bg-danger/10 px-1.5 py-px text-[9px] text-danger">
              {failedCount} failed
            </span>
          )}
          {heldCount > 0 && (
            <span className="rounded-full border border-warn/30 bg-warn/10 px-1.5 py-px text-[9px] text-warn">
              {heldCount} held
            </span>
          )}
          {streaming && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] text-ink-4 font-mono">
          {totalDuration > 0 && <span>{totalDuration}ms</span>}
          <ChevronRight className={`w-3.5 h-3.5 text-ink-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="mt-2.5 space-y-1.5 max-h-80 overflow-y-auto pr-0.5">
          {tools.map((tool, index) => (
            <ToolCard key={`${tool.name}-${index}`} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

interface TaskPlanViewProps {
  plan: NonNullable<ChatMessage['taskPlan']>;
  streaming?: boolean;
  approval?: ChatMessage['planApproval'];
  onApprove?: () => void;
  onReject?: () => void;
}

function TaskPlanView({ plan, streaming, approval, onApprove, onReject }: TaskPlanViewProps) {
  const completed = plan.filter((t) => t.status === 'done').length;
  const total = plan.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mb-2.5 rounded-xl border border-line bg-overlay p-3 text-[11px]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-accent" />
          <span className="font-semibold text-ink-2 text-xs">Autonomous Task Plan</span>
          <span className="text-[10px] font-mono text-ink-4">
            {completed}/{total} done ({percent}%)
          </span>
        </div>
        {streaming && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-overlay-2 h-1.5 rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-gradient-to-r from-[var(--accent)] to-[var(--ok)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Steps List */}
      <ul className="space-y-1.5">
        {plan.map((task) => (
          <li key={task.id} className="flex items-start gap-2 rounded-lg bg-base/40 p-2 border border-line">
            <div className="mt-0.5 shrink-0">
              {task.status === 'done' ? (
                <Check className="w-3.5 h-3.5 text-ok" />
              ) : task.status === 'blocked' ? (
                <AlertCircle className="w-3.5 h-3.5 text-warn" />
              ) : task.status === 'doing' ? (
                <Loader2 className={`w-3.5 h-3.5 ${streaming ? 'text-accent animate-spin' : 'text-ink-4'}`} />
              ) : (
                <span className="block size-2 rounded-full border border-line-2 bg-surface-2 ml-1 mt-1" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`leading-snug ${task.status === 'done' ? 'text-ink-4 line-through' : task.status === 'doing' ? 'text-ink font-medium' : 'text-ink-3'}`}>
                {task.subject}
              </p>
              {task.files && task.files.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {task.files.map((file) => (
                    <span key={file} className="rounded bg-overlay border border-line px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
                      {file}
                    </span>
                  ))}
                </div>
              )}
              {task.evidence && (
                <p className="mt-1 text-[10px] text-ok/90 font-mono bg-ok/10 rounded px-1.5 py-0.5 border border-ok/30">
                  {task.evidence}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Plan review is separate from execution approval; file changes remain reviewable below. */}
      {approval && (approval.status === 'pending' || approval.status === 'required') && (
        <div className="mt-3 rounded-lg border border-accent-line bg-accent-soft p-2.5">
          <div className="flex items-center gap-1.5 text-accent font-medium text-xs mb-1">
            <Sparkles className="w-3.5 h-3.5 text-accent" />
            <span>Review proposed plan changes</span>
          </div>
          {approval.planSummary && (
            <p className="text-[11px] text-ink-3 mb-2 leading-relaxed">
              {approval.planSummary}
            </p>
          )}
          {approval.targetFiles && approval.targetFiles.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1">
              {approval.targetFiles.map((file) => (
                <span key={file} className="rounded bg-accent-soft border border-accent-line px-1.5 py-0.5 font-mono text-[9.5px] text-accent">
                  {file}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              className="flex items-center gap-1.5 rounded-md bg-accent-strong px-3 py-1 text-xs font-semibold text-white shadow hover:opacity-90 transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Accept proposed changes
            </button>
            <button
              type="button"
              onClick={onReject}
              className="flex items-center gap-1 rounded-md border border-line-2 px-2.5 py-1 text-xs text-ink-3 hover:text-ink hover:bg-overlay transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Reject proposed changes
            </button>
          </div>
        </div>
      )}

      {approval && approval.status === 'approved' && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1.5 text-[11px] text-ok">
          <Check className="w-3.5 h-3.5 text-ok" />
          <span>Proposed changes accepted</span>
        </div>
      )}
    </div>
  );
}

function VerificationOutcomeBanner({ result }: { result: NonNullable<ChatMessage['verificationResult']> }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`mb-2.5 rounded-xl border p-2.5 text-[11px] ${
        result.passed
          ? 'border-ok/30 bg-ok/10 text-ok'
          : 'border-warn/30 bg-warn/10 text-warn'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {result.passed ? (
            <ShieldCheck className="w-4 h-4 text-ok shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-warn shrink-0" />
          )}
          <span className="font-semibold text-xs">
            {result.passed ? 'Code Verification Passed' : 'Verification Warnings'}
          </span>
          <span className="text-[10px] text-ink-3 font-mono">
            {result.summary}
          </span>
        </div>
        {result.checks && result.checks.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="flex items-center gap-1 font-mono text-[10px] text-ink-3 hover:text-ink cursor-pointer"
          >
            <span>{result.checks.length} checks</span>
            <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>

      {open && result.checks && (
        <div className="mt-2 pt-2 border-t border-line space-y-1">
          {result.checks.map((chk, i) => (
            <div key={`${chk.name}-${i}`} className="flex items-start gap-1.5 font-mono text-[10.5px]">
              {chk.ok ? (
                <Check className="w-3 h-3 text-ok mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3 h-3 text-warn mt-0.5 shrink-0" />
              )}
              <span className={chk.ok ? 'text-ink-3' : 'text-warn'}>
                {chk.name}
              </span>
              {chk.details && (
                <span className="text-ink-4 truncate" title={chk.details}>
                  — {chk.details}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  permissionMode,
  onPermissionModeChange,
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
  activeCheckpointId,
  onShowCheckpoint,
  onCloseCheckpoint,
  checkpointDiff,
  checkpointDiffLoading,
  onExportDeltaReceipt,
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
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const runMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [isRunMenuOpen, setIsRunMenuOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const activePermission = PERMISSION_MODES.find((mode) => mode.id === permissionMode) || PERMISSION_MODES[2];
  const ActivePermissionIcon = activePermission.icon;

  /** `/name` in the composer is a project skill; a bare slash lists them all. */
  const slashName = /^\/([\w.-]*)$/.exec(input)?.[1]?.toLowerCase() ?? null;
  const skillMatches = useMemo(() => {
    if (slashName === null || slashDismissed || skills.length === 0) return [];
    const ordered = [...skills].sort((a, b) => skillKey(a.name).localeCompare(skillKey(b.name)));
    if (slashName === '') return ordered.slice(0, 8);
    return ordered.filter((skill) => skillKey(skill.name).startsWith(slashName)).slice(0, 8);
  }, [slashName, slashDismissed, skills]);

  /**
   * S18: the same `/` surface offers the built-in prompt templates. A template is
   * only composed when the user picks one — the composer is never rewritten on its own.
   */
  const templateMatches = useMemo(() => {
    if (slashName === null || slashDismissed) return [];
    if (slashName === '') return PROMPT_TEMPLATES;
    return PROMPT_TEMPLATES.filter((template) => template.id.startsWith(slashName));
  }, [slashName, slashDismissed]);

  const slashMatches = useMemo(
    () => [
      ...templateMatches.map((template) => ({ kind: 'template' as const, template })),
      ...skillMatches.map((skill) => ({ kind: 'skill' as const, skill }))
    ],
    [templateMatches, skillMatches]
  );

  /** Insert a picked slash option: a template composes guidance, a skill inserts its name. */
  const acceptSlashOption = (option: (typeof slashMatches)[number]) => {
    if (option.kind === 'template') {
      handleInputChange(applyTemplate(option.template.id, input.replace(/^\/[\w.-]*$/, '')));
    } else {
      handleInputChange(`/${skillKey(option.skill.name)} `);
    }
  };

  /** One dismissal path for every chat popover: outside click and Escape. */
  useEffect(() => {
    if (!isModelMenuOpen && !isAttachMenuOpen && !isRunMenuOpen && !isContextOpen) return;
    const inside = (ref: { current: HTMLElement | null }, target: EventTarget | null) =>
      Boolean(ref.current && target instanceof Node && ref.current.contains(target));
    const closeOthers = (event: PointerEvent) => {
      if (!inside(modelMenuRef, event.target) && !inside(modelTriggerRef, event.target)) setIsModelMenuOpen(false);
      if (!inside(attachMenuRef, event.target)) setIsAttachMenuOpen(false);
      if (!inside(runMenuRef, event.target)) setIsRunMenuOpen(false);
      if (!inside(contextMenuRef, event.target)) setIsContextOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsModelMenuOpen(false);
      setIsAttachMenuOpen(false);
      setIsRunMenuOpen(false);
      setIsContextOpen(false);
    };
    document.addEventListener('pointerdown', closeOthers);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOthers);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isModelMenuOpen, isAttachMenuOpen, isRunMenuOpen, isContextOpen]);

  useEffect(() => {
    // Streaming rewrites `messages` on every delta; without this the pane
    // yanks the reader back down whenever they scroll up mid-reply.
    if (!stickToBottomRef.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const activeModel = models.find((model) => model.id === selectedModel) || null;
  const hasDraft = input.trim().length > 0 || pastedTexts.length > 0;
  const canSend = hasDraft && !isGenerating;
  const canQueue = hasDraft && isGenerating;
  const manifestTotals = contextManifest ? contextManifestTotals(contextManifest) : null;
  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'model')?.id ?? null;

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
  // The folder tree, not the open tabs: the user attaches a file they have not opened yet.
  const attachableFiles = (workspaceAllFiles.length > 0 ? workspaceAllFiles : workspaceFiles)
    .filter((file) => !attachedFiles.includes(file.name));

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
    onInputChange(input.replace(/@([^\s@]*)$/, '').replace(/\s+$/, ''));
    closeMention();
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
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    const isLong = text.length >= PASTE_AS_FILE_CHARS || text.split('\n').length >= PASTE_AS_FILE_LINES;
    if (!isLong) return;
    event.preventDefault();
    addPastedText(text);
  };

  /** One send path so long pastes always travel with the message they belong to. */
  const submitDraft = () => {
    const outgoing = pastedTexts;
    setPastedTexts([]);
    onSend(outgoing.length > 0 ? outgoing : undefined);
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

  const groupedModels: Record<ModelTier, ModelInfo[]> = {
    free: models.filter((model) => model.tier === 'free'),
    own: models.filter((model) => model.tier === 'own'),
    pro: models.filter((model) => model.tier === 'pro')
  };


  return (
    <div className="h-full flex flex-col bg-base select-text">
      {/* Header */}
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-line">
        <button
          type="button"
          ref={modelTriggerRef}
          onClick={() => setIsModelMenuOpen((open) => !open)}
          disabled={models.length === 0}
          title={activeModel ? activeModel.label : 'Select Model'}
          className={`mr-2 flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1 text-xs transition-colors cursor-pointer disabled:opacity-50 ${
            isModelMenuOpen
              ? 'border-accent-line bg-accent-strong/20 text-ink'
              : 'border-accent-line bg-accent-soft text-ink hover:border-accent-line hover:bg-accent-strong/15'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="truncate font-medium">{activeModel ? activeModel.label : 'Select Model'}</span>
          {activeModel && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 border text-[10px] uppercase tracking-wide ${TIER_STYLES[activeModel.tier]}`}>
              {TIER_BADGE_LABEL[activeModel.tier]}
            </span>
          )}
          <ChevronDown className="ml-auto w-3 h-3 shrink-0 text-ink-3" />
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* One product state: your own key, nothing billed by ShadRox. */}
          <button
            type="button"
            onClick={() => onOpenSettings('CHAT')}
            title="ShadRox bills nothing — every token is paid to the provider key you saved in Settings."
            className="flex items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-2 py-1 text-[10px] tracking-wide text-accent transition-colors hover:border-accent-line cursor-pointer"
          >
            <KeyRound className="w-3 h-3 text-accent" />
            <span className="font-mono">BYOK</span>
          </button>

          <div ref={contextMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setIsContextOpen((open) => !open)}
              title="What the model can see: repo map, retrieval mode and pinned context"
              className={`p-1.5 transition-colors cursor-pointer ${isContextOpen ? 'text-accent' : 'text-ink-4 hover:text-ink'}`}
            >
              <ListTree className="w-3.5 h-3.5" />
            </button>
            {isContextOpen && (
              <div className="absolute right-0 top-8 z-30 w-80 overflow-hidden rounded-xl border border-line bg-base-2/95 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-ink-4">
                    What the model can see
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsContextOpen(false)}
                    className="text-ink-4 hover:text-ink cursor-pointer"
                    aria-label="Close context details"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="space-y-1.5 border-b border-line px-3 py-2 text-[11px]">
                  <div className="flex items-center justify-between text-ink-3">
                    <span>Files indexed</span>
                    <span className="font-mono text-ink-3">{workspaceFiles.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-ink-3">
                    <span>Pinned context</span>
                    <span className="font-mono text-ink-3">{attachedFiles.length + pinnedSymbols.length}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-ink-3">
                    <span>Retrieval</span>
                    <span className="text-right text-ink-3">
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
                      <span className="font-mono text-[10px] text-ink-3">
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
                      <p className="text-[10px] text-ink-5">No sources resolved for this request.</p>
                    ) : (
                      <ul className="max-h-40 space-y-0.5 overflow-auto">
                        {contextManifest.sources.slice(0, 24).map((source) => (
                          <li
                            key={`${source.kind}:${source.path}`}
                            className="flex items-center justify-between gap-2 font-mono text-[10px]"
                            title={`${source.reason} — ${source.path}`}
                          >
                            <span className="min-w-0 truncate text-ink-3">{source.path}</span>
                            <span className="shrink-0 text-ink-5">{source.kind}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {contextManifest.deduped > 0 && (
                      <p className="mt-1 text-[10px] text-ink-5">
                        {contextManifest.deduped} overlapping source(s) merged.
                      </p>
                    )}
                  </div>
                )}
                <div className="px-3 py-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-ink-4">Repo map sent with each request</p>
                  {repoMap ? (
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-3">
                      {repoMap}
                    </pre>
                  ) : repoMapLoading ? (
                    <p className="text-[11px] text-ink-5">Reading the folder once to build the map…</p>
                  ) : (
                    <p className="text-[11px] text-ink-5">Open a folder or attach a file to build a map.</p>
                  )}
                  <p className="mt-2 text-[10px] text-ink-5">
                    Attach a file or pin a symbol with <span className="font-mono text-ink-3">@</span> to force it into context.
                  </p>
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClearChat}
            disabled={messages.length === 0 || isGenerating}
            title="Start a new chat"
            className="p-1.5 text-ink-4 hover:text-ink disabled:opacity-30 transition-colors cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Model Selector Dropdown */}
      {isModelMenuOpen && (
        <div ref={modelMenuRef} className="shrink-0 max-h-64 overflow-y-auto border-b border-line bg-base">
          {models.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                setIsModelMenuOpen(false);
                onOpenSettings('CHAT');
              }}
              className="w-full px-3 py-4 text-left text-xs text-ink-3 hover:text-ink cursor-pointer"
            >
              No models available. Add your API key — and for a custom endpoint its URL and model ids — in Settings.
            </button>
          ) : (
            (['free', 'own', 'pro'] as ModelTier[]).map((tier) =>
              groupedModels[tier].length === 0 ? null : (
                <div key={tier}>
                  <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-ink-5">
                    {TIER_GROUP_LABEL[tier]}
                  </div>
                  {groupedModels[tier].map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => {
                        onSelectModel(model.id);
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs hover:bg-overlay cursor-pointer ${
                        model.id === selectedModel ? 'text-ink' : 'text-ink-3'
                      }`}
                    >
                      <span className="truncate">{model.label}</span>
                      {model.contextWindow && (
                        <span className="text-[10px] text-ink-5 shrink-0">
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
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4 text-xs"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-ink-4">
            <Sparkles className="w-6 h-6 text-accent/70 mb-2" />
            <p className="text-xs text-ink-3 font-medium">ShadRox Assistant</p>
            <p className="mt-1 text-[11px] text-ink-4 max-w-xs leading-relaxed">
              Describe what you want to build or change. ShadRox answers directly, or quietly switches to an autonomous
              run or a team when the task actually needs one.
            </p>
          </div>
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
                <span>{message.timestamp}</span>
              </div>
            )}

            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {message.attachments.map((file) => (
                  <span
                    key={file}
                    className="rounded-md border border-line bg-overlay px-2 py-0.5 text-[10px] font-mono text-ink-3"
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
                className="mb-1 max-h-40 max-w-[70%] rounded-lg border border-line object-contain"
              />
            )}

            {message.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent-line bg-gradient-to-b from-[var(--accent)]/[0.14] to-[var(--accent)]/[0.07] px-3.5 py-2.5 text-ink leading-relaxed whitespace-pre-wrap shadow-[0_1px_0_var(--overlay)_inset]">
                {message.content}
              </div>
            ) : (
              <div className="relative w-full max-w-[96%] overflow-hidden rounded-2xl border border-line bg-[linear-gradient(180deg,var(--overlay),transparent)] shadow-[0_1px_0_var(--overlay)_inset,0_14px_36px_-24px_rgba(0,0,0,0.9)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--accent)]/35 to-transparent" />
                <div className="px-3.5 pb-2.5 pt-3">
                  <div className="mb-2.5 flex items-center gap-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-gradient-to-br from-[var(--accent)] to-[var(--accent-strong)] text-white shadow-[0_2px_10px_-2px_var(--glow)]">
                      <Sparkles className="size-3" />
                    </span>
                    <span className="text-[11px] font-semibold tracking-tight text-ink">ShadRox</span>
                    <span className="font-mono text-[10px] text-ink-5">{message.timestamp}</span>
                    {message.streaming && (
                      <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-accent-line bg-accent-soft px-1.5 py-px text-[9px] font-medium tracking-wide text-accent">
                        <span className="size-1 animate-pulse rounded-full bg-accent-strong" />
                        writing
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
                  <ToolActivityFeed tools={message.toolActivity} streaming={message.streaming} />
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
                  <ThinkingTrace reasoning={message.reasoning} streaming={message.streaming} />
                )}

                {(() => {
                  if (!message.content) {
                    return message.streaming ? (
                      <span className="inline-flex items-center gap-2 text-ink-4">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                        Thinking...
                      </span>
                    ) : null;
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
                  return renderMarkdownContent(maskFileWrites(message.content, workspaceFiles, outcomeFor));
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
                                  <span
                                    className="flex items-center gap-1 text-danger min-w-0"
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
                    {(() => {
                      const checkpoint = checkpoints.find((entry) => entry.messageId === message.id);
                      if (!checkpoint) return null;
                      const restoring = restoringCheckpointId === checkpoint.id;
                      const open = activeCheckpointId === checkpoint.id;
                      return (
                        <button
                          type="button"
                          onClick={() => (open ? onCloseCheckpoint() : onShowCheckpoint(checkpoint.id))}
                          disabled={restoring}
                          title={open ? 'Hide the history rail' : `See what restoring before this reply changes (${checkpoint.fileCount} files)`}
                          className={`flex items-center gap-1 transition-colors hover:text-warn disabled:opacity-40 cursor-pointer ${open ? 'text-warn' : ''}`}
                        >
                          {restoring ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <History className="w-3 h-3" />
                          )}
                          {restoring ? 'Restoring…' : open ? 'History' : 'Checkpoint'}
                        </button>
                      );
                    })()}
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

      {activeCheckpointId && (
        <div className="shrink-0 px-3 pb-1 pt-2">
          <TimelineSlider
            checkpoints={checkpoints}
            selectedId={activeCheckpointId}
            onSelect={onShowCheckpoint}
            onRestore={onRestoreCheckpoint}
            restoringId={restoringCheckpointId}
            onClose={onCloseCheckpoint}
            diff={checkpointDiff}
            diffLoading={checkpointDiffLoading}
            onExportReceipt={onExportDeltaReceipt}
            disabled={isGenerating}
          />
        </div>
      )}

      {/* Input Area & Prompt Box */}
      <div className="shrink-0 border-t border-line p-3 bg-base">

        {/* ask_user: the tool loop is paused on this question until a pick or dismiss. */}
        {askUserPrompt && onAnswerAskUser && (
          <div className="mb-2 rounded-lg border border-accent-line bg-accent-soft px-3 py-2.5" role="dialog" aria-label="Agent question">
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
                  className="rounded-lg border border-accent-line bg-base px-2.5 py-1 text-[11px] text-ink hover:bg-accent-soft cursor-pointer"
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
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-accent-line bg-accent-soft px-2.5 py-1.5 text-[11px] text-accent">
            <div className="flex items-center gap-2 min-w-0">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-strong opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent-strong"></span>
              </span>
              <span className="truncate font-mono text-[10.5px] text-accent">
                {activeStatusMessage}
              </span>
            </div>
            {onStop && isGenerating && (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 text-[10px] text-danger hover:text-danger cursor-pointer shrink-0"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            )}
          </div>
        )}

        {isRefining && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-accent/80">
            <Loader2 className="w-3 h-3 animate-spin" />
            {refineStep || 'Refining prompt...'}
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
                className="absolute -right-1.5 -top-1.5 rounded-full border border-line bg-base-2 p-0.5 text-ink-3 hover:text-ink cursor-pointer"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <span className="text-[11px] text-ink-4">Photo ready to send</span>
          </div>
        )}

        {pastedTexts.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            <div className="flex flex-wrap gap-1.5">
              {pastedTexts.map((entry) => (
                <span
                  key={entry.id}
                  title={entry.name}
                  className="flex max-w-full items-center gap-1 rounded-lg border border-accent-line/40 bg-accent-soft/60 px-2 py-1 text-[11px] text-ink-3"
                >
                  <FileText className="h-3 w-3 shrink-0 text-accent/80" />
                  <span className="truncate font-mono">{entry.name}</span>
                  <span className="shrink-0 text-[10px] text-ink-5">
                    ~{Math.max(1, Math.round(entry.content.length / 1024))} KB
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => setPastedTexts((current) => current.filter((item) => item.id !== entry.id))}
                    className="ml-0.5 text-ink-5 hover:text-ink cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <p className="text-[10px] text-ink-5">Pasted as a .txt attachment — the chat stays short.</p>
          </div>
        )}

        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((name) => (
              <span
                key={name}
                className="flex max-w-full items-center gap-1 rounded-lg border border-line bg-overlay px-2 py-1 text-[11px] text-ink-3"
              >
                {/\.(mdx?|txt|rst)$/i.test(name) ? (
                  <FileText className="h-3 w-3 shrink-0 text-accent/80" />
                ) : (
                  <FileCode2 className="h-3 w-3 shrink-0 text-accent/80" />
                )}
                <span className="truncate font-mono">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => onAttachedFilesChange(attachedFiles.filter((file) => file !== name))}
                  className="ml-0.5 text-ink-5 hover:text-ink cursor-pointer"
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
                <Code2 className="h-3 w-3 shrink-0 text-accent/80" />
                <span className="truncate font-mono">{symbol.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${symbol.name}`}
                  onClick={() =>
                    onPinnedSymbolsChange(
                      pinnedSymbols.filter((entry) => !(entry.name === symbol.name && entry.file === symbol.file))
                    )
                  }
                  className="ml-0.5 text-accent/50 hover:text-ink cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="mb-2 rounded-xl border border-line bg-overlay px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-ink-4">
              <span>Queued messages</span>
              <span>{queuedMessages.length}/5</span>
            </div>
            <ol className="space-y-1">
              {queuedMessages.map((message, index) => (
                <li key={message.id} className="flex items-center gap-2 text-[11px] text-ink-3">
                  <span className="shrink-0 font-mono text-ink-5">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{message.text}</span>
                  {onCancelQueuedMessage && (
                    <button
                      type="button"
                      onClick={() => onCancelQueuedMessage(message.id)}
                      aria-label={`Cancel queued message ${index + 1}`}
                      className="shrink-0 text-ink-5 transition-colors hover:text-danger cursor-pointer"
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
        <div className="relative rounded-2xl border border-line bg-overlay transition-colors focus-within:border-accent-line focus-within:bg-overlay">
          {slashMatches.length > 0 && (
            <div className="absolute bottom-full left-2 right-2 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-base-2/95 py-1 shadow-2xl backdrop-blur-xl">
              <div className="border-b border-line px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-4">
                Templates and skills
              </div>
              {templateMatches.length > 0 && (
                <>
                  <div className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-5">
                    Prompt templates
                  </div>
                  {templateMatches.map((template) => (
                    <button
                      key={`template:${template.id}`}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        acceptSlashOption({ kind: 'template', template });
                      }}
                      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer text-ink-3 hover:bg-overlay hover:text-ink"
                    >
                      <span className="shrink-0 font-mono text-[11px] text-accent">/{template.id}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px]">{template.label}</span>
                    </button>
                  ))}
                </>
              )}
              {skillMatches.length > 0 && (
                <>
                  <div className="px-3 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-5">
                    Skills of this folder
                  </div>
                  {skillMatches.map((skill) => (
                    <button
                      key={skill.path}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        acceptSlashOption({ kind: 'skill', skill });
                      }}
                      className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer text-ink-3 hover:bg-overlay hover:text-ink"
                    >
                      <span className="shrink-0 font-mono text-[11px] text-accent">/{skillKey(skill.name)}</span>
                      <span className="min-w-0 flex-1 truncate text-[11px]">
                        {skill.description || skill.whenToUse || 'no description'}
                      </span>
                    </button>
                  ))}
                </>
              )}
              <div className="border-t border-line px-3 py-1 text-[10px] text-ink-5">
                Tab inserts the first · Esc hides
              </div>
            </div>
          )}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-2 right-2 z-20 mb-2 overflow-hidden rounded-xl border border-line bg-base-2/95 py-1 shadow-2xl backdrop-blur-xl">
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
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                      item.id === activeMention?.id
                        ? 'bg-accent-soft text-accent'
                        : 'text-ink-3 hover:bg-overlay hover:text-ink'
                    }`}
                  >
                    {item.kind === 'symbol' ? (
                      <Code2 className="h-3.5 w-3.5 shrink-0 text-accent/80" />
                    ) : /\.(mdx?|txt|rst)$/i.test(item.file) ? (
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.label}</span>
                    {item.kind === 'symbol' && (
                      <span className="shrink-0 truncate font-mono text-[10px] text-ink-5">
                        {item.file}:{(item.line ?? 0) + 1}
                      </span>
                    )}
                  </button>
                ))
              )}
              <div className="border-t border-line px-3 py-1 text-[10px] text-ink-5">
                ↑↓ choose · Enter attach · Esc close
              </div>
            </div>
          )}
          <textarea
            value={input}
            onChange={(event) => handleInputChange(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (slashMatches.length > 0) {
                if (event.key === 'Tab') {
                  event.preventDefault();
                  acceptSlashOption(slashMatches[0]);
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
            rows={3}
            placeholder="Ask ShadRox to build, refactor, or explain code… (@ to attach a file or symbol)"
            className="w-full resize-none rounded-2xl bg-transparent py-3 pl-10 pr-3.5 text-xs text-ink outline-none placeholder:text-ink-5 disabled:opacity-50"
          />
          <div className="pointer-events-none absolute left-3 top-3 text-ok/80">
            <ShadRoxLogo className="h-4 w-4" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-2 pb-2">
            <div className="flex min-w-0 flex-auto flex-wrap items-center gap-1.5 gap-y-1.5">
              {/* Access boundary for the next turn: Ask, Plan or Agent. */}
              <div ref={runMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsRunMenuOpen((open) => !open)}
                  title={`${activePermission.label} access`}
                  className={`flex h-7 min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors cursor-pointer ${PERMISSION_BUTTON_STYLE[permissionMode]}`}
                >
                  <ActivePermissionIcon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate font-medium">{activePermission.label}</span>
                  <ChevronDown className="w-3 h-3 shrink-0 text-ink-3" />
                </button>

                {isRunMenuOpen && (
                  <div className="absolute bottom-9 left-0 z-20 w-64 overflow-hidden rounded-xl border border-line bg-base-2/95 py-1 shadow-2xl backdrop-blur-xl">
                    <div className="border-b border-line px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-4">
                      Access
                    </div>
                    {PERMISSION_MODES.map((mode) => {
                      const Icon = mode.icon;
                      const isSelected = mode.id === permissionMode;
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => {
                            onPermissionModeChange(mode.id);
                            setIsRunMenuOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-overlay cursor-pointer ${
                            isSelected ? 'bg-accent-soft text-accent' : 'text-ink-3'
                          }`}
                        >
                          <Icon className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent' : 'text-ink-4'}`} />
                          <span className="min-w-0 flex-1">
                            <span className={`block text-xs font-medium ${isSelected ? 'text-accent' : 'text-ink-2'}`}>
                              {mode.label}
                            </span>
                            <span className="mt-0.5 block text-[10px] leading-tight text-ink-4">{mode.hint}</span>
                          </span>
                          <Check className={`h-3.5 w-3.5 shrink-0 text-accent ${isSelected ? 'opacity-100' : 'opacity-0'}`} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Attach File */}
              <div ref={attachMenuRef} className="relative flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setIsAttachMenuOpen((open) => !open)}
                  disabled={attachableFiles.length === 0}
                  title={attachableFiles.length === 0
                    ? (workspaceAllFiles.length === 0 && workspaceFiles.length === 0
                        ? 'Open a folder to attach files'
                        : 'Every workspace file is already attached')
                    : 'Attach file context'}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:text-ink disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                {isAttachMenuOpen && (
                  <div className="absolute bottom-8 left-0 z-10 max-h-64 w-64 overflow-y-auto rounded-xl border border-line bg-base-2/95 py-1 shadow-2xl backdrop-blur-xl">
                    {attachableFiles.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => {
                          onAttachedFilesChange([...new Set([...attachedFiles, file.name])]);
                          setIsAttachMenuOpen(false);
                        }}
                        className="block w-full truncate px-3 py-1.5 text-left text-xs text-ink-3 hover:bg-overlay hover:text-ink cursor-pointer"
                      >
                        {file.name}
                      </button>
                    ))}
                  </div>
                )}
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
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                      if (typeof reader.result === 'string') onAttachedImageChange(reader.result);
                    };
                    reader.readAsDataURL(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  title="Attach one photo"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:text-ink transition-colors cursor-pointer"
                >
                  <Image className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* S18: undo a refinement, restoring the draft the user actually typed */}
              {canUndoRefine && onUndoRefine && (
                <button
                  type="button"
                  onClick={onUndoRefine}
                  title="Restore the prompt you typed before refining"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-4 hover:text-ink transition-colors cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Right side: toggles, token count & Send Button */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {input.length > 0 && (
                <span className="hidden text-[10px] text-ink-4 font-mono xl:inline">
                  {input.length}c · ~{estimateTokens(input)} tok
                </span>
              )}

              {isGenerating ? (
                <>
                  <button
                    type="button"
                    onClick={submitDraft}
                    disabled={!canQueue || queuedMessages.length >= 5}
                    title="Queue this message after the current task"
                    className="flex h-7 items-center gap-1.5 rounded-lg border border-accent-line px-2.5 text-[11px] text-accent transition-colors hover:bg-accent-soft disabled:opacity-30 cursor-pointer"
                  >
                    <MessageSquarePlus className="w-3 h-3" />
                    Queue
                  </button>
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex h-7 items-center gap-1.5 rounded-lg border border-danger/30 px-3 text-[11px] text-danger transition-colors hover:bg-danger/10 cursor-pointer"
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
                  className="flex h-7 items-center gap-1.5 rounded-lg bg-accent-strong px-3.5 text-[11px] font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-30 disabled:hover:bg-accent-strong cursor-pointer"
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
