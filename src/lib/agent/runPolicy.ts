export type PermissionMode = 'ask' | 'plan' | 'agent';

export type ToolEffect = 'read' | 'write' | 'execute' | 'external' | 'control';

export interface RequestScope {
  workspaceId: string;
  allowedPaths?: readonly string[];
  maxReadFiles?: number;
  maxReadBytes?: number;
}

export interface RunPolicy {
  mode: PermissionMode;
  scope?: RequestScope;
}

export function allowsEffect(mode: PermissionMode, effect: ToolEffect): boolean {
  if (effect === 'control' || effect === 'read') return true;
  return mode === 'agent';
}

export type ApplyHold = 'none' | 'auto-apply-off' | 'plan-approval' | 'permission-mode';

/**
 * Why a finished reply's changes are not going to disk by themselves.
 *
 * Auto-apply is a user preference and a plan gate is a run-level decision, so
 * neither can be allowed to override the permission mode: an ask or plan turn
 * stages its edits for review and stops there.
 */
export function holdReplyApply(input: {
  autoApplyChanges: boolean;
  awaitingPlanApproval: boolean;
  permissionMode: PermissionMode;
}): ApplyHold {
  if (!input.autoApplyChanges) return 'auto-apply-off';
  if (input.awaitingPlanApproval) return 'plan-approval';
  if (!allowsEffect(input.permissionMode, 'write')) return 'permission-mode';
  return 'none';
}

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'plan' || value === 'agent' ? value : 'ask';
}