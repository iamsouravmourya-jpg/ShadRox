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

export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'plan' || value === 'agent' ? value : 'ask';
}