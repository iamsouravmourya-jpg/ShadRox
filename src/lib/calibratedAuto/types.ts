export type CalibratedTaskType = 'refactor' | 'bugfix' | 'feature' | 'test' | 'chat';
export type CalibratedRoute = 'reader' | 'writer' | 'frontier';

export interface OutcomeRecord {
  id: string;
  createdAt: number;
  taskType: CalibratedTaskType;
  route: CalibratedRoute;
  model: string;
  passed: boolean;
  repairIterations: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  verified: boolean;
}

export interface RouteProfile {
  route: CalibratedRoute;
  attempts: number;
  passRate: number;
  averageRepairs: number;
  averageLatencyMs: number;
  averageTokens: number;
  score: number;
}
