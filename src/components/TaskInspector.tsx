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
import type { DecisionInput, IntentDecision, IntentGraph } from '../lib/intent/types';
import type { AcceptanceContract, BehaviorEvent } from '../lib/behavior/types';
import type { OutcomeRecord, RouteProfile } from '../lib/calibratedAuto/types';

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
  onIntentRefresh: () => void;
  onAddDecision: (input: DecisionInput) => void;
  onDeleteDecision: (id: string) => void;
  onIntentExport: () => void;
  onIntentImport: (data: unknown) => void;
  behaviorEvents: BehaviorEvent[];
  contract: AcceptanceContract | null;
  onClearBehavior: () => void;
  onGenerateContract: () => void;
  onUpdateContract: (contract: AcceptanceContract) => void;
  outcomes: OutcomeRecord[];
  routeProfiles: RouteProfile[];
}

const TABS = [
  { id: 'capsules', label: 'Capsules', deferred: null },
  { id: 'intent', label: 'Intent Graph', deferred: null },
  { id: 'behavior', label: 'Behavior Studio', deferred: null },
  { id: 'calibrated', label: 'Calibrated Auto', deferred: null }
] as const;

type TabId = (typeof TABS)[number]['id'];

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
  onIntentRefresh,
  onAddDecision,
  onDeleteDecision,
  onIntentExport,
  onIntentImport,
  behaviorEvents,
  contract,
  onClearBehavior,
  onGenerateContract,
  onUpdateContract,
  outcomes,
  routeProfiles
}: TaskInspectorProps): ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>('capsules');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [intentTitle, setIntentTitle] = useState('');
  const [intentBody, setIntentBody] = useState('');
  const [intentPath, setIntentPath] = useState('');
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
              <span className="text-neutral-600">{intentGraph?.symbols.length ?? 0} symbols · {intentDecisions.length} decisions</span>
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
              onAddDecision({ workspaceRoot, kind: 'rationale', title: intentTitle, body: intentBody, targets: [{ path: intentPath }], baseHashes: intentGraph?.fileHashes ?? {} });
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
                      <span className={`rounded border px-1 py-px font-mono text-[9px] uppercase ${decision.status === 'stale' ? 'border-amber-400/30 text-amber-200' : 'border-emerald-400/30 text-emerald-300'}`}>{decision.status}</span>
                      <span className="truncate text-[11px] text-neutral-200">{decision.title}</span>
                      <button type="button" onClick={() => onDeleteDecision(decision.id)} title="Delete decision" className="ml-auto rounded p-1 text-neutral-600 hover:text-rose-300 cursor-pointer"><Trash2 className="h-3 w-3" /></button>
                    </div>
                    <p className="mt-1 text-[10px] leading-snug text-neutral-400">{decision.body}</p>
                    <p className="mt-1 font-mono text-[9px] text-neutral-600">{decision.targets.map((target) => target.symbol ? `${target.path}#${target.symbol}` : target.path).join(', ')}</p>
                  </li>
                ))}
              </ul>
            )}
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
              <div className="mt-2 flex gap-1">
                <button type="button" onClick={() => onUpdateContract({ ...contract, baseline: 'failed' })} className={`rounded border px-1.5 py-0.5 text-[9px] cursor-pointer ${contract.baseline === 'failed' ? 'border-rose-400/40 text-rose-200' : 'border-white/10 text-neutral-500'}`}>Baseline failed</button>
                <button type="button" onClick={() => onUpdateContract({ ...contract, postPatch: 'passed' })} className={`rounded border px-1.5 py-0.5 text-[9px] cursor-pointer ${contract.postPatch === 'passed' ? 'border-emerald-400/40 text-emerald-200' : 'border-white/10 text-neutral-500'}`}>Post-patch passed</button>
              </div>
            </div>}
            {behaviorEvents.length === 0 ? <p className="py-5 text-center text-[10px] text-neutral-500">Use Pick mode or interact with the preview to record clicks and runtime errors.</p> : (
              <ul className="space-y-1">{behaviorEvents.map((event) => <li key={event.id} className="rounded border border-white/[0.08] bg-neutral-950/50 p-1.5 text-[10px] text-neutral-300"><span className="mr-1 font-mono uppercase text-cyan-300">{event.type}</span>{event.target}{event.path ? ` · ${event.path}` : ''}{event.message ? ` · ${event.message}` : ''}</li>)}</ul>
            )}
          </div>
        </div>
      ) : activeTab === 'calibrated' ? (
        <div role="tabpanel" aria-label="Calibrated Auto" className="flex min-h-0 flex-1 flex-col">
          <header className="flex items-center gap-1.5 border-b border-white/[0.07] px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400"><Activity className="h-3 w-3 text-violet-300" />Outcome-Calibrated Auto <span className="text-neutral-600">{outcomes.length} outcomes</span></header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <ul className="space-y-1.5">{routeProfiles.map((profile) => <li key={profile.route} className="rounded-lg border border-white/[0.08] bg-neutral-950/50 p-2"><div className="flex justify-between text-[10px] text-neutral-200"><span className="uppercase">{profile.route}</span><span>{Math.round(profile.passRate * 100)}% pass</span></div><div className="mt-1 text-[9px] text-neutral-500">{profile.attempts} runs · {profile.averageRepairs.toFixed(1)} repairs · {Math.round(profile.averageTokens)} tokens</div></li>)}</ul>
            {outcomes.length === 0 && <p className="py-5 text-center text-[10px] text-neutral-500">Verified outcomes will calibrate route selection over time.</p>}
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