export interface StuckSignal {
  kind: 'repeat' | 'no-progress' | 'exhausted';
  detail: string;
}

export interface StuckRound {
  calls: string[];
  changedFiles: number;
  /** Successful outcomes this round; optional so older callers stay valid. */
  okCount?: number;
  /** Failed or refused outcomes this round. */
  failedCount?: number;
}

const REPEAT_RUN = 3;
const NO_PROGRESS_LIMIT = 4;
const EXHAUSTED_LIMIT = 6;
const MAX_DETAIL_KEYS = 3;

function keysOf(calls: string[]): string[] {
  return Array.isArray(calls) ? calls.filter((call) => typeof call === 'string' && Boolean(call.trim())) : [];
}

function signature(calls: string[]): string {
  return [...new Set(keysOf(calls))].sort().join('|');
}

function keyList(calls: string[]): string {
  const keys = keysOf(calls);
  const shown = keys.slice(0, MAX_DETAIL_KEYS).join(', ');
  return keys.length > MAX_DETAIL_KEYS ? `${shown}, +${keys.length - MAX_DETAIL_KEYS} more` : shown;
}

function isQuiet(rounds: StuckRound[], index: number): boolean {
  if (typeof rounds[index].changedFiles === 'number' && rounds[index].changedFiles > 0) return false;
  return signature(rounds[index].calls) === '' || signature(rounds[index].calls) === signature(rounds[index - 1].calls);
}

function repeatRun(rounds: StuckRound[]): { start: number; end: number } | null {
  let start = 0;
  for (let index = 1; index < rounds.length; index += 1) {
    const same = signature(rounds[index].calls) !== '' && signature(rounds[index].calls) === signature(rounds[index - 1].calls);
    if (!same) {
      if (index - start >= REPEAT_RUN) return { start, end: index - 1 };
      start = index;
    }
  }
  return rounds.length - start >= REPEAT_RUN ? { start, end: rounds.length - 1 } : null;
}

function allZeroChanges(rounds: StuckRound[]): boolean {
  return rounds.every((round) => !(typeof round.changedFiles === 'number' && round.changedFiles > 0));
}

function noNewKeys(rounds: StuckRound[]): boolean {
  const seen = new Set<string>();
  let primed = false;
  for (const round of rounds) {
    const keys = keysOf(round.calls);
    if (!primed) {
      if (keys.length === 0) continue;
      primed = true;
      keys.forEach((key) => seen.add(key));
      continue;
    }
    if (keys.some((key) => !seen.has(key))) return false;
  }
  return true;
}

export function detectStuck(rounds: StuckRound[]): StuckSignal | null {
  if (rounds.length === 0) return null;

  if (rounds.length >= EXHAUSTED_LIMIT && isQuiet(rounds, rounds.length - 2) && isQuiet(rounds, rounds.length - 1)) {
    return {
      kind: 'exhausted',
      detail: `rounds ${rounds.length - 1} and ${rounds.length} of ${rounds.length} asked for nothing new`
    };
  }

  const run = repeatRun(rounds);
  if (run) {
    return {
      kind: 'repeat',
      detail: `rounds ${run.start + 1}-${run.end + 1} asked for the same calls again: ${keyList(rounds[run.start].calls)}`
    };
  }

  if (rounds.length >= NO_PROGRESS_LIMIT && allZeroChanges(rounds) && noNewKeys(rounds)) {
    return {
      kind: 'no-progress',
      detail: `${rounds.length} rounds changed no files and asked for no call the earlier rounds had not`
    };
  }

  return null;
}

const OPENING: Record<StuckSignal['kind'], string> = {
  repeat: 'You are looping: the same tool calls, over and over.',
  'no-progress': 'You are looping: the rounds are not making progress.',
  exhausted: 'You are looping and the tool budget is spent.'
};

export function stuckInstruction(signal: StuckSignal): string {
  return `${OPENING[signal.kind]} (${signal.detail}.) Stop calling tools and write the final answer now with what you have already read. `
    + 'Say plainly which files you did not get to instead of guessing about them, and propose the next concrete step rather than another search.';
}

/* ------------------------------------------------------------------ *
 * Same-call-same-error tracking: the second identical failure earns a
 * "change approach" nudge, the third blocks the call outright. A guard
 * refusal is not a failed operation and never counts; a DIFFERENT error
 * on the same call is new information and resets the run.
 * ------------------------------------------------------------------ */

export interface FailureObservation {
  key: string;
  ok: boolean;
  refused?: boolean;
  error?: string;
  content?: string;
}

export type FailureVerdict = 'nudge' | 'block' | null;

export function createFailureRepeatTracker() {
  const runs = new Map<string, { signature: string; count: number }>();
  const blocked = new Set<string>();

  // Command failures embed per-run noise — a self-healing receipt id, the wall
  // duration, and timestamps in server output — so two runs of the same failing
  // command must be stripped down to their stable core or the "same error"
  // comparison never matches and the repeat blocker stays dead forever.
  const VOLATILE_FAILURE_NOISE =
    /ran in the opened folder · \d+ ms|proof-\d+-[a-z0-9]+|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?|\b\d{1,2}:\d{2}:\d{2}\b/gi;

  const signatureOf = (entry: FailureObservation): string =>
    (entry.error ?? entry.content ?? '')
      .replace(VOLATILE_FAILURE_NOISE, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);

  /** Feed one executed outcome; returns the verdict for THIS observation. */
  const note = (entry: FailureObservation): FailureVerdict => {
    if (entry.ok || entry.refused) return null;
    const signature = signatureOf(entry);
    const previous = runs.get(entry.key);
    if (!previous || previous.signature !== signature) {
      runs.set(entry.key, { signature, count: 1 });
      return null;
    }
    previous.count += 1;
    if (previous.count === 2) return 'nudge';
    if (previous.count === 3) {
      blocked.add(entry.key);
      return 'block';
    }
    return null;
  };

  const isBlocked = (key: string): boolean => blocked.has(key);

  /**
   * A successful mutation means the turn moved: earlier failure runs (and
   * blocks) described a stale disk state, so they clear. Without this, a
   * verify that failed before a fix could stay blocked after the fix landed.
   */
  const reset = (): void => {
    runs.clear();
    blocked.clear();
  };

  return { note, isBlocked, reset };
}

export function failureNudge(label: string): string {
  return `${label} failed the same way twice. Repeating it will not change the result — change approach: `
    + 're-read the file to get its exact current text, narrow or fix the arguments, or use a different tool. '
    + 'A third identical failure blocks the call for the rest of this turn.';
}

export function failureBlockMessage(label: string): string {
  return `${label} is blocked: it failed the same way three times this turn. `
    + 'Do not ask for it again — take a different approach (read the current file, change the arguments, or another tool) and say what you changed.';
}
