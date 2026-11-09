import type { AcceptanceContract, BehaviorEvent } from './types';
import { eventLabel } from './recorder';

export function generateAcceptanceContract(events: readonly BehaviorEvent[]): AcceptanceContract | null {
  if (events.length === 0) return null;
  const target = events.find((event) => event.path) ?? events[0];
  const failure = events.find((event) => event.type === 'error');
  const steps = events.slice(0, 20).map(eventLabel);
  return {
    id: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    target: {
      path: target.path,
      line: target.line,
      label: target.target
    },
    observedFailure: failure?.message ?? 'The recorded interaction did not produce the expected result.',
    expectedBehavior: target.type === 'click'
      ? `${target.target} should respond to the click without a runtime error.`
      : 'The interaction should complete successfully.',
    steps,
    baseline: failure ? 'failed' : 'unverified',
    postPatch: 'unverified',
    events: [...events]
  };
}

export function updateContractVerification(
  contract: AcceptanceContract,
  phase: 'baseline' | 'postPatch',
  result: 'failed' | 'passed'
): AcceptanceContract {
  return phase === 'baseline'
    ? { ...contract, baseline: result }
    : { ...contract, postPatch: result };
}
