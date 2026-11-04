/**
 * Condenser policy ported from OpenHands (https://github.com/OpenHands/OpenHands),
 * MIT License — Copyright (c) 2024 Raghavendra Kapagan / Open Hands.
 *
 * Ported, adapted and partially rewritten from the OpenHands event-store
 * condenser lineage — `TruncatingCondenser` (keep head, keep tail, forget the
 * middle) and `LLMSummarizingCondenser` (`keep_first` events, a summarize-the-
 * middle pass with a rolling-update prompt, `minimum_progress`, and the hard
 * context-reset escalation) — as documented by the MIT-licensed Agent Canvas
 * reference copy in this repo:
 *
 * - reference/OpenHands-main/src/types/agent-server/core/events/condensation-event.ts
 *   (forgotten ids + summary + summary offset: the middle is replaced by a
 *   summary inserted where the forgotten events began)
 * - reference/OpenHands-main/src/i18n/translation.json, keys
 *   SCHEMA$CONDENSER$KEEP_FIRST / MAX_TOKENS / MINIMUM_PROGRESS /
 *   HARD_CONTEXT_RESET_* ("Number of events at the start of the conversation
 *   that are always kept when condensing", "Minimum fraction of events that
 *   must be condensed for a condensation to count as successful", "Factor used
 *   to shrink event text when summarizing fails after a hard context reset")
 * - reference/OpenHands-main/src/api/agent-server-adapter.ts (planning preset:
 *   kind LLMSummarizingCondenser, max_size 100, keep_first 6)
 *
 * The upstream Python condensers themselves live in OpenHands/software-agent-sdk
 * and are not vendored here; what is ported is their *policy*, adapted to
 * ShadRox's message-array world (one ShadRox ChatMessage ≈ one OpenHands
 * action/observation pair, so OpenHands's default keep_first of 4 events is
 * adapted to 2 messages and the planning preset's 6 to 3).
 *
 * The summarizer templates are recognizable adaptations of the upstream
 * LLMSummarizingCondenser prompts: a first-condensation pass, and a
 * rolling-update pass that keeps the tone and format of the previous summary.
 * ShadRox's compaction step stays LLM-free by default — the caller may pass a
 * synchronous summarizer seam (CompactionOptions.condenseSummarizer), and if it
 * is missing or unhelpful the deterministic extractive digest below is used,
 * which is the same fallback posture as OpenHands's hard-reset scaling except
 * that it never needs a model call.
 */

import type { ChatMessage } from '../types';
import { RESULT_FENCE, TOOL_FENCE } from '../agent/toolProtocol';

/**
 * OpenHands keep_first, adapted: the first N messages of the archived history
 * are always kept when condensing — the original request is exactly what a
 * summarizer is worst at preserving, and dropping it churns the prompt prefix
 * that provider-side caches key on.
 */
export const DEFAULT_KEEP_FIRST_HEAD = 2;

/**
 * OpenHands minimum_progress (default 0.1): a condensation only counts as
 * successful if it actually shrinks the region it forgets. A run that cannot
 * save at least this fraction of its own characters is not replaced by a
 * digest; it stays for the plain drop loop instead.
 */
export const CONDENSER_MINIMUM_PROGRESS = 0.1;

/** Hard ceiling for the digest message so one condensation event cannot grow the history. */
export const DIGEST_MAX_CHARS = 600;

/** Longest per-message line the summarizer transcript shows. */
const TRANSCRIPT_LINE_CHARS = 400;
/** Ceiling for the whole transcript handed to the summarizer seam. */
const TRANSCRIPT_MAX_CHARS = 12_000;

/** Adapted from the OpenHands LLMSummarizingCondenser first-condensation prompt. */
export const FIRST_CONDENSATION_PROMPT =
  'You are summarizing a coding conversation between a user and an AI assistant so the assistant can ' +
  'continue with a condensed history. Summarize the events below, keeping the user requests, every ' +
  'file path that was read or edited, the actions taken and their outcomes, and anything the user ' +
  'corrected or rejected. Answer with the summary and nothing else.';

/** Adapted from the OpenHands rolling-update prompt: same tone and format as the previous summary. */
export function rollingCondensationPrompt(previousSummary: string): string {
  return (
    'Here is a summary of the events that were condensed so far: ' +
    `${previousSummary.trim()}\n\n` +
    'Given the above summary, write a summary of the new events below that keeps the same tone and ' +
    'format as the previous summary, while including the most important details from the new events ' +
    '(requests, file paths, actions and outcomes). Do not include any other text.'
  );
}

/** The prompt handed to the optional summarizer seam for one condensation run. */
export function condensationPrompt(transcript: string, previousSummary: string | null): string {
  const head = previousSummary ? rollingCondensationPrompt(previousSummary) : FIRST_CONDENSATION_PROMPT;
  return `${head}\n\nEvents to summarize:\n${transcript}`;
}

/** Deterministic transcript of a forgotten run, whitespace-collapsed and capped. */
export function transcriptOf(entries: readonly ChatMessage[]): string {
  const lines = entries.map((entry) =>
    `${entry.role}: ${entry.content.replace(/\s+/g, ' ').trim().slice(0, TRANSCRIPT_LINE_CHARS)}`);
  return lines.join('\n').slice(0, TRANSCRIPT_MAX_CHARS);
}

const TOOL_FENCE_PATTERN = new RegExp('```[ \\t]*' + TOOL_FENCE, 'g');
const RESULT_FENCE_PATTERN = new RegExp('```[ \\t]*' + RESULT_FENCE, 'g');

function countMatches(content: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(content) !== null) count += 1;
  return count;
}

/** A message that issues tool calls (an OpenHands "action"). */
export function hasToolAction(content: string): boolean {
  return countMatches(content, TOOL_FENCE_PATTERN) > 0;
}

/** A message that carries tool results (an OpenHands "observation"). */
export function hasToolObservation(content: string): boolean {
  return countMatches(content, RESULT_FENCE_PATTERN) > 0;
}

/**
 * TruncatingCondenser pair integrity: an observation travels with the action
 * that produced it. Walking the archive, every result-only message is anchored
 * to the most recent action message; the walk breaks on any prose message (a
 * new exchange opens a new pair). Returns, per index, the index of the anchor
 * the message must not be split from (its own index when unanchored).
 */
export function observationAnchors(contents: readonly string[]): number[] {
  const anchors: number[] = [];
  let anchor = -1;
  contents.forEach((content, index) => {
    if (hasToolAction(content)) {
      anchor = index;
      anchors.push(index);
    } else if (hasToolObservation(content)) {
      anchors.push(anchor === -1 ? index : anchor);
    } else {
      anchor = -1;
      anchors.push(index);
    }
  });
  return anchors;
}

/**
 * The always-kept set, OpenHands style: head keep_first, protected survivors
 * (pending review, edit carriers, recent tail, the digest itself, the newest
 * message), and — the pair rule — every message anchored to a kept one stays
 * kept too, so an action is never cut from its observation. `anchors[i]` is the
 * index the i-th message must travel with (its own index when unanchored);
 * pass positions from observationAnchors() over the *original* contents so the
 * rule survives folding, which rewrites the fence text in place.
 */
export function computeLocks(
  entries: ReadonlyArray<{ message: ChatMessage; protected: boolean }>,
  keepFirstHead: number,
  anchors?: readonly number[]
): boolean[] {
  const count = entries.length;
  const locked = entries.map((entry, index) =>
    entry.protected || index < keepFirstHead || index === count - 1);
  const pairAnchors = anchors ?? observationAnchors(entries.map((entry) => entry.message.content));

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < count; index += 1) {
      const anchor = pairAnchors[index] ?? index;
      if (anchor === index || anchor < 0 || anchor >= count || !locked[anchor] || locked[index]) continue;
      locked[index] = true;
      changed = true;
    }
  }
  return locked;
}

const PATH_ATTRIBUTE = /path=([\w./\\+-]+)/g;
const JSON_PATH_ARGUMENT = /"(?:path|file_path|file|target)"\s*:\s*"([^"]+)"/g;

/** Every file path a message mentions, fence attributes and tool arguments alike. */
export function collectPathMentions(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(PATH_ATTRIBUTE)) found.add(match[1]);
  for (const match of content.matchAll(JSON_PATH_ARGUMENT)) found.add(match[1]);
  return [...found].sort();
}

function pluralize(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const DIGEST_PATH_LIMIT = 6;
const DIGEST_LABEL_LIMIT = 4;
const DIGEST_ASK_CHARS = 120;

function toolTally(entries: readonly ChatMessage[]): string {
  const byName = new Map<string, { count: number; failed: number; labels: Set<string> }>();
  entries.forEach((entry) => {
    (entry.toolActivity ?? []).forEach((activity) => {
      const group = byName.get(activity.name) ?? { count: 0, failed: 0, labels: new Set<string>() };
      group.count += 1;
      if (!activity.ok) group.failed += 1;
      const label = activity.label.trim();
      if (label) group.labels.add(label);
      byName.set(activity.name, group);
    });
  });
  return [...byName.keys()].sort().map((name) => {
    const group = byName.get(name) as { count: number; failed: number; labels: Set<string> };
    const labels = [...group.labels].sort();
    const shown = labels.slice(0, DIGEST_LABEL_LIMIT).join(', ');
    const tail = labels.length > DIGEST_LABEL_LIMIT ? `, +${labels.length - DIGEST_LABEL_LIMIT} more` : '';
    const target = shown ? ` (${shown}${tail})` : '';
    const failures = group.failed > 0 ? ` [${group.failed} failed]` : '';
    return `${name} x${group.count}${target}${failures}`;
  }).join('; ');
}

/**
 * The deterministic stand-in for LLMSummarizingCondenser's summary message:
 * counts what was forgotten, names the paths and tools the middle touched —
 * the product invariant that a post-compaction turn must still carry a path
 * inventory — and rolls up into the previous digest when one exists, mirroring
 * OpenHands's rolling summary_offset insertion.
 */
export function buildCondensationDigest(
  entries: readonly ChatMessage[],
  preservedEdits: number,
  previousDigest: string | null
): string {
  const lines: string[] = [];
  lines.push(`[condensed ${pluralize(entries.length, 'older message')}` +
    `${previousDigest ? '; rolled up with the earlier digest' : ''}]`);

  const first = entries.find((entry) => entry.content.trim().length > 0);
  if (first) {
    const ask = first.content.trim().split('\n')[0].replace(/\s+/g, ' ');
    lines.push(`First ask: "${ask.slice(0, DIGEST_ASK_CHARS)}${ask.length > DIGEST_ASK_CHARS ? '…' : ''}"`);
  }

  const paths = [...new Set(entries.flatMap((entry) => collectPathMentions(entry.content)))].sort();
  if (paths.length > 0) {
    const shown = paths.slice(0, DIGEST_PATH_LIMIT).join(', ');
    lines.push(`Files seen: ${shown}${paths.length > DIGEST_PATH_LIMIT ? ` (+${paths.length - DIGEST_PATH_LIMIT} more)` : ''}`);
  }

  const tools = toolTally(entries);
  if (tools) lines.push(`Tools: ${tools}`);

  if (preservedEdits > 0) {
    lines.push(`${pluralize(preservedEdits, 'edit block')} kept verbatim in the history`);
  }

  const text = lines.join('\n');
  return text.length <= DIGEST_MAX_CHARS ? text : `${text.slice(0, DIGEST_MAX_CHARS - 1)}…`;
}
