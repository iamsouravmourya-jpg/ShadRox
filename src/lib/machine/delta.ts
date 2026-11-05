export interface MachinePreview {
  id: string;
  kind: string;
  port: number | null;
}

export interface MachineGitState {
  head: string | null;
  branch: string | null;
  dirty: boolean;
}

export interface MachineTerminal {
  id: string;
  mode: string;
  launchCwd: string;
}

export interface MachineDelta {
  checkpointId: string;
  startedAt: number;
  endedAt: number | null;
  state: 'recording' | 'complete' | 'restored';
  files: Array<{ path: string; kind: 'created' | 'deleted' | 'edited'; dependency: boolean; beforeHash: string | null; afterHash: string | null }>;
  dependencies: string[];
  git: { before: MachineGitState | null; after: MachineGitState | null; changed: boolean; positionChanged: boolean; reversible: boolean };
  previews: { started: MachinePreview[]; stopped: MachinePreview[] };
  terminals: { before: MachineTerminal[]; after: MachineTerminal[] };
  tools: Record<string, string>;
  environment: string;
  limitations: string[];
  omissions: string[];
  canRestore: boolean;
  blockedReason: string | null;
}

export function machineRestoreReason(report: MachineDelta | null | undefined): string | null {
  if (!report) return 'Machine snapshot unavailable or expired. No disk rewind is available.';
  if (report.state === 'restored') return 'This turn has already been rewound.';
  if (report.omissions.length) return `Incomplete snapshot: ${report.omissions.join(' ')}`;
  if (report.state === 'recording') return 'Recording this turn; wait for it to finish.';
  if (report.blockedReason) return report.blockedReason;
  if (!report.git.reversible) return 'Git changes outside the safely reversible scope block rewind.';
  return report.canRestore ? null : 'No reversible changes captured.';
}
