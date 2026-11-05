import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, FileDown, History, Loader2, RotateCcw, X } from 'lucide-react';
import type { CheckpointDiff } from '../lib/checkpointDiff';
import { describeCheckpointDiff } from '../lib/checkpointDiff';
import type { CheckpointMeta } from '../lib/history';
import { machineRestoreReason } from '../lib/machine/delta';
import {
  buildTimeline,
  describeCheckpoint,
  diffSince,
  timelinePosition,
  truncateCheckpointLabel
} from '../lib/timeline';

export interface TimelineSliderProps {
  checkpoints: CheckpointMeta[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onRestore: (id: string) => void;
  restoringId?: string | null;
  onClose?: () => void;
  disabled?: boolean;
  /** What restoring the selected checkpoint would do, computed by the host. */
  diff?: CheckpointDiff | null;
  diffLoading?: boolean;
  onExportReceipt?: (checkpointId: string) => Promise<string>;
}

const CONFIRM_WINDOW_MS = 4000;
const RAIL_NODE_SPACING = 26;
const DIFF_ROWS = 6;

const KIND_GLYPH: Record<string, { mark: string; tone: string; word: string }> = {
  edit: { mark: '~', tone: 'text-amber-300', word: 'edited' },
  restore: { mark: '+', tone: 'text-emerald-300', word: 'comes back' },
  delete: { mark: '−', tone: 'text-rose-300', word: 'deleted' }
};

/**
 * Compact visual history rail. Nodes run oldest -> newest left to right and are
 * the only way to pick a checkpoint; a long run scrolls inside the rail with
 * visible edge fades and nudge buttons, plus arrow-key selection. Restoring
 * stays a deliberate two-step action so a mis-click cannot wipe later work.
 */
export function TimelineSlider({
  checkpoints,
  selectedId,
  onSelect,
  onRestore,
  restoringId,
  onClose,
  disabled,
  diff,
  diffLoading,
  onExportReceipt
}: TimelineSliderProps) {
  const [internalId, setInternalId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptResult, setReceiptResult] = useState<{ id: string; message: string } | null>(null);

  const points = useMemo(() => buildTimeline(checkpoints), [checkpoints]);
  const chronological = useMemo(() => [...points].reverse(), [points]);
  const count = chronological.length;

  const selected = useMemo<CheckpointMeta | null>(() => {
    if (points.length === 0) return null;
    const activeId = selectedId ?? internalId;
    if (activeId) {
      const match = points.find((checkpoint) => checkpoint.id === activeId);
      if (match) return match;
    }
    return points[0];
  }, [points, selectedId, internalId]);

  const selectedIndex = useMemo(() => {
    if (!selected) return -1;
    return chronological.findIndex((checkpoint) => checkpoint.id === selected.id);
  }, [chronological, selected]);

  const selectedRatio = count <= 1 || selectedIndex < 0 ? 0.5 : selectedIndex / (count - 1);
  const isRestoringSelected = Boolean(restoringId) && Boolean(selected) && restoringId === selected?.id;
  const busy = Boolean(restoringId);
  const blocked = Boolean(disabled) || busy;
  const machine = selected?.machineReport;
  const machineReason = selected?.machine ? machineRestoreReason(machine) : null;

  // The rail scrolls when a run is long; the fades and nudge buttons below are
  // what make that reachable instead of invisible overflow.
  const railRef = useRef<HTMLDivElement>(null);
  const [railOverflow, setRailOverflow] = useState({ start: false, end: false });

  const syncRailOverflow = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const max = rail.scrollWidth - rail.clientWidth;
    setRailOverflow({
      start: rail.scrollLeft > 4,
      end: max > 4 && rail.scrollLeft < max - 4
    });
  }, []);

  const nudgeRail = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(80, rail.clientWidth * 0.6), behavior: 'smooth' });
  };

  const sideCounts = useMemo(() => diffSince(points, selected ? selected.id : null), [points, selected]);
  const summary = selected?.machine
    ? 'Rewind only this turn’s captured changes, if disk state still matches.'
    : 'Legacy checkpoint: restores editor buffers only, not machine state.';

  useEffect(() => {
    setConfirming(false);
  }, [selected ? selected.id : null]);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  // Overflow state has to follow resizes and new checkpoints, not just scrolling.
  useEffect(() => {
    syncRailOverflow();
    const rail = railRef.current;
    if (!rail || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => syncRailOverflow());
    observer.observe(rail);
    return () => observer.disconnect();
  }, [count, syncRailOverflow]);

  // The selected marker is the keyboard cursor too, so keep it on screen.
  useEffect(() => {
    const marker = railRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    marker?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncRailOverflow();
  }, [selected?.id, syncRailOverflow]);

  const selectPoint = (id: string) => {
    if (blocked) return;
    setInternalId(id);
    if (onSelect) onSelect(id);
  };

  const stepSelection = (delta: number) => {
    if (count === 0 || blocked) return;
    const from = selectedIndex < 0 ? count - 1 : selectedIndex;
    const next = chronological[Math.min(count - 1, Math.max(0, from + delta))];
    if (next) selectPoint(next.id);
  };

  const handleRailKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (step === 0) {
        const target = event.key === 'Home' ? chronological[0] : chronological[count - 1];
        if (target) selectPoint(target.id);
      } else {
        stepSelection(step);
      }
      return;
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      const rail = railRef.current;
      if (rail) rail.scrollBy({ left: (event.key === 'PageUp' ? -1 : 1) * rail.clientWidth * 0.8, behavior: 'smooth' });
    }
  };

  const handleRestoreClick = () => {
    if (!selected || blocked || machineReason) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onRestore(selected.id);
  };

  const handleExportReceipt = async () => {
    if (!selected || !selected.machine || !onExportReceipt || receiptBusy) return;
    setReceiptBusy(true);
    try {
      setReceiptResult({ id: selected.id, message: await onExportReceipt(selected.id) });
    } finally {
      setReceiptBusy(false);
    }
  };

  const selectedLabel = selected ? truncateCheckpointLabel(selected.label) || 'Checkpoint' : '';

  return (
    <section
      aria-label="Checkpoint timeline"
      className="flex max-h-[200px] w-full min-w-0 flex-col overflow-y-auto rounded-xl border border-white/10 bg-neutral-900/90 text-neutral-200"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-neutral-400">
          <History className="h-3 w-3 shrink-0 text-emerald-400/80" />
          <span className="truncate">Timeline</span>
          <span className="shrink-0 text-neutral-600">
            {count} checkpoint{count === 1 ? '' : 's'}
          </span>
          {busy && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-300" />}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-neutral-500 transition-colors hover:text-white cursor-pointer"
            title="Close timeline"
            aria-label="Close checkpoint timeline"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-4 py-5 text-center">
          <History className="h-4 w-4 text-neutral-600" />
          <p className="text-[11px] leading-snug text-neutral-500">
            No checkpoints yet — they are created after each assistant reply.
          </p>
        </div>
      ) : (
        <>
          <div className="shrink-0 px-3 pt-2">
            <p className="truncate text-[11px] font-medium text-white" title={selected ? selected.label : ''}>
              {selectedLabel}
            </p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
              {selected ? describeCheckpoint(selected) : ''}
            </p>
          </div>

          <div className="shrink-0 px-3 pt-2">
            <div className="relative flex items-center gap-1">
              <button
                type="button"
                onClick={() => nudgeRail(-1)}
                disabled={!railOverflow.start}
                title="Scroll to older checkpoints"
                aria-label="Scroll timeline to older checkpoints"
                className="shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:text-white disabled:pointer-events-none disabled:opacity-25 cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>

              <div
                ref={railRef}
                onScroll={syncRailOverflow}
                onKeyDown={handleRailKeyDown}
                tabIndex={0}
                role="group"
                aria-label="Checkpoint markers (arrow keys move between checkpoints)"
                className="relative min-w-0 flex-1 overflow-x-auto rounded px-2 pb-1 outline-none focus-visible:ring-1 focus-visible:ring-violet-300/40"
              >
                <div
                  className="relative h-6"
                  style={{ minWidth: `${Math.max(160, count * RAIL_NODE_SPACING)}px` }}
                >
                  <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/15" />
                  <div
                    className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-emerald-400/40"
                    style={{ width: `${selectedRatio * 100}%` }}
                  />
                  {chronological.map((checkpoint, index) => {
                    const isSelected = Boolean(selected) && checkpoint.id === selected?.id;
                    const isRestoring = Boolean(restoringId) && restoringId === checkpoint.id;
                    return (
                      <button
                        key={checkpoint.id}
                        type="button"
                        onClick={() => selectPoint(checkpoint.id)}
                        disabled={blocked}
                        data-selected={isSelected ? 'true' : undefined}
                        aria-label={`${checkpoint.label} · ${describeCheckpoint(checkpoint)}`}
                        aria-pressed={isSelected}
                        title={`${checkpoint.label} · ${describeCheckpoint(checkpoint)}`}
                        style={{ left: `${timelinePosition(index, count) * 100}%` }}
                        className={`absolute top-1/2 z-10 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed ${
                          isSelected ? 'text-emerald-300' : 'text-neutral-500 hover:text-neutral-200'
                        }`}
                      >
                        {isRestoring ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <span
                            className={`h-2 w-2 rounded-full border ${
                              isSelected
                                ? 'border-emerald-300 bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.15)]'
                                : 'border-neutral-500 bg-neutral-800'
                            }`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                type="button"
                onClick={() => nudgeRail(1)}
                disabled={!railOverflow.end}
                title="Scroll to newer checkpoints"
                aria-label="Scroll timeline to newer checkpoints"
                className="shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:text-white disabled:pointer-events-none disabled:opacity-25 cursor-pointer"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>

              {/* Edge fades sit on the wrapper, not the scroll content. */}
              {railOverflow.start && (
                <div className="pointer-events-none absolute inset-y-0 left-5 w-6 bg-gradient-to-r from-neutral-900 to-transparent" />
              )}
              {railOverflow.end && (
                <div className="pointer-events-none absolute inset-y-0 right-5 w-6 bg-gradient-to-l from-neutral-900 to-transparent" />
              )}
            </div>

            <p className="mt-1 truncate text-[10px] text-neutral-500" title={summary}>
              {summary}
            </p>
          </div>

          <div className="shrink-0 px-3 pb-1 pt-2">
            {selected?.machine ? (
              <div className="space-y-1.5 text-[10px] text-neutral-400" aria-label="Machine Delta">
                <p className="font-medium text-emerald-300">Machine Delta · {machine?.state ?? 'unavailable'}</p>
                {machineReason && <p role="status" className="text-amber-200">{machineReason}</p>}
                {machine && <>
                  <ul className="space-y-0.5 font-mono">
                    {machine.files.map((file) => <li key={file.path}>{file.kind}: {file.path}{file.dependency ? ' · dependency manifest/lockfile' : ''}</li>)}
                  </ul>
                  <p>Git: {machine.git.before?.head?.slice(0, 8) ?? 'unavailable'} → {machine.git.after?.head?.slice(0, 8) ?? 'unavailable'} · {machine.git.changed ? 'changed' : 'unchanged'}{!machine.git.reversible ? ' · observed, not revertable' : ''}</p>
                  <p>Branch: {machine.git.before?.branch ?? 'none'} → {machine.git.after?.branch ?? 'none'} · dirty: {String(machine.git.before?.dirty ?? false)} → {String(machine.git.after?.dirty ?? false)}</p>
                  <p>Owned previews started: {machine.previews.started.map((item) => `${item.kind} :${item.port ?? 'starting'}`).join(', ') || 'none'}</p>
                  <p>Owned previews stopped: {machine.previews.stopped.map((item) => `${item.kind} :${item.port ?? '?'}`).join(', ') || 'none'} · observed, not revertable</p>
                  <p>Terminals: {machine.terminals.before.length} → {machine.terminals.after.length} · observed, not revertable</p>
                  {[...machine.terminals.before, ...machine.terminals.after.filter((item) => !machine.terminals.before.some((before) => before.id === item.id))].map((item) => <p key={item.id}>Launch cwd ({item.mode}): {item.launchCwd}</p>)}
                  <p>{machine.environment}</p>
                  <p>Runtime: {Object.entries(machine.tools).map(([name, value]) => `${name}: ${value}`).join(' · ')}</p>
                  <details><summary className="cursor-pointer">Scope and limits — not a full-machine restore</summary>
                    <ul className="mt-1 space-y-1">{machine.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                  </details>
                </>}
                {onExportReceipt && selected.machine && (
                  <div className="pt-0.5">
                    <button
                      type="button"
                      onClick={handleExportReceipt}
                      disabled={blocked || receiptBusy}
                      className="flex items-center gap-1.5 rounded-lg border border-white/15 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-neutral-300 transition-colors hover:border-emerald-400/40 hover:text-emerald-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {receiptBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3" />}
                      {receiptBusy ? 'Writing receipt' : 'Export delta receipt'}
                    </button>
                    {receiptResult?.id === selected.id && (
                      <p role="status" className="mt-1 whitespace-normal break-words text-[9.5px] leading-snug text-neutral-400">
                        {receiptResult.message}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : diffLoading ? (
              <p className="flex items-center gap-1.5 font-mono text-[10px] text-neutral-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                Comparing files
              </p>
            ) : diff ? (
              <>
                <p className="truncate text-[10px] text-neutral-400" title={describeCheckpointDiff(diff)}>
                  {describeCheckpointDiff(diff)}
                </p>
                {diff.changes.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {diff.changes.slice(0, DIFF_ROWS).map((change) => {
                      const glyph = KIND_GLYPH[change.kind];
                      return (
                        <li key={change.path} className="flex min-w-0 items-center gap-1.5 font-mono text-[10px]">
                          <span className={`${glyph.tone} w-2 shrink-0`}>{glyph.mark}</span>
                          <span className="truncate text-neutral-300" title={`${change.path} · ${glyph.word}`}>
                            {change.path}
                          </span>
                          {!change.approximate && (change.added || change.removed) > 0 && (
                            <span className="ml-auto shrink-0 text-neutral-600">
                              {change.added > 0 && <span className="text-emerald-400/70">+{change.added}</span>}
                              {change.removed > 0 && <span className="text-rose-400/70"> −{change.removed}</span>}
                            </span>
                          )}
                        </li>
                      );
                    })}
                    {diff.changes.length > DIFF_ROWS && (() => {
                      const more = diff.edited + diff.restored + diff.deleted - DIFF_ROWS;
                      return (
                        <li className="font-mono text-[10px] text-neutral-600">
                          and {more} more file{more === 1 ? '' : 's'}
                        </li>
                      );
                    })()}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-[10px] text-neutral-600">File comparison unavailable for this checkpoint.</p>
            )}
          </div>

          <div className="mt-auto flex shrink-0 items-center gap-2 border-t border-white/[0.07] px-3 py-2">
            <span className="hidden shrink-0 font-mono text-[9px] text-neutral-600 sm:inline">
              {sideCounts.older} older
            </span>
            <button
              type="button"
              onClick={handleRestoreClick}
              disabled={blocked || !selected || Boolean(machineReason)}
              className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[10px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                confirming
                  ? 'border-amber-400/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                  : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
              }`}
            >
              {isRestoringSelected ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : confirming ? (
                <AlertTriangle className="h-3 w-3" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              {isRestoringSelected ? 'Restoring…' : confirming ? 'Confirm restore' : selected?.machine ? 'Rewind captured changes' : 'Restore editor buffers'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
