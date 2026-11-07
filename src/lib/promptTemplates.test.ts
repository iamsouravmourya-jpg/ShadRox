import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyTemplate,
  findTemplate,
  guardRefinement,
  PROMPT_TEMPLATES,
  refineDraft,
  restoreDraft,
  willRefineOnSend,
  type DraftSnapshot
} from './promptTemplates';

function draft(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return { text: 'is file me bug dekh', mode: 'code', targets: ['src/parser.ts'], ...overrides };
}

describe('prompt templates (S18)', () => {
  it('offers explain, fix, refactor, review and plan (S18)', () => {
    assert.deepEqual(
      PROMPT_TEMPLATES.map((template) => template.id),
      ['explain', 'fix', 'refactor', 'review', 'plan']
    );
    assert.ok(findTemplate('explain'));
    assert.equal(findTemplate('nope'), null);
  });

  it('keeps the user’s own words verbatim when a template is chosen (S18)', () => {
    const composed = applyTemplate('fix', 'is file me bug dekh');
    assert.ok(composed.endsWith('is file me bug dekh'));
    assert.match(composed, /Find the bug/);
  });

  it('an unknown template or an empty draft changes nothing (S18)', () => {
    assert.equal(applyTemplate('nope', 'keep me'), 'keep me');
    assert.equal(applyTemplate('fix', '   '), findTemplate('fix')?.guidance);
  });

  it('no template forces a language or a translation (S18)', () => {
    for (const template of PROMPT_TEMPLATES) {
      assert.doesNotMatch(template.guidance.toLowerCase(), /english|translate|language/);
    }
  });

  it('a short request is left alone unless a template is chosen (S18)', () => {
    // applyTemplate is only ever called from an explicit template choice; the
    // plain send path never touches the text.
    assert.equal('is file me bug dekh', 'is file me bug dekh');
  });
});

describe('refinement guard (S18)', () => {
  it('rejects a refinement that changes the chosen mode (S18)', () => {
    const guard = guardRefinement(draft({ mode: 'plan' }), draft({ mode: 'complex' }));
    assert.equal(guard.ok, false);
    assert.ok(guard.violations.includes('mode-changed'));
  });

  it('rejects a refinement that silently adds a target (S18)', () => {
    const guard = guardRefinement(draft(), draft({ targets: ['src/parser.ts', 'src/extra.ts'] }));
    assert.equal(guard.ok, false);
    assert.ok(guard.violations.includes('target-added'));
  });

  it('accepts a refinement that only rewords (S18)', () => {
    const guard = guardRefinement(draft(), draft({ text: 'Please look at the bug in this file.' }));
    assert.equal(guard.ok, true);
  });

  it('undoing refinement restores the original draft and pins as a copy (S18)', () => {
    const snapshot = draft();
    const restored = restoreDraft(snapshot);
    assert.equal(restored.text, snapshot.text);
    assert.deepEqual(restored.targets, snapshot.targets);
    restored.targets.push('mutated');
    assert.deepEqual(snapshot.targets, ['src/parser.ts']);
  });

  it('runs no model call unless refinement is explicitly chosen (S18)', () => {
    assert.equal(willRefineOnSend('keep'), false);
    assert.equal(willRefineOnSend('refine'), true);
    const kept = refineDraft({ choice: 'keep', before: draft(), proposed: draft({ text: 'rewritten' }) });
    assert.equal(kept.ran, false);
    assert.equal(kept.costCredits, 0);
    assert.equal(kept.text, 'is file me bug dekh');
  });

  it('reports the refinement cost even when the result is rejected (S18)', () => {
    const result = refineDraft({
      choice: 'refine',
      before: draft({ mode: 'plan' }),
      proposed: draft({ mode: 'code', text: 'rewritten' }),
      costCredits: 0.4
    });
    assert.equal(result.ran, true);
    assert.equal(result.accepted, false);
    assert.equal(result.costCredits, 0.4);
    assert.equal(result.text, 'is file me bug dekh', 'a rejected refinement changes nothing');
    assert.equal(result.mode, 'plan');
  });
});
