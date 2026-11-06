import { getDesktopBridge, type ProofReceiptEntry } from './desktop';
import { FailureReceipt } from './repairProof';

export interface MilestoneProofRecord {
  id: string;
  milestoneId: string;
  title: string;
  verifiedAt: number;
  verdict: 'passed' | 'failed' | 'unverified';
  command?: string;
  exitCode?: number | null;
  diagnosticsCount: number;
}

export interface ProofLedgerSummary {
  totalMilestonesVerified: number;
  passedMilestones: number;
  failedMilestones: number;
  totalFailuresCaptured: number;
  totalHealed: number;
  healingSuccessRate: number;
}

/**
 * What the desktop wrote for one entry: the signed chain record's payload hash
 * plus its sequence number. `null` hash means "browser session, nothing durable".
 */
export interface ProofLedgerEntryProof {
  proofHash: string | null;
  seq: number | null;
  keyId?: string | null;
}

type ProofBridge = NonNullable<ReturnType<typeof getDesktopBridge>['proof']>;

function bridge(): ProofBridge | null {
  return getDesktopBridge()?.proof ?? null;
}

/**
 * In-memory view of the proofs this app has produced, backed by the durable
 * signed chain in the main process (`electron/proof-service.cjs` ->
 * `electron/proof-store.cjs`).
 *
 * The API stays synchronous because `src/lib/agent/tools.ts` records a receipt
 * in the middle of a tool call; persistence is queued on `queue` so callers
 * that need to be sure it landed (tests, shutdown, the proof card after a
 * restart) can `await ledger.flushPersistence()`. A failed write is *not*
 * swallowed: it is remembered in `lastError` and exposed, because a receipt
 * that never reached the chain is a promise the app cannot keep.
 *
 * `clear()` empties the in-memory view only. The ledger on disk is append-only
 * by design — deleting history is what the chain exists to detect.
 */
export class ProofLedger {
  private milestoneProofs = new Map<string, MilestoneProofRecord>();
  private failureReceipts = new Map<string, FailureReceipt>();
  private proofs = new Map<string, ProofLedgerEntryProof>();
  /** Entries whose authoritative copy is on disk; never re-appended. */
  private durable = new Set<string>();
  /** Entries with a first (record) append queued but not yet confirmed. */
  private queued = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private lastError: string | null = null;
  private hydrated = false;

  public recordMilestoneProof(proof: MilestoneProofRecord): void {
    this.milestoneProofs.set(proof.id, { ...proof });
    this.appendMilestoneRecord({ ...proof });
  }

  public recordFailureReceipt(receipt: FailureReceipt): void {
    this.failureReceipts.set(receipt.id, { ...receipt });
    this.appendReceiptRecord({ ...receipt });
  }

  public updateFailureReceipt(receipt: FailureReceipt): void {
    if (!this.failureReceipts.has(receipt.id)) return;
    this.failureReceipts.set(receipt.id, { ...receipt });
    const copy = { ...receipt };
    this.enqueue(async (store) => {
      // Nothing durable and nothing on its way means the first write failed, so
      // this state becomes the record instead of an update to a missing one.
      const kind = this.durable.has(receipt.id) ? 'update' : 'record';
      const result = await store.appendReceipt(copy, kind);
      this.durable.add(receipt.id);
      this.proofs.set(receipt.id, { proofHash: result.proofHash, seq: result.seq, keyId: result.keyId });
    });
  }

  public getFailureReceipt(id: string): FailureReceipt | null {
    return this.failureReceipts.get(id) || null;
  }

  public getAllFailureReceipts(): FailureReceipt[] {
    return Array.from(this.failureReceipts.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /** The signed chain entry behind a receipt, if it was persisted. */
  public getFailureReceiptProof(id: string): ProofLedgerEntryProof | null {
    return this.proofs.get(id) ?? null;
  }

  public getFailureReceiptProofHash(id: string): string | null {
    return this.proofs.get(id)?.proofHash ?? null;
  }

  public getMilestoneProofHash(id: string): string | null {
    return this.proofs.get(`milestone:${id}`)?.proofHash ?? null;
  }

  /** Why the last durable write failed, or null. Never a silent drop. */
  public getLastError(): string | null {
    return this.lastError;
  }

  /** Resolves once every queued append has been attempted. */
  public async flushPersistence(): Promise<void> {
    // Drain as the queue grows: a flush that lands while appends are still
    // being queued must not return early.
    let pending = this.queue;
    while (true) {
      await pending.catch(() => undefined);
      if (this.queue === pending) return;
      pending = this.queue;
    }
  }

  /**
   * Replay the durable chain into memory. Entries already held win, so a
   * receipt recorded moments ago is never overwritten by an older on-disk
   * state. Returns how many receipts were added from disk.
   */
  public async hydrate(): Promise<number> {
    const store = bridge();
    if (!store) return 0;
    let added = 0;
    try {
      const entries = await store.receipts();
      for (const entry of entries) added += this.applyDurable(entry) ? 1 : 0;
      this.hydrated = true;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return added;
  }

  public isHydrated(): boolean {
    return this.hydrated;
  }

  private applyDurable(entry: ProofReceiptEntry): boolean {
    const id = entry?.receipt?.id;
    if (typeof id !== 'string' || !id) return false;
    this.durable.add(id);
    this.proofs.set(id, { proofHash: entry.proofHash, seq: entry.seq });
    if (this.failureReceipts.has(id)) return false;
    this.failureReceipts.set(id, { ...entry.receipt });
    return true;
  }

  /** Queue a milestone's first write; `durable` only flips once it lands. */
  private appendMilestoneRecord(proof: MilestoneProofRecord): void {
    const key = `milestone:${proof.id}`;
    if (this.durable.has(key) || this.queued.has(key) || !bridge()) return;
    this.queued.add(key);
    this.enqueue(async (store) => {
      try {
        const result = await store.appendMilestone(proof);
        this.durable.add(key);
        this.proofs.set(key, { proofHash: result.proofHash, seq: result.seq, keyId: result.keyId });
      } finally {
        this.queued.delete(key);
      }
    });
  }

  /** Queue a receipt's first write; `durable` only flips once it lands. */
  private appendReceiptRecord(receipt: FailureReceipt): void {
    if (this.durable.has(receipt.id) || this.queued.has(receipt.id) || !bridge()) return;
    this.queued.add(receipt.id);
    this.enqueue(async (store) => {
      try {
        const result = await store.appendReceipt(receipt, 'record');
        this.durable.add(receipt.id);
        this.proofs.set(receipt.id, { proofHash: result.proofHash, seq: result.seq, keyId: result.keyId });
      } finally {
        this.queued.delete(receipt.id);
      }
    });
  }

  private enqueue(task: (store: ProofBridge) => Promise<void>): void {
    const store = bridge();
    if (!store) {
      // A browser session has no chain to append to; the receipts stay in
      // memory exactly as they always did.
      return;
    }
    this.queue = this.queue.then(async () => {
      try {
        await task(store);
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.warn('[shadrox] proof ledger append failed', error);
      }
    });
  }

  public getSummary(): ProofLedgerSummary {
    const milestones = Array.from(this.milestoneProofs.values());
    const failures = Array.from(this.failureReceipts.values());

    const passedMilestones = milestones.filter((m) => m.verdict === 'passed').length;
    const failedMilestones = milestones.filter((m) => m.verdict === 'failed').length;
    const totalHealed = failures.filter((f) => f.status === 'verified_healed').length;

    const healingSuccessRate = failures.length > 0 ? totalHealed / failures.length : 1;

    return {
      totalMilestonesVerified: milestones.length,
      passedMilestones,
      failedMilestones,
      totalFailuresCaptured: failures.length,
      totalHealed,
      healingSuccessRate: Math.round(healingSuccessRate * 100) / 100
    };
  }

  public clear(): void {
    this.milestoneProofs.clear();
    this.failureReceipts.clear();
    this.proofs.clear();
    this.durable.clear();
    this.queued.clear();
    this.hydrated = false;
  }
}

export const globalProofLedger = new ProofLedger();

/**
 * Replay the signed chain into the global ledger. Called on module load in a
 * desktop session (this module is reached by the agent tool loop, so it runs
 * during app start) and exported for callers that want to await it — the
 * Self-Healing Proof card, or a repair flow that needs last session's failure.
 */
export async function hydrateFailureReceipts(): Promise<number> {
  return globalProofLedger.hydrate();
}

/** The proof hash a receipt was written under, or null if it never got there. */
export function getRecordedProofHash(receiptId: string): string | null {
  return globalProofLedger.getFailureReceiptProofHash(receiptId);
}

export function getProofLedgerError(): string | null {
  return globalProofLedger.getLastError();
}

export async function flushProofLedger(): Promise<void> {
  await globalProofLedger.flushPersistence();
}

if (bridge()) {
  void globalProofLedger.hydrate();
}
