/**
 * Click-to-source state machine for the preview panel.
 *
 * Two honest ways to pick an element:
 *   - Alt-click, which works whenever the served document carries ShadRox's
 *     bridge (static HTML and ShadRox-served protocol pages).
 *   - The toolbar "pick" mode, which asks the frame to report every click and
 *     stops the click from navigating the page.
 *
 * A message can only be trusted when the frame is the panel's own iframe, so
 * the host tag below is what the injected bridge answers with.
 */

import type { RevealSourceTarget } from '../previewSource';
import { normalizeSlashes, type SourceLocation } from './sourceMapping';

export const HOST_MESSAGE_SOURCE = 'shadrox-preview-host';
export const FRAME_MESSAGE_SOURCE = 'shadrox-preview';

export type PickModeRequest = { source: typeof HOST_MESSAGE_SOURCE; type: 'set-pick-mode'; enabled: boolean };

export function buildPickModeMessage(enabled: boolean): PickModeRequest {
  return { source: HOST_MESSAGE_SOURCE, type: 'set-pick-mode', enabled: enabled === true };
}

export type BridgeStatus =
  | { kind: 'ready'; supportsPickMode: boolean }
  | { kind: 'ignored' };

export function parseBridgeStatusMessage(data: unknown): BridgeStatus {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'ignored' };
  const record = data as Record<string, unknown>;
  if (record.source !== FRAME_MESSAGE_SOURCE || record.type !== 'bridge-status') return { kind: 'ignored' };
  return { kind: 'ready', supportsPickMode: record.pickMode === true };
}

export interface AttachableSource {
  /** Workspace-relative file, already matched against the mounted files when possible. */
  path: string;
  line?: number;
  character?: number;
  /** Where this came from, so the UI can say it truthfully. */
  from: 'click' | 'stack' | 'served-url' | 'inlined-asset';
  /** Short element description for the chip, never page-authored HTML. */
  label?: string;
}

const MAX_LABEL_LENGTH = 120;

function describeTarget(target: RevealSourceTarget): string {
  const parts = [`<${target.tag}`];
  if (target.id) parts.push(`#${target.id}`);
  parts.push('>');
  const text = target.text ? ` "${target.text.slice(0, 40)}"` : '';
  return `${target.path} ${parts.join('')}${text}`.slice(0, MAX_LABEL_LENGTH);
}

/** Turns a validated reveal message into the payload the chat composer receives. */
export function attachableFromReveal(
  target: RevealSourceTarget,
  location?: SourceLocation | null
): AttachableSource {
  const attachment: AttachableSource = {
    path: normalizeSlashes(target.path),
    from: 'click',
    label: describeTarget(target)
  };
  if (location && typeof location.line === 'number') attachment.line = location.line;
  if (location && typeof location.character === 'number') attachment.character = location.character;
  return attachment;
}

export function attachableFromStack(location: SourceLocation | null): AttachableSource | null {
  if (!location) return null;
  return {
    path: normalizeSlashes(location.path),
    line: location.line,
    character: location.character,
    from: 'stack'
  };
}

export function attachableFromServedUrl(path: string | null): AttachableSource | null {
  if (!path) return null;
  return { path: normalizeSlashes(path), from: 'served-url' };
}

/**
 * De-duplicates attachments and keeps the most specific one first, so a click
 * outranks a stack frame and a stack frame outranks a page URL. Stable input
 * order means stable output for the tests and for the composer chips.
 */
export function mergeAttachments(items: (AttachableSource | null | undefined)[]): AttachableSource[] {
  const rank = (from: AttachableSource['from']) => (from === 'click' ? 0 : from === 'stack' ? 1 : from === 'served-url' ? 2 : 3);
  const kept = items.filter((item): item is AttachableSource => !!item && !!item.path);
  const byPath = new Map<string, AttachableSource>();
  for (const item of kept) {
    const existing = byPath.get(item.path);
    if (!existing || rank(item.from) < rank(existing.from)) byPath.set(item.path, item);
  }
  return [...byPath.values()].sort((left, right) => rank(left.from) - rank(right.from) || left.path.localeCompare(right.path));
}

/** Bounded, readable chip text for a list of attachments. */
export function formatAttachments(items: AttachableSource[], limit = 4): string {
  const names = items.slice(0, limit).map((item) => (item.line ? `${item.path}:${item.line}` : item.path));
  if (names.length === 0) return '';
  const rest = items.length - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest} more` : names.join(', ');
}
