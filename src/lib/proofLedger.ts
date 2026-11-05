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

export class ProofLedger {
  private milestoneProofs = new Map<string, MilestoneProofRecord>();
  private failureReceipts = new Map<string, FailureReceipt>();

  public recordMilestoneProof(proof: MilestoneProofRecord): void {
    this.milestoneProofs.set(proof.id, { ...proof });
  }

  public recordFailureReceipt(receipt: FailureReceipt): void {
    this.failureReceipts.set(receipt.id, { ...receipt });
  }

  public updateFailureReceipt(receipt: FailureReceipt): void {
    if (this.failureReceipts.has(receipt.id)) {
      this.failureReceipts.set(receipt.id, { ...receipt });
    }
  }

  public getFailureReceipt(id: string): FailureReceipt | null {
    return this.failureReceipts.get(id) || null;
  }

  public getAllFailureReceipts(): FailureReceipt[] {
    return Array.from(this.failureReceipts.values()).sort((a, b) => b.timestamp - a.timestamp);
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
  }
}

export const globalProofLedger = new ProofLedger();
