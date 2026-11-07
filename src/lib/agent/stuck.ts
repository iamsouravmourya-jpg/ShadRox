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
