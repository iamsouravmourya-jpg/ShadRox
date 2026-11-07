/**
 * Shared-spend admission (S12).
 *
 * The paid route spends the operator's key, so a request must be admitted
 * against the monthly ceiling *before* it is dispatched, not reconciled after.
 * The money rules this encodes:
 *
 * - A request is reserved at its estimate, so two parallel requests cannot both
 *   be admitted against an allowance that only fits one. Admission is decided on
 *   `spent + held + estimate`, never on `spent` alone.
 * - BYOK is never metered, capped or reserved: the user's own key pays.
 * - The server-resolved payer is authoritative. A request that claims BYOK while
 *   the shared key would actually carry it is refused as a mismatch, never
 *   honoured — that is the one direction that spends someone else's money.
 * - When the provider reports no usage, the reservation is *held*, not released
 *   and not charged: an unknown cost is not a free request.
 * - Admission fails closed. A disabled shared route, an unpriced request or an
 *   unknown plan all refuse rather than guess.
 *
 * Pure state in a class so the arithmetic and the concurrency behaviour can be
 * tested without a server, a database or a clock.
 */

import { getPlanMeta } from './plans';
import type { PlanTier } from './types';
import type { ResolvedPayer } from './sharedKeyPolicy';
import { SHARED_KEY_ENABLED } from './sharedKeyPolicy';

export interface SharedAdmissionInput {
  requestId: string;
  plan: PlanTier;
  /** Who the request claims will pay — untrusted. */
  claimedPayer: ResolvedPayer;
  /** Who the server resolved as payer — authoritative. */
  resolvedPayer: ResolvedPayer;
  /** Estimated credits this request may spend. Must be finite and positive. */
  estimateCredits: number;
}

export interface AdmissionDecision {
  admitted: boolean;
  /** Present only when a shared reservation was taken. */
  reservationId: string | null;
  reason: string;
  /** Total credits held by open reservations after this decision. */
  heldCredits: number;
  availableCredits: number;
}

export interface SettlementResult {
  settled: boolean;
  chargedCredits: number;
  /** Credits returned from the reservation — the COGS refund when actual < hold. */
  refundedCredits: number;
  heldCredits: number;
  reason: string;
}

interface Reservation {
  plan: PlanTier;
  credits: number;
}

export class SharedAdmissionGate {
  private spent: number;
  private readonly enabled: boolean;
  private readonly held = new Map<string, Reservation>();
  private readonly settledKeys = new Set<string>();

  constructor(options: { spentCredits?: number; enabled?: boolean } = {}) {
    this.spent = Math.max(0, options.spentCredits ?? 0);
    this.enabled = options.enabled ?? SHARED_KEY_ENABLED;
  }

  get spentCredits(): number {
    return this.spent;
  }

  get heldCredits(): number {
    let total = 0;
    for (const reservation of this.held.values()) total += reservation.credits;
    return total;
  }

  availableCredits(plan: PlanTier): number {
    const limit = getPlanMeta(plan).creditsPerMonth;
    if (!Number.isFinite(limit)) return 0;
    return Math.max(0, limit - this.spent - this.heldCredits);
  }

  admit(input: SharedAdmissionInput): AdmissionDecision {
    if (input.resolvedPayer === 'byok') {
      return this.decision(true, null, 'BYOK — the user’s own key pays; nothing is metered or reserved.', input.plan);
    }

    // Shared key would carry it: a BYOK claim is a mismatch, not a discount.
    if (input.claimedPayer === 'byok') {
      return this.decision(false, null, 'Payer mismatch — the request claims BYOK but the shared key would carry it.', input.plan);
    }
    if (!this.enabled) {
      return this.decision(false, null, 'Shared access is disabled on this server.', input.plan);
    }
    const limit = getPlanMeta(input.plan).creditsPerMonth;
    if (!Number.isFinite(limit)) {
      return this.decision(false, null, `${input.plan} has no shared allowance.`, input.plan);
    }
    if (!Number.isFinite(input.estimateCredits) || input.estimateCredits <= 0) {
      return this.decision(false, null, 'Unpriced request refused — the estimate is not a finite positive number.', input.plan);
    }
    if (this.spent + this.heldCredits + input.estimateCredits > limit) {
      return this.decision(false, null, 'Would exceed the monthly credit cap.', input.plan);
    }

    const reservationId = `res_${input.requestId}`;
    this.held.set(reservationId, { plan: input.plan, credits: input.estimateCredits });
    return this.decision(true, reservationId, 'Admitted and reserved against the monthly cap.', input.plan);
  }

  /**
   * Commit a reservation with the provider's actual usage. `null` means the
   * provider reported no split: the hold stays (unknown usage is not free).
   * `actual` below the hold refunds the difference.
   */
  settle(
    reservationId: string,
    actualCredits: number | null,
    options: { idempotencyKey?: string } = {}
  ): SettlementResult {
    const reservation = this.held.get(reservationId);
    if (!reservation) {
      return { settled: false, chargedCredits: 0, refundedCredits: 0, heldCredits: this.heldCredits, reason: 'Unknown reservation.' };
    }
    if (options.idempotencyKey && this.settledKeys.has(options.idempotencyKey)) {
      return { settled: false, chargedCredits: 0, refundedCredits: 0, heldCredits: this.heldCredits, reason: 'Already settled.' };
    }
    if (actualCredits === null) {
      return {
        settled: false,
        chargedCredits: 0,
        refundedCredits: 0,
        heldCredits: this.heldCredits,
        reason: 'Usage unknown — the reservation is held, not charged.'
      };
    }
    if (!Number.isFinite(actualCredits) || actualCredits < 0) {
      return {
        settled: false,
        chargedCredits: 0,
        refundedCredits: 0,
        heldCredits: this.heldCredits,
        reason: 'Invalid usage figure — the reservation is held, not charged.'
      };
    }

    this.held.delete(reservationId);
    if (options.idempotencyKey) this.settledKeys.add(options.idempotencyKey);
    this.spent += actualCredits;
    const refunded = Math.max(0, reservation.credits - actualCredits);
    return {
      settled: true,
      chargedCredits: actualCredits,
      refundedCredits: refunded,
      heldCredits: this.heldCredits,
      reason: refunded > 0 ? 'Settled; the unused reservation was refunded.' : 'Settled.'
    };
  }

  /** Drop a reservation without charging — a cancelled or failed before dispatch. */
  release(reservationId: string): SettlementResult {
    const reservation = this.held.get(reservationId);
    if (!reservation) {
      return { settled: false, chargedCredits: 0, refundedCredits: 0, heldCredits: this.heldCredits, reason: 'Unknown reservation.' };
    }
    this.held.delete(reservationId);
    return {
      settled: true,
      chargedCredits: 0,
      refundedCredits: reservation.credits,
      heldCredits: this.heldCredits,
      reason: 'Released without charge.'
    };
  }

  private decision(admitted: boolean, reservationId: string | null, reason: string, plan: PlanTier): AdmissionDecision {
    return { admitted, reservationId, reason, heldCredits: this.heldCredits, availableCredits: this.availableCredits(plan) };
  }
}
