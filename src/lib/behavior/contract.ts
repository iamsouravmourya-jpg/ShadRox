import type { AcceptanceContract, AcceptancePhase, BehaviorEvent } from './types';
import { eventLabel } from './recorder';

const unverified = (): AcceptancePhase => ({ result: 'unverified', evidence: null });

/**
 * A contract is a promise to check, not a result.
 *
 * Both phases start `unverified` with no evidence: the only way either can move
 * is `recordContractEvidence`, which takes a verdict the preview harness
 * returned. The generated text describes what was recorded, so it is a lead for
 * the human — nothing downstream treats it as proof that anything is broken.
 */
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
    probe: { selectors: [] },
    baseline: unverified(),
    postPatch: unverified(),
    events: [...events]
  };
}
