import { useEffect, useMemo, useRef, useState } from 'react';
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
  Loader2,
  ListTree,
  MessageSquarePlus,
  Mic,
  MicOff,
  Paperclip,
  Play,
  History,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Undo2,
  Users,
  Wand2,
  X,
  Zap
} from 'lucide-react';
import { maskFileWrites, renderMarkdownContent } from '../lib/markdown';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';import { getRefineMode, REFINE_MODES } from '../lib/ai';
import { getProviderMeta, type ModelInfo, type ModelTier } from '../lib/providers';
import { getMonthlyUsage, onQuotaChange, type UsageState } from '../lib/quota';
import { estimateTokens } from '../lib/toolUtils';
import { computeHunks, groupedHunkId, hunkStats } from '../lib/editor/hunks';
import { formatCredits, formatTokenSplit } from '../lib/usageCredits';
import type { Skill } from '../lib/skills';
import type { ChatMessage, PatchSet, PlanTier, RefineMode, SemanticStatus, SettingsTab, WorkspaceFile } from '../lib/types';
import type { CheckpointMeta } from '../lib/history';
import type { CheckpointDiff } from '../lib/checkpointDiff';
import { TimelineSlider } from './TimelineSlider';

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

interface ChatPanelProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  queuedMessages?: Array<{ id: string; text: string }>;
  onCancelQueuedMessage?: (id: string) => void;
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
  attachedFiles: string[];
  onAttachedFilesChange: (fileNames: string[]) => void;
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
}

const TIER_STYLES: Record<ModelTier, string> = {
  free: 'text-violet-300 border-violet-300/25 bg-violet-500/10',
  own: 'text-sky-300 border-sky-300/25 bg-sky-500/10',
  pro: 'text-amber-400 border-amber-900/60 bg-amber-950/30'
};

const TIER_GROUP_LABEL: Record<ModelTier, string> = {
  free: 'Free tier models',
  own: 'Your endpoint',
  pro: 'Pro tier models'
};

const MODE_ICONS: Record<RefineMode, typeof Code2> = {
  code: Code2,
  plan: FileText,
  complex: Brain
};

const ORCHESTRATION_STATUS: Record<NonNullable<ChatMessage['orchestration']>['status'], { label: string; tone: string }> = {
  planning: { label: 'planning', tone: 'text-violet-200 border-violet-300/25 bg-violet-500/10' },
  running: { label: 'working', tone: 'text-violet-200 border-violet-300/25 bg-violet-500/10' },
  done: { label: 'done', tone: 'text-emerald-200 border-emerald-400/25 bg-emerald-500/10' },
  failed: { label: 'failed', tone: 'text-red-200 border-red-400/25 bg-red-500/10' },
  stopped: { label: 'stopped', tone: 'text-neutral-300 border-white/10 bg-white/[0.04]' },
  budget: { label: 'budget cap', tone: 'text-amber-200 border-amber-500/25 bg-amber-500/10' }
};

/** The chat-inline trace of an automatic run or team with Executive Summary Report. */
function OrchestrationCard({ message, onStop }: { message: ChatMessage; onStop: () => void }) {
  const orchestration = message.orchestration;
  if (!orchestration) return null;
  const Icon = orchestration.kind === 'team' ? Users : Bot;
  const status = ORCHESTRATION_STATUS[orchestration.status];
  const active = orchestration.status === 'planning' || orchestration.status === 'running';
  const report = orchestration.summaryReport;

  return (
    <div className="mb-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-[11px]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="grid size-6 shrink-0 place-items-center rounded-md border border-violet-300/20 bg-violet-500/10">
            <Icon className="h-3.5 w-3.5 text-violet-200" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-neutral-200">
              {orchestration.kind === 'team' ? 'Autonomous Specialist Team' : 'Autonomous Agent Run'}
              {active && <Loader2 className="h-3 w-3 animate-spin text-violet-300" />}
              <span className={`rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide ${status.tone}`}>
                {status.label}
              </span>
            </div>
            {orchestration.detail && (
              <p className="text-[10.5px] text-neutral-400 mt-0.5 font-mono">{orchestration.detail}</p>
            )}
          </div>
        </div>
        {active && (
          <button
            type="button"
            onClick={onStop}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-red-500/30 px-2 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-500/10"
          >
            <Square className="h-2.5 w-2.5 fill-current" />
            Stop
          </button>
        )}
      </div>

      {/* Structured Executive Summary Report */}
      {report && (
        <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-950/20 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2 border-b border-emerald-500/20 pb-1.5">
            <span className="font-semibold text-emerald-200 text-xs flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              Executive Summary Report
            </span>
            <span className="font-mono text-[9.5px] text-emerald-400">
              {report.tasksCompleted}/{report.totalTasks} tasks passed
            </span>
          </div>
          <p className="text-[10.5px] text-neutral-200 leading-relaxed">{report.overview}</p>
          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-neutral-400 pt-1">
            <div className="rounded bg-black/30 p-1.5 border border-white/[0.04]">
              <span className="text-neutral-500 block text-[9px] uppercase">Files Modified</span>
              <span className="text-emerald-300 font-bold">{report.filesModified.length} file(s)</span>
            </div>
            <div className="rounded bg-black/30 p-1.5 border border-white/[0.04]">
              <span className="text-neutral-500 block text-[9px] uppercase">Tests Executed</span>
              <span className="text-violet-300 font-bold">{report.testsPassed ?? 0} / {report.testsRun ?? 0}</span>
            </div>
          </div>
          {report.filesModified.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {report.filesModified.map((file) => (
                <span key={file} className="rounded bg-white/[0.05] border border-white/[0.08] px-1.5 py-0.5 font-mono text-[9.5px] text-neutral-300">
                  {file}
                </span>
              ))}
            </div>
          )}
          {report.openIssues && report.openIssues.length > 0 && (
            <div className="mt-1 border-t border-emerald-500/15 pt-1 text-[10px] text-amber-300 font-mono space-y-0.5">
              <span className="text-neutral-500 uppercase text-[9px]">Open Follow-ups:</span>
              {report.openIssues.map((issue, idx) => (
                <div key={idx}>• {issue}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {orchestration.progress && orchestration.progress.length > 0 && (
        <details className="mt-2 pl-8">
          <summary className="cursor-pointer text-[10px] font-mono text-neutral-500 hover:text-neutral-300">
            Execution trace ({orchestration.progress.length} logs)
          </summary>
          <div className="mt-1.5 max-h-36 space-y-0.5 overflow-y-auto rounded bg-ink-950/80 p-2 font-mono text-[9.5px] text-neutral-400 border border-white/[0.04]">
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

  return (
    <div className="mb-2.5 rounded-xl border border-violet-500/20 bg-violet-950/15 p-2.5 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Brain className="w-3.5 h-3.5 text-violet-300 shrink-0" />
          <span className="font-semibold text-violet-200 text-xs">
            {streaming ? 'Deep Reasoning in Progress…' : 'Deep Reasoning Trace'}
          </span>
          <span className="text-[10px] text-neutral-500 font-mono">
            · {wordCount} words
          </span>
          {streaming && <Loader2 className="w-3 h-3 animate-spin text-violet-300 ml-1" />}
        </div>
        <ChevronRight className={`w-3.5 h-3.5 text-neutral-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <div className="mt-2 pt-2 border-t border-violet-400/10 max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-neutral-400 bg-black/30 p-2 rounded">
          {reasoning}
        </div>
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
    reading: { label: 'READ', tone: 'text-sky-300 border-sky-400/25 bg-sky-500/10' },
    planning: { label: 'PLAN', tone: 'text-violet-300 border-violet-400/25 bg-violet-500/10' },
    editing: { label: 'EDIT', tone: 'text-amber-300 border-amber-400/25 bg-amber-500/10' },
    checking: { label: 'CHECK', tone: 'text-indigo-300 border-indigo-400/25 bg-indigo-500/10' },
    completed: { label: 'DONE', tone: 'text-emerald-300 border-emerald-400/25 bg-emerald-500/10' },
    failed: { label: 'FAIL', tone: 'text-rose-300 border-rose-400/25 bg-rose-500/10' }
  };
  const config = tool.refused
    ? { label: 'HELD', tone: 'text-amber-300 border-amber-400/25 bg-amber-500/10' }
    : stageStyles[stage] || { label: 'TOOL', tone: 'text-neutral-300 border-white/10 bg-white/[0.04]' };

  return (
    <div className="rounded-lg border border-white/[0.06] bg-ink-950/80 transition-colors hover:border-white/[0.12]">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11px]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-mono font-semibold tracking-wider border ${config.tone}`}>
            {config.label}
          </span>
          <span className="font-mono text-neutral-300 truncate" title={tool.label}>
            {tool.label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-neutral-500 font-mono text-[10px]">
          {typeof tool.durationMs === 'number' && (
            <span className="flex items-center gap-0.5 text-neutral-500">
              <Clock className="w-2.5 h-2.5" />
              {tool.durationMs}ms
            </span>
          )}
          {tool.refused ? (
            <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
          ) : tool.ok ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
          )}
          <ChevronRight className={`w-3 h-3 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="border-t border-white/[0.06] bg-black/30 p-2.5 space-y-2 text-[10.5px]">
          {tool.error && (
            <div className="rounded border border-rose-500/30 bg-rose-950/30 p-2 text-rose-200 font-mono break-all">
              {tool.error}
            </div>
          )}
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-neutral-500 mb-1 font-semibold">Arguments</p>
              <pre className="max-h-36 overflow-y-auto rounded bg-ink-900/90 p-2 font-mono text-neutral-300 leading-relaxed break-all whitespace-pre-wrap">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <p className="text-[9.5px] uppercase tracking-wider text-neutral-500 mb-1 font-semibold">Output</p>
              <pre className="max-h-44 overflow-y-auto rounded bg-ink-900/90 p-2 font-mono text-neutral-300 leading-relaxed break-all whitespace-pre-wrap">
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
    <div className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 text-[11px]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="grid size-5 place-items-center rounded-md border border-violet-400/20 bg-violet-500/10 text-violet-300">
            <ListTree className="w-3 h-3" />
          </span>
          <span className="font-medium text-neutral-200">
            Agent Operations · {tools.length} step{tools.length === 1 ? '' : 's'}
          </span>
          {failedCount > 0 && (
            <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-px text-[9px] text-rose-300">
              {failedCount} failed
            </span>
          )}
          {heldCount > 0 && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[9px] text-amber-300">
              {heldCount} held
            </span>
          )}
          {streaming && <Loader2 className="w-3 h-3 animate-spin text-violet-300" />}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10px] text-neutral-500 font-mono">
          {totalDuration > 0 && <span>{totalDuration}ms</span>}
          <ChevronRight className={`w-3.5 h-3.5 text-neutral-400 transition-transform ${expanded ? 'rotate-90' : ''}`} />
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
    <div className="mb-2.5 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-[11px]">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <Brain className="w-3.5 h-3.5 text-violet-300" />
          <span className="font-semibold text-neutral-200 text-xs">Autonomous Task Plan</span>
          <span className="text-[10px] font-mono text-neutral-500">
            {completed}/{total} done ({percent}%)
          </span>
        </div>
        {streaming && <Loader2 className="w-3 h-3 animate-spin text-violet-300" />}
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-white/[0.06] h-1.5 rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-gradient-to-r from-violet-500 to-emerald-400 transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Steps List */}
      <ul className="space-y-1.5">
        {plan.map((task) => (
          <li key={task.id} className="flex items-start gap-2 rounded-lg bg-ink-950/40 p-2 border border-white/[0.04]">
            <div className="mt-0.5 shrink-0">
              {task.status === 'done' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : task.status === 'blocked' ? (
                <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
              ) : task.status === 'doing' ? (
                <Loader2 className={`w-3.5 h-3.5 ${streaming ? 'text-violet-300 animate-spin' : 'text-neutral-500'}`} />
              ) : (
                <span className="block size-2 rounded-full border border-neutral-600 bg-neutral-800 ml-1 mt-1" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className={`leading-snug ${task.status === 'done' ? 'text-neutral-500 line-through' : task.status === 'doing' ? 'text-white font-medium' : 'text-neutral-300'}`}>
                {task.subject}
              </p>
              {task.files && task.files.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {task.files.map((file) => (
                    <span key={file} className="rounded bg-white/[0.05] border border-white/[0.08] px-1.5 py-0.5 font-mono text-[9.5px] text-neutral-400">
                      {file}
                    </span>
                  ))}
                </div>
              )}
              {task.evidence && (
                <p className="mt-1 text-[10px] text-emerald-400/90 font-mono bg-emerald-950/20 rounded px-1.5 py-0.5 border border-emerald-500/20">
                  {task.evidence}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Plan review is separate from execution approval; file changes remain reviewable below. */}
      {approval && (approval.status === 'pending' || approval.status === 'required') && (
        <div className="mt-3 rounded-lg border border-violet-400/30 bg-violet-950/20 p-2.5">
          <div className="flex items-center gap-1.5 text-violet-200 font-medium text-xs mb-1">
            <Sparkles className="w-3.5 h-3.5 text-violet-300" />
            <span>Review proposed plan changes</span>
          </div>
          {approval.planSummary && (
            <p className="text-[11px] text-neutral-300 mb-2 leading-relaxed">
              {approval.planSummary}
            </p>
          )}
          {approval.targetFiles && approval.targetFiles.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1">
              {approval.targetFiles.map((file) => (
                <span key={file} className="rounded bg-violet-500/10 border border-violet-400/20 px-1.5 py-0.5 font-mono text-[9.5px] text-violet-300">
                  {file}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-violet-500 transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              Accept proposed changes
            </button>
            <button
              type="button"
              onClick={onReject}
              className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-xs text-neutral-400 hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              Reject proposed changes
            </button>
          </div>
        </div>
      )}

      {approval && approval.status === 'approved' && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-950/20 px-2.5 py-1.5 text-[11px] text-emerald-300">
          <Check className="w-3.5 h-3.5 text-emerald-400" />
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
          ? 'border-emerald-500/25 bg-emerald-950/20 text-emerald-200'
          : 'border-amber-500/30 bg-amber-950/20 text-amber-200'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {result.passed ? (
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <span className="font-semibold text-xs">
            {result.passed ? 'Code Verification Passed' : 'Verification Warnings'}
          </span>
          <span className="text-[10px] text-neutral-400 font-mono">
            {result.summary}
          </span>
        </div>
        {result.checks && result.checks.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="flex items-center gap-1 font-mono text-[10px] text-neutral-400 hover:text-white cursor-pointer"
          >
            <span>{result.checks.length} checks</span>
            <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>

      {open && result.checks && (
        <div className="mt-2 pt-2 border-t border-white/[0.08] space-y-1">
          {result.checks.map((chk, i) => (
            <div key={`${chk.name}-${i}`} className="flex items-start gap-1.5 font-mono text-[10.5px]">
              {chk.ok ? (
                <Check className="w-3 h-3 text-emerald-400 mt-0.5 shrink-0" />
              ) : (
                <AlertCircle className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
              )}
              <span className={chk.ok ? 'text-neutral-300' : 'text-amber-300'}>
                {chk.name}
              </span>
              {chk.details && (
                <span className="text-neutral-500 truncate" title={chk.details}>
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
    <div className="border-t border-white/[0.06] px-2 pb-1.5 pt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-[10px] text-neutral-400 transition-colors hover:text-neutral-200 cursor-pointer"
      >
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="font-medium">Review hunks</span>
        <span className="text-emerald-400/90">+{stats.added}</span>
        <span className="text-rose-400/90">−{stats.removed}</span>
        <span className="text-neutral-600">
          {hunks.length} hunk{hunks.length === 1 ? '' : 's'}
          {rejectedCount > 0 ? ` · ${rejectedCount} rejected` : ''}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {groupedSections.map((section) => (
            <div key={section.key} className="space-y-1.5">
              {section.label && (
                <div className="px-1 text-[10px] font-medium text-neutral-500">{section.label}</div>
              )}
              {section.hunks.map((hunk) => {
                const isRejected = rejected.has(hunk.reviewId);
                const removed = hunk.beforeEnd - hunk.beforeStart;
            return (
              <div
                key={hunk.reviewId}
                className={`overflow-hidden rounded-md border ${
                  isRejected ? 'border-white/[0.06] opacity-50' : 'border-white/[0.1]'
                }`}
              >
                <div className="flex items-center justify-between gap-2 px-1.5 py-1">
                  <span className="font-mono text-[10px] text-neutral-500">
                    line {hunk.beforeStart + 1}
                    {removed > 0 ? ` · −${removed}` : ''}
                    {hunk.afterLines.length > 0 ? ` +${hunk.afterLines.length}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(hunk.reviewId)}
                    className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer ${
                      isRejected
                        ? 'border-white/[0.12] text-neutral-400 hover:text-neutral-200'
                        : 'border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10'
                    }`}
                  >
                    {isRejected ? <X className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                    {isRejected ? 'Rejected' : 'Accepted'}
                  </button>
                </div>
                <div className="max-h-40 overflow-y-auto px-1.5 pb-1.5 font-mono text-[10px] leading-relaxed">
                  {section.beforeLines.slice(hunk.beforeStart, hunk.beforeEnd).map((line, index) => (
                    <div key={`removed-${index}`} className="flex gap-1.5 whitespace-pre text-rose-200/90">
                      <span className="w-2 shrink-0 select-none text-rose-400/60">−</span>
                      <span>{line || ' '}</span>
                    </div>
                  ))}
                  {hunk.afterLines.map((line, index) => (
                    <div key={`added-${index}`} className="flex gap-1.5 whitespace-pre text-emerald-200/90">
                      <span className="w-2 shrink-0 select-none text-emerald-400/60">+</span>
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
                className="text-[10px] text-neutral-500 transition-colors hover:text-neutral-300 cursor-pointer"
              >
                Accept all
              </button>
              <button
                type="button"
                onClick={() => setRejected(new Set(hunks.map((hunk) => hunk.reviewId)))}
                className="text-[10px] text-neutral-500 transition-colors hover:text-neutral-300 cursor-pointer"
              >
                Reject all
              </button>
            </div>
            <button
              type="button"
              disabled={acceptedIds.length === 0}
              onClick={() => onApply(acceptedIds)}
              className="rounded-md border border-violet-300/25 bg-violet-500/[.12] px-2 py-0.5 text-[10px] font-semibold text-violet-200 transition-colors hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
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
  plan,
  onOpenSettings,
  attachedFiles,
  onAttachedFilesChange,
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
  activeStatusMessage = null
}: ChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [isContextOpen, setIsContextOpen] = useState(false);
  const speech = useSpeechRecognition('en-US');
  const activeMode = getRefineMode(refineMode);

  /** `/name` in the composer is a project skill; a bare slash lists them all. */
  const slashName = /^\/([\w.-]*)$/.exec(input)?.[1]?.toLowerCase() ?? null;
  const skillMatches = useMemo(() => {
    if (slashName === null || slashDismissed || skills.length === 0) return [];
    const ordered = [...skills].sort((a, b) => skillKey(a.name).localeCompare(skillKey(b.name)));
    if (slashName === '') return ordered.slice(0, 8);
    return ordered.filter((skill) => skillKey(skill.name).startsWith(slashName)).slice(0, 8);
  }, [slashName, slashDismissed, skills]);

  const [usage, setUsage] = useState<UsageState>(() => getMonthlyUsage(plan));

  useEffect(() => {
    setUsage(getMonthlyUsage(plan));
    return onQuotaChange(() => {
      setUsage(getMonthlyUsage(plan));
    });
  }, [plan]);

  /** One dismissal path for every chat popover: outside click and Escape. */
  useEffect(() => {
    if (!isModelMenuOpen && !isAttachMenuOpen && !isModeMenuOpen && !isContextOpen) return;
    const inside = (ref: { current: HTMLElement | null }, target: EventTarget | null) =>
      Boolean(ref.current && target instanceof Node && ref.current.contains(target));
    const closeOthers = (event: PointerEvent) => {
      if (!inside(modelMenuRef, event.target) && !inside(modelTriggerRef, event.target)) setIsModelMenuOpen(false);
      if (!inside(attachMenuRef, event.target)) setIsAttachMenuOpen(false);
      if (!inside(modeMenuRef, event.target)) setIsModeMenuOpen(false);
      if (!inside(contextMenuRef, event.target)) setIsContextOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setIsModelMenuOpen(false);
      setIsAttachMenuOpen(false);
      setIsModeMenuOpen(false);
      setIsContextOpen(false);
    };
    document.addEventListener('pointerdown', closeOthers);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOthers);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isModelMenuOpen, isAttachMenuOpen, isModeMenuOpen, isContextOpen]);

  useEffect(() => {
    if (speech.transcript) onInputChange(speech.transcript);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speech.transcript]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const activeModel = models.find((model) => model.id === selectedModel) || null;
  const canSend = input.trim().length > 0 && !isGenerating && !usage.isCapReached;
  const canQueue = input.trim().length > 0 && isGenerating && !usage.isCapReached;
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

  /** BYOK keys, and plans with no monthly cap, have no meaningful used/limit ratio. */
  const quotaHasNoCap = usage.isUnlimited || Math.round(usage.limit) === 0;

  const groupedModels: Record<ModelTier, ModelInfo[]> = {
    free: models.filter((model) => model.tier === 'free'),
    own: models.filter((model) => model.tier === 'own'),
    pro: models.filter((model) => model.tier === 'pro')
  };

  const ActiveModeIcon = MODE_ICONS[refineMode] || Code2;

  return (
    <div className="h-full flex flex-col bg-ink-950 select-text">
      {/* Header */}
      <header className="h-12 shrink-0 flex items-center justify-between px-3 border-b border-white/[0.07]">
        <button
          type="button"
          ref={modelTriggerRef}
          onClick={() => setIsModelMenuOpen((open) => !open)}
          disabled={models.length === 0}
          title={activeModel ? activeModel.label : 'Select Model'}
          className={`mr-2 flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2 py-1 text-xs transition-colors cursor-pointer disabled:opacity-50 ${
            isModelMenuOpen
              ? 'border-violet-300/50 bg-violet-500/20 text-white'
              : 'border-violet-300/25 bg-violet-500/[0.08] text-neutral-100 hover:border-violet-300/40 hover:bg-violet-500/15'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-300" />
          <span className="truncate font-medium">{activeModel ? activeModel.label : 'Select Model'}</span>
          {activeModel && (
            <span className={`shrink-0 rounded px-1.5 py-0.5 border text-[10px] uppercase tracking-wide ${TIER_STYLES[activeModel.tier]}`}>
              {activeModel.tier}
            </span>
          )}
          <ChevronDown className="ml-auto w-3 h-3 shrink-0 text-neutral-400" />
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Monthly Quota Indicator Pill */}
          <button
            type="button"
            onClick={() => onOpenSettings('PLAN')}
            title={
              quotaHasNoCap
                ? `No monthly cap — ${Math.round(usage.used)} credits used this month. Manage plan in Settings.`
                : `Credits: ${Math.round(usage.used)}/${Math.round(usage.limit)} used this month (${Math.floor(usage.remaining)} left)`
            }
            className={`flex items-center gap-1 rounded-full px-2 py-1 border text-[10px] tracking-wide transition-colors cursor-pointer ${quotaTone.pill}`}
          >
            <Zap className={`w-3 h-3 ${quotaTone.icon}`} />
            <span className="font-mono">
              {quotaHasNoCap ? 'BYOK' : `${Math.round(usage.used)}/${Math.round(usage.limit)}`}
            </span>
          </button>

          <div ref={contextMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setIsContextOpen((open) => !open)}
              title="What the model can see: repo map, retrieval mode and pinned context"
              className={`p-1.5 transition-colors cursor-pointer ${isContextOpen ? 'text-violet-300' : 'text-neutral-500 hover:text-white'}`}
            >
              <ListTree className="w-3.5 h-3.5" />
            </button>
            {isContextOpen && (
              <div className="absolute right-0 top-8 z-30 w-80 overflow-hidden rounded-xl border border-white/[0.09] bg-ink-900/95 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                    What the model can see
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsContextOpen(false)}
                    className="text-neutral-500 hover:text-white cursor-pointer"
                    aria-label="Close context details"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="space-y-1.5 border-b border-white/[0.07] px-3 py-2 text-[11px]">
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>Files indexed</span>
                    <span className="font-mono text-neutral-300">{workspaceFiles.length}</span>
                  </div>
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>Pinned context</span>
                    <span className="font-mono text-neutral-300">{attachedFiles.length + pinnedSymbols.length}</span>
                  </div>
                  <div className="flex items-start justify-between gap-3 text-neutral-400">
                    <span>Retrieval</span>
                    <span className="text-right text-neutral-300">
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
                <div className="px-3 py-2">
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">Repo map sent with each request</p>
                  {repoMap ? (
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.07] bg-ink-950/60 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-400">
                      {repoMap}
                    </pre>
                  ) : repoMapLoading ? (
                    <p className="text-[11px] text-neutral-600">Reading the folder once to build the map…</p>
                  ) : (
                    <p className="text-[11px] text-neutral-600">Open a folder or attach a file to build a map.</p>
                  )}
                  <p className="mt-2 text-[10px] text-neutral-600">
                    Attach a file or pin a symbol with <span className="font-mono text-neutral-400">@</span> to force it into context.
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
            className="p-1.5 text-neutral-500 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Model Selector Dropdown */}
      {isModelMenuOpen && (
        <div ref={modelMenuRef} className="shrink-0 max-h-64 overflow-y-auto border-b border-white/[0.07] bg-ink-950">
          {models.length === 0 ? (
            <button
              type="button"
              onClick={() => {
                setIsModelMenuOpen(false);
                onOpenSettings('CHAT');
              }}
              className="w-full px-3 py-4 text-left text-xs text-neutral-400 hover:text-white cursor-pointer"
            >
              No models available. Add your API key — and for a custom endpoint its URL and model ids — in Settings.
            </button>
          ) : (
            (['free', 'own', 'pro'] as ModelTier[]).map((tier) =>
              groupedModels[tier].length === 0 ? null : (
                <div key={tier}>
                  <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-600">
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
        {backgroundResume && (
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2.5">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-amber-100">Background run paused</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-amber-200/80">
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
                  className="flex items-center gap-1 rounded-md border border-amber-500/30 px-2 py-0.5 text-[10px] text-amber-200 transition-colors hover:bg-amber-500/10 disabled:opacity-40 cursor-pointer"
                >
                  <Play className="h-2.5 w-2.5" />
                  Resume
                </button>
                <button
                  type="button"
                  onClick={backgroundResume.onDismiss}
                  title="Forget this interrupted run"
                  className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-0.5 text-[10px] text-neutral-400 transition-colors hover:bg-white/[0.04] cursor-pointer"
                >
                  <X className="h-2.5 w-2.5" />
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        )}
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-neutral-500">
            <Sparkles className="w-6 h-6 text-violet-300/70 mb-2" />
            <p className="text-xs text-neutral-300 font-medium">ShadRox Assistant</p>
            <p className="mt-1 text-[11px] text-neutral-500 max-w-xs leading-relaxed">
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
              <div className="flex items-center gap-1.5 mb-1 px-1 text-[10px] text-neutral-500">
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
                    className="rounded-md border border-white/[0.09] bg-white/[0.04] px-2 py-0.5 text-[10px] font-mono text-neutral-400"
                  >
                    {file}
                  </span>
                ))}
              </div>
            )}

            {message.role === 'user' ? (
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-violet-300/15 bg-gradient-to-b from-violet-500/[0.14] to-violet-500/[0.07] px-3.5 py-2.5 text-neutral-100 leading-relaxed whitespace-pre-wrap shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                {message.content}
              </div>
            ) : (
              <div className="relative w-full max-w-[96%] overflow-hidden rounded-2xl border border-white/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.012)_42%,rgba(255,255,255,0.008))] shadow-[0_1px_0_rgba(255,255,255,0.03)_inset,0_14px_36px_-24px_rgba(0,0,0,0.9)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-400/35 to-transparent" />
                <div className="px-3.5 pb-2.5 pt-3">
                  <div className="mb-2.5 flex items-center gap-2">
                    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-[0_2px_10px_-2px_rgba(139,92,246,0.7)]">
                      <Sparkles className="size-3" />
                    </span>
                    <span className="text-[11px] font-semibold tracking-tight text-neutral-100">ShadRox</span>
                    <span className="font-mono text-[10px] text-neutral-600">{message.timestamp}</span>
                    {message.streaming && (
                      <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-violet-400/20 bg-violet-500/10 px-1.5 py-px text-[9px] font-medium tracking-wide text-violet-200">
                        <span className="size-1 animate-pulse rounded-full bg-violet-300" />
                        writing
                      </span>
                    )}
                  </div>
                {message.orchestration && <OrchestrationCard message={message} onStop={onStop} />}

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

                {message.reasoning && (
                  <ThinkingTrace reasoning={message.reasoning} streaming={message.streaming} />
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
                  const fileCount = new Set(patchSet.patches.map((patch) => patch.path.toLowerCase())).size;
                  const editCount = patchSet.patches.length;
                  return (
                    <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 text-[11px]">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-neutral-300 font-medium">
                          <FileDiff className="w-3.5 h-3.5 text-violet-300 shrink-0" />
                          Changes · {fileCount} file{fileCount === 1 ? '' : 's'}
                          {editCount > fileCount ? ` · ${editCount} edits` : ''}
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
                          {typeFixCounts?.[message.id] ? (
                            <button
                              type="button"
                              onClick={() => onFixTypeErrors?.(message.id)}
                              title="Ask the model to fix only the type errors this apply introduced"
                              className="rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-0.5 text-[10px] font-semibold text-amber-200 transition-colors hover:bg-amber-900/40 cursor-pointer"
                            >
                              Fix {typeFixCounts[message.id]} type error{typeFixCounts[message.id] === 1 ? '' : 's'}
                            </button>
                          ) : null}
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
                            className="rounded-lg border border-white/[0.06] bg-ink-950/60"
                          >
                            <div className="flex items-center justify-between gap-2 px-2 py-1">
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
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-2 text-[10px] text-neutral-500">
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
                          className={`flex items-center gap-1 transition-colors hover:text-amber-400 disabled:opacity-40 cursor-pointer ${open ? 'text-amber-300' : ''}`}
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
                        className="flex items-center gap-1 text-violet-300 transition-colors hover:text-violet-200 cursor-pointer"
                      >
                        <Play className="w-3 h-3" />
                        Resume reply
                      </button>
                    )}
                    {message.metrics && (message.metrics.tokens > 0 || message.metrics.firstTokenMs !== null) && (
                      <details className="font-mono text-neutral-600">
                        <summary className="flex cursor-pointer items-center gap-1">
                          <Zap className="w-3 h-3" />
                          Usage
                        </summary>
                        <span className="mt-1 block" title="Time to first token · input/output tokens · credits billed · total duration">
                          {message.metrics.firstTokenMs !== null ? `${message.metrics.firstTokenMs}ms` : '—'}
                          {message.metrics.tokens > 0 ? ` · ${formatTokenSplit(message.metrics, message.metrics.tokens)}` : ''}
                          {message.metrics.credits !== undefined ? ` · ${formatCredits(message.metrics.credits)}` : ''}
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
          />
        </div>
      )}

      {/* Input Area & Prompt Box */}
      <div className="shrink-0 border-t border-white/[0.07] p-3 bg-ink-950">
        {/* Monthly Cap Warning Banner */}
        {usage.isCapReached && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-rose-500/25 bg-rose-500/[.07] p-2 text-[11px] text-rose-300">
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="truncate">Out of credits this month ({Math.round(usage.limit)}/{Math.round(usage.limit)})</span>
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

        {/* Live Agent Phase / Activity Status */}
        {activeStatusMessage && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-violet-400/25 bg-violet-950/30 px-2.5 py-1.5 text-[11px] text-violet-200">
            <div className="flex items-center gap-2 min-w-0">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500"></span>
              </span>
              <span className="truncate font-mono text-[10.5px] text-violet-200">
                {activeStatusMessage}
              </span>
            </div>
            {onStop && isGenerating && (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 text-[10px] text-red-300 hover:text-red-200 cursor-pointer shrink-0"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            )}
          </div>
        )}

        {isRefining && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-violet-300/80">
            <Loader2 className="w-3 h-3 animate-spin" />
            {refineStep || 'Refining prompt...'}
          </div>
        )}

        {attachedFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachedFiles.map((name) => (
              <span
                key={name}
                className="flex max-w-full items-center gap-1 rounded-lg border border-white/[0.09] bg-white/[0.02] px-2 py-1 text-[11px] text-neutral-300"
              >
                {/\.(mdx?|txt|rst)$/i.test(name) ? (
                  <FileText className="h-3 w-3 shrink-0 text-violet-300/80" />
                ) : (
                  <FileCode2 className="h-3 w-3 shrink-0 text-violet-300/80" />
                )}
                <span className="truncate font-mono">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => onAttachedFilesChange(attachedFiles.filter((file) => file !== name))}
                  className="ml-0.5 text-neutral-600 hover:text-white cursor-pointer"
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
                className="flex max-w-full items-center gap-1 rounded-lg border border-violet-300/20 bg-violet-500/[.08] px-2 py-1 text-[11px] text-violet-100"
              >
                <Code2 className="h-3 w-3 shrink-0 text-violet-300/80" />
                <span className="truncate font-mono">{symbol.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${symbol.name}`}
                  onClick={() =>
                    onPinnedSymbolsChange(
                      pinnedSymbols.filter((entry) => !(entry.name === symbol.name && entry.file === symbol.file))
                    )
                  }
                  className="ml-0.5 text-violet-300/50 hover:text-white cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="mb-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-neutral-500">
              <span>Queued messages</span>
              <span>{queuedMessages.length}/5</span>
            </div>
            <ol className="space-y-1">
              {queuedMessages.map((message, index) => (
                <li key={message.id} className="flex items-center gap-2 text-[11px] text-neutral-300">
                  <span className="shrink-0 font-mono text-neutral-600">{index + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{message.text}</span>
                  {onCancelQueuedMessage && (
                    <button
                      type="button"
                      onClick={() => onCancelQueuedMessage(message.id)}
                      aria-label={`Cancel queued message ${index + 1}`}
                      className="shrink-0 text-neutral-600 transition-colors hover:text-rose-300 cursor-pointer"
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
        <div className="relative rounded-2xl border border-white/[0.09] bg-white/[0.03] transition-colors focus-within:border-violet-300/40 focus-within:bg-white/[0.04]">
          {skillMatches.length > 0 && (
            <div className="absolute bottom-full left-2 right-2 z-20 mb-2 overflow-hidden rounded-xl border border-white/[0.09] bg-ink-900/95 py-1 shadow-2xl backdrop-blur-xl">
              <div className="border-b border-white/[0.07] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Skill of this folder
              </div>
              {skillMatches.map((skill) => (
                <button
                  key={skill.path}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    handleInputChange(`/${skillKey(skill.name)} `);
                  }}
                  className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer text-neutral-400 hover:bg-white/[0.04] hover:text-white"
                >
                  <span className="shrink-0 font-mono text-[11px] text-violet-200">/{skillKey(skill.name)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px]">
                    {skill.description || skill.whenToUse || 'no description'}
                  </span>
                </button>
              ))}
              <div className="border-t border-white/[0.07] px-3 py-1 text-[10px] text-neutral-600">
                Tab inserts the name · Esc hides
              </div>
            </div>
          )}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-2 right-2 z-20 mb-2 overflow-hidden rounded-xl border border-white/[0.09] bg-ink-900/95 py-1 shadow-2xl backdrop-blur-xl">
              <div className="border-b border-white/[0.07] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                Attach a file or pin a symbol
              </div>
              {mentionMatches.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-neutral-500">
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
                        ? 'bg-violet-500/[.14] text-violet-100'
                        : 'text-neutral-400 hover:bg-white/[0.04] hover:text-white'
                    }`}
                  >
                    {item.kind === 'symbol' ? (
                      <Code2 className="h-3.5 w-3.5 shrink-0 text-violet-300/80" />
                    ) : /\.(mdx?|txt|rst)$/i.test(item.file) ? (
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{item.label}</span>
                    {item.kind === 'symbol' && (
                      <span className="shrink-0 truncate font-mono text-[10px] text-neutral-600">
                        {item.file}:{(item.line ?? 0) + 1}
                      </span>
                    )}
                  </button>
                ))
              )}
              <div className="border-t border-white/[0.07] px-3 py-1 text-[10px] text-neutral-600">
                ↑↓ choose · Enter attach · Esc close
              </div>
            </div>
          )}
          <textarea
            value={input}
            onChange={(event) => handleInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (skillMatches.length > 0) {
                if (event.key === 'Tab') {
                  event.preventDefault();
                  handleInputChange(`/${skillKey(skillMatches[0].name)} `);
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
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (canSend || canQueue) onSend();
              }
            }}
            rows={3}
            placeholder={
              usage.isCapReached
                ? 'Monthly message cap reached. Manage usage in Settings...'
                : 'Ask ShadRox to build, refactor, or explain code… (@ to attach a file or symbol)'
            }
            disabled={usage.isCapReached}
            className="w-full resize-none rounded-2xl bg-transparent px-3.5 py-3 text-xs text-neutral-100 outline-none placeholder:text-neutral-600 disabled:opacity-50"
          />

          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
            <div className="flex min-w-0 flex-auto flex-wrap items-center gap-1.5">
              {/* Work Mode Dropdown (Replaces old template option with Code, Plan, Complex) */}
              <div ref={modeMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsModeMenuOpen((open) => !open)}
                  title={`Active mode: ${activeMode.label} — ${activeMode.hint}`}
                  className={`flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                    refineMode === 'plan'
                      ? 'border-amber-500/30 bg-amber-500/[.08] text-amber-300'
                      : refineMode === 'complex'
                        ? 'border-purple-400/30 bg-purple-500/[.10] text-purple-300'
                        : 'border-violet-300/30 bg-violet-500/10 text-violet-200'
                  }`}
                >
                  <ActiveModeIcon className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate font-medium">Mode</span>
                  <ChevronDown className="w-3 h-3 shrink-0 text-neutral-400" />
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
              <div ref={attachMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsAttachMenuOpen((open) => !open)}
                  disabled={attachableFiles.length === 0}
                  title={attachableFiles.length === 0
                    ? (workspaceAllFiles.length === 0 && workspaceFiles.length === 0
                        ? 'Open a folder to attach files'
                        : 'Every workspace file is already attached')
                    : 'Attach file context'}
                  className="shrink-0 p-1.5 text-neutral-500 hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
                {isAttachMenuOpen && (
                  <div className="absolute bottom-8 left-0 z-10 max-h-64 w-64 overflow-y-auto rounded-xl border border-white/[0.09] bg-ink-900/95 py-1 shadow-2xl backdrop-blur-xl">
                    {attachableFiles.map((file) => (
                      <button
                        key={file.name}
                        type="button"
                        onClick={() => {
                          onAttachedFilesChange([...new Set([...attachedFiles, file.name])]);
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
                  className={`shrink-0 p-1.5 transition-colors cursor-pointer ${
                    speech.isListening ? 'text-red-400 animate-pulse' : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  {speech.isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                </button>
              )}
              {speech.error && (
                <span
                  title={speech.error.message}
                  className="max-w-36 shrink-0 truncate rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] text-amber-300"
                >
                  {speech.error.message}
                </span>
              )}

              {/* Refine prompt button */}
              {hasKey && (
                <button
                  type="button"
                  onClick={onRefinePrompt}
                  disabled={!input.trim() || isRefining || isGenerating}
                  title="Auto-refine prompt with AI"
                  className="shrink-0 p-1.5 text-neutral-500 hover:text-white disabled:opacity-30 transition-colors cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Right side: toggles, token count & Send Button */}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <label
                title="Semantic: re-rank the retrieval shortlist with an on-device embedding model. Off = BM25 only."
                className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500 hover:text-neutral-300 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={semanticRetrieval}
                  onChange={onToggleSemanticRetrieval}
                  disabled={semanticStatus === 'checking'}
                  aria-label="Semantic retrieval"
                  className="accent-violet-400 cursor-pointer disabled:opacity-40"
                />
                <span className="hidden sm:inline">Semantic</span>
                {semanticStatus === 'checking' && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {semanticStatus === 'ready' && (
                  <span className="font-mono normal-case text-neutral-600">{semanticChunkCount}</span>
                )}
                {semanticStatus === 'unavailable' && (
                  <span
                    className="text-amber-400/80"
                    title="Local embeddings unavailable — install @huggingface/transformers to enable. Retrieval stays on BM25."
                  >
                    !
                  </span>
                )}
              </label>

              <label
                title="Auto: a cheap model first picks which files this task needs, your answer model then reads those files from disk. Heavy repo context stops landing on the expensive model."
                className="flex shrink-0 items-center gap-1 text-[10px] uppercase tracking-wide text-neutral-500 hover:text-neutral-300 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={autoContext}
                  onChange={onToggleAutoContext}
                  aria-label="Auto file context"
                  className="accent-violet-400 cursor-pointer"
                />
                <span className="hidden sm:inline">Auto</span>
              </label>

              {input.length > 0 && (
                <span className="hidden text-[10px] text-neutral-500 font-mono xl:inline">
                  {input.length}c · ~{estimateTokens(input)} tok
                </span>
              )}

              {isGenerating ? (
                <>
                  <button
                    type="button"
                    onClick={() => onSend()}
                    disabled={!canQueue || queuedMessages.length >= 5}
                    title="Queue this message after the current task"
                    className="flex items-center gap-1.5 rounded-lg border border-violet-300/25 px-2.5 py-1.5 text-[11px] text-violet-200 transition-colors hover:bg-violet-500/10 disabled:opacity-30 cursor-pointer"
                  >
                    <MessageSquarePlus className="w-3 h-3" />
                    Queue
                  </button>
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-[11px] text-red-300 transition-colors hover:bg-red-500/10 cursor-pointer"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    Stop
                  </button>
                </>
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
