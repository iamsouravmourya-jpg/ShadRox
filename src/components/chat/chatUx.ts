export interface ChatStarter {
  id: 'explain' | 'fix' | 'plan' | 'refactor';
  title: string;
  subtitle: string;
  prompt: string;
}

export const CHAT_STARTERS: readonly ChatStarter[] = [
  {
    id: 'explain',
    title: 'Explain this code',
    subtitle: 'Trace responsibilities & data flow',
    prompt: 'Explain how the active file works and trace its main data flow before suggesting any changes.'
  },
  {
    id: 'fix',
    title: 'Find & fix bugs',
    subtitle: 'Check edge cases with minimal edits',
    prompt: 'Inspect this workspace for bugs or edge cases, explain the root cause, and propose the smallest clean fix.'
  },
  {
    id: 'plan',
    title: 'Plan an architecture change',
    subtitle: 'Step-by-step design before coding',
    prompt: 'Write a step-by-step implementation plan with file targets and risks first. Do not edit files yet.'
  },
  {
    id: 'refactor',
    title: 'Refactor for clarity',
    subtitle: 'Simplify structure, keep behavior identical',
    prompt: 'Refactor the selected code for readability and maintainability while keeping all existing behavior intact.'
  }
];

/**
 * Inserts an `@` trigger at the end of the draft when one is not already active,
 * guaranteeing leading whitespace separation when appending to existing text.
 */
export function appendMentionTrigger(current: string): string {
  if (/(?:^|\s)@([^\s@]*)$/.test(current)) return current;
  if (current.length === 0 || /\s$/.test(current)) return `${current}@`;
  return `${current} @`;
}

/**
 * Strips any trailing `@query` token when a mention item is selected, preserving
 * surrounding text cleanliness.
 */
export function stripTrailingMention(current: string): string {
  return current.replace(/@([^\s@]*)$/, '').replace(/\s+$/, '');
}

/**
 * Computes bounded auto-grow textarea height in pixels so short prompts feel
 * roomy and long prompts scroll smoothly instead of pushing the composer off-screen.
 */
export function computeComposerHeight(
  scrollHeight: number,
  minHeight = 58,
  maxHeight = 180
): { height: number; overflowY: 'hidden' | 'auto' } {
  const safeScroll = Number.isFinite(scrollHeight) ? Math.max(0, scrollHeight) : minHeight;
  const clamped = Math.min(maxHeight, Math.max(minHeight, Math.ceil(safeScroll)));
  return {
    height: clamped,
    overflowY: safeScroll > maxHeight ? 'auto' : 'hidden'
  };
}

export interface ToolActivitySummary {
  total: number;
  failed: number;
  held: number;
  reads: number;
  edits: number;
  checks: number;
  totalDurationMs: number;
  latestLabel: string | null;
}

export function formatToolDuration(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function summarizeToolActivity(
  tools: ReadonlyArray<{
    name: string;
    label: string;
    ok?: boolean;
    refused?: boolean;
    stage?: string;
    durationMs?: number;
  }>
): ToolActivitySummary {
  let failed = 0;
  let held = 0;
  let reads = 0;
  let edits = 0;
  let checks = 0;
  let totalDurationMs = 0;

  for (const tool of tools) {
    if (tool.refused) held += 1;
    else if (!tool.ok) failed += 1;

    const stage = tool.stage ?? (tool.name.includes('read') || tool.name.includes('list') ? 'reading' : 'completed');
    if (stage === 'reading') reads += 1;
    else if (stage === 'editing') edits += 1;
    else if (stage === 'checking') checks += 1;

    if (typeof tool.durationMs === 'number' && Number.isFinite(tool.durationMs) && tool.durationMs > 0) {
      totalDurationMs += tool.durationMs;
    }
  }

  return {
    total: tools.length,
    failed,
    held,
    reads,
    edits,
    checks,
    totalDurationMs,
    latestLabel: tools.length > 0 ? tools[tools.length - 1].label : null
  };
}

export function describeLivePhase(options: {
  activeStatusMessage?: string | null;
  hasContent: boolean;
  latestToolLabel?: string | null;
  hasReasoning?: boolean;
}): string {
  const explicit = options.activeStatusMessage?.trim();
  if (explicit) return explicit;
  if (options.hasContent) return 'Writing response…';
  if (options.latestToolLabel) return options.latestToolLabel;
  if (options.hasReasoning) return 'Reasoning through approach…';
  return 'Analyzing workspace & planning response…';
}
