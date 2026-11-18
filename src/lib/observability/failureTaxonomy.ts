/**
 * The failure taxonomy: one primary code per failed or stopped run.
 *
 * A trace without a verdict is just noise. Every run the flight recorder
 * closes with a non-success stop reason (or never closes at all) is tagged
 * here with exactly ONE primary code, derived only from recorded events —
 * never from a guess about what the model "meant". When the events do not
 * explain the failure, the tag is F12 with low confidence, which is an honest
 * "we don't know yet" rather than a confident wrong answer.
 *
 * Codes (owner-approved Phase 0 list):
 *  F01 wrong lane            — the model attempted an effect its permission mode forbids
 *  F02 invalid tool args     — malformed/unparsable calls, unknown tools, missing required args
 *  F03 edit match failure    — edit_file NOT_FOUND or AMBIGUOUS snippet
 *  F04 command policy refuse — the command guard/policy blocked the command itself
 *  F05 command timeout       — the command ran out of time
 *  F06 never read the file   — the run looped/ended without ever reading a workspace file
 *  F07 verify false-fail     — verification said no, later real evidence said yes
 *  F08 step cap              — the round budget ran out
 *  F09 provider error        — upstream failure, truncation, empty or broken stream
 *  F10 approval declined     — the user said no, or abandoned the run
 *  F11 stale buffer          — the write was pinned to a version that moved underneath it
 *  F12 reasoning error       — everything else; low confidence when unexplained
 */

import type { FlightEvent } from './flightRecorder';

export type FailureCode =
  | 'F01' | 'F02' | 'F03' | 'F04' | 'F05' | 'F06'
  | 'F07' | 'F08' | 'F09' | 'F10' | 'F11' | 'F12';

export interface FailureTag {
  code: FailureCode;
  /** How sure the derivation is. `low` means "unexplained — needs a human trace read". */
  confidence: 'high' | 'medium' | 'low';
  /** One readable line naming the evidence, for the trace viewer and the report. */
  reason: string;
}

export const FAILURE_LABELS: Record<FailureCode, string> = {
  F01: 'wrong lane for the permission mode',
  F02: 'invalid or unparsable tool arguments',
  F03: 'edit snippet not found or ambiguous',
  F04: 'command refused by policy',
  F05: 'command timeout',
  F06: 'model never read the right file',
  F07: 'verification false-fail',
  F08: 'step cap hit',
  F09: 'provider error or truncation',
  F10: 'approval declined or run abandoned',
  F11: 'stale buffer / version conflict',
  F12: 'model reasoning error'
};

/** Stop reasons that mean the run succeeded; those runs get no failure tag. */
const SUCCESS_REASONS = new Set(['complete', 'finish', 'finished', 'answered', 'stream_complete']);

export function isSuccessStopReason(reason: string): boolean {
  return SUCCESS_REASONS.has(reason);
}

/**
 * A short stable code for a tool outcome, recorded on `tool_result` events so
 * the taxonomy (and a future trace viewer) can group failures without
 * re-parsing prose. Order matters: the most specific shape wins.
 */
export function toolErrorCode(outcome: { ok: boolean; error?: string; refused?: boolean }): string | undefined {
  if (outcome.ok) return undefined;
  const error = outcome.error ?? '';
  if (/mode does not allow/.test(error)) return 'POLICY';
  if (/not approved|did not allow/i.test(error)) return 'DENIED';
  if (/original snippet was not found/i.test(error)) return 'NOT_FOUND';
  if (/appears more than once/i.test(error)) return 'AMBIGUOUS';
  if (/timed?\s?out|timeout/i.test(error)) return 'TIMEOUT';
  if (/changed since|expected version|version mismatch|stale/i.test(error)) return 'STALE';
  if (/^Not written —|failed pre-apply verification|could not be verified/i.test(error)) return 'VERIFY';
  if (/not valid JSON|incomplete or invalid JSON|needs a |needs path|needs content|needs original|no usable calls|is not a tool/i.test(error)) return 'BAD_ARGS';
  if (/ENOENT|no such file|does not exist|not found/i.test(error)) return 'NOT_FOUND';
  if (outcome.refused) return 'REFUSED';
  return 'ERROR';
}

function dataOf(event: FlightEvent): Record<string, unknown> {
  return event.data ?? {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toolResults(events: FlightEvent[]): FlightEvent[] {
  return events.filter((event) => event.type === 'tool_result');
}

function failedToolResults(events: FlightEvent[]): FlightEvent[] {
  return toolResults(events).filter((event) => dataOf(event).status !== 'ok');
}

function errorTexts(events: FlightEvent[]): string[] {
  return failedToolResults(events).map((event) => text(dataOf(event).error));
}

function firstMatch(events: FlightEvent[], pattern: RegExp): string | null {
  for (const error of errorTexts(events)) {
    const match = error.match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * Derives the ONE primary failure code from a run's recorded events.
 * Returns null for a cleanly completed run. Precedence runs from the cause
 * that actually ended the run (cap, provider, abandonment) down to the
 * earliest actionable defect in the trace, so a run that limped to the cap
 * with bad edits is tagged F08 (why it stopped) — the edit failures remain
 * visible as individual tool_result events for the trace viewer.
 */
export function classifyFailure(events: FlightEvent[]): FailureTag | null {
  if (events.length === 0) return null;
  const stop = [...events].reverse().find((event) => event.type === 'stop');
  const reason = stop ? text(dataOf(stop).reason) : '';
  if (stop && isSuccessStopReason(reason)) return null;

  const failed = failedToolResults(events);
  const errors = errorTexts(events);
  const anyError = (pattern: RegExp): boolean => errors.some((error) => pattern.test(error));

  // F08 — the budget ended the run, whatever happened inside it.
  if (reason === 'step_cap') {
    return { code: 'F08', confidence: 'high', reason: `step cap reached (${text(dataOf(stop).rounds) || '?'} rounds)` };
  }

  // F09 — the provider failed, truncated, or the stream never confirmed done.
  const providerError = events.find((event) => event.type === 'provider_error');
  const truncated = events.some((event) =>
    (event.type === 'usage' || event.type === 'stream_end') && dataOf(event).truncated === true);
  if (reason === 'provider_error' || providerError || truncated) {
    const detail = providerError
      ? text(dataOf(providerError).code) || text(dataOf(providerError).message).slice(0, 120)
      : truncated ? 'output truncated at the provider limit' : reason;
    return { code: 'F09', confidence: 'high', reason: `provider failure: ${detail || 'unknown'}` };
  }

  // F10 — the user stopped the run, declined an approval, or walked away.
  if (reason === 'aborted') {
    return { code: 'F10', confidence: 'medium', reason: 'run aborted by the user before it finished' };
  }
  const declinedDecision = events.find((event) =>
    event.type === 'command_decision'
    && dataOf(event).decision === 'deny'
    && (dataOf(event).source === 'native-approval' || dataOf(event).source === 'user'));
  const approvalRefusal = failed.find((event) =>
    dataOf(event).refused === true && /not approved|did not allow/i.test(text(dataOf(event).error)));
  if (declinedDecision || approvalRefusal) {
    return { code: 'F10', confidence: 'high', reason: 'an approval was declined (native command gate or external tool prompt)' };
  }

  // F05 — a command ran out of time.
  const timedOutCommand = events.find((event) => event.type === 'command_finished' && dataOf(event).timedOut === true);
  const timeoutError = firstMatch(events, /timed?\s?out|timeout/i);
  if (timedOutCommand || (timeoutError && errors.some((error) => /timed?\s?out|timeout/i.test(error) && /\$ |exit /i.test(error)))) {
    return { code: 'F05', confidence: 'high', reason: `command timeout${timeoutError ? `: ${timeoutError.slice(0, 100)}` : ''}` };
  }

  // F04 — the command guard/policy refused the command itself (not the user).
  const policyDecision = events.find((event) =>
    event.type === 'command_decision'
    && dataOf(event).decision === 'deny'
    && dataOf(event).source !== 'native-approval'
    && dataOf(event).source !== 'user'
    && dataOf(event).source !== 'run-policy');
  if (policyDecision || anyError(/blocked by (?:the )?(?:command )?(?:guard|policy|blacklist)|command policy/i)) {
    return { code: 'F04', confidence: 'high', reason: 'command refused by the command guard/policy' };
  }

  // F01 — the model worked in a lane its permission mode does not allow.
  if (anyError(/mode does not allow/)) {
    const lane = firstMatch(events, /\w+ mode does not allow \w+/);
    return { code: 'F01', confidence: 'high', reason: lane ?? 'effect refused by the permission mode' };
  }

  // F03 — the edit could not be placed: snippet absent or ambiguous.
  const notFound = firstMatch(events, /original snippet was not found/i);
  const ambiguous = firstMatch(events, /appears more than once/i);
  if (notFound || ambiguous) {
    return {
      code: 'F03',
      confidence: 'high',
      reason: notFound ? 'edit_file NOT_FOUND: the original snippet is not in the file' : 'edit_file AMBIGUOUS: the snippet matches more than one place'
    };
  }

  // F11 — the write was pinned to a buffer that moved underneath it.
  if (anyError(/changed since|expected version|version mismatch|stale buffer/i)) {
    return { code: 'F11', confidence: 'medium', reason: 'a write lost its version pin — the file changed since it was read' };
  }

  // F02 — the calls themselves were malformed.
  if (anyError(/not valid JSON|incomplete or invalid JSON|needs a |needs content|needs original|no usable calls|is not a tool/i)) {
    const detail = firstMatch(events, /not valid JSON|incomplete or invalid JSON|needs a [a-z_]+|is not a tool/i);
    return { code: 'F02', confidence: 'high', reason: `invalid tool call: ${detail ?? 'malformed arguments'}` };
  }

  // F07 — verification said no, but a later real command exit said yes.
  const verifyFails = events.filter((event) => event.type === 'verify_result' && dataOf(event).ok === false);
  if (verifyFails.length > 0) {
    const lastVerify = verifyFails[verifyFails.length - 1];
    const laterHeal = events.some((event) =>
      event.type === 'command_finished'
      && dataOf(event).exit === 0
      && event.seq > lastVerify.seq);
    if (laterHeal) {
      return { code: 'F07', confidence: 'medium', reason: 'verification failed but a later command exited 0 — probable false-fail' };
    }
  }

  // F06 — the run never read a single workspace file before it died.
  const successfulReads = toolResults(events).filter((event) =>
    dataOf(event).status === 'ok' && dataOf(event).tool === 'read_file').length;
  if (reason === 'stuck' || reason === 'no_progress') {
    if (successfulReads === 0) {
      return { code: 'F06', confidence: 'high', reason: 'looped without progress and never successfully read a file' };
    }
    return { code: 'F12', confidence: 'medium', reason: `looped without progress despite ${successfulReads} successful read(s) — reasoning loop` };
  }

  // Everything else is unexplained: F12, honestly flagged low confidence.
  if (failed.length > 0) {
    const codes = [...new Set(failed.map((event) => text(dataOf(event).error_code)).filter(Boolean))];
    return { code: 'F12', confidence: 'low', reason: `unclassified failure (${codes.join(', ') || 'no error code'}) — needs a trace read` };
  }
  return { code: 'F12', confidence: 'low', reason: reason ? `unexplained stop: ${reason}` : 'run never recorded a stop event' };
}