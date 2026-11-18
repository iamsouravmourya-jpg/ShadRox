import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestEnvelope, describeEnvelopeDrift, envelopeDrift, type RequestEnvelopeInput } from './requestEnvelope';

const base: RequestEnvelopeInput = {
  id: 'request-1',
  workspaceId: 'ws-1',
  prompt: 'fix the bug in a.ts',
  targets: ['src/a.ts'],
  permissionMode: 'agent',
  refineMode: 'code',
  provider: 'groq',
  model: 'glm-4.7-flash'
};

test('a request with nothing changed cannot drift', () => {
  const frozen = createRequestEnvelope(base);
  const current = createRequestEnvelope({ ...base, id: 'request-2' });
  assert.deepEqual(envelopeDrift(frozen, current), []);
  assert.equal(describeEnvelopeDrift([]), '');
});

test('the target list is copied, not aliased to the caller array', () => {
  const targets = ['src/a.ts'];
  const frozen = createRequestEnvelope({ ...base, targets });
  targets.push('src/b.ts');
  assert.deepEqual(frozen.targets, ['src/a.ts']);
});

test('switching workspace or model is reported as drift', () => {
  const frozen = createRequestEnvelope(base);
  const current = createRequestEnvelope({ ...base, workspaceId: 'ws-2', model: 'other-model' });
  assert.deepEqual(envelopeDrift(frozen, current), ['workspace', 'model']);
});

test('provider and permission changes are detected', () => {
  const frozen = createRequestEnvelope(base);
  const current = createRequestEnvelope({ ...base, provider: 'gemini', permissionMode: 'plan' });
  assert.deepEqual(envelopeDrift(frozen, current), ['provider', 'permission']);
});

test('drift is described in plain language for the user', () => {
  const frozen = createRequestEnvelope(base);
  const current = createRequestEnvelope({ ...base, model: 'other-model' });
  assert.match(describeEnvelopeDrift(envelopeDrift(frozen, current)), /model changed/);
});

test('a null workspace compares equal to a null workspace', () => {
  const frozen = createRequestEnvelope({ ...base, workspaceId: null });
  const current = createRequestEnvelope({ ...base, workspaceId: null });
  assert.deepEqual(envelopeDrift(frozen, current), []);
});

test('an old persisted payload with extra billing fields still builds cleanly', () => {
  const legacy = { ...base, payer: 'shared', budgetCredits: 40 } as RequestEnvelopeInput;
  const envelope = createRequestEnvelope(legacy);
  assert.equal('payer' in envelope, false);
  assert.equal('budgetCredits' in envelope, false);
  assert.deepEqual(envelopeDrift(envelope, createRequestEnvelope(base)), []);
});
