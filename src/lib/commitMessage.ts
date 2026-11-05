/**
 * AI commit messages. Uses the read-only git bridge when the workspace is a
 * real repository, and falls back to the editor's dirty-file list in the
 * browser so the feature works everywhere.
 */
import { getDesktopBridge } from './desktop';
import { scrubWorkspaceText } from './envSafety';
import type { ProviderId } from './providers';

export interface CommitAiOptions {
  provider: ProviderId;
  /** Base URL of a BYOK custom endpoint. */
  baseUrl?: string;
  model: string;
  apiKey?: string;
}

export interface CommitSource {
  status: string;
  diff: string;
  log: string;
}

/** Builds the commit context from git (desktop) or from unsaved editor buffers. */
export async function collectCommitContext(
  workspaceId: string | null,
  dirtyFiles: string[],
  files: Array<{ name: string; content: string }>
): Promise<CommitSource> {
  const desktop = getDesktopBridge();
  if (desktop && workspaceId) {
    const snapshot = await desktop.gitRead(workspaceId);
    if (snapshot.isRepo) {
      return { status: snapshot.status, diff: snapshot.diff, log: snapshot.log };
    }
  }

  const status = dirtyFiles.length
    ? dirtyFiles.map((name) => `M ${name}`).join('\n')
    : files.map((file) => `A ${file.name}`).join('\n');
  return { status, diff: '', log: '' };
}

export async function generateCommitMessage(
  source: CommitSource,
  ai: CommitAiOptions
): Promise<string> {
  const response = await fetch('/api/ai/commit-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: scrubWorkspaceText(source.status),
      diff: scrubWorkspaceText(source.diff),
      log: scrubWorkspaceText(source.log),
      ...ai
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || 'Commit message generation failed.');
  return typeof data?.message === 'string' ? data.message : '';
}
