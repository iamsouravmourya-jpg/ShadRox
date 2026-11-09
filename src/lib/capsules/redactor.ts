import { scrubWorkspaceText } from '../envSafety';
import { sha256Hex, canonicalJson } from '../proof/ledger';
import type { ChangeCapsule, RedactionReport } from './types';

const MARKER_RE = /\[REDACTED_SECRET\]/g;

function countMarkers(text: string): number {
  return (text.match(MARKER_RE) ?? []).length;
}

export function redactText(text: string): { text: string; count: number } {
  const scrubbed = scrubWorkspaceText(text);
  // Pre-existing markers are not fresh masks, so subtract them from the total.
  const count = Math.max(0, countMarkers(scrubbed) - countMarkers(text));
  return { text: scrubbed, count };
}

export function redactCapsule(capsule: ChangeCapsule): { capsule: ChangeCapsule; report: RedactionReport } {
  const fields: string[] = [];
  let count = 0;

  const intent = redactText(capsule.promptIntent);
  if (intent.count > 0) {
    fields.push('promptIntent');
    count += intent.count;
  }

  const diffs = capsule.diffs.map((diff, index) => {
    let before = diff.before;
    let after = diff.after;
    if (diff.before !== null) {
      const result = redactText(diff.before);
      before = result.text;
      if (result.count > 0) {
        fields.push(`diffs[${index}].before`);
        count += result.count;
      }
    }
    if (diff.after !== null) {
      const result = redactText(diff.after);
      after = result.text;
      if (result.count > 0) {
        fields.push(`diffs[${index}].after`);
        count += result.count;
      }
    }
    return { ...diff, before, after };
  });

  const report: RedactionReport = { redacted: count > 0, fields, count };
  // selfHash is left untouched; the caller seals after redaction.
  return { capsule: { ...capsule, promptIntent: intent.text, diffs, redaction: report }, report };
}

export async function sealCapsule(capsule: ChangeCapsule): Promise<ChangeCapsule> {
  // Blank selfHash before hashing so the digest excludes itself and stays deterministic.
  const selfHash = await sha256Hex(canonicalJson({ ...capsule, selfHash: '' }));
  return { ...capsule, selfHash };
}

export async function verifyCapsuleIntegrity(capsule: ChangeCapsule): Promise<boolean> {
  if (!capsule.selfHash) return false;
  const recomputed = await sha256Hex(canonicalJson({ ...capsule, selfHash: '' }));
  return recomputed === capsule.selfHash;
}