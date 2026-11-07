import type { PlanTier, RefineMode } from './types';
import type { PermissionMode } from './agent/runPolicy';
import type { ResolvedPayer } from './sharedKeyPolicy';

/**
 * The parts of a request that must not change under it once the user has hit
 * send (S01). Everything here is captured before queueing or execution: a
 * request that is parked in the queue and then dispatched after the user
 * switched workspace, plan or key must still run — and bill — as the request
 * they actually made, or say so out loud. It must never silently rebind.
 *
 * This is deliberately a small, plain record, not a live view of app state.
 */
export interface RequestEnvelope {
  id: string;
  /** Which folder this request was written against. */
  workspaceId: string | null;
  /** The prompt after skill expansion — the bytes the model is asked to answer. */
  prompt: string;
  /** Explicit user targets: attached paths and pinned symbols. */
  targets: readonly string[];
  /** Capability boundary chosen at send time. */
  permissionMode: PermissionMode;
  /** Reasoning/refinement mode chosen at send time. */
  refineMode: RefineMode;
  /** Which plan was active, since it gates metering. */
  plan: PlanTier;
  /** Who pays for this request. Frozen so a mid-flight key change cannot flip it. */
  payer: ResolvedPayer;
  provider: string;
  model: string;
  /** The spend ceiling this request was admitted under. */
  budgetCredits: number;
}

export interface RequestEnvelopeInput {
  id: string;
  workspaceId: string | null;
  prompt: string;
  targets?: readonly string[];
  permissionMode: PermissionMode;
  refineMode: RefineMode;
  plan: PlanTier;
  payer: ResolvedPayer;
  provider: string;
  model: string;
  budgetCredits: number;
}

export function createRequestEnvelope(input: RequestEnvelopeInput): RequestEnvelope {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    prompt: input.prompt,
    targets: [...(input.targets ?? [])],
    permissionMode: input.permissionMode,
    refineMode: input.refineMode,
    plan: input.plan,
    payer: input.payer,
    provider: input.provider,
    model: input.model,
    budgetCredits: input.budgetCredits
  };
}

/** The dimensions a frozen request can drift on between queueing and dispatch. */
export type EnvelopeDrift = 'workspace' | 'payer' | 'plan' | 'provider' | 'model' | 'permission';

/**
 * Which frozen dimensions no longer match the live app state. An empty list
 * means the request can run exactly as queued. Non-empty means the caller must
 * surface the difference rather than substituting current settings.
 *
 * Only billing- and execution-identity fields are compared. `prompt`, `targets`
 * and `budgetCredits` are part of the request itself and cannot "drift".
 */
export function envelopeDrift(frozen: RequestEnvelope, current: RequestEnvelope): EnvelopeDrift[] {
  const drift: EnvelopeDrift[] = [];
  if (frozen.workspaceId !== current.workspaceId) drift.push('workspace');
  if (frozen.payer !== current.payer) drift.push('payer');
  if (frozen.plan !== current.plan) drift.push('plan');
  if (frozen.provider !== current.provider) drift.push('provider');
  if (frozen.model !== current.model) drift.push('model');
  if (frozen.permissionMode !== current.permissionMode) drift.push('permission');
  return drift;
}

/** A one-line, human-readable reason a queued request no longer matches. */
export function describeEnvelopeDrift(drift: readonly EnvelopeDrift[]): string {
  if (drift.length === 0) return '';
  const labels: Record<EnvelopeDrift, string> = {
    workspace: 'the workspace changed',
    payer: 'the paying key changed',
    plan: 'the plan changed',
    provider: 'the provider changed',
    model: 'the model changed',
    permission: 'the permission mode changed'
  };
  return drift.map((entry) => labels[entry]).join(', ');
}
