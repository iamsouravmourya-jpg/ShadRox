/**
 * Run budget: the work ceilings that stop an autonomous run before it runs away.
 *
 * `ceilingReached` is the one tested rule for the non-monetary ceilings — turns,
 * tool calls, wall clock — that both drivers consult at the same boundaries.
 * Everything here is pure/in-memory: ShadRox is BYOK and meters no account, so
 * these numbers exist only to stop a runaway loop, never to limit spend.
 */

/** The ceilings that bound the work: turns, tool calls and wall clock. */
export interface WorkCeilings {
  maxTurns: number;
  maxToolCalls: number;
  maxWallClockMs: number;
}

/** What the run has done so far, as the driver sees it. */
export interface WorkUsage {
  turns: number;
  /** Null until a host reports a real count — a guessed number must not trip a ceiling. */
  toolCalls: number | null;
  elapsedMs: number;
}

export interface CeilingStop {
  kind: 'turns' | 'tool-calls' | 'time';
  /** Written for the panel: names the ceiling and the number it stopped on. */
  message: string;
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}min`;
}

/**
 * The tool calls actually reported across these records, or null while none of
 * them carries a number. Guessing a count would stop a run on a figure nobody
 * measured, so an unreported run is bounded by its turn ceiling instead.
 */
export function toolCallsReported(records: ReadonlyArray<{ toolCalls?: number }>): number | null {
  const reported = records.filter((record) => typeof record.toolCalls === 'number');
  if (reported.length === 0) return null;
  return reported.reduce((sum, record) => sum + (record.toolCalls ?? 0), 0);
}

/**
 * What the run has already used of its work ceilings, read off the
 * attempts it recorded rather than a counter the loop has to keep in sync.
 * That makes a resumed run honest: the attempts it made before the crash still
 * count against the ceiling.
 */
export function workUsageOf(attempts: ReadonlyArray<{ toolCalls?: number }>, elapsedMs: number): WorkUsage {
  return { turns: attempts.length, toolCalls: toolCallsReported(attempts), elapsedMs };
}

/**
 * The work ceiling the run has just reached, or null when it may start one more
 * turn. Checked at a boundary — before a turn starts — which is the only point
 * where stopping still costs nothing.
 *
 * A ceiling of zero, a negative number or `Infinity` means the caller did not
 * configure one: the loop must not stop on a number nobody chose.
 */
export function ceilingReached(ceilings: WorkCeilings, usage: WorkUsage): CeilingStop | null {
  if (ceilings.maxTurns > 0 && Number.isFinite(ceilings.maxTurns) && usage.turns >= ceilings.maxTurns) {
    return {
      kind: 'turns',
      message: `Stopped at the turn cap of ${ceilings.maxTurns} — the run has already made ${usage.turns} model turn(s), and more iterations are not what a cap is for.`
    };
  }
  if (
    usage.toolCalls !== null &&
    ceilings.maxToolCalls > 0 &&
    Number.isFinite(ceilings.maxToolCalls) &&
    usage.toolCalls >= ceilings.maxToolCalls
  ) {
    return {
      kind: 'tool-calls',
      message: `Stopped at the tool-call cap of ${ceilings.maxToolCalls} — the run has made ${usage.toolCalls} tool call(s).`
    };
  }
  if (
    ceilings.maxWallClockMs > 0 &&
    Number.isFinite(ceilings.maxWallClockMs) &&
    usage.elapsedMs >= ceilings.maxWallClockMs
  ) {
    return {
      kind: 'time',
      message: `Stopped after ${formatSeconds(usage.elapsedMs)} — the run's time limit is ${formatSeconds(ceilings.maxWallClockMs)}.`
    };
  }
  return null;
}
