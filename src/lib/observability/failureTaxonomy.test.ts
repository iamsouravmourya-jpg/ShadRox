import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlightEvent } from './flightRecorder';
import {
  categorizeFailure,
  categorizeFailureText,
  categoryForTag,
  classifyFailure,
  FAILURE_CATEGORY_LABELS,
  type FailureCategory
} from './failureTaxonomy';

const ev = (type: string, data: Record<string, unknown>, seq: number): FlightEvent => ({
  type,
  data,
  seq
} as unknown as FlightEvent);

test('categoryForTag maps each F-code onto a Black Box category', () => {
  const cases: Array<[Parameters<typeof classifyFailure>[0], string | undefined, FailureCategory]> = [
    [[ev('tool_result', { status: 'error', error: 'not valid JSON' }, 1)], undefined, 'bad_tool_json'],
    [[ev('tool_result', { status: 'error', error: 'original snippet was not found' }, 1)], undefined, 'edit_anchor_miss'],
    [[ev('stop', { reason: 'stuck' }, 2)], 'stuck', 'loop'],
    [[ev('verify_result', { ok: false }, 1), ev('command_finished', { exit: 0 }, 2)], undefined, 'verification_false_fail'],
    [[ev('provider_error', { code: 'Timeout' }, 1)], undefined, 'provider_error'],
    [[ev('tool_result', { status: 'error', error: 'mode does not allow write' }, 1)], undefined, 'other']
  ];
  for (const [events, reason, expected] of cases) {
    const tag = classifyFailure(events);
    assert.ok(tag, 'a failed run yields a tag');
    assert.equal(categoryForTag(tag!, reason), expected);
  }
});

test('categorizeFailure reads the category straight from events (loop via stop reason)', () => {
  assert.equal(categorizeFailure([ev('stop', { reason: 'complete' }, 1)]), null, 'a clean run has no category');
  assert.equal(
    categorizeFailure([ev('tool_result', { status: 'ok', tool: 'read_file' }, 1), ev('stop', { reason: 'stuck' }, 2)]),
    'loop'
  );
  assert.equal(
    categorizeFailure([ev('tool_result', { status: 'error', error: 'appears more than once' }, 1)]),
    'edit_anchor_miss'
  );
});

test('categorizeFailureText classifies from a stop reason and error text alone', () => {
  assert.equal(categorizeFailureText('stuck'), 'loop');
  assert.equal(categorizeFailureText('provider_error'), 'provider_error');
  assert.equal(categorizeFailureText('complete', 'original snippet was not found'), 'edit_anchor_miss');
  assert.equal(categorizeFailureText('complete', 'incomplete or invalid JSON'), 'bad_tool_json');
  assert.equal(categorizeFailureText(null, 'something odd happened'), 'other');
});

test('every category has a human label', () => {
  for (const category of Object.keys(FAILURE_CATEGORY_LABELS) as FailureCategory[]) {
    assert.ok(FAILURE_CATEGORY_LABELS[category].length > 0, `${category} is labelled`);
  }
});