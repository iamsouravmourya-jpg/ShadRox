/**
 * Fill-in-the-middle completion primitives, shared by the /api/ai/fim route
 * and the editor ghost-text extension. Ported from Void's tab-completion
 * postprocessing, minus the VS Code plumbing.
 */

/** Chars of code kept before/after the caret when building the FIM prompt. */
export const FIM_PREFIX_CHARS = 8_000;
export const FIM_SUFFIX_CHARS = 3_000;

/** Hard cap on what a single ghost suggestion may contain. */
export const FIM_MAX_OUTPUT_CHARS = 600;

/** A ghost suggestion stays on one line so CodeMirror can render it inline. */
export const FIM_MAX_LINES = 3;

const STOP_MARKERS = ['<|', '```', '###', '// TODO'];

/**
 * Builds the two messages that ask a chat model to act as a completion engine.
 * Chat APIs do not speak FIM tokens natively, so the caret is marked with XML
 * tags the model can follow.
 */
export function buildFimMessages(prefix: string, suffix: string, language: string) {
  const head = prefix.slice(-FIM_PREFIX_CHARS);
  const tail = suffix.slice(0, FIM_SUFFIX_CHARS);
  return {
    systemInstruction:
      'You are a code completion engine. Output only the code that belongs at the caret, ' +
      'continuing the line exactly where the context stops. Never repeat code that is already ' +
      'present, never explain, never wrap the answer in markdown fences, and stop as soon as the ' +
      'current statement is complete.',
    prompt:
      `Language: ${language}\n\n<context-before>\n${head}\n</context-before>\n` +
      '<caret>\n<context-after>\n' + tail + '\n</context-after>\n\nCode at the caret:'
  };
}

/**
 * Longest overlap between the start of the completion and the text already at
 * the caret, so a model that re-types the suffix does not duplicate it.
 * Leading indentation is ignored: models commonly echo the suffix after it.
 */
export function suffixOverlapLength(completion: string, suffix: string): number {
  const head = completion.replace(/^[ \t]+/, '');
  const limit = Math.min(head.length, suffix.length, 120);
  for (let size = limit; size > 0; size -= 1) {
    if (head.startsWith(suffix.slice(0, size))) return size;
  }
  return 0;
}

/**
 * Turns a raw model reply into the ghost string to render: fences and prose
 * removed, cut at stop markers, deduplicated against the text after the caret,
 * limited to a few lines and the output cap.
 */
export function postprocessFimCompletion(raw: string, suffix: string): string {
  let text = raw.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '');
  for (const marker of STOP_MARKERS) {
    const index = text.indexOf(marker);
    if (index > -1) text = text.slice(0, index);
  }
  const overlap = suffixOverlapLength(text, suffix);
  if (overlap > 0) text = text.replace(/^[ \t]+/, '').slice(overlap);
  const lines = text.split('\n').slice(0, FIM_MAX_LINES);
  text = lines.join('\n');
  if (text.length > FIM_MAX_OUTPUT_CHARS) text = text.slice(0, FIM_MAX_OUTPUT_CHARS);
  return text.replace(/\s+$/, '');
}

/** Ghost text needs at least a character of code on the caret's line. */
export function isWorthCompleting(prefix: string): boolean {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  return /\S/.test(line) || /[({[."']/.test(prefix.slice(-1));
}
