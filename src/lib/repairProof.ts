/**
 * Self-Healing Proof Engine (Phase 3D Signature Flagship Feature)
 * Automatically captures runtime failure contexts (stack traces, exit codes, DOM assertions, diffs)
 * into immutable failure receipts and coordinates atomic self-healing repair proposals.
 */

export type FailureSource = 'test' | 'preview' | 'verify' | 'compiler' | 'terminal';

export type RepairProofStatus =
  | 'captured'
  | 'repair_proposed'
  | 'repair_applied'
  | 'verified_healed'
  | 'healing_failed'
  | 'rejected';

export interface FailureReceipt {
  id: string;
  source: FailureSource;
  target: string;
  timestamp: number;
  exitCode: number | null;
  errorMessage: string;
  stackTrace?: string;
  diagnostics?: Array<{ file: string; line: number; message: string; severity?: string }>;
  consoleErrors?: string[];
  relevantFiles: string[];
  diffSummary?: string;
  checkpointId?: string;
  status: RepairProofStatus;
  repairPatch?: string;
  healedAt?: number;
  verificationEvidence?: string;
}

export function createFailureReceipt(params: {
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
}): FailureReceipt {
  return {
    id: `proof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: params.source,
    target: params.target,
    timestamp: Date.now(),
    exitCode: params.exitCode ?? null,
    errorMessage: params.errorMessage.trim(),
    stackTrace: params.stackTrace?.trim(),
    diagnostics: params.diagnostics ? [...params.diagnostics] : [],
    consoleErrors: params.consoleErrors ? [...params.consoleErrors] : [],
    relevantFiles: params.relevantFiles ? Array.from(new Set(params.relevantFiles)) : [],
    diffSummary: params.diffSummary,
    checkpointId: params.checkpointId,
    status: 'captured'
  };
}

/**
 * Builds an untrusted-data wrapped repair brief prompt for the agent
 */
export function buildRepairBrief(receipt: FailureReceipt): string {
  const sections: string[] = [];

  sections.push(`[SELF-HEALING PROOF RECEIPT: ${receipt.id}]`);
  sections.push(`SOURCE: ${receipt.source.toUpperCase()} (${receipt.target})`);
  if (receipt.exitCode !== null) {
    sections.push(`EXIT CODE: ${receipt.exitCode}`);
  }
  sections.push(`PRIMARY ERROR:\n${receipt.errorMessage}`);

  if (receipt.stackTrace) {
    sections.push(`STACK TRACE (UNTRUSTED-DATA):\n--- BEGIN DATA ---\n${receipt.stackTrace.slice(0, 2048)}\n--- END DATA ---`);
  }

  if (receipt.diagnostics && receipt.diagnostics.length > 0) {
    const diagLines = receipt.diagnostics
      .slice(0, 10)
      .map((d) => `  ${d.file}:${d.line} - [${d.severity || 'error'}] ${d.message}`)
      .join('\n');
    sections.push(`COMPILER DIAGNOSTICS:\n${diagLines}`);
  }

  if (receipt.consoleErrors && receipt.consoleErrors.length > 0) {
    const errorLines = receipt.consoleErrors.slice(0, 5).join('\n');
    sections.push(`CONSOLE ERRORS (UNTRUSTED-DATA):\n--- BEGIN DATA ---\n${errorLines}\n--- END DATA ---`);
  }

  if (receipt.relevantFiles.length > 0) {
    sections.push(`AFFECTED FILES:\n${receipt.relevantFiles.join(', ')}`);
  }

  if (receipt.diffSummary) {
    sections.push(`RECENT DIFF SUMMARY:\n${receipt.diffSummary.slice(0, 1024)}`);
  }

  sections.push(`INSTRUCTION: Analyze the exact root cause above. Propose a surgical patch to heal the failure without altering unrelated code.`);

  return sections.join('\n\n');
}

/**
 * Attaches a proposed patch to the receipt
 */
export function proposeRepair(receipt: FailureReceipt, patch: string): FailureReceipt {
  if (receipt.status !== 'captured' && receipt.status !== 'healing_failed') {
    throw new Error(`Cannot propose repair for receipt with status ${receipt.status}`);
  }
  return {
    ...receipt,
    status: 'repair_proposed',
    repairPatch: patch
  };
}

/**
 * Verifies whether the repair healed the failure
 */
export function verifyHealing(
  receipt: FailureReceipt,
  outcome: {
    clean: boolean;
    exitCode?: number | null;
    evidenceMessage?: string;
  }
): FailureReceipt {
  if (receipt.status !== 'repair_proposed' && receipt.status !== 'repair_applied') {
    throw new Error(`Cannot verify healing for receipt in status ${receipt.status}`);
  }

  if (outcome.clean) {
    return {
      ...receipt,
      status: 'verified_healed',
      healedAt: Date.now(),
      verificationEvidence: outcome.evidenceMessage || 'All verification checks passed cleanly.'
    };
  }

  return {
    ...receipt,
    status: 'healing_failed',
    verificationEvidence: outcome.evidenceMessage || `Healing verification failed with exit code ${outcome.exitCode}`
  };
}
