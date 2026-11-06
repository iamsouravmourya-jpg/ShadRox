/**
 * Repair session (Phase 3D)
 *
 * Ties a captured failure receipt to what happens next: the edit that claims to
 * repair it, the re-run that proves (or refutes) the repair, and the undo that
 * rewinds the failing state. The rules live here instead of in the tool loop so
 * every call site — the agent's `run_command`, the preview assertion, the apply
 * pipeline, the checkpoint restore — goes through the same state machine, and
 * no receipt can be marked healed by a path that never re-ran anything.
 */

import {
  createFailureReceipt,
  proposeRepair,
  verifyHealing,
  type FailureReceipt,
  type FailureSource
} from './repairProof';
import { globalProofLedger } from './proofLedger';

/**
 * The slice of a proof ledger a session writes through. `updateFailureReceipt`
 * appends a signed transition; ledgers without it (an in-memory stub) still get
 * the latest copy through `recordFailureReceipt`.
 */
export interface RepairLedger {
  recordFailureReceipt(receipt: FailureReceipt): void;
  updateFailureReceipt?(receipt: FailureReceipt): void;
  getFailureReceipt?(id: string): FailureReceipt | null;
  getAllFailureReceipts?(): FailureReceipt[];
}

export interface CaptureFailureParams {
  source: FailureSource;
  target: string;
  errorMessage: string;
  exitCode?: number | null;
  stackTrace?: string;
  diagnostics?: Array<{ file: string; line: number; message: string; severity?: string }>;
  consoleErrors?: string[];
  relevantFiles?: string[];
  diffSummary?: string;
  checkpointId?: string;
}

/** Receipts a turn is still allowed to repair; newest last. */
export const MAX_OPEN_RECEIPTS = 12;
export const MAX_RECENT_SIGNATURES = 24;
export const MAX_REPAIR_PATCH_CHARS = 1200;
export const MAX_EVIDENCE_CHARS = 400;
export const MAX_RECEIPT_CONSOLE_ERRORS = 10;

const OPEN_STATUSES = new Set<FailureReceipt['status']>([
  'captured',
  'repair_proposed',
  'repair_applied',
  'healing_failed'
]);

/** ANSI colour/cursor sequences a compiler or runner may have emitted. */
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Flattens untrusted process output into one bounded line of evidence. Control
 * bytes (ANSI colours, carriage returns, NULs) would otherwise corrupt the
 * proof card; the card renders the result as text, so it can never become markup.
 */
export function formatEvidence(text: string, maxLength: number = MAX_EVIDENCE_CHARS): string {
  const flattened = String(text ?? '')
    .replace(ANSI_ESCAPE, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flattened) return '';
  return flattened.length > maxLength ? `${flattened.slice(0, Math.max(0, maxLength - 1))}…` : flattened;
}

function normalizeTarget(target: string): string {
  return String(target ?? '').trim().replace(/\s+/g, ' ');
}

function firstLine(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return formatEvidence(line ?? '', 160);
}

function clipRepairPatch(summary: string): string {
  const trimmed = String(summary ?? '').trim();
  if (!trimmed) return 'Edit applied; no diff summary was captured.';
  return trimmed.length > MAX_REPAIR_PATCH_CHARS
    ? `${trimmed.slice(0, MAX_REPAIR_PATCH_CHARS)}\n… (patch summary clipped)`
    : trimmed;
}

export class RepairSession {
  private readonly ledger: RepairLedger;
  /** Receipts still eligible for a repair transition, oldest first. */
  private readonly open = new Map<string, FailureReceipt>();
  private readonly recentSignatures: string[] = [];
  private lastCapture: { signature: string; receiptId: string } | null = null;
  private turnCheckpointId: string | null = null;

  constructor(ledger: RepairLedger = globalProofLedger) {
    this.ledger = ledger;
  }

  /** The checkpoint a turn opened before its tools ran; receipts inherit it. */
  beginTurn(checkpointId?: string | null): void {
    this.turnCheckpointId = checkpointId?.trim() || null;
  }

  endTurn(): void {
    this.turnCheckpointId = null;
  }

  currentCheckpointId(): string | undefined {
    return this.turnCheckpointId ?? undefined;
  }

  getOpenReceipts(): FailureReceipt[] {
    return [...this.open.values()];
  }

  getRecentSignatures(): string[] {
    return [...this.recentSignatures];
  }

  getReceipt(id: string): FailureReceipt | null {
    return this.open.get(id) ?? this.ledger.getFailureReceipt?.(id) ?? null;
  }

  /**
   * Captures a failure. A failure observed twice in a row with the same source,
   * target and message is the same failure (a preview reload storm, a command
   * retried before any repair), so the existing receipt is returned and nothing
   * new is appended. Once that receipt has been repaired or rejected, a repeat
   * failure is genuinely new and is captured again.
   */
  capture(params: CaptureFailureParams): FailureReceipt | null {
    const target = normalizeTarget(params.target);
    const errorMessage = params.errorMessage.trim();
    if (!target || !errorMessage) return null;

    const signature = `${params.source}\u0000${target}\u0000${errorMessage}`;
    if (this.lastCapture?.signature === signature) {
      const existing = this.getReceipt(this.lastCapture.receiptId);
      // Still captured and unrepaired: the same failure observed again is the
      // same failure, not a new one. Keep it in the open map so a later edit can
      // still propose a repair for it.
      if (existing && existing.status === 'captured') {
        this.remember(existing);
        return existing;
      }
    }

    const receipt = createFailureReceipt({
      source: params.source,
      target,
      errorMessage,
      exitCode: params.exitCode,
      stackTrace: params.stackTrace,
      diagnostics: params.diagnostics,
      consoleErrors: (params.consoleErrors ?? [])
        .map((entry) => formatEvidence(entry, 300))
        .filter(Boolean)
        .slice(0, MAX_RECEIPT_CONSOLE_ERRORS),
      relevantFiles: params.relevantFiles,
      diffSummary: params.diffSummary,
      checkpointId: params.checkpointId ?? this.turnCheckpointId ?? undefined
    });

    this.remember(receipt);
    this.ledger.recordFailureReceipt(receipt);
    this.lastCapture = { signature, receiptId: receipt.id };
    this.recentSignatures.unshift(signature);
    if (this.recentSignatures.length > MAX_RECENT_SIGNATURES) {
      this.recentSignatures.length = MAX_RECENT_SIGNATURES;
    }
    return receipt;
  }

  /**
   * An edit landed. Every open receipt becomes `repair_proposed` with the diff
   * summary as its patch; nothing is marked healed here — only a re-run is.
   */
  onEditApplied(diffSummary: string): FailureReceipt[] {
    const patch = clipRepairPatch(diffSummary);
    const updated: FailureReceipt[] = [];
    for (const receipt of [...this.open.values()]) {
      if (receipt.status !== 'captured' && receipt.status !== 'healing_failed') continue;
      const proposed = proposeRepair(receipt, patch);
      this.persist(proposed);
      updated.push(proposed);
    }
    return updated;
  }

  /**
   * The failing target was re-run. Only a receipt whose repair was proposed can
   * be verified: a command that now passes before any repair proves nothing
   * about healing, so it is deliberately left alone.
   */
  observeCommand(command: string, exitCode: number, output = ''): FailureReceipt[] {
    const target = normalizeTarget(command);
    if (!target) return [];
    const updated: FailureReceipt[] = [];
    for (const receipt of [...this.open.values()]) {
      if (receipt.status !== 'repair_proposed' && receipt.status !== 'repair_applied') continue;
      if (normalizeTarget(receipt.target) !== target) continue;
      const evidence = exitCode === 0
        ? formatEvidence(`Re-ran \`${target}\` and it exited 0.`)
        : formatEvidence(`Re-ran \`${target}\` and it exited ${exitCode}: ${firstLine(output) || 'no output captured'}`);
      const verified = verifyHealing(receipt, {
        clean: exitCode === 0,
        exitCode,
        evidenceMessage: evidence
      });
      this.persist(verified);
      updated.push(verified);
    }
    return updated;
  }

  /**
   * A checkpoint the receipt belongs to was restored. The failing state is gone
   * from disk, so the repair claim is rejected rather than credited as a heal.
   */
  rejectForCheckpoint(checkpointId: string, evidenceMessage?: string): FailureReceipt[] {
    const id = checkpointId.trim();
    if (!id) return [];
    const evidence = formatEvidence(
      evidenceMessage || `Restored checkpoint ${id}; the failing state was rewound.`
    );
    const candidates = new Map<string, FailureReceipt>();
    for (const receipt of this.open.values()) candidates.set(receipt.id, receipt);
    for (const receipt of this.ledger.getAllFailureReceipts?.() ?? []) {
      if (!candidates.has(receipt.id)) candidates.set(receipt.id, receipt);
    }

    const rejected: FailureReceipt[] = [];
    for (const receipt of candidates.values()) {
      if (receipt.checkpointId !== id) continue;
      // A heal that was already proven stays proven; a repeat restore changes nothing.
      if (receipt.status === 'rejected' || receipt.status === 'verified_healed') continue;
      const updated: FailureReceipt = {
        ...receipt,
        status: 'rejected',
        verificationEvidence: evidence
      };
      this.persist(updated);
      rejected.push(updated);
    }
    return rejected;
  }

  /**
   * Binds a receipt to a turn checkpoint. The checkpoint id only exists in the
   * app, after the snapshot was opened, so a receipt captured by a tool inherits
   * it here when the turn surfaces the proof.
   */
  attachCheckpoint(receiptId: string, checkpointId: string | null | undefined): FailureReceipt | null {
    const receipt = this.getReceipt(receiptId);
    if (!receipt) return null;
    const id = checkpointId?.trim();
    if (!id || receipt.checkpointId === id) return receipt;
    // A healed or rejected receipt is history; moving its checkpoint would be a lie.
    if (!OPEN_STATUSES.has(receipt.status)) return receipt;
    const updated: FailureReceipt = { ...receipt, checkpointId: id };
    this.persist(updated);
    return updated;
  }

  /** Test/restart hook: forget this session's view, never the ledger on disk. */
  reset(): void {
    this.open.clear();
    this.recentSignatures.length = 0;
    this.lastCapture = null;
    this.turnCheckpointId = null;
  }

  private remember(receipt: FailureReceipt): void {
    this.open.delete(receipt.id);
    this.open.set(receipt.id, receipt);
    while (this.open.size > MAX_OPEN_RECEIPTS) {
      const oldest = this.open.keys().next();
      if (oldest.done) break;
      this.open.delete(oldest.value);
    }
  }

  private persist(receipt: FailureReceipt): void {
    this.remember(receipt);
    if (this.ledger.updateFailureReceipt) this.ledger.updateFailureReceipt(receipt);
    else this.ledger.recordFailureReceipt(receipt);
  }
}

export const globalRepairSession = new RepairSession(globalProofLedger);
