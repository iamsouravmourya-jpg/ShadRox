import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SharedAdmissionGate, type SharedAdmissionInput } from './sharedAdmission';

function input(overrides: Partial<SharedAdmissionInput> = {}): SharedAdmissionInput {
  return {
    requestId: 'r1',
    plan: 'starter',
    claimedPayer: 'shared',
    resolvedPayer: 'shared',
    estimateCredits: 10,
    ...overrides
  };
}

describe('SharedAdmissionGate (S12)', () => {
  it('never meters, caps or reserves a BYOK request (S12)', () => {
    const gate = new SharedAdmissionGate({ spentCredits: 795 });
    const decision = gate.admit(input({ claimedPayer: 'byok', resolvedPayer: 'byok', estimateCredits: 999 }));
    assert.equal(decision.admitted, true);
    assert.equal(decision.reservationId, null);
    assert.equal(gate.heldCredits, 0);
    assert.match(decision.reason, /BYOK/);
  });

  it('refuses a request that claims BYOK while the shared key would carry it (S12)', () => {
    const gate = new SharedAdmissionGate();
    const decision = gate.admit(input({ claimedPayer: 'byok', resolvedPayer: 'shared' }));
    assert.equal(decision.admitted, false);
    assert.match(decision.reason, /mismatch/i);
    assert.equal(gate.heldCredits, 0);
  });

  it('holds the first parallel reservation so the second cannot double-spend (S12)', () => {
    const gate = new SharedAdmissionGate({ spentCredits: 790, enabled: true });
    const first = gate.admit(input({ requestId: 'a', estimateCredits: 8 }));
    const second = gate.admit(input({ requestId: 'b', estimateCredits: 8 }));
    assert.equal(first.admitted, true);
    assert.equal(second.admitted, false);
    assert.match(second.reason, /cap/);
    assert.equal(gate.heldCredits, 8);
  });

  it('keeps the hold when the provider reports no usage instead of charging zero (S12)', () => {
    const gate = new SharedAdmissionGate({ enabled: true });
    const decision = gate.admit(input({ requestId: 'a', estimateCredits: 12 }));
    const settlement = gate.settle(decision.reservationId as string, null);
    assert.equal(settlement.settled, false);
    assert.equal(settlement.chargedCredits, 0);
    assert.equal(gate.heldCredits, 12, 'the hold survives until real usage arrives');
    assert.match(settlement.reason, /held/);
  });

  it('refunds the unused part of the reservation when actual usage is lower (S12)', () => {
    const gate = new SharedAdmissionGate({ enabled: true });
    const decision = gate.admit(input({ estimateCredits: 20 }));
    const settlement = gate.settle(decision.reservationId as string, 7);
    assert.equal(settlement.settled, true);
    assert.equal(settlement.chargedCredits, 7);
    assert.equal(settlement.refundedCredits, 13);
    assert.equal(gate.heldCredits, 0);
    assert.equal(gate.spentCredits, 7);
    assert.equal(gate.availableCredits('starter'), 800 - 7);
  });

  it('settles a reservation once — a duplicate key is not double-charged (S12)', () => {
    const gate = new SharedAdmissionGate({ enabled: true });
    const decision = gate.admit(input({ estimateCredits: 20 }));
    const id = decision.reservationId as string;
    gate.settle(id, 7, { idempotencyKey: 'turn-1' });
    const again = gate.settle(id, 7, { idempotencyKey: 'turn-1' });
    assert.equal(again.settled, false);
    assert.equal(gate.spentCredits, 7);
  });

  it('releases a reservation without charging when the request never dispatched (S12)', () => {
    const gate = new SharedAdmissionGate({ enabled: true });
    const decision = gate.admit(input({ estimateCredits: 30 }));
    const released = gate.release(decision.reservationId as string);
    assert.equal(released.settled, true);
    assert.equal(released.chargedCredits, 0);
    assert.equal(released.refundedCredits, 30);
    assert.equal(gate.heldCredits, 0);
    assert.equal(gate.spentCredits, 0);
  });

  it('fails closed when shared access is disabled, unpriced or has no allowance (S12)', () => {
    const disabled = new SharedAdmissionGate({ enabled: false });
    assert.equal(disabled.admit(input()).admitted, false);

    const gate = new SharedAdmissionGate({ enabled: true });
    assert.equal(gate.admit(input({ estimateCredits: 0 })).admitted, false);
    assert.equal(gate.admit(input({ estimateCredits: Number.NaN })).admitted, false);

    const free = gate.admit(input({ plan: 'free', estimateCredits: 5 }));
    assert.equal(free.admitted, false);
    assert.match(free.reason, /no shared allowance/);

    const tooBig = gate.admit(input({ requestId: 'huge', plan: 'starter', estimateCredits: 900 }));
    assert.equal(tooBig.admitted, false);
  });
});
