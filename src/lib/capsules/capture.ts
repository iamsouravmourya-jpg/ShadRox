import { sha256Hex } from '../proof/ledger';
import { redactCapsule, sealCapsule } from './redactor';
import {
  CAPSULE_FORMAT,
  CAPSULE_VERSION,
  type CapsuleCaptureInput,
  type CapsuleFileDiff,
  type ChangeCapsule
} from './types';

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

// Case-insensitive matching mirrors atomicApply so Windows paths pair up, while
// the displayed path keeps the post file's original casing.
function matchKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

export async function buildCapsule(input: CapsuleCaptureInput): Promise<ChangeCapsule> {
  const baseByKey = new Map<string, { path: string; content: string }>();
  for (const file of input.baseFiles) baseByKey.set(matchKey(file.path), file);
  const postKeys = new Set(input.postFiles.map((file) => matchKey(file.path)));

  const baseHashes: Record<string, string> = Object.fromEntries(
    await Promise.all(
      input.baseFiles.map(async (file) => [normalizePath(file.path), await sha256Hex(file.content)] as const)
    )
  );

  const diffs: CapsuleFileDiff[] = [];
  for (const post of input.postFiles) {
    const base = baseByKey.get(matchKey(post.path));
    if (!base) {
      diffs.push({
        path: normalizePath(post.path),
        kind: 'created',
        beforeHash: null,
        before: null,
        afterHash: await sha256Hex(post.content),
        after: post.content
      });
    } else if (base.content !== post.content) {
      diffs.push({
        path: normalizePath(post.path),
        kind: 'edited',
        beforeHash: baseHashes[normalizePath(base.path)],
        before: base.content,
        afterHash: await sha256Hex(post.content),
        after: post.content
      });
    }
  }
  for (const base of input.baseFiles) {
    if (postKeys.has(matchKey(base.path))) continue;
    diffs.push({
      path: normalizePath(base.path),
      kind: 'deleted',
      beforeHash: baseHashes[normalizePath(base.path)],
      before: base.content,
      afterHash: null,
      after: null
    });
  }

  const assembled: ChangeCapsule = {
    format: CAPSULE_FORMAT,
    version: CAPSULE_VERSION,
    id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    taskId: input.taskId,
    workspaceRoot: input.workspaceRoot,
    createdAt: input.createdAt ?? Date.now(),
    status: input.status ?? 'captured',
    promptIntent: input.promptIntent,
    baseHashes,
    diffs,
    verification: input.verification ?? [],
    spend: input.spend ?? null,
    machineDeltaRef: input.machineDeltaRef ?? null,
    redaction: { redacted: false, fields: [], count: 0 },
    selfHash: ''
  };

  // Raw content must never escape: redact before sealing so the persisted
  // capsule (and its selfHash) only ever cover masked text.
  const { capsule: redacted } = redactCapsule(assembled);
  return await sealCapsule(redacted);
}