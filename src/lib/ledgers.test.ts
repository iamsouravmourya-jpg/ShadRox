import test from 'node:test';
import assert from 'node:assert/strict';
import { ProofLedger } from './proofLedger';
import { SpendLedger } from './spendLedger';
import { resolveModelMetadata, KNOWN_MODELS_CATALOG } from './modelMetadata';
import { createFailureReceipt } from './repairProof';

test('ProofLedger records and summarizes milestone proofs and healing receipts', () => {
  const ledger = new ProofLedger();

  ledger.recordMilestoneProof({
    id: 'proof-m1',
    milestoneId: 'm1',
    title: 'Setup DB schema',
    verifiedAt: Date.now(),
    verdict: 'passed',
    diagnosticsCount: 0
  });

  ledger.recordMilestoneProof({
    id: 'proof-m2',
    milestoneId: 'm2',
    title: 'Run test suite',
    verifiedAt: Date.now(),
    verdict: 'failed',
    diagnosticsCount: 2
  });

  const failure = createFailureReceipt({
    source: 'test',
    target: 'npm test',
    errorMessage: 'Syntax Error'
  });
  ledger.recordFailureReceipt(failure);

  const summary = ledger.getSummary();
  assert.equal(summary.totalMilestonesVerified, 2);
  assert.equal(summary.passedMilestones, 1);
  assert.equal(summary.failedMilestones, 1);
  assert.equal(summary.totalFailuresCaptured, 1);
  assert.equal(summary.totalHealed, 0);

  // Mark healed
  failure.status = 'verified_healed';
  ledger.updateFailureReceipt(failure);
  assert.equal(ledger.getSummary().totalHealed, 1);
  assert.equal(ledger.getSummary().healingSuccessRate, 1);
});

test('SpendLedger calculates prompt spend, cached token savings, and hit ratio', () => {
  const ledger = new SpendLedger();

  // 100,000 prompt tokens total, 80,000 cached (80% hit rate)
  ledger.recordTurnSpend({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    promptTokens: 100_000,
    cachedTokens: 80_000,
    completionTokens: 2_000,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.60,
    cacheReadPricePerMillion: 0.0375
  });

  const summary = ledger.getSummary();
  assert.equal(summary.totalPromptTokens, 100_000);
  assert.equal(summary.totalCachedTokens, 80_000);
  assert.equal(summary.totalCompletionTokens, 2_000);
  assert.ok(summary.cacheSavingsUsd > 0, 'Should have positive cache savings');
  assert.ok(summary.totalCostUsd > 0);
  assert.equal(summary.cacheHitRatio, 0.44); // 80k / 180k
});

test('resolveModelMetadata normalizes known models and falls back cleanly for unknown models', () => {
  const gemini = resolveModelMetadata('gemini-2.5-flash');
  assert.equal(gemini.provider, 'gemini');
  assert.equal(gemini.supportsPromptCache, true);
  assert.equal(gemini.contextWindow, 1_048_576);

  const gpt = resolveModelMetadata('gpt-4o');
  assert.equal(gpt.provider, 'openai');
  assert.equal(gpt.supportsPromptCache, true);

  const custom = resolveModelMetadata('unrecognized-custom-llm');
  assert.equal(custom.provider, 'custom');
  assert.equal(custom.supportsPromptCache, false);
  assert.equal(custom.id, 'unrecognized-custom-llm');
});
