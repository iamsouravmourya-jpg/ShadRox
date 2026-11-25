/**
 * Turns a captured runtime error into a bounded prompt for the chat composer.
 *
 * Only facts already present are used: the message, the stack frames the page
 * reported, and whichever frame resolves to a workspace file through
 * `sourceMapping`. Nothing is invented — no component names, no line numbers the
 * stack did not report.
 */

import type { RevealSourceTarget } from '../previewSource';
import { parseStackFrames, sourceFromStack, type SourceLocation } from './sourceMapping';
import { normalizeSlashes, stripAnsi } from './sourceMapping';

export type { SourceLocation };

export interface FixPromptInput {
  message: string;
  stack?: string;
  url?: string | null;
  source?: SourceLocation | null;
  /** Click-to-source result, when the user picked the element that broke. */
  reveal?: RevealSourceTarget | null;
  maxChars?: number;
}

const MAX_MESSAGE_CHARS = 700;
const MAX_FRAMES = 6;
const MAX_STACK_CHARS = 1200;
const DEFAULT_PROMPT_CHARS = 1800;

/**
 * Control characters a page can throw into console output (NUL, bells, ANSI
 * remainder) never belong in a prompt: they confuse the model and can forge
 * terminal escapes in whatever echoes the prompt back. Newlines, tabs and CR
 * are kept — the stack excerpt is multi-line by design.
 */
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function clip(value: string, max: number): string {
  const text = stripAnsi(value ?? '').replace(CONTROL_CHARS, '').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()} ...` : text;
}

/** The frames worth sending to a model: the first few, with the rest counted. */
export function formatStackExcerpt(stack: string | undefined): string {
  if (!stack) return '';
  const lines = stripAnsi(stack)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== 'Error');
  // `Error: boom` is a header, not a frame; it belongs to the prompt's own
  // `Error:` line. Counted as a frame it inflated the dropped-frame summary.
  const frames = lines.filter((line) => line.startsWith('at '));
  if (frames.length === 0) return clip(lines.join('\n'), MAX_STACK_CHARS);
  const kept = frames.slice(0, MAX_FRAMES).join('\n');
  const suffix = frames.length > MAX_FRAMES ? `\n... ${frames.length - MAX_FRAMES} more frame(s)` : '';
  return clip(`${kept}${suffix}`, MAX_STACK_CHARS);
}

/** Workspace files this error points at, most specific first. */
export function errorSourceFiles(stack: string | undefined): SourceLocation[] {
  return parseStackFrames(stack ?? '');
}

/** Convenience used by the panel: file + line + column rendered for humans. */
export function formatSourceLocation(source: SourceLocation | null | undefined): string {
  if (!source) return '';
  const path = normalizeSlashes(source.path);
  if (!source.line) return path;
  return source.character ? `${path}:${source.line}:${source.character}` : `${path}:${source.line}`;
}

export { sourceFromStack };

/**
 * The prompt handed to the composer. Bounded by `maxChars` so one runtime error
 * cannot swallow the context budget, and explicit about what the model must not
 * invent.
 */
export function buildFixPrompt(input: FixPromptInput): string {
  const maxChars = input.maxChars ?? DEFAULT_PROMPT_CHARS;
  const message = clip(input.message || 'Runtime error', MAX_MESSAGE_CHARS);
  const stack = formatStackExcerpt(input.stack);
  const source = input.source ?? null;

  const lines: string[] = [];
  lines.push('The running preview reported this runtime error. Fix it in the workspace code.');
  lines.push('');
  lines.push(`Error: ${message}`);
  if (input.url) lines.push(`Page: ${clip(input.url, 200)}`);
  const location = formatSourceLocation(source);
  if (location) lines.push(`Nearest source in the stack: ${location}`);
  if (input.reveal) {
    const selector = `<${input.reveal.tag}${input.reveal.id ? ` id="${input.reveal.id}"` : ''}>`;
    lines.push(`Element picked in the preview: ${selector} served from ${input.reveal.path}`);
  }
  if (stack) {
    lines.push('');
    lines.push('Stack:');
    lines.push(stack);
  }
  lines.push('');
  lines.push(
    'Change only what this error requires, keep the existing behaviour, and do not add mocks, ' +
      'placeholder data or new dependencies unless the fix genuinely needs one.'
  );

  const prompt = lines.join('\n');
  return prompt.length > maxChars ? `${prompt.slice(0, maxChars - 15).trimEnd()}\n...[truncated]` : prompt;
}

/** Stable key so the same error is not offered to the model twice in a row. */
export function errorSignature(message: string, stack?: string): string {
  const head = stripAnsi(message ?? '').trim().slice(0, 200);
  const firstFrame =
    stripAnsi(stack ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('at ')) ?? '';
  return `${head}|${firstFrame}`;
}

/**
 * Unwraps AggregateError (`.errors` getter arrays, empty `.message`), `.cause`,
 * and error `.code` strings into a single actionable diagnostic string.
 */
export function unwrapRuntimeError(error: unknown, depth = 0): string {
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (depth > 3) return error instanceof Error ? (error.message || error.name) : String(error);

  if (typeof error === 'object') {
    const record = error as { errors?: unknown; cause?: unknown; message?: unknown; code?: unknown; name?: unknown };
    let nestedErrors: unknown[] | null = null;
    try {
      if (Array.isArray(record.errors) && record.errors.length > 0) nestedErrors = record.errors;
    } catch {
      nestedErrors = null;
    }

    const headMsg = typeof record.message === 'string' && record.message.trim() ? record.message.trim() : '';
    const code = typeof record.code === 'string' && record.code.trim() ? record.code.trim() : '';

    if (nestedErrors) {
      const parts: string[] = [];
      const seen = new Set<string>();
      for (const item of nestedErrors.slice(0, 5)) {
        const text = unwrapRuntimeError(item, depth + 1).trim();
        if (text && !seen.has(text)) {
          seen.add(text);
          parts.push(text);
        }
      }
      if (parts.length > 0) {
        const joined = parts.join('; ');
        return headMsg && !joined.includes(headMsg) ? `${headMsg}: ${joined}` : joined;
      }
    }

    if (record.cause !== undefined) {
      const causeText = unwrapRuntimeError(record.cause, depth + 1).trim();
      if (headMsg && causeText && !headMsg.includes(causeText)) {
        return `${headMsg} (${causeText})`;
      }
      if (!headMsg && causeText) return causeText;
    }

    if (headMsg) {
      return code && !headMsg.includes(code) ? `${headMsg} (${code})` : headMsg;
    }
    if (code) return `${typeof record.name === 'string' && record.name ? record.name : 'Error'} (${code})`;
    if (error instanceof Error && error.name) return error.name;
  }

  return String(error);
}
