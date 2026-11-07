export type AttemptRole = 'answer' | 'reader' | 'planner' | 'repair' | 'refine' | 'tab' | 'tool-round';

export type AttemptState = 'completed' | 'incomplete' | 'failed' | 'cancelled' | 'pending';

export type UsageSource = 'provider' | 'estimated' | 'unknown';

export interface AttemptRecord {
  taskId: string;
  attemptId: string;
  role: AttemptRole;
  provider: string;
  requestedModel: string;
  servedModel?: string | null;
  state: AttemptState;
  usageSource: UsageSource;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  durationMs?: number | null;
  startedAt: number;
  reason?: string;
}

export function unknownAttemptUsage(): Pick<AttemptRecord, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'usageSource'> {
  return { inputTokens: null, outputTokens: null, cachedInputTokens: null, usageSource: 'unknown' };
}

export function sumAttemptTokens(attempts: readonly AttemptRecord[]): { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; complete: boolean } {
  let input = 0;
  let output = 0;
  let cached = 0;
  let complete = true;
  for (const attempt of attempts) {
    if (attempt.inputTokens === null || attempt.outputTokens === null) {
      complete = false;
      continue;
    }
    input += attempt.inputTokens;
    output += attempt.outputTokens;
    cached += attempt.cachedInputTokens ?? 0;
  }
  return complete
    ? { inputTokens: input, outputTokens: output, cachedInputTokens: cached, complete }
    : { inputTokens: null, outputTokens: null, cachedInputTokens: null, complete };
}