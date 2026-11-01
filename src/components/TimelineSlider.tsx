import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { AlertTriangle, History, Loader2, RotateCcw, X } from 'lucide-react';
import type { CheckpointMeta } from '../lib/history';
import {
  buildTimeline,
  checkpointAtRatio,
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
}

const CONFIRM_WINDOW_MS = 4000;
const RAIL_NODE_SPACING = 26;

/**
 * Compact visual history rail. Nodes run oldest -> newest left to right, the
 * range input snaps to whole checkpoints, and restoring is a deliberate
 * two-step action so a mis-click cannot wipe later work.
 */
export function TimelineSlider({
  checkpoints,
  selectedId,
  onSelect,
  onRestore,
  restoringId,
  onClose,
  disabled
}: TimelineSliderProps) {
  const [internalId, setInternalId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

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
  const sliderMax = Math.max(0, count - 1);
  const sliderValue = selectedIndex < 0 ? sliderMax : selectedIndex;
  const isRestoringSelected = Boolean(restoringId) && Boolean(selected) && restoringId === selected.id;
  const busy = Boolean(restoringId);
  const blocked = Boolean(disabled) || busy;

  const sideCounts = useMemo(() => diffSince(points, selected ? selected.id : null), [points, selected]);
  const summary =
    sideCounts.newer > 0
      ? `Restoring here reverts ${sideCounts.newer} later change${sideCounts.newer === 1 ? '' : 's'}`
      : 'Restoring here is the current state';

  useEffect(() => {
    setConfirming(false);
  }, [selected ? selected.id : null]);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const selectPoint = (id: string) => {
    if (blocked) return;
    setInternalId(id);
    if (onSelect) onSelect(id);
  };

  const handleSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const index = Number(event.target.value);
    const ratio = sliderMax > 0 ? index / sliderMax : 1;
    const nearest = checkpointAtRatio(points, ratio);
    if (nearest) selectPoint(nearest.id);
  };

  const handleRestoreClick = () => {
    if (!selected || blocked) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onRestore(selected.id);
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
            <div className="overflow-x-auto px-2 pb-0.5">
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
                  const isSelected = Boolean(selected) && checkpoint.id === selected.id;
                  const isRestoring = Boolean(restoringId) && restoringId === checkpoint.id;
                  return (
                    <button
                      key={checkpoint.id}
                      type="button"
                      onClick={() => selectPoint(checkpoint.id)}
                      disabled={blocked}
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

            <input
              type="range"
              aria-label="Checkpoint timeline"
              aria-valuetext={selected ? `${selectedLabel}, ${describeCheckpoint(selected)}` : undefined}
              min={0}
              max={sliderMax}
              step={1}
              value={sliderValue}
              disabled={blocked}
              onChange={handleSliderChange}
              className="mt-0.5 h-1 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            />

            <p className="mt-1 truncate text-[10px] text-neutral-500" title={summary}>
              {summary}
            </p>
          </div>

          <div className="mt-auto flex shrink-0 items-center gap-2 border-t border-white/[0.07] px-3 py-2">
            <span className="hidden shrink-0 font-mono text-[9px] text-neutral-600 sm:inline">
              {sideCounts.older} older
            </span>
            <button
              type="button"
              onClick={handleRestoreClick}
              disabled={blocked || !selected}
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
              {isRestoringSelected ? 'Restoring…' : confirming ? 'Confirm restore' : 'Restore this checkpoint'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
