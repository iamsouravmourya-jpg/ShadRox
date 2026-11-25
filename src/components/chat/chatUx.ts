export interface ChatStarter {
  id: 'build' | 'explain' | 'optimize' | 'plan';
  title: string;
  subtitle: string;
  prompt: string;
}

export const CHAT_STARTERS: readonly ChatStarter[] = [
  {
    id: 'build',
    title: 'Build full-stack app',
    subtitle: 'Scaffold routes, UI & APIs end-to-end',
    prompt: 'Design and scaffold a clean full-stack feature in this workspace with types, UI, and tests.'
  },
  {
    id: 'explain',
    title: 'Explain this code',
    subtitle: 'Trace responsibilities & data flow',
    prompt: 'Explain how the active file works and trace its main data flow before suggesting any changes.'
  },
  {
    id: 'optimize',
    title: 'Optimize performance',
    subtitle: 'Profile hot paths & reduce overhead',
    prompt: 'Inspect the active module for bottlenecks, unnecessary re-renders, or edge cases and propose targeted improvements.'
  },
  {
    id: 'plan',
    title: 'Create a project plan',
    subtitle: 'Step-by-step design before coding',
    prompt: 'Write a step-by-step implementation plan with file targets and risks first. Do not edit files yet.'
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
  recovered: number;
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

export function formatTurnElapsed(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

interface ActivityTargetEntry {
  name: string;
  label: string;
  ok?: boolean;
  refused?: boolean;
  stage?: string;
  durationMs?: number;
  input?: Record<string, unknown> | string;
}

function targetPathOf(tool: ActivityTargetEntry): string | null {
  if (tool.input && typeof tool.input === 'object') {
    const record = tool.input as Record<string, unknown>;
    if (typeof record.path === 'string' && record.path.trim()) {
      return record.path.trim().replace(/\\/g, '/').toLowerCase();
    }
    if (Array.isArray(record.patches) && record.patches.length === 1) {
      const first = record.patches[0];
      if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).path === 'string') {
        return String((first as Record<string, unknown>).path).trim().replace(/\\/g, '/').toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Returns indices of non-refused intermediate errors that were later succeeded by a
 * matching tool call (same tool name or same target file path).
 */
export function findRecoveredToolIndices(tools: ReadonlyArray<ActivityTargetEntry>): Set<number> {
  const recovered = new Set<number>();
  for (let i = 0; i < tools.length; i += 1) {
    const entry = tools[i];
    if (entry.ok || entry.refused) continue;
    const targetPath = targetPathOf(entry);
    for (let j = i + 1; j < tools.length; j += 1) {
      const later = tools[j];
      if (!later.ok) continue;
      if (later.name === entry.name) {
        recovered.add(i);
        break;
      }
      if (targetPath && targetPathOf(later) === targetPath) {
        recovered.add(i);
        break;
      }
    }
  }
  return recovered;
}

export function summarizeToolActivity(
  tools: ReadonlyArray<ActivityTargetEntry>,
  options?: { streaming?: boolean }
): ToolActivitySummary {
  let failed = 0;
  let recovered = 0;
  let held = 0;
  let reads = 0;
  let edits = 0;
  let checks = 0;
  let totalDurationMs = 0;
  const recoveredIndices = findRecoveredToolIndices(tools);

  for (let index = 0; index < tools.length; index += 1) {
    const tool = tools[index];
    if (tool.refused) held += 1;
    else if (!tool.ok) {
      if (recoveredIndices.has(index) || options?.streaming) recovered += 1;
      else failed += 1;
    }

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
    recovered,
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

