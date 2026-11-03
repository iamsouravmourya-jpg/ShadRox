/**
 * Automations: small, declarative jobs the user owns.
 *
 * A definition is the JSON stored in `.shadrox/automations.json`; everything
 * that changes at runtime (last run, daily count) lives in `AutomationState`
 * beside it. No definition is ever run implicitly: the scheduler only proposes
 * `AutomationRunRequest`s and the caller still applies the budget gate and the
 * normal approval path for the chosen action.
 */

export type AutomationTriggerType = 'interval' | 'onSave' | 'webhook';

export interface AutomationIntervalTrigger {
  type: 'interval';
  /** Minutes between runs, 1..10080 (one week). */
  minutes: number;
}

export interface AutomationSaveTrigger {
  type: 'onSave';
  /** Workspace-relative glob; absolute paths and `..` are rejected. */
  glob: string;
}

export interface AutomationWebhookTrigger {
  type: 'webhook';
  /** Exact loopback path, always starting with `/`. */
  path: string;
  /** Shared secret checked by the loopback server, at least 16 characters. */
  secret: string;
}

export type AutomationTrigger =
  | AutomationIntervalTrigger
  | AutomationSaveTrigger
  | AutomationWebhookTrigger;

export type AutomationActionType = 'prompt' | 'command';

export interface AutomationPromptAction {
  type: 'prompt';
  /** Sent through the normal chat path, so it keeps chat's own gates. */
  prompt: string;
}

export interface AutomationCommandAction {
  type: 'command';
  /** A single argv string; the terminal's approval gate still shows it. */
  argv: string;
}

export type AutomationAction = AutomationPromptAction | AutomationCommandAction;

export interface AutomationDefinition {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** Hard daily cap on runs; omitted means no daily cap. */
  maxRunsPerDay?: number;
  /** Credits reserved by one run, 0.1..20. Defaults to 1. */
  creditsPerRun: number;
}

export interface AutomationState {
  id: string;
  /** When the definition was first loaded; anchor for the first interval run. */
  createdAt: number;
  lastRunAt?: number;
  /** Runs consumed on `dayKey`; reset when the UTC day changes. */
  runCount: number;
  /** UTC day (YYYY-MM-DD) that `runCount` belongs to. */
  dayKey?: string;
}

export type AutomationRunReason = AutomationTriggerType | 'manual';

export interface AutomationRunRequest {
  automationId: string;
  name: string;
  trigger: AutomationTriggerType;
  action: AutomationAction;
  credits: number;
  reason: AutomationRunReason;
  /** Present for scheduler-driven requests; omitted when the caller stamps it. */
  requestedAt?: number;
}

export interface BudgetDecision {
  allowed: boolean;
  /** The state to persist; unchanged when the run is refused. */
  state: AutomationState;
  reason?: string;
}

export interface AutomationValidationError {
  index: number;
  id?: string;
  field?: string;
  message: string;
}

export interface ParseAutomationsResult {
  definitions: AutomationDefinition[];
  errors: string[];
}
