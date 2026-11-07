import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsEffect, normalizePermissionMode, type ToolEffect } from './runPolicy';

const EFFECTS: ToolEffect[] = ['read', 'write', 'execute', 'external', 'control'];

test('control and read are allowed in every mode', () => {
  for (const mode of ['ask', 'plan', 'agent'] as const) {
    assert.equal(allowsEffect(mode, 'control'), true, `${mode} control`);
    assert.equal(allowsEffect(mode, 'read'), true, `${mode} read`);
  }
});

test('only agent mode allows the mutating effects', () => {
  for (const effect of ['write', 'execute', 'external'] as const) {
    assert.equal(allowsEffect('agent', effect), true, `agent ${effect}`);
    assert.equal(allowsEffect('ask', effect), false, `ask ${effect}`);
    assert.equal(allowsEffect('plan', effect), false, `plan ${effect}`);
  }
});

test('ask is the fail-closed default for anything unrecognized', () => {
  for (const value of [undefined, null, '', 'Ask', 'PLAN', 'yolo', 7, {}]) {
    assert.equal(normalizePermissionMode(value), 'ask', `value: ${String(value)}`);
  }
});

test('only the two explicit literals survive normalization', () => {
  assert.equal(normalizePermissionMode('plan'), 'plan');
  assert.equal(normalizePermissionMode('agent'), 'agent');
  assert.equal(normalizePermissionMode('ask'), 'ask');
});

test('every mode makes a decision for every effect (no undefined behavior)', () => {
  for (const mode of ['ask', 'plan', 'agent'] as const) {
    for (const effect of EFFECTS) {
      assert.equal(typeof allowsEffect(mode, effect), 'boolean', `${mode}/${effect}`);
    }
  }
});
