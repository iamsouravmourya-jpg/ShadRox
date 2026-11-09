export type BehaviorEventType = 'click' | 'input' | 'route' | 'error';

export interface BehaviorEvent {
  id: string;
  type: BehaviorEventType;
  timestamp: number;
  target: string;
  path: string | null;
  line: number | null;
  value: string | null;
  message: string | null;
}

export interface AcceptanceContract {
  id: string;
  createdAt: number;
  target: { path: string | null; line: number | null; label: string };
  observedFailure: string;
  expectedBehavior: string;
  steps: string[];
  baseline: 'unverified' | 'failed' | 'passed';
  postPatch: 'unverified' | 'failed' | 'passed';
  events: BehaviorEvent[];
}
