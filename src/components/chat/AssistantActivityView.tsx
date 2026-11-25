import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Clock,
  FileSearch,
  ListTree,
  Loader2,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Users,
  X
} from 'lucide-react';
import type { ChatMessage, SubagentActivityRecord } from '../../lib/types';
import { dedupePaths } from '../../lib/paths';
import { MAX_CONCURRENT_SUBAGENTS } from '../../lib/agent/subagent';
import { findRecoveredToolIndices, formatToolDuration, formatTurnElapsed, summarizeToolActivity } from './chatUx';

const ORCHESTRATION_STATUS: Record<string, { label: string; tone: string }> = {
  planning: { label: 'planning', tone: 'text-accent border-accent-line bg-accent-soft' },
  running: { label: 'working', tone: 'text-accent border-accent-line bg-accent-soft' },
  done: { label: 'done', tone: 'text-ok border-ok/30 bg-ok/10' },
  failed: { label: 'failed', tone: 'text-danger border-danger/30 bg-danger/10' },
  stopped: { label: 'stopped', tone: 'text-ink-3 border-line-2 bg-surface-2' },
  paused: { label: 'paused', tone: 'text-cool border-cool/30 bg-cool-soft' }
};

export function WorkingResponseSkeleton({ phase }: { phase: string }) {
  return (
    <div className="space-y-3 py-1" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-[12px] font-medium text-ink-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
        <span className="truncate">{phase}</span>
      </div>
      <div className="space-y-2 pl-5">
        <div className="h-2 w-4/5 animate-pulse rounded bg-surface-2" />
        <div className="h-2 w-3/5 animate-pulse rounded bg-surface-2" />
        <div className="h-2 w-2/3 animate-pulse rounded bg-surface-2" />
      </div>
    </div>
  );
}

export function StreamingResponseFooter({
  phase,
  onStop
}: {
  phase: string;
  onStop?: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-line/70 pt-2 text-[11px] text-ink-3">
      <div className="flex min-w-0 items-center gap-2">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
        <span className="truncate font-mono text-[10.5px]">{phase}</span>
      </div>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger transition-colors hover:bg-danger/15"
        >
          <Square className="h-2.5 w-2.5 fill-current" />
          Stop
        </button>
      )}
    </div>
  );
}

export function OrchestrationCard({
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
  const latestTrace =
    orchestration.progress && orchestration.progress.length > 0
      ? orchestration.progress[orchestration.progress.length - 1]
      : null;

  return (
    <div className="mb-3 rounded-xl border border-line bg-surface-2/70 p-3 text-[11.5px]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-lg border border-accent-line bg-accent-soft">
            <Icon className="h-3.5 w-3.5 text-accent" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink">
              <span>{orchestration.kind === 'team' ? 'Specialist Team' : 'Autonomous Run'}</span>
              {active && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
              <span className={`rounded-md border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide ${status.tone}`}>
                {status.label}
              </span>
            </div>
            {orchestration.detail && (
              <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-3" title={orchestration.detail}>
                {orchestration.detail}
              </p>
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
                className="flex cursor-pointer items-center gap-1 rounded-md border border-cool/30 bg-surface px-2 py-0.5 text-[10px] font-medium text-cool transition-colors hover:bg-cool-soft"
              >
                <Pause className="h-2.5 w-2.5" />
                Pause
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              className="flex cursor-pointer items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger transition-colors hover:bg-danger/15"
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
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-ok/30 bg-ok/10 px-2 py-0.5 text-[10px] font-medium text-ok transition-colors hover:bg-ok/15"
          >
            <Play className="h-2.5 w-2.5 fill-current" />
            Resume
          </button>
        )}
      </div>

      {active && latestTrace && (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[10.5px] text-ink-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-strong" />
          <span className="min-w-0 truncate">{latestTrace}</span>
        </div>
      )}

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
          <div className={`mt-3 space-y-2 rounded-lg border p-2.5 ${cardTone}`}>
            <div className={`flex flex-wrap items-center justify-between gap-2 border-b pb-1.5 ${borderTone}`}>
              <span className={`flex items-center gap-1.5 text-xs font-semibold ${headerTone}`}>
                {failedOrIncomplete
                  ? <AlertTriangle className={`h-3.5 w-3.5 ${headerTone}`} />
                  : <Check className={`h-3.5 w-3.5 ${headerTone}`} />}
                Summary Report
              </span>
              <div className="flex items-center gap-1.5">
                {report.mergeVerdict && (
                  <span className={`rounded-md border px-1.5 py-px font-mono text-[9.5px] uppercase ${mergeBadgeTone}`}>
                    {report.mergeVerdict}
                  </span>
                )}
                <span className={`font-mono tabular-nums text-[10px] ${headerTone}`}>
                  {report.tasksCompleted}/{report.totalTasks} tasks
                </span>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-ink-2">{report.overview}</p>
            <div className="grid grid-cols-2 gap-2 pt-0.5 font-mono text-[10px] text-ink-3">
              <div className="rounded-md border border-line bg-surface px-2 py-1.5">
                <span className="block text-[9px] uppercase text-ink-4">Files Modified</span>
                <span className={`font-bold tabular-nums ${headerTone}`}>{dedupedFiles.length} file(s)</span>
              </div>
              <div className="rounded-md border border-line bg-surface px-2 py-1.5">
                <span className="block text-[9px] uppercase text-ink-4">Tests Passed</span>
                <span className="font-bold tabular-nums text-accent">{report.testsPassed ?? 0} / {report.testsRun ?? 0}</span>
              </div>
            </div>
            {dedupedFiles.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {dedupedFiles.map((file) => (
                  <span key={file} className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-ink-2">
                    {file}
                  </span>
                ))}
              </div>
            )}
            {report.openIssues && report.openIssues.length > 0 && (
              <div className={`mt-1 space-y-0.5 border-t pt-1.5 font-mono text-[10px] text-warn ${borderTone}`}>
                <span className="text-[9px] uppercase text-ink-4">Open Follow-ups:</span>
                {report.openIssues.map((issue, idx) => (
                  <div key={idx}>• {issue}</div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {orchestration.progress && orchestration.progress.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-[10px] text-ink-4 hover:text-ink-2">
            Execution trace ({orchestration.progress.length} logs)
          </summary>
          <div className="mt-1.5 max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-base p-2 font-mono text-[9.5px] text-ink-2">
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

export function ThinkingTrace({ reasoning, streaming, durationMs }: { reasoning: string; streaming?: boolean; durationMs?: number }) {
  const [open, setOpen] = useState(false);
  const wordCount = useMemo(() => reasoning.trim().split(/\s+/).filter(Boolean).length, [reasoning]);
  const seconds = durationMs ? (durationMs / 1000).toFixed(1) : null;

  return (
    <div className="mb-3 rounded-xl border border-line bg-surface-2/80 px-3.5 py-2.5 text-[11px] shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Brain className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="text-[11.5px] font-semibold text-ink">
            {streaming ? 'Thinking & Progress…' : `Thought & worked${seconds ? ` for ${seconds}s` : ''} (${wordCount} words)`}
          </span>
          {streaming && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-ink-4">
          <span>{open ? 'Hide' : 'Show details'}</span>
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="mt-2.5 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-t border-line pt-2.5 font-mono text-[10.5px] leading-relaxed text-ink-2">
          {reasoning}
        </div>
      )}
    </div>
  );
}

export function SelfHealingProofCard({
  proof
}: {
  proof: import('../../lib/repairProof').FailureReceipt;
}) {
  const isHealed = proof.status === 'verified_healed';
  const isRejected = proof.status === 'rejected';
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
    <div className={`mb-3 rounded-xl border p-3 text-[11px] ${surface}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`grid size-6 shrink-0 place-items-center rounded-md border ${badge}`}>
            <ShieldCheck className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink">
              <span>Self-Healing Proof</span>
              <span className={`rounded-md border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wide ${badge}`}>
                {proof.status.replace('_', ' ')}
              </span>
              <span className="font-mono text-[10px] text-ink-4">[{proof.source.toUpperCase()}]</span>
            </div>
            <p className="mt-0.5 max-w-[20rem] truncate font-mono text-[10.5px] text-ink-3" title={proof.target}>
              {proof.target}
            </p>
          </div>
        </div>
      </div>

      {proof.errorMessage && (
        <div className="mt-2 rounded-lg border border-line bg-surface p-2 font-mono text-[10.5px] text-ink-2">
          {proof.errorMessage}
        </div>
      )}

      {proof.verificationEvidence && (
        <div className={`mt-2 flex items-center gap-1 font-mono text-[10px] ${isHealed ? 'text-ok' : isRejected ? 'text-warn' : 'text-danger'}`}>
          <Check className="h-3 w-3 shrink-0" />
          <span>{proof.verificationEvidence}</span>
        </div>
      )}

      {(proof.stackTrace || (proof.diagnostics && proof.diagnostics.length > 0)) && (
        <details className="mt-2">
          <summary className="cursor-pointer font-mono text-[10px] text-ink-4 hover:text-ink-2">
            View captured failure evidence
          </summary>
          <div className="mt-1.5 max-h-32 overflow-y-auto rounded-lg border border-line bg-base p-2 font-mono text-[9.5px] text-ink-2">
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

function parsePatchFailureSummary(failure: string, filePath?: string): { headline: string; hasDetails: boolean } {
  const trimmed = failure.trim();
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0] ?? '';
  const cleaned = firstLine
    .replace(/^Not applied\s*[—-]\s*/i, '')
    .replace(/\s*—\s*re-read the file and copy the current text exactly$/i, '')
    .trim();
  const prefix = filePath && !cleaned.toLowerCase().startsWith(filePath.toLowerCase()) ? `${filePath}: ` : '';
  const headline = `Not applied — ${prefix}${cleaned || 'patch could not match file'}`;
  const hasDetails = lines.length > 1 || trimmed.length > headline.length + 12;
  return { headline, hasDetails };
}

export function CollapsiblePatchFailurePill({
  failure,
  filePath,
  expanded,
  onToggle
}: {
  failure: string;
  filePath?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { headline, hasDetails } = parsePatchFailureSummary(failure, filePath);
  if (!hasDetails) {
    return (
      <span
        className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger"
        title={failure}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="truncate">{headline}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={failure}
      className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger transition-colors hover:bg-danger/15"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span className="truncate">{headline}</span>
      <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
    </button>
  );
}

function ToolStepRow({
  tool,
  isLiveActive,
  recovered,
  turnStreaming
}: {
  tool: NonNullable<ChatMessage['toolActivity']>[number];
  isLiveActive: boolean;
  recovered: boolean;
  turnStreaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const isCalmAdjustment = !tool.ok && !tool.refused && (recovered || Boolean(turnStreaming));
  const stage = isCalmAdjustment
    ? 'adjusted'
    : (tool.stage ?? (tool.ok ? (tool.name.includes('read') || tool.name.includes('list') ? 'reading' : 'completed') : 'failed'));

  const stageStyles: Record<string, { label: string; tone: string; Icon: typeof FileSearch }> = {
    reading: { label: 'READ', tone: 'text-cool', Icon: FileSearch },
    planning: { label: 'PLAN', tone: 'text-accent', Icon: ListTree },
    editing: { label: 'EDIT', tone: 'text-warn', Icon: Pencil },
    checking: { label: 'CHECK', tone: 'text-cool', Icon: Terminal },
    completed: { label: 'DONE', tone: 'text-ok', Icon: Check },
    adjusted: { label: 'ADJ', tone: 'text-ink-3', Icon: RotateCcw },
    failed: { label: 'FAIL', tone: 'text-danger', Icon: AlertCircle }
  };
  const config = tool.refused
    ? { label: 'HELD', tone: 'text-ink-3', Icon: RotateCcw }
    : stageStyles[stage] || { label: 'STEP', tone: 'text-ink-3', Icon: Terminal };
  const StageIcon = config.Icon;
  const isPatchMismatchError = Boolean(
    tool.error && /(?:not applied|closest region on disk|text not found|old text not found)/i.test(tool.error)
  );
  const durationLabel = formatToolDuration(tool.durationMs);

  return (
    <div className="border-b border-line/60 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-surface"
      >
        <div className="flex min-w-0 items-center gap-2">
          <StageIcon className={`h-3.5 w-3.5 shrink-0 ${config.tone}`} />
          <span className={`shrink-0 font-mono text-[9.5px] font-semibold uppercase tracking-wider ${config.tone}`}>
            {config.label}
          </span>
          <span className="truncate font-mono text-[11px] text-ink-2" title={tool.label}>
            {tool.label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-ink-4">
          {durationLabel && (
            <span className="flex items-center gap-0.5 tabular-nums">
              <Clock className="h-2.5 w-2.5" />
              {durationLabel}
            </span>
          )}
          {isLiveActive ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : tool.refused || isCalmAdjustment ? (
            <RotateCcw className="h-3 w-3 text-ink-4" />
          ) : tool.ok ? (
            <Check className="h-3.5 w-3.5 text-ok" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-danger" />
          )}
          <ChevronRight className={`h-3 w-3 text-ink-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {open && (
        <div className="space-y-2 border-t border-line/60 bg-base px-2.5 py-2 text-[10.5px]">
          {tool.error && (
            isPatchMismatchError && !isCalmAdjustment ? (
              <div className="space-y-1.5">
                <CollapsiblePatchFailurePill
                  failure={tool.error}
                  expanded={errorDetailsOpen}
                  onToggle={() => setErrorDetailsOpen((prev) => !prev)}
                />
                {errorDetailsOpen && (
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-danger/25 bg-danger/5 p-2 font-mono text-[10px] leading-relaxed text-danger">
                    {tool.error}
                  </pre>
                )}
              </div>
            ) : (
              <div
                className={`break-all rounded border p-2 font-mono ${
                  isCalmAdjustment || tool.refused
                    ? 'border-line bg-surface-2 text-ink-3'
                    : 'border-danger/30 bg-danger/10 text-danger'
                }`}
              >
                {tool.error}
              </div>
            )
          )}
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div>
              <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-wider text-ink-4">Arguments</p>
              <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 font-mono leading-relaxed text-ink-2">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <p className="mb-1 text-[9.5px] font-semibold uppercase tracking-wider text-ink-4">Output</p>
              <pre className="max-h-44 overflow-y-auto whitespace-pre-wrap break-all rounded border border-line bg-surface p-2 font-mono leading-relaxed text-ink-2">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolActivityFeed({
  tools,
  streaming,
  turnDurationMs,
  turnStartedAt
}: {
  tools: NonNullable<ChatMessage['toolActivity']>;
  streaming?: boolean;
  turnDurationMs?: number;
  turnStartedAt?: number;
}) {
  // Open live steps while the agent is actively executing so users see progress
  // immediately, then fold cleanly into a compact summary once the turn settles.
  const [expanded, setExpanded] = useState(Boolean(streaming));
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    setExpanded(Boolean(streaming));
  }, [streaming]);

  useEffect(() => {
    if (!streaming || !turnStartedAt) return;
    setLiveNow(Date.now());
    const timer = window.setInterval(() => setLiveNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [streaming, turnStartedAt]);

  const recoveredIndices = useMemo(() => findRecoveredToolIndices(tools), [tools]);
  const summary = useMemo(() => summarizeToolActivity(tools, { streaming }), [tools, streaming]);
  const elapsedMs = streaming && turnStartedAt
    ? Math.max(0, liveNow - turnStartedAt)
    : (turnDurationMs ?? (summary.totalDurationMs > 0 ? summary.totalDurationMs : undefined));
  const durationLabel = turnDurationMs || (streaming && turnStartedAt)
    ? formatTurnElapsed(elapsedMs)
    : formatToolDuration(summary.totalDurationMs);

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-line bg-surface-2/70 text-[11px]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-md border border-line bg-surface text-accent">
            {streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : <ListTree className="h-3 w-3" />}
          </span>
          <span className="truncate font-medium text-ink">
            {streaming ? 'Working' : 'Operations'} · {summary.total} step{summary.total === 1 ? '' : 's'}
          </span>
          {!streaming && summary.failed > 0 && (
            <span className="shrink-0 rounded-md border border-danger/30 bg-danger/10 px-1.5 py-px font-mono text-[9.5px] text-danger">
              {summary.failed} failed
            </span>
          )}
          {summary.recovered > 0 && (
            <span className="shrink-0 rounded-md border border-line bg-surface px-1.5 py-px font-mono text-[9.5px] text-ink-3">
              {summary.recovered} adjusted
            </span>
          )}
          {summary.held > 0 && (
            <span className="shrink-0 rounded-md border border-line bg-surface px-1.5 py-px font-mono text-[9.5px] text-ink-3">
              {summary.held} checked
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-4">
          {durationLabel && (
            <span className="flex items-center gap-1 tabular-nums">
              <Clock className="h-2.5 w-2.5" />
              {durationLabel}
            </span>
          )}
          <ChevronRight className={`h-3.5 w-3.5 text-ink-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t border-line bg-surface/50">
          {tools.map((tool, index) => (
            <ToolStepRow
              key={`${tool.name}-${index}`}
              tool={tool}
              isLiveActive={Boolean(streaming && index === tools.length - 1)}
              recovered={recoveredIndices.has(index)}
              turnStreaming={streaming}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export type SubagentActivityItem = SubagentActivityRecord;

/**
 * Live Qoder-style 2-column parallel scout cards: shows up to 2 side-by-side live
 * worker cards with real-time currentAction + stepsCount and collapsible findings.
 */
export function SubagentActivityFeed({ items, streaming }: { items: SubagentActivityItem[]; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (streaming) setExpanded(true);
  }, [streaming]);
  if (items.length === 0) return null;
  const ordered = [...items].sort((a, b) => (a.index ?? 9) - (b.index ?? 9));
  const running = ordered.filter((item) => item.status === 'running').length;
  const done = ordered.filter((item) => item.status === 'done').length;
  const failed = ordered.filter((item) => item.status === 'error').length;

  return (
    <div className="mb-3 overflow-hidden rounded-xl border border-line bg-surface-2/70 text-[11px]">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid size-5 shrink-0 place-items-center rounded-md border border-line bg-surface text-accent">
            {running > 0 ? <Loader2 className="h-3 w-3 animate-spin" /> : <Users className="h-3 w-3" />}
          </span>
          <span className="truncate font-medium text-ink">
            Subagent Scouts ({running > 0 ? `${running}/${MAX_CONCURRENT_SUBAGENTS} active` : `${ordered.length}/${MAX_CONCURRENT_SUBAGENTS}`})
          </span>
          {done > 0 && (
            <span className="shrink-0 rounded-md border border-ok/30 bg-ok/10 px-1.5 py-px font-mono text-[9.5px] text-ok">
              {done} done
            </span>
          )}
          {failed > 0 && !streaming && (
            <span className="shrink-0 rounded-md border border-danger/30 bg-danger/10 px-1.5 py-px font-mono text-[9.5px] text-danger">
              {failed} failed
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink-4">
          <ChevronRight className={`h-3.5 w-3.5 text-ink-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </button>

      {expanded && (
        <div className="grid grid-cols-1 gap-2.5 border-t border-line bg-surface/50 p-2.5 md:grid-cols-2">
          {ordered.map((item, idx) => (
            <div
              key={item.id}
              className={`flex flex-col justify-between rounded-lg border p-2.5 transition-colors ${
                item.status === 'running'
                  ? 'border-accent-line bg-surface'
                  : item.status === 'done'
                    ? 'border-line bg-surface/80'
                    : 'border-danger/30 bg-danger/5'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="rounded border border-line bg-surface-2 px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider text-ink-3">
                      Agent {item.index ?? idx + 1}
                    </span>
                    <span className="truncate text-[11.5px] font-semibold text-ink" title={item.label}>
                      {item.title || item.label}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {typeof item.stepsCount === 'number' && (
                      <span className="font-mono text-[9.5px] tabular-nums text-ink-4">
                        {item.stepsCount} step{item.stepsCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {item.status === 'running' ? (
                      <span className="inline-flex items-center gap-1 text-accent">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-strong" />
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    ) : item.status === 'done' ? (
                      <Check className="h-3.5 w-3.5 text-ok" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 text-danger" />
                    )}
                  </div>
                </div>
                {item.currentAction && (
                  <p className="mt-1.5 truncate font-mono text-[10px] text-ink-3" title={item.currentAction}>
                    {item.currentAction}
                  </p>
                )}
              </div>

              {item.summary && (
                <details className="mt-2 border-t border-line/60 pt-1.5">
                  <summary className="cursor-pointer font-mono text-[9.5px] text-ink-4 hover:text-ink-2">
                    Findings
                  </summary>
                  <p className="mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-ink-2">
                    {item.summary}
                  </p>
                </details>
              )}
            </div>
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

export function TaskPlanView({ plan, streaming, approval, onApprove, onReject }: TaskPlanViewProps) {
  const completed = plan.filter((t) => t.status === 'done').length;
  const total = plan.length;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="mb-3 rounded-xl border border-line bg-surface-2/70 p-3 text-[11.5px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListTree className="h-3.5 w-3.5 text-accent" />
          <span className="text-xs font-semibold text-ink">Execution Plan</span>
          <span className="font-mono tabular-nums text-[10px] text-ink-4">
            {completed}/{total} ({percent}%)
          </span>
        </div>
        {streaming && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
      </div>

      <div className="mb-2.5 h-1 w-full overflow-hidden rounded-full bg-surface">
        <div
          className="h-full bg-accent-strong transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>

      <ul className="divide-y divide-line/60">
        {plan.map((task) => {
          const isDoing = task.status === 'doing';
          return (
            <li
              key={task.id}
              className={`flex items-start gap-2 py-2 ${isDoing ? 'rounded-lg bg-accent-soft/50 px-2' : 'px-0.5'}`}
            >
              <div className="mt-0.5 shrink-0">
                {task.status === 'done' ? (
                  <Check className="h-3.5 w-3.5 text-ok" />
                ) : task.status === 'blocked' ? (
                  <AlertCircle className="h-3.5 w-3.5 text-warn" />
                ) : isDoing ? (
                  <Loader2 className={`h-3.5 w-3.5 ${streaming ? 'animate-spin text-accent' : 'text-ink-4'}`} />
                ) : (
                  <span className="ml-1 mt-1 block size-2 rounded-full border border-line-2 bg-surface" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={`leading-snug ${
                    task.status === 'done'
                      ? 'text-ink-4 line-through'
                      : isDoing
                        ? 'font-medium text-ink'
                        : 'text-ink-2'
                  }`}
                >
                  {task.subject}
                </p>
                {task.files && task.files.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {task.files.map((file) => (
                      <span key={file} className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-ink-3">
                        {file}
                      </span>
                    ))}
                  </div>
                )}
                {task.evidence && (
                  <p className="mt-1 rounded border border-ok/30 bg-ok/10 px-1.5 py-0.5 font-mono text-[10px] text-ok">
                    {task.evidence}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {approval && (approval.status === 'pending' || approval.status === 'required') && (
        <div className="mt-3 rounded-lg border border-accent-line bg-accent-soft p-2.5">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent">
            <Sparkles className="h-3.5 w-3.5 text-accent" />
            <span>Review proposed plan changes</span>
          </div>
          {approval.planSummary && (
            <p className="mb-2 text-[11px] leading-relaxed text-ink-2">
              {approval.planSummary}
            </p>
          )}
          {approval.targetFiles && approval.targetFiles.length > 0 && (
            <div className="mb-2.5 flex flex-wrap gap-1">
              {approval.targetFiles.map((file) => (
                <span key={file} className="rounded border border-accent-line bg-surface px-1.5 py-0.5 font-mono text-[9.5px] text-accent">
                  {file}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onApprove}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent-strong px-3 py-1 text-xs font-semibold text-white transition-opacity hover:opacity-90"
            >
              <Check className="h-3.5 w-3.5" />
              Accept proposed changes
            </button>
            <button
              type="button"
              onClick={onReject}
              className="flex cursor-pointer items-center gap-1 rounded-md border border-line-2 bg-surface px-2.5 py-1 text-xs text-ink-2 transition-colors hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
              Reject proposed changes
            </button>
          </div>
        </div>
      )}

      {approval && approval.status === 'approved' && (
        <div className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1.5 text-[11px] text-ok">
          <Check className="h-3.5 w-3.5 text-ok" />
          <span>Proposed changes accepted</span>
        </div>
      )}
    </div>
  );
}

export function VerificationOutcomeBanner({ result }: { result: NonNullable<ChatMessage['verificationResult']> }) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`mb-3 rounded-xl border p-2.5 text-[11px] ${
        result.passed
          ? 'border-ok/30 bg-ok/10 text-ok'
          : 'border-warn/30 bg-warn/10 text-warn'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {result.passed ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
          ) : (
            <ShieldAlert className="h-4 w-4 shrink-0 text-warn" />
          )}
          <span className="text-xs font-semibold">
            {result.passed ? 'Verification Passed' : 'Verification Warnings'}
          </span>
          <span className="truncate font-mono text-[10px] text-ink-2">
            {result.summary}
          </span>
        </div>
        {result.checks && result.checks.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="flex shrink-0 cursor-pointer items-center gap-1 font-mono text-[10px] text-ink-2 hover:text-ink"
          >
            <span>{result.checks.length} checks</span>
            <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>

      {open && result.checks && (
        <div className="mt-2 space-y-1 border-t border-line pt-2">
          {result.checks.map((chk, i) => (
            <div key={`${chk.name}-${i}`} className="flex items-start gap-1.5 font-mono text-[10.5px]">
              {chk.ok ? (
                <Check className="mt-0.5 h-3 w-3 shrink-0 text-ok" />
              ) : (
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
              )}
              <span className={chk.ok ? 'text-ink-2' : 'text-warn'}>
                {chk.name}
              </span>
              {chk.details && (
                <span className="truncate text-ink-4" title={chk.details}>
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
