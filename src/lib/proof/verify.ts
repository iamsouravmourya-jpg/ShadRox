/**
 * `shadrox verify` — offline verification of the proof ledger.
 *
 * Two independent jobs:
 *  1. Chain integrity: recompute every record's canonical SHA-256, check the
 *     prev-hash links and sequence continuity, and verify each Ed25519
 *     signature against the workspace key registry (all historical keys).
 *  2. Claim freshness: re-hash the LIVE workspace files and compare against
 *     the before/after hashes recorded by `turn.apply` / `turn.delta` events.
 *     A claim that no longer matches means a later human or tool edit
 *     invalidated it — exactly what the user asked to be told.
 *
 * Command/usage claims can only be chain-verified (you cannot re-run `npm
 * test` offline and call it the same observation), so they report as
 * `recorded`. IO is injected so this runs in the renderer, in a future CLI,
 * and in tests without Electron.
 */

import {
  canonicalJson,
  sha256Hex,
  unsignedOf,
  webcryptoEd25519,
  type KeyRegistry,
  type ProofCrypto,
  type ProofLedgerIo,
  type ProofRecord
} from './ledger';
import { verifyChain } from '../../../electron/proof-chain.cjs';

export type ClaimStatus = 'holds' | 'invalidated' | 'missing' | 'recorded';

export interface ProofClaim {
  seq: number;
  type: ProofRecord['type'];
  messageId: string | null;
  path?: string;
  status: ClaimStatus;
  detail: string;
}

export interface VerifyReport {
  ranAt: number;
  workspace: string;
  totalRecords: number;
  chainValid: boolean;
  /** Records whose recomputed SHA-256 does not match the stored hash. */
  tamperedRecords: number[];
  /** Records whose `prev` does not link to the previous record's hash. */
  brokenLinks: number[];
  /** Sequence discontinuities (a record was removed from the middle). */
  gaps: number[];
  /** Records whose Ed25519 signature failed against the key registry. */
  signatureFailures: number[];
  unknownKeys: number[];
  keyIds: string[];
  /** The last line was a torn append; it was ignored, not chained. */
  truncatedTail: boolean;
  claims: ProofClaim[];
  summary: string;
}

export interface LiveFileIo {
  /** Current workspace file content, or null when the path no longer exists. */
  readLive(path: string): Promise<string | null>;
}

export interface VerifyIo extends ProofLedgerIo {
  live: LiveFileIo;
}

interface FileClaim { path: string; after: string | null; created?: boolean }

function isCorrupted(record: ProofRecord): boolean {
  return Boolean((record as { corrupted?: boolean }).corrupted);
}

function claimedFiles(record: ProofRecord): FileClaim[] {
  if (record.type === 'turn.apply') {
    const files = (record.data as { files?: Array<{ path: string; after: string | null; created?: boolean }> }).files;
    return Array.isArray(files) ? files.map((file) => ({ path: file.path, after: file.after, created: file.created })) : [];
  }
  if (record.type === 'turn.delta') {
    const files = (record.data as { files?: Array<{ path: string; afterHash: string | null }> }).files;
    return Array.isArray(files) ? files.map((file) => ({ path: file.path, after: file.afterHash })) : [];
  }
  return [];
}

export async function verifyProofLedger(
  io: VerifyIo,
  options: { workspace?: string; crypto?: ProofCrypto; now?: () => number } = {}
): Promise<VerifyReport> {
  const crypto = options.crypto ?? webcryptoEd25519;
  const text = await io.readLedger();
  const lines = (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

  let truncatedTail = false;
  const records: ProofRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]) as ProofRecord);
    } catch {
      if (i === lines.length - 1) truncatedTail = true;
      else {
        // A corrupt line in the middle: keep the parsed prefix honest by
        // reporting the position and treating the chain as broken there.
        records.push({ corrupted: true, line: i + 1 } as unknown as ProofRecord);
      }
    }
  }

  const keysText = await io.readKeys();
  let registry: KeyRegistry | null = null;
  try { registry = keysText ? JSON.parse(keysText) as KeyRegistry : null; } catch { registry = null; }
  const publicKeys = new Map<string, CryptoKey>();
  if (registry) {
    for (const entry of registry.keys) {
      try { publicKeys.set(entry.keyId, await crypto.importPublic(entry.publicJwk)); } catch { /* malformed key: counted as unknown */ }
    }
  }

  const tamperedRecords: number[] = [];
  const brokenLinks: number[] = [];
  const gaps: number[] = [];
  const signatureFailures: number[] = [];
  const unknownKeys: number[] = [];
  const claims: ProofClaim[] = [];
  let previousHash = '0'.repeat(64);
  let previousSeq = 0;
  const liveHashCache = new Map<string, Promise<string | null>>();

  const liveHash = (path: string): Promise<string | null> => {
    let pending = liveHashCache.get(path);
    if (!pending) {
      pending = io.live.readLive(path).then(async (content) => (content === null ? null : await sha256Hex(content)));
      liveHashCache.set(path, pending);
    }
    return pending;
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if ((record as { corrupted?: boolean }).corrupted) {
      const corrupted = record as unknown as { line: number };
      tamperedRecords.push(corrupted.line);
      previousHash = '';
      continue;
    }
    const expected = await sha256Hex(unsignedOf(record));
    if (expected !== record.hash) tamperedRecords.push(record.seq);
    if (previousHash && record.prev !== previousHash) brokenLinks.push(record.seq);
    if (index > 0 && !isCorrupted(records[index - 1]) && record.seq !== previousSeq + 1) gaps.push(record.seq);
    previousSeq = record.seq;
    previousHash = expected;

    const key = publicKeys.get(record.keyId);
    if (!key) unknownKeys.push(record.seq);
    else if (!(await crypto.verify(key, record.hash, record.sig))) signatureFailures.push(record.seq);

    const fileClaims = claimedFiles(record);
    if (fileClaims.length > 0) {
      for (const file of fileClaims) {
        if (file.after === null) {
          const exists = (await liveHash(file.path)) !== null;
          claims.push({
            seq: record.seq, type: record.type, messageId: record.messageId, path: file.path,
            status: exists ? 'invalidated' : 'holds',
            detail: exists ? 'deleted by the claim, but the file is back on disk' : 'deletion still holds on disk'
          });
          continue;
        }
        const live = await liveHash(file.path);
        claims.push({
          seq: record.seq, type: record.type, messageId: record.messageId, path: file.path,
          status: live === null ? 'missing' : live === file.after ? 'holds' : 'invalidated',
          detail: live === null
            ? 'file no longer exists'
            : live === file.after
              ? 'live SHA-256 matches the recorded after-hash'
              : 'live file differs from the recorded after-hash (later human or tool edit)'
        });
      }
    } else if (record.type === 'command.run' || record.type === 'command.denied') {
      const data = record.data as { argv?: string; exitCode?: number | null; deniedReason?: string };
      claims.push({
        seq: record.seq, type: record.type, messageId: record.messageId, status: 'recorded',
        detail: record.type === 'command.denied'
          ? `denied: ${data.deniedReason ?? 'no reason recorded'}`
          : `argv ${JSON.stringify(data.argv ?? '')} exit ${data.exitCode ?? 'n/a'} — output hashes are chain-verified only`
      });
    } else if (record.type === 'turn.usage') {
      claims.push({
        seq: record.seq, type: record.type, messageId: record.messageId, status: 'recorded',
        detail: 'token/cost receipt is chain-verified only'
      });
    } else if (record.type === 'turn.denied' || record.type === 'turn.cancelled') {
      claims.push({
        seq: record.seq, type: record.type, messageId: record.messageId, status: 'recorded',
        detail: (record.data as { reason?: string }).reason ?? 'no reason recorded'
      });
    }
  }

  const integrityFailures =
    tamperedRecords.length + brokenLinks.length + gaps.length + signatureFailures.length + unknownKeys.length;
  const holds = claims.filter((claim) => claim.status === 'holds').length;
  const invalidated = claims.filter((claim) => claim.status !== 'holds' && claim.status !== 'recorded').length;
  const summary = records.length === 0
    ? 'No proof records — nothing has been observed through the ledger yet.'
    : integrityFailures > 0 || truncatedTail
      ? `Chain integrity FAILED: ${tamperedRecords.length} tampered, ${brokenLinks.length} broken links, ${signatureFailures.length} bad signatures, ${unknownKeys.length} unknown keys${truncatedTail ? ', torn last line' : ''}.`
      : `${records.length} records, chain intact · ${holds} claim${holds === 1 ? '' : 's'} still hold, ${invalidated} invalidated.`;

  return {
    ranAt: (options.now ?? (() => Date.now()))(),
    workspace: options.workspace ?? '',
    totalRecords: records.length,
    // The offline verifier (`electron/proof-chain.cjs`) fails a half-written
    // tail line too; the renderer must agree or the two report different truths.
    chainValid: records.length > 0 && integrityFailures === 0 && !truncatedTail,
    tamperedRecords, brokenLinks, gaps, signatureFailures, unknownKeys,
    keyIds: [...publicKeys.keys()],
    truncatedTail,
    claims,
    summary
  };
}
