export const FINISH_TOOL_NAME = 'finish';

export interface FinishArguments {
  summary: string;
  blocked: string | null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

export function parseFinishArguments(raw: unknown): FinishArguments | null {
  if (typeof raw === 'string') {
    const summary = asText(raw);
    return summary ? { summary, blocked: null } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const args = raw as Record<string, unknown>;
  const summary = firstText(args.summary, args.answer, args.result);
  if (!summary) return null;
  return { summary, blocked: firstText(args.blocked, args.reason) };
}

export function describeFinish(): string {
  return 'FINISHING THE TURN: a turn ends with the finish tool, not with prose. When the work is done, send one last '
    + 'shadrox:tools block holding {"name":"finish","args":{"summary":"what you did and what the user should check"}}. '
    + 'The summary becomes the answer the user reads, so write it as an answer and name the files you touched. '
    + 'Optional fields make the answer honest: "files_changed" (array of paths), "verified" (true only after verify/problems/build/test actually ran and you saw the result), '
    + '"could_not_do" (what you left undone) and "how_to_test" (one line the user can run or click). '
    + 'Calling finish ends the turn: emit no tool call after it and never call finish twice. If you could not complete the '
    + 'work, call finish anyway and put the one-line reason in "blocked" so the user sees what stopped you.';
}

/* ------------------------------------------------------------------ *
 * Structured finish: the legacy {summary, blocked} parser above stays
 * byte-compatible; the details parser adds the honesty fields and the
 * renderer turns them into the text the user reads.
 * ------------------------------------------------------------------ */

export interface FinishDetails {
  summary: string;
  blocked: string | null;
  filesChanged: string[] | null;
  /** null = the model did not say; the loop resolves it from real verification. */
  verified: boolean | null;
  couldNotDo: string | null;
  howToTest: string | null;
}

function asStringList(value: unknown): string[] | null {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return null;
  const list = value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim());
  return list.length > 0 ? list : null;
}

export function parseFinishDetails(raw: unknown): FinishDetails | null {
  const base = parseFinishArguments(raw);
  if (!base) return null;
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const verifiedRaw = args.verified;
  return {
    summary: base.summary,
    blocked: base.blocked,
    filesChanged: asStringList(args.files_changed ?? args.filesChanged),
    verified: typeof verifiedRaw === 'boolean' ? verifiedRaw : null,
    couldNotDo: firstText(args.could_not_do, args.couldNotDo),
    howToTest: firstText(args.how_to_test, args.howToTest)
  };
}

export interface FinishResolution {
  /** What the turn's actual verification state says, after the loop's gate. */
  verified: boolean;
  /** Paths the turn really changed on disk (the model's list is merged in). */
  filesChanged: string[];
  /** A documentation-only turn: no build/test applies, and the summary says so. */
  docsOnly: boolean;
}

/**
 * The user-readable finish text. A plain summary with nothing to add stays
 * plain — decoration only appears when there is something honest to say.
 * verified=false is ALWAYS visible in the text, never just a flag.
 */
export function renderFinishSummary(details: FinishDetails, resolution: FinishResolution): string {
  const lines = [details.summary];
  const files = [...new Set([...resolution.filesChanged, ...(details.filesChanged ?? [])])];
  if (files.length > 0) lines.push(`Files changed: ${files.join(', ')}`);
  if (!resolution.verified) {
    lines.push(resolution.docsOnly
      ? 'NOT VERIFIED: documentation-only turn — no build/test verification applies.'
      : 'NOT VERIFIED: no successful check ran after the last change. Treat the result as unconfirmed.');
  }
  if (details.couldNotDo) lines.push(`Could not do: ${details.couldNotDo}`);
  if (details.howToTest) lines.push(`How to test: ${details.howToTest}`);
  if (details.blocked) lines.push(`Blocked: ${details.blocked}`);
  return lines.join('\n');
}
