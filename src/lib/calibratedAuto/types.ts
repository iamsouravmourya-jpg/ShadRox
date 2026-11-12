export type CalibratedTaskType = 'refactor' | 'bugfix' | 'feature' | 'test' | 'chat';
export type CalibratedRoute = 'reader' | 'writer' | 'frontier';

export interface OutcomeRecord {
  id: string;
  createdAt: number;
  taskType: CalibratedTaskType;
  route: CalibratedRoute;
  model: string;
  /**
   * Decided from evidence by `outcomeOfTurn`, never by the caller: a check ran
   * and came back clean. A turn with no check is `passed: true, verified: false`
   * only when it wrote nothing — an answer nobody graded.
   */
  passed: boolean;
  /**
   * True only when something outside the model examined the result: a test
   * exit code, the verification card, or post-apply diagnostics.
   */
  verified: boolean;
  /** What decided the two fields above, kept so a record can be audited. */
  reason: string;
  repairIterations: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface RouteProfile {
  route: CalibratedRoute;
  /** Every turn logged for this route, checked or not. */
  attempts: number;
  /** Turns a check actually examined — the only ones a rate may be drawn from. */
  verifiedAttempts: number;
  unverifiedAttempts: number;
  /**
   * Shrunk toward the neutral prior, so three lucky runs do not outrank thirty
   * proven ones. Null when nothing was verified: no rate, no opinion.
   */
  passRate: number | null;
  averageRepairs: number;
  averageLatencyMs: number;
  averageTokens: number;
  score: number | null;
}

export interface ModelPerformance {
  model: string;
  taskType: CalibratedTaskType;
  verifiedAttempts: number;
  provenPasses: number;
  /** `provenPasses` shrunk toward the pool prior; null with no verified runs. */
  passRate: number | null;
  averageRepairs: number;
  /** Human-readable basis for the ranking position. */
  reason: string;
}
