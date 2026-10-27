/**
 * Ctrl+K quick edit: rewrite the selected region with an instruction.
 * The prompt shape (ABOVE / SELECTED / BELOW) and the fenced-reply handling
 * are ported from Void's inline edit flow.
 */
import { streamChat } from './ai';
import type { ProviderId } from './providers';

const CONTEXT_LINES = 28;

export interface QuickEditContext {
  filePath: string;
  language: string;
  above: string;
  selected: string;
  below: string;
  instruction: string;
}

export interface QuickEditAiOptions {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  /** The user's chat temperature. Clamped down — see `clampInlineTemperature`. */
  temperature?: number;
}

/** Sampling default when the caller has no preference. */
export const INLINE_TEMPERATURE_DEFAULT = 0.1;

/**
 * Inline edits get a tighter ceiling than chat.
 *
 * A chat reply is prose, so a hot temperature mostly changes wording. An inline
 * edit has to return the selected region and *nothing else* — every token above
 * this range makes the model rewrite the surrounding style, re-indent code it
 * was not asked to touch, or narrate its reasoning into the buffer, and the
 * replacement is dropped straight into the user's file. So even a user who runs
 * chat at 1.5 is capped here; the preference is honoured within the range where
 * it is still safe to write into a document.
 */
export const INLINE_TEMPERATURE_MAX = 0.4;

export const INLINE_TEMPERATURE_MIN = 0;

/** Keeps the user's preference, but only inside the safe inline-edit band. */
export function clampInlineTemperature(temperature?: number): number {
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) return INLINE_TEMPERATURE_DEFAULT;
  return Math.min(INLINE_TEMPERATURE_MAX, Math.max(INLINE_TEMPERATURE_MIN, temperature));
}

export function buildQuickEditPrompt(context: QuickEditContext): { systemInstruction: string; prompt: string } {
  return {
    systemInstruction:
      'You are an inline code editor. You receive a slice of a file and one instruction. ' +
      'Return ONLY the new code that replaces the selected region, in the same language and style. ' +
      'No explanations, no diff markers, no code outside the replaced region. ' +
      'If the instruction cannot be satisfied, return the selected code unchanged.',
    prompt:
      `File: ${context.filePath} (${context.language})\n\n` +
      `<ABOVE>\n${context.above}\n</ABOVE>\n\n` +
      `<SELECTED>\n${context.selected}\n</SELECTED>\n\n` +
      `<BELOW>\n${context.below}\n</BELOW>\n\n` +
      `Instruction: ${context.instruction}\n\n` +
      'Replacement code for <SELECTED> only:'
  };
}

/** Splits a document around a character range into the three prompt regions. */
export function sliceQuickEditContext(
  content: string,
  from: number,
  to: number,
  instruction: string,
  filePath: string,
  language: string
): QuickEditContext {
  // An empty caret means "edit this line", the Void inline-edit fallback.
  const lineStart = content.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const lineEnd = (() => {
    const nextBreak = content.indexOf('\n', from);
    return nextBreak === -1 ? content.length : nextBreak;
  })();
  const start = from < to ? from : lineStart;
  const end = from < to ? to : lineEnd;
  return {
    filePath,
    language,
    above: content.slice(0, start).split('\n').slice(-CONTEXT_LINES).join('\n'),
    selected: content.slice(start, end),
    below: content.slice(end).split('\n').slice(0, CONTEXT_LINES).join('\n'),
    instruction
  };
}

/** Keeps the model output usable as code: first fenced block, else raw text. */
export function extractReplacement(raw: string): string {
  const fenced = raw.match(/```[a-zA-Z]*\r?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].replace(/\n+$/, '');
  const text = raw
    .replace(/^\s*```\s*[a-zA-Z]*\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  return text;
}

/**
 * Runs one inline edit and returns the replacement text. Rejects when the
 * model produced nothing, so the caller can leave the buffer untouched.
 */
export async function runQuickEdit(
  context: QuickEditContext,
  ai: QuickEditAiOptions,
  signal?: AbortSignal
): Promise<string> {
  const { systemInstruction, prompt } = buildQuickEditPrompt(context);
  const outcome: { reply: string; error: string | null } = { reply: '', error: null };

  await streamChat(
    {
      provider: ai.provider,
      model: ai.model,
      apiKey: ai.apiKey,
      messages: [{ role: 'user', content: prompt }],
      systemInstruction,
      temperature: clampInlineTemperature(ai.temperature),
      thinking: 'low',
      signal
    },
    {
      onDelta: (chunk) => {
        outcome.reply += chunk;
      },
      onError: (message) => {
        outcome.error = message;
      }
    }
  );

  if (outcome.error) throw new Error(outcome.error);
  const replacement = extractReplacement(outcome.reply);
  if (!replacement.trim()) throw new Error('The model returned no replacement code.');
  return replacement;
}
