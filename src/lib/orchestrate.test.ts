import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideOrchestration, type OrchestrationInput } from './orchestrate';

function input(overrides: Partial<OrchestrationInput> = {}): OrchestrationInput {
  return {
    prompt: 'Refactor the authentication flow across the whole codebase and add tests for every route.',
    mode: 'code',
    permissionMode: 'agent',
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
    assert.equal(decideOrchestration(input({ permissionMode: 'team', hasKey: false })).kind, 'chat');
  });

  it('never escalates ask or plan mode, because those modes promise read-only', () => {
    assert.equal(decideOrchestration(input({ mode: 'plan' })).kind, 'chat');
    assert.equal(decideOrchestration(input({ mode: 'complex', permissionMode: 'ask' })).kind, 'chat');
    assert.equal(decideOrchestration(input({ mode: 'complex', permissionMode: 'plan' })).kind, 'chat');
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

describe('decideOrchestration strict mode routing', () => {
  it('never auto-escalates Agent mode to Specialist Team even with team/full-stack/multi-area keywords', () => {
    const multiArea = decideOrchestration(
      input({ prompt: 'Build the checkout page: frontend form, backend API, database migration and tests.' })
    );
    assert.equal(multiArea.kind, 'chat');

    const teamWords = decideOrchestration(
      input({ prompt: 'Use a team of agents to add Google sign-in full-stack end to end across frontend and backend.' })
    );
    assert.equal(teamWords.kind, 'chat');
  });

  it('keeps Agent mode (code) in the direct single-agent loop even for multi-file requests', () => {
    const decision = decideOrchestration(
      input({ prompt: 'Refactor the authentication flow across the whole codebase and add tests for every route.' })
    );
    assert.equal(decision.kind, 'chat');
  });

  it('routes to Specialist Team ONLY when permissionMode is explicitly team', () => {
    const decision = decideOrchestration(
      input({
        permissionMode: 'team',
        prompt: 'Implement the checkout flow across UI, API, and database schema.'
      })
    );
    assert.equal(decision.kind, 'team');
    assert.match(decision.reason, /Team mode selected/i);
  });

  it('routes complex mode substantive edits to autonomy without ever escalating to team', () => {
    const decision = decideOrchestration(
      input({ mode: 'complex', prompt: 'Migrate the session store to the new API client and wire tests.' })
    );
    assert.equal(decision.kind, 'autonomy');
    assert.match(decision.reason, /plan|milestones/);

    const withTeamProse = decideOrchestration(
      input({
        mode: 'complex',
        prompt: 'Use a team of specialists to build the frontend, backend API, and database schema.'
      })
    );
    assert.equal(withTeamProse.kind, 'autonomy');
  });

  it('keeps a one-file edit in chat', () => {
    assert.equal(
      decideOrchestration(input({ prompt: 'Add a loading spinner to the settings button.', workspaceFileCount: 12 }))
        .kind,
      'chat'
    );
  });
});
