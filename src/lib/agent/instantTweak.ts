/**
 * Instant tweaks (N4): the fast path for a small, concrete edit to the open
 * file — a rename, a typo, a format/whitespace pass, a one-line change. These
 * are the asks a cheap model answers in ONE pass with a focused prompt and no
 * tool loop, so they cost a fraction of a full agent turn.
 *
 * This module is the pure half: it decides whether a request qualifies and
 * builds the focused system prompt. The caller (the chat controller) resolves
 * the active file's bytes, picks the cheap model, streams once, and applies the
 * reply's edit fences through the normal patch engine. Nothing here reads the
 * disk or calls a model.
 */

/** The verbs that mark a request as a small, local edit rather than a question
 *  or a multi-step task. Deliberately narrow so "explain this function" or
 *  "add a whole new page" never take the cheap one-shot path. */
const TWEAK_VERBS =
  /\b(rename|typo|format|reformat|whitespace|indent(?:ation)?|comment|docstring|simplify|shorten|clarify|fix|change|replace|remove|delete|add|update|tweak|clean\s*up)\b/i;

/** A request longer than this (chars or words) is a real task, not a tweak. */
const MAX_TWEAK_CHARS = 200;
const MAX_TWEAK_WORDS = 40;

export interface InstantTweakInput {
  /** The user's instruction text. */
  text: string;
  /** The turn's mode allows file writes. */
  writesFiles: boolean;
  /** An editor file is open and its bytes are available. */
  hasActiveFile: boolean;
}

/**
 * Whether this request should take the one-shot cheap-model tweak path.
 *
 * Conservative on purpose: a tweak must be a SHORT, write-mode request against
 * an open file whose wording names a local edit. Anything with a code fence, a
 * question shape, or task-sized length falls through to the normal turn so a
 * cheap model is never trusted with work it cannot do in one pass.
 */
export function isInstantTweakCandidate(input: InstantTweakInput): boolean {
  const text = input.text.trim();
  if (!text || !input.writesFiles || !input.hasActiveFile) return false;
  if (text.length > MAX_TWEAK_CHARS) return false;
  if (text.split(/\s+/).length > MAX_TWEAK_WORDS) return false;
  if (text.includes('```')) return false;
  // A question is a request for information, not an edit.
  if (/[?]\s*$/.test(text) || /^(what|why|how|explain|describe|where|is|are|does|do|can you explain)\b/i.test(text)) {
    return false;
  }
  return TWEAK_VERBS.test(text);
}

/**
 * The focused system prompt for a one-shot tweak. It carries the edit-fence
 * protocol (the same SEARCH/REPLACE + full-file blocks the patch engine reads)
 * and forbids tools and prose-only answers, so the single streamed reply is
 * directly applicable. The active file's content is supplied separately by the
 * caller as the user turn.
 */
export function buildInstantTweakSystemPrompt(activeFileName: string | null): string[] {
  const target = activeFileName ?? 'the active file';
  return [
    'ONE-SHOT EDIT MODE — make exactly the change the user asked for and nothing else.',
    `You are editing a single open file: ${target}. Its current contents are provided below.`,
    'Do NOT use tools and do NOT ask questions. Reply with ONLY the edit, then stop.',
    'For a small change, emit one SEARCH/REPLACE block, copying the ORIGINAL lines verbatim (same whitespace) so they match exactly one place:',
    '```path=' + target,
    '<<<<<<< ORIGINAL',
    '// the exact current lines being replaced',
    '=======',
    '// the replacement lines',
    '>>>>>>> UPDATED',
    '```',
    'To rewrite the whole file, emit a single fenced block with the COMPLETE new contents instead:',
    '```' + (target.split('.').pop() || 'txt') + ' path=' + target,
    '// full file contents, nothing omitted',
    '```',
    'Never restate the whole file for a small change, never leave placeholders like "// rest unchanged", and never wrap the block in extra prose.'
  ];
}