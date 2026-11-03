import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideOrchestration, type OrchestrationInput } from './orchestrate';

function input(overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
  return {
    prompt: 'Refactor the authentication flow across the whole codebase and add tests for every route.',
    mode: 'code',
    workspaceFileCount: 40,
    hasKey: true,
    canRun: true,
    busy: false,
    ...overrides
  };
}

describe('decideOrchestration guard rails', () => {
  it('stays chat without a key, workspace or while busy', () => {
    assert.equal(decideOrchestration(input({ hasKey: false })).kind, 'chat');
    assert.equal(decideOrchestration(input({ canRun: false })).kind, 'chat');
    assert.equal(decideOrchestration(input({ busy: true })).kind, 'chat');
  });

  it('never escalates plan mode, because that mode promises read-only', () => {
    assert.equal(decideOrchestration(input({ mode: 'plan' })).kind, 'chat');
  });

  it('keeps short requests and explicit no-edit requests in chat', () => {
    assert.equal(decideOrchestration(input({ prompt: 'fix this' })).kind, 'chat');
    assert.equal(
      decideOrchestration(input({ prompt: 'Explain the auth flow across the whole codebase, do not edit anything.' }))
        .kind,
      'chat'
    );
  });

  it('keeps a long question a question', () => {
    assert.equal(
      decideOrchestration(input({ prompt: 'How does the authentication flow work across the whole codebase today?' }))
        .kind,
      'chat'
    );
  });
});

describe('decideOrchestration escalation', () => {
  it('sends multi-area work to the team', () => {
    const decision = decideOrchestration(
      input({ prompt: 'Build the checkout page: frontend form, backend API, database migration and tests.' })
    );
    assert.equal(decision.kind, 'team');
    assert.match(decision.reason, /frontend|backend|database|tests/);
  });

  it('sends an explicitly requested team to the team', () => {
    const decision = decideOrchestration(input({ prompt: 'Use a team of agents to add Google sign-in end to end.' }));
    assert.equal(decision.kind, 'team');
    assert.match(decision.reason, /specialists|coordinator/);
  });

  it('sends a broad multi-step change to an autonomous run', () => {
    const decision = decideOrchestration(
      input({ prompt: 'Refactor the authentication flow across the whole codebase and add tests for every route.' })
    );
    assert.equal(decision.kind, 'autonomy');
    assert.match(decision.reason, /plan|milestones/);
  });

  it('lets complex mode escalate a smaller but real edit', () => {
    const decision = decideOrchestration(
      input({ mode: 'complex', prompt: 'Migrate the session store to the new API client.' })
    );
    assert.equal(decision.kind, 'autonomy');
  });

  it('keeps a one-file edit in chat', () => {
    assert.equal(
      decideOrchestration(input({ prompt: 'Add a loading spinner to the settings button.', workspaceFileCount: 12 }))
        .kind,
      'chat'
    );
  });

  it('does not move a small workspace to autonomy without a broad scope', () => {
    assert.equal(
      decideOrchestration(
        input({
          prompt: 'Implement the new API client and wire the settings page to it.',
          workspaceFileCount: 3
        })
      ).kind,
      'chat'
    );
  });
});
