import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowsEffect,
  classifyTurnIntent,
  holdReplyApply,
  normalizePermissionMode,
  shouldGatePlanApproval,
  type ApplyHold,
  type ToolEffect
} from './runPolicy';

const EFFECTS: ToolEffect[] = ['read', 'write', 'execute', 'external', 'control'];

test('control and read are allowed in every mode', () => {
  for (const mode of ['ask', 'plan', 'agent', 'team'] as const) {
    assert.equal(allowsEffect(mode, 'control'), true, `${mode} control`);
    assert.equal(allowsEffect(mode, 'read'), true, `${mode} read`);
  }
});

test('only agent and team modes allow the mutating effects', () => {
  for (const effect of ['write', 'execute', 'external'] as const) {
    assert.equal(allowsEffect('agent', effect), true, `agent ${effect}`);
    assert.equal(allowsEffect('team', effect), true, `team ${effect}`);
    assert.equal(allowsEffect('ask', effect), false, `ask ${effect}`);
    assert.equal(allowsEffect('plan', effect), false, `plan ${effect}`);
  }
});

test('ask is the fail-closed default for anything unrecognized', () => {
  for (const value of [undefined, null, '', 'Ask', 'PLAN', 'yolo', 7, {}]) {
    assert.equal(normalizePermissionMode(value), 'ask', `value: ${String(value)}`);
  }
});

test('only the explicit literals survive normalization', () => {
  assert.equal(normalizePermissionMode('plan'), 'plan');
  assert.equal(normalizePermissionMode('agent'), 'agent');
  assert.equal(normalizePermissionMode('team'), 'team');
  assert.equal(normalizePermissionMode('ask'), 'ask');
});

test('every mode makes a decision for every effect (no undefined behavior)', () => {
  for (const mode of ['ask', 'plan', 'agent', 'team'] as const) {
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
  assert.equal(
    holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: false, permissionMode: 'team' }),
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
  for (const mode of ['ask', 'plan', 'agent', 'team'] as const) {
    for (const awaitingPlanApproval of [true, false]) {
      assert.equal(
        holdReplyApply({ autoApplyChanges: false, awaitingPlanApproval, permissionMode: mode }),
        'auto-apply-off',
        `${mode}/${awaitingPlanApproval}`
      );
    }
  }
});

test('only an agent or team turn with auto-apply and no plan gate writes by itself', () => {
  assert.equal(
    holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: false, permissionMode: 'agent' }),
    'none'
  );
  assert.equal(
    holdReplyApply({ autoApplyChanges: true, awaitingPlanApproval: false, permissionMode: 'team' }),
    'none'
  );
});

test('shouldGatePlanApproval never gates agent or team turns, even with many steps and files', () => {
  assert.equal(shouldGatePlanApproval('agent', 12, 8), false);
  assert.equal(shouldGatePlanApproval('team', 12, 8), false);
  assert.equal(shouldGatePlanApproval('ask', 3, 1), true);
  assert.equal(shouldGatePlanApproval('plan', 1, 2), true);
  assert.equal(shouldGatePlanApproval('ask', 2, 1), false);
});

test('code and framework questions without file extensions route to advisory instead of conversational', () => {
  assert.equal(classifyTurnIntent({ prompt: 'what is a closure?', workspaceOpen: true }).kind, 'conversational');
  for (const prompt of [
    'why does my React effect run twice?',
    'how do hooks re-render in Next.js?',
    'why is my useEffect firing on mount?'
  ]) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.equal(intent.kind, 'advisory', `Expected advisory for "${prompt}"`);
    assert.equal(intent.writesFiles, false);
    assert.equal(intent.skipVerify, true);
  }
});

test('exploration and mutation combinations always route to execution', () => {
  for (const prompt of [
    'find and fix the auth bug',
    'check and update the header',
    'inspect and patch server.ts',
    'scan and add error handling'
  ]) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.equal(intent.kind, 'execution', `Expected execution for "${prompt}"`);
    assert.equal(intent.writesFiles, true);
  }
});

test('Hinglish and English conversational meta follow-ups route to conversational zero-tool fast-path', () => {
  for (const prompt of [
    'kyu nhi kar raha hai',
    'pehle kyu nahi kiya?',
    'ab jakar hua',
    'why didn\'t you do that earlier?',
    'what were you doing?'
  ]) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.equal(intent.kind, 'conversational', `Expected conversational for "${prompt}"`);
    assert.equal(intent.enabledBundles.size, 0);
    assert.equal(intent.writesFiles, false);
  }

  // Follow-up containing concrete file/stack cues still stays in execution/advisory
  const concrete = classifyTurnIntent({ prompt: 'kyu nhi kar raha hai server.ts ko fix?', workspaceOpen: true });
  assert.notEqual(concrete.kind, 'conversational');
});

test('explicit subagent or scout cues unlock interaction bundle for spawn_subagent', () => {
  for (const prompt of [
    'use subagents to scan auth and billing',
    'spawn_subagent on src/hooks',
    'run 2 scouts in parallel to inspect routes'
  ]) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.ok(intent.enabledBundles.has('interaction'), `Expected interaction bundle for "${prompt}"`);
  }
});
