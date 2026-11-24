import type { SystemContext } from '../contextBudget';
import { buildContextManifest } from '../contextManifest';
import { CONVERSATIONAL_PROMPT_CORE } from './promptDiscipline';

/**
 * The ONLY system context a purely conversational turn is allowed to send.
 *
 * Live-path guarantee (see `useContextBuilder.buildSystemContext` and
 * `useOrchestrationController`): when `classifyTurnIntent(...) === 'conversational'`
 * and the user did not explicitly attach an error/file, the request must carry
 * this tiny prompt and NOTHING else — zero project memory, zero dev/preview
 * console logs, zero diagnostics, zero file trees/manifests, zero tool schemas.
 *
 * Keeping the assembly here (instead of inline in the hook) lets the integration
 * test exercise the exact same code the live UI runs, so a regression that
 * re-injects heavy context fails CI instead of silently burning ~10k tokens.
 */
export function buildConversationalSystemContext(input: {
  projectName?: string | null;
  stackBits?: string | null;
}): SystemContext {
  const core = [...CONVERSATIONAL_PROMPT_CORE];
  if (input.projectName) {
    const bits = input.stackBits?.trim();
    core.push(`Active IDE project: ${input.projectName}${bits ? ` (${bits})` : ''}.`);
  }
  return {
    core,
    chunkHeader: '',
    chunks: [],
    files: [],
    manifest: buildContextManifest({ sources: [], targets: [], resolvedPaths: [] })
  };
}

/** True only for turns that must take the minimal conversational path. */
export function isConversationalTurn(turnIntent: { kind: string } | undefined | null): boolean {
  return turnIntent?.kind === 'conversational';
}