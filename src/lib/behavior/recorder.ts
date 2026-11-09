import type { BehaviorEvent, BehaviorEventType } from './types';

const MAX_EVENTS = 100;
const MAX_TEXT = 240;

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) || null;
}

export function createBehaviorEvent(
  type: BehaviorEventType,
  input: Partial<Omit<BehaviorEvent, 'id' | 'type' | 'timestamp'>>
): BehaviorEvent {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    timestamp: Date.now(),
    target: clean(input.target) ?? 'preview',
    path: clean(input.path),
    line: typeof input.line === 'number' && Number.isFinite(input.line) ? Math.max(1, Math.floor(input.line)) : null,
    value: clean(input.value),
    message: clean(input.message)
  };
}

export function appendBehaviorEvent(events: readonly BehaviorEvent[], event: BehaviorEvent): BehaviorEvent[] {
  return [...events, event].slice(-MAX_EVENTS);
}

export function eventLabel(event: BehaviorEvent): string {
  if (event.type === 'click') return `Click ${event.target}`;
  if (event.type === 'input') return `Input in ${event.target}`;
  if (event.type === 'route') return `Navigate to ${event.target}`;
  return `Runtime error: ${event.message ?? 'unknown error'}`;
}
