import type { MachineDelta } from './delta';

export interface MachineReceipt {
  format: 'shadrox-machine-delta-receipt';
  version: 1;
  receiptId: string;
  checkpointId: string;
  workspaceRoot: string;
  exportedAt: number;
  hashKind: 'sha256';
  partial: boolean;
  limits: { files: number; bytes: number; directories: number; records: number };
  report: MachineDelta;
  selfHash: string;
}

export interface MachineReceiptExport {
  receiptId: string;
  filePath: string;
  partial: boolean;
}

export interface MachineReceiptVerification {
  valid: boolean;
  checked: number;
  matched: number;
  invalidatedBy: string[];
  selfHashMismatch: boolean;
  message: string;
}
