import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsEffect, holdReplyApply, normalizePermissionMode, type ApplyHold, type ToolEffect } from './runPolicy';

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

test('ask and plan hold a reply write even when auto-apply is on', () => {
  for (const mode of ['ask', 'plan'] as const) {
    assert.equal(
      holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: false, permissionMode: mode }),
      'permission-mode',
      `${mode} must not write from a reply`
    );
  }
  assert.equal(
    holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: false, permissionMode: 'agent' }),
    'none'
  );
});

test('an open plan gate on an ask or plan turn still never writes', () => {
  const ask = holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: true, permissionMode: 'ask' });
  const plan = holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: true, permissionMode: 'plan' });
  assert.equal(ask, 'plan-approval');
  assert.equal(plan, 'plan-approval');
  // Whichever hold fires first, neither combination is allowed to reach 'none'.
  for (const awaitingPlanApproval of [true, false]) {
    for (const mode of ['ask', 'plan'] as const) {
      const hold: ApplyHold = holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval, permissionMode: mode });
      assert.notEqual(hold, 'none', `${mode}/${awaitingPlanApproval}`);
    }
  }
});

test('auto-apply off holds silently before any other decision', () => {
  for (const mode of ['ask', 'plan', 'agent'] as const) {
    for (const awaitingPlanApproval of [true, false]) {
      assert.equal(
        holdReplyApply({ autoApplyChanges: false, awaitingPlanApproval, permissionMode: mode }),
        'auto-apply-off',
        `${mode}/${awaitingPlanApproval}`
      );
    }
  }
});

test('only an agent turn with auto-apply and no plan gate writes by itself', () => {
  assert.equal(
    holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: false, permissionMode: 'agent' }),
    'none'
  );
});
