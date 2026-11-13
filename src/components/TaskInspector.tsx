import { useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import {
  Activity,
  Construction,
  Download,
  FileCode,
  History,
  Loader2,
  Plus,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  X
} from 'lucide-react';
import type { CapsuleFileDiff, CapsuleStatus, ChangeCapsule } from '../lib/capsules/types';
import { hashesForTargets } from '../lib/intent/graph';
import type { DecisionInput, DecisionStatus, DependencyAnswer, DependencyEvidence, IntentDecision, IntentGraph } from '../lib/intent/types';
import type { AcceptanceContract, AcceptancePhase, AcceptanceResult, BehaviorEvent } from '../lib/behavior/types';
import { acceptanceOutcome, describeEvidence, type AcceptanceOutcome } from '../lib/behavior/verification';
import type { CalibratedTaskType, OutcomeRecord, RouteProfile } from '../lib/calibratedAuto/types';
import type { RankedModel } from '../lib/calibratedAuto/router';
import { MIN_VERIFIED_RUNS } from '../lib/calibratedAuto/statistics';

export interface TaskInspectorProps {
  workspaceRoot: string | null;
  capsules: ChangeCapsule[];
  loading: boolean;
  onRefresh: () => void;
  onReplay: (id: string) => void;
  onRevert: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  onImport: (data: unknown) => void;
  intentGraph: IntentGraph | null;
  intentDecisions: IntentDecision[];
  intentLoading: boolean;
  /** How many files the intent index actually read; the rest is unverified. */
  indexedFiles: number;
  onIntentRefresh: () => void;
  onAddDecision: (input: DecisionInput) => void;
  onDeleteDecision: (id: string) => void;
  onAskDependencies: (question: string) => DependencyAnswer | null;
  onIntentExport: () => void;
  onIntentImport: (data: unknown) => void;
  behaviorEvents: BehaviorEvent[];
  contract: AcceptanceContract | null;
  onClearBehavior: () => void;
  onGenerateContract: () => void;
  /** Asks the preview harness to run one phase and record its receipt. */
  onRunCheck: (phase: 'baseline' | 'postPatch') => void;
  checkPhase: 'baseline' | 'postPatch' | null;
  /** False when the local preview is not serving, so no check can prove anything. */
  previewReady: boolean;
  outcomes: OutcomeRecord[];
  routeProfiles: RouteProfile[];
  /** Which task type the ranking and the route profiles are read for. */
  calibratedTaskType: CalibratedTaskType;
  onCalibratedTaskType: (taskType: CalibratedTaskType) => void;
  /** The models ordered by measured outcome, pin first. */
  modelRanking: RankedModel[];
  /** Passing null hands the choice back to the router. */
  onPinModel: (taskType: CalibratedTaskType, model: string | null) => void;
}

const TABS = [
  { id: 'capsules', label: 'Capsules', deferred: null },
  { id: 'intent', label: 'Intent Graph', deferred: null },
  { id: 'behavior', label: 'Behavior Studio', deferred: null },
  { id: 'calibrated', label: 'Calibrated Auto', deferred: null }
] as const;

type TabId = (typeof TABS)[number]['id'];

const CALIBRATED_TASK_TYPES: CalibratedTaskType[] = ['chat', 'bugfix', 'refactor', 'feature', 'test'];

const STATUS_TONE: Record<CapsuleStatus, string> = {
  captured: 'border-sky-400/30 bg-sky-500/10 text-sky-300',
  applied: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300',
  reverted: 'border-amber-400/30 bg-amber-500/10 text-amber-200',
  replayed: 'border-violet-400/30 bg-violet-500/10 text-violet-300',
  conflicted: 'border-rose-400/30 bg-rose-500/10 text-rose-300'
};

const KIND_GLYPH: Record<CapsuleFileDiff['kind'], { mark: string; tone: string; badge: string }> = {
  created: { mark: '+', tone: 'text-emerald-300', badge: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300' },
  deleted: { mark: '−', tone: 'text-rose-300', badge: 'border-rose-400/30 bg-rose-500/10 text-rose-300' },
  edited: { mark: '~', tone: 'text-amber-300', badge: 'border-amber-400/30 bg-amber-500/10 text-amber-200' }
};

/**
 * `unknown` is deliberately grey, not amber: it means the governing file is not
 * in the index, which is a limit of what ShadRox has read, not a decision that
 * needs reviewing.
 */
const DECISION_TONE: Record<DecisionStatus, string> = {
  fresh: 'border-emerald-400/30 text-emerald-300',
  stale: 'border-amber-400/30 text-amber-200',
  unknown: 'border-white/15 text-neutral-500'
};

/** Grey for `unverified` on purpose: nothing ran, so nothing is claimed. */
const CHECK_TONE: Record<AcceptanceResult, string> = {
  passed: 'border-emerald-400/30 text-emerald-300',
  failed: 'border-rose-400/30 text-rose-200',
  unverified: 'border-white/15 text-neutral-500'
};

const OUTCOME_TONE: Record<AcceptanceOutcome, string> = {
  fixed: 'text-emerald-300',
  'still-broken': 'text-rose-300',
  regressed: 'text-rose-300',
  unverified: 'text-neutral-500'
};

/**
 * One phase of a contract: the verdict the harness returned plus the receipt
 * that produced it. The button asks main process to run the probe; there is no
 * control that writes a result without running one.
 */
function AcceptancePhaseRow({
  label,
  phase,
  disabled,
  running,
  onRun
}: {
  label: string;
  phase: AcceptancePhase;
  disabled: boolean;
  running: boolean;
  onRun: () => void;
}): ReactElement {
  return (
    <div className="rounded border border-white/[0.08] bg-neutral-950/40 p-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`rounded border px-1 py-px font-mono text-[9px] uppercase ${CHECK_TONE[phase.result]}`}>{phase.result}</span>
        <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-400">{label}</span>
        <button
          type="button"
          onClick={onRun}
          disabled={disabled || running}
          title={disabled ? 'Start the local preview to run this check' : 'Run this check against the live preview'}
          className="ml-auto flex items-center gap-1 rounded border border-cyan-400/30 px-1.5 py-0.5 text-[9px] text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40 cursor-pointer"
        >
          {running ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5" />}
          {running ? 'Running' : 'Run check'}
        </button>
      </div>
      <p className="mt-1 font-mono text-[9px] leading-snug text-neutral-500">{describeEvidence(phase.evidence)}</p>
    </div>
  );
}

const SNIPPET_LENGTH = 80;
function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '(no intent captured)';
  return clean.length > SNIPPET_LENGTH ? `${clean.slice(0, SNIPPET_LENGTH - 1)}…` : clean;
}

function spendLabel(capsule: ChangeCapsule): string {
  const spend = capsule.spend;
  if (!spend) return 'BYOK/unmetered';
  const cost = spend.estimatedCostUsd !== null
    ? `$${spend.estimatedCostUsd.toFixed(4)}`
    : `${spend.inputTokens + spend.outputTokens} tok`;
  return `${spend.model} · ${cost}`;
}

/** One edge list of a dependency answer, dimmed where the far end is not indexed. */
function DependencyRows({ title, rows }: { title: string; rows: DependencyEvidence[] }): ReactElement {
  return (
    <div>
      <p className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">{title} · {rows.length}</p>
      {rows.length === 0 ? (
        <p className="text-[9px] text-neutral-600">none seen by the index</p>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {rows.map((row) => (
            <li key={`${title}-${row.path}`} className="flex items-center gap-1 font-mono text-[9px]">
              <span className={row.indexed ? 'text-neutral-300' : 'text-neutral-600'}>{row.path}</span>
              <span className="ml-auto text-neutral-600">w{row.weight}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskInspector({
  workspaceRoot,
  capsules,
  loading,
  onRefresh,
  onReplay,
  onRevert,
  onDelete,
  onExport,
  onImport,
  intentGraph,
  intentDecisions,
  intentLoading,
  indexedFiles,
  onIntentRefresh,
  onAddDecision,
  onDeleteDecision,
  onAskDependencies,
  onIntentExport,
  onIntentImport,
  behaviorEvents,
  contract,
  onClearBehavior,
  onGenerateContract,
  onRunCheck,
  checkPhase,
  previewReady,
  outcomes,
  routeProfiles,
  calibratedTaskType,
  onCalibratedTaskType,
  modelRanking,
  onPinModel
}: TaskInspectorProps): ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>('capsules');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [intentTitle, setIntentTitle] = useState('');
  const [intentBody, setIntentBody] = useState('');
  const [intentPath, setIntentPath] = useState('');
  const [dependencyQuestion, setDependencyQuestion] = useState('');
  const [dependencyAnswer, setDependencyAnswer] = useState<DependencyAnswer | null>(null);
  const intentFileRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = capsules.find((capsule) => capsule.id === selectedId) ?? null;
  const activeIndex = TABS.findIndex((tab) => tab.id === activeTab);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(activeIndex + delta + TABS.length) % TABS.length];
    setActiveTab(next.id);
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImportError(null);
    try {
      onImport(JSON.parse(await file.text()) as unknown);
    } catch {
      setImportError('Import failed — the file is not valid JSON.');
    }
  };

  return (
    <section
      aria-label="Task inspector"
      className="flex max-h-[480px] w-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900/90 text-neutral-200"
    >
      <div
        role="tablist"
        aria-label="Inspector sections"
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.07] px-2 py-1.5"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={handleTabKeyDown}
              title={tab.label}
              className={`flex h-6 shrink-0 items-center rounded border px-1.5 font-mono text-[10px] transition-colors cursor-pointer ${
                isActive
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-white/[0.06] bg-white/[0.02] text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'intent' ? (
        <div role="tabpanel" aria-label="Intent Graph" className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3 py-1.5">
            <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
              <span className="text-emerald-300">Intent Graph</span>
              <span className="text-neutral-600">{intentGraph?.symbols.length ?? 0} symbols · {intentDecisions.length} decisions · {indexedFiles} files indexed</span>
              {intentLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-300" />}
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={onIntentRefresh} title="Refresh intent graph" className="rounded p-1 text-neutral-500 hover:text-white cursor-pointer"><RefreshCw className="h-3.5 w-3.5" /></button>
              <button type="button" onClick={onIntentExport} disabled={!workspaceRoot} title="Export intent graph" className="rounded border border-white/15 px-1.5 py-1 text-[9px] text-neutral-300 hover:text-white cursor-pointer disabled:opacity-40"><Download className="h-3 w-3" /></button>
              <button type="button" onClick={() => intentFileRef.current?.click()} disabled={!workspaceRoot} title="Import intent graph" className="rounded border border-white/15 px-1.5 py-1 text-[9px] text-neutral-300 hover:text-white cursor-pointer disabled:opacity-40"><Upload className="h-3 w-3" /></button>
              <input ref={intentFileRef} type="file" accept="application/json" className="hidden" tabIndex={-1} aria-label="Intent graph JSON file" onChange={async (event) => {
                const file = event.target.files?.[0]; event.target.value = '';
                if (!file) return;
                try { onIntentImport(JSON.parse(await file.text()) as unknown); } catch { setImportError('Intent import failed — invalid JSON.'); }
              }} />
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <form className="mb-2 rounded-lg border border-emerald-400/20 bg-emerald-500/5 p-2" onSubmit={(event) => {
              event.preventDefault();
              if (!workspaceRoot || !intentTitle.trim() || !intentBody.trim() || !intentPath.trim()) return;
              // Pin only the files this decision governs. Pinning the whole
              // index would make every unrelated edit look like a review need.
              const targets = [{ path: intentPath }];
              onAddDecision({ workspaceRoot, kind: 'rationale', title: intentTitle, body: intentBody, targets, baseHashes: hashesForTargets(intentGraph?.fileHashes ?? {}, targets) });
              setIntentTitle(''); setIntentBody(''); setIntentPath('');
            }}>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-emerald-300">Add approved decision</div>
              <input value={intentTitle} onChange={(event) => setIntentTitle(event.target.value)} placeholder="Why does this exist?" className="mb-1 w-full rounded border border-white/10 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-200 outline-none" />
              <textarea value={intentBody} onChange={(event) => setIntentBody(event.target.value)} placeholder="Rationale or invariant" rows={2} className="mb-1 w-full resize-none rounded border border-white/10 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-200 outline-none" />
              <div className="flex gap-1">
                <input value={intentPath} onChange={(event) => setIntentPath(event.target.value)} placeholder="src/file.tsx" className="min-w-0 flex-1 rounded border border-white/10 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-200 outline-none" />
                <button type="submit" className="flex items-center gap-1 rounded border border-emerald-400/30 px-2 py-1 text-[10px] text-emerald-200 hover:bg-emerald-500/10 cursor-pointer"><Plus className="h-3 w-3" />Add</button>
              </div>
            </form>
            {intentDecisions.length === 0 ? <p className="py-5 text-center text-[10px] text-neutral-500">No decisions yet. Add the first rationale above.</p> : (
              <ul className="space-y-1.5">
                {intentDecisions.map((decision) => (
                  <li key={decision.id} className="rounded-lg border border-white/[0.08] bg-neutral-950/50 p-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`rounded border px-1 py-px font-mono text-[9px] uppercase ${DECISION_TONE[decision.status]}`}>{decision.status}</span>
                      <span className="truncate text-[11px] text-neutral-200">{decision.title}</span>
                      <button type="button" onClick={() => onDeleteDecision(decision.id)} title="Delete decision" className="ml-auto rounded p-1 text-neutral-600 hover:text-rose-300 cursor-pointer"><Trash2 className="h-3 w-3" /></button>
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-neutral-400">{decision.body}</p>
                    <p className="mt-1 font-mono text-[9px] text-neutral-600">{decision.targets.map((target) => target.symbol ? `${target.path}#${target.symbol}` : target.path).join(', ')}</p>
                  </li>
                ))}
              </ul>
            )}
            <form className="mt-2 rounded-lg border border-white/[0.08] bg-neutral-950/50 p-2" onSubmit={(event) => {
              event.preventDefault();
              const question = dependencyQuestion.trim();
              setDependencyAnswer(question ? onAskDependencies(question) : null);
            }}>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-neutral-400">Dependency question</div>
              <div className="flex gap-1">
                <input value={dependencyQuestion} onChange={(event) => setDependencyQuestion(event.target.value)} placeholder="what depends on src/a.ts?" className="min-w-0 flex-1 rounded border border-white/10 bg-neutral-950 px-2 py-1 text-[10px] text-neutral-200 outline-none" />
                <button type="submit" className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[10px] text-neutral-300 hover:text-white cursor-pointer"><FileCode className="h-3 w-3" />Ask</button>
              </div>
              {dependencyAnswer && (dependencyAnswer.resolved ? (
                <div className="mt-2 space-y-1.5">
                  <p className="font-mono text-[9px] text-neutral-500">
                    {dependencyAnswer.subject} · confidence {Math.round(dependencyAnswer.confidence * 100)}%
                    {dependencyAnswer.truncated ? ' · list capped' : ''}
                  </p>
                  <DependencyRows title="depends on" rows={dependencyAnswer.dependsOn} />
                  <DependencyRows title="depended by" rows={dependencyAnswer.dependedBy} />
                  <ul className="space-y-0.5">
                    {dependencyAnswer.reasons.map((reason) => <li key={reason} className="text-[9px] leading-snug text-neutral-500">{reason}</li>)}
                  </ul>
                </div>
              ) : (
                <p className="mt-2 text-[9px] leading-snug text-neutral-500">
                  {dependencyAnswer.reasons[0] ?? 'Nothing in the index matches this question.'}
                </p>
              ))}
            </form>
          </div>
        </div>
      ) : activeTab === 'behavior' ? (
        <div role="tabpanel" aria-label="Behavior Studio" className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-white/[0.07] px-3 py-1.5">
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400"><Activity className="h-3 w-3 text-cyan-300" />Behavior Recorder <span className="text-neutral-600">{behaviorEvents.length} events</span></span>
            <div className="flex gap-1">
              <button type="button" onClick={onGenerateContract} disabled={behaviorEvents.length === 0} className="rounded border border-cyan-400/30 px-2 py-1 text-[9px] text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-40 cursor-pointer">Generate Contract</button>
              <button type="button" onClick={onClearBehavior} className="rounded border border-white/10 px-2 py-1 text-[9px] text-neutral-400 hover:text-white cursor-pointer">Clear</button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {contract && <div className="mb-2 rounded-lg border border-cyan-400/20 bg-cyan-500/5 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-cyan-200">Acceptance Contract</div>
              <p className="mt-1 text-[10px] text-neutral-300">{contract.observedFailure}</p>
              <p className="mt-1 text-[10px] text-neutral-400">Expected: {contract.expectedBehavior}</p>
              <p className="mt-1 font-mono text-[9px] text-neutral-500">{contract.target.path ?? 'unmapped'}{contract.target.line ? `:${contract.target.line}` : ''}</p>
              <p className="mt-1 font-mono text-[9px] text-neutral-500">
                probe: {contract.probe.selectors.length > 0 ? contract.probe.selectors.join(', ') : 'derived from the served HTML on the first run'}
              </p>
              <div className="mt-2 space-y-1">
                <AcceptancePhaseRow
                  label="Baseline"
                  phase={contract.baseline}
                  disabled={!previewReady}
                  running={checkPhase === 'baseline'}
                  onRun={() => onRunCheck('baseline')}
                />
                <AcceptancePhaseRow
                  label="Post-patch"
                  phase={contract.postPatch}
                  disabled={!previewReady}
                  running={checkPhase === 'postPatch'}
                  onRun={() => onRunCheck('postPatch')}
                />
              </div>
              <p className={`mt-2 font-mono text-[9px] leading-snug ${OUTCOME_TONE[acceptanceOutcome(contract).state]}`}>
                {acceptanceOutcome(contract).summary}
              </p>
              {!previewReady && (
                <p className="mt-1 text-[9px] leading-snug text-neutral-500">
                  Neither phase can be decided until the local preview is running.
                </p>
              )}
            </div>}
            {behaviorEvents.length === 0 ? <p className="py-5 text-center text-[10px] text-neutral-500">Use Pick mode or interact with the preview to record clicks and runtime errors.</p> : (
              <ul className="space-y-1">{behaviorEvents.map((event) => <li key={event.id} className="rounded border border-white/[0.08] bg-neutral-950/50 p-1.5 text-[10px] text-neutral-300"><span className="mr-1 font-mono uppercase text-cyan-300">{event.type}</span>{event.target}{event.path ? ` · ${event.path}` : ''}{event.message ? ` · ${event.message}` : ''}</li>)}</ul>
            )}
          </div>
        </div>
      ) : activeTab === 'calibrated' ? (
        <div role="tabpanel" aria-label="Calibrated Auto" className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center gap-1.5 border-b border-white/[0.07] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400"><Activity className="h-3 w-3 text-violet-300" />Outcome-Calibrated Auto <span className="text-neutral-600">{outcomes.filter((outcome) => outcome.verified).length} checked of {outcomes.length}</span></header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <div className="mb-1.5 flex flex-wrap gap-1">
              {CALIBRATED_TASK_TYPES.map((taskType) => (
                <button
                  key={taskType}
                  type="button"
                  onClick={() => onCalibratedTaskType(taskType)}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase transition-colors ${taskType === calibratedTaskType ? 'border-violet-400/40 bg-violet-500/15 text-violet-200' : 'border-white/[0.08] text-neutral-400 hover:text-neutral-200'}`}
                >
                  {taskType}
                </button>
              ))}
            </div>
            <p className="mb-2 text-[9px] leading-snug text-neutral-500">
              Ranked only on {calibratedTaskType} turns something outside the model checked. Rates are shrunk toward the pool average, and a model under {MIN_VERIFIED_RUNS} checked runs sits behind every proven one. Pinning puts your choice above the record.
            </p>
            <ul className="space-y-1.5">{routeProfiles.map((profile) => <li key={profile.route} className="rounded-lg border border-white/[0.08] bg-neutral-950/50 p-2"><div className="flex justify-between text-[10px] text-neutral-200"><span className="uppercase">{profile.route}</span><span>{profile.passRate === null ? 'no verified run' : `${Math.round(profile.passRate * 100)}% checked`}</span></div><div className="mt-1 text-[9px] text-neutral-500">{profile.verifiedAttempts} verified of {profile.attempts} run(s){profile.unverifiedAttempts > 0 ? ` · ${profile.unverifiedAttempts} unchecked, not counted` : ''} · {profile.averageRepairs.toFixed(1)} repairs · {Math.round(profile.averageTokens)} tokens</div></li>)}</ul>
            {modelRanking.length > 0 && <ul className="mt-2 space-y-1">
              {modelRanking.map((entry) => (
                <li key={entry.model} className="rounded-lg border border-white/[0.08] bg-neutral-950/50 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-[9px] text-neutral-200">#{entry.rank + 1} {entry.model}</span>
                    <button
                      type="button"
                      onClick={() => onPinModel(calibratedTaskType, entry.pinned ? null : entry.model)}
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] transition-colors ${entry.pinned ? 'border-amber-400/40 bg-amber-500/10 text-amber-200' : 'border-white/[0.08] text-neutral-400 hover:text-neutral-200'}`}
                    >
                      {entry.pinned ? 'Unpin' : 'Pin'}
                    </button>
                  </div>
                  <p className={`mt-1 text-[9px] leading-snug ${entry.pinned ? 'text-amber-200/80' : entry.proven ? 'text-emerald-300/80' : 'text-neutral-500'}`}>{entry.reason}</p>
                </li>
              ))}
            </ul>}
            {outcomes.length === 0 && <p className="py-5 text-center text-[10px] text-neutral-500">Nothing has been verified yet — the first checked turn is what starts the record.</p>}
          </div>
        </div>
      ) : activeTab !== 'capsules' ? (
        <div
          role="tabpanel"
          aria-label={TABS[activeIndex].label}
          className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center"
        >
          <Construction className="h-4 w-4 text-neutral-600" />
          <p className="text-[11px] font-medium text-neutral-400">Not built yet</p>
          <p className="text-[10px] leading-snug text-neutral-600">{TABS[activeIndex].deferred}</p>
        </div>
      ) : (
        <div role="tabpanel" aria-label="Capsules" className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
              <History className="h-3 w-3 shrink-0 text-emerald-400/80" />
              <span className="truncate">Change Capsules</span>
              <span className="shrink-0 text-neutral-600">{capsules.length}</span>
              {loading && (
                <span className="flex shrink-0 items-center gap-1 text-neutral-500" role="status">
                  <Loader2 className="h-3 w-3 animate-spin text-emerald-300" />
                  Loading…
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                title="Refresh capsules"
                aria-label="Refresh capsules"
                className="rounded p-1 text-neutral-500 transition-colors hover:text-white cursor-pointer disabled:pointer-events-none disabled:opacity-25"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onExport}
                disabled={!workspaceRoot}
                title="Export capsules as JSON"
                aria-label="Export capsules as JSON"
                className="flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-emerald-400/40 hover:text-emerald-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-3 w-3" />
                Export
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={!workspaceRoot}
                title="Import capsules from JSON"
                aria-label="Import capsules from JSON"
                className="flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-emerald-400/40 hover:text-emerald-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Upload className="h-3 w-3" />
                Import
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                onChange={handleImportFile}
                className="hidden"
                aria-label="Capsule JSON file"
                tabIndex={-1}
              />
            </div>
          </header>

          {importError && (
            <p role="alert" className="shrink-0 border-b border-white/[0.07] px-3 py-1 text-[10px] text-rose-300">
              {importError}
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {loading && capsules.length === 0 ? (
              <p className="flex items-center justify-center gap-1.5 py-5 font-mono text-[10px] text-neutral-500" role="status">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading…
              </p>
            ) : capsules.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-5 text-center">
                <FileCode className="h-4 w-4 text-neutral-600" />
                <p className="text-[11px] leading-snug text-neutral-500">
                  No change capsules yet — they appear after an AI task runs.
                </p>
              </div>
            ) : (
              <>
                <ul className="space-y-1" aria-label="Capsule timeline">
                  {capsules.map((capsule) => {
                    const isSelected = capsule.id === selectedId;
                    return (
                      <li key={capsule.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(isSelected ? null : capsule.id)}
                          aria-pressed={isSelected}
                          title={capsule.promptIntent}
                          className={`w-full rounded-lg border px-2 py-1.5 text-left transition-colors cursor-pointer ${
                            isSelected
                              ? 'border-emerald-400/30 bg-emerald-500/10'
                              : 'border-white/[0.07] bg-neutral-950/40 hover:border-white/15'
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-[10px] text-neutral-400">
                              {new Date(capsule.createdAt).toLocaleString()}
                            </span>
                            <span
                              className={`ml-auto shrink-0 rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider ${STATUS_TONE[capsule.status]}`}
                            >
                              {capsule.status}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-[11px] text-neutral-200">{snippet(capsule.promptIntent)}</p>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-[9px] text-neutral-500">
                            <span className="flex shrink-0 items-center gap-1">
                              <FileCode className="h-2.5 w-2.5" />
                              {capsule.diffs.length} file{capsule.diffs.length === 1 ? '' : 's'}
                            </span>
                            <span className="truncate" title={spendLabel(capsule)}>{spendLabel(capsule)}</span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {selected && (
                  <div
                    aria-label="Capsule diff inspector"
                    className="mt-2 rounded-lg border border-white/[0.07] bg-neutral-950/50 p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <FileCode className="h-3 w-3 shrink-0 text-emerald-400/80" />
                      <span className="truncate font-mono text-[10px] text-neutral-300" title={selected.id}>
                        {selected.id}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedId(null)}
                        title="Close diff inspector"
                        aria-label="Close diff inspector"
                        className="ml-auto shrink-0 rounded p-1 text-neutral-500 transition-colors hover:text-white cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>

                    {selected.redaction.redacted && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-200" role="status">
                        <ShieldCheck className="h-3 w-3 shrink-0" />
                        Secrets removed ({selected.redaction.count})
                      </p>
                    )}

                    {selected.diffs.length === 0 ? (
                      <p className="mt-1 text-[10px] text-neutral-600">No file changes in this capsule.</p>
                    ) : (
                      <ul className="mt-1.5 space-y-1.5">
                        {selected.diffs.map((diff) => {
                          const glyph = KIND_GLYPH[diff.kind];
                          return (
                            <li key={diff.path} className="rounded border border-white/[0.07] bg-neutral-900/60 p-1.5">
                              <div className="flex items-center gap-1.5 font-mono text-[10px]">
                                <span className={`w-2 shrink-0 ${glyph.tone}`}>{glyph.mark}</span>
                                <span className="truncate text-neutral-300" title={diff.path}>{diff.path}</span>
                                <span
                                  className={`ml-auto shrink-0 rounded-full border px-1.5 py-px font-mono text-[9px] uppercase tracking-wider ${glyph.badge}`}
                                >
                                  {diff.kind}
                                </span>
                              </div>
                              {diff.before !== null && (
                                <>
                                  <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-neutral-600">Before</p>
                                  <pre className="mt-0.5 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.07] bg-neutral-950/80 p-1.5 font-mono text-[10px] leading-relaxed text-neutral-300">
                                    {diff.before}
                                  </pre>
                                </>
                              )}
                              {diff.after !== null && (
                                <>
                                  <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-neutral-600">After</p>
                                  <pre className="mt-0.5 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-white/[0.07] bg-neutral-950/80 p-1.5 font-mono text-[10px] leading-relaxed text-neutral-300">
                                    {diff.after}
                                  </pre>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.07] pt-2">
                      <button
                        type="button"
                        onClick={() => onReplay(selected.id)}
                        title="Plan a replay of this capsule"
                        aria-label={`Replay capsule ${selected.id}`}
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 cursor-pointer"
                      >
                        <Play className="h-3 w-3" />
                        Replay
                      </button>
                      <button
                        type="button"
                        onClick={() => onRevert(selected.id)}
                        title="Plan a revert of this capsule"
                        aria-label={`Revert capsule ${selected.id}`}
                        className="flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20 cursor-pointer"
                      >
                        <Undo2 className="h-3 w-3" />
                        Revert
                      </button>
                      <button
                        type="button"
                        onClick={() => { setSelectedId(null); onDelete(selected.id); }}
                        title="Delete this capsule"
                        aria-label={`Delete capsule ${selected.id}`}
                        className="ml-auto flex items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-2.5 py-1 text-[10px] font-medium text-rose-300 transition-colors hover:bg-rose-500/20 cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" />
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}