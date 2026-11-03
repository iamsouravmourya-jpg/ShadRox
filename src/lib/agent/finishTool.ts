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
    + 'Calling finish ends the turn: emit no tool call after it and never call finish twice. If you could not complete the '
    + 'work, call finish anyway and put the one-line reason in "blocked" so the user sees what stopped you.';
}
