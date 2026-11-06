'use strict';
/**
 * The production proof writer.
 *
 * `electron/main.cjs` wires this up; `scripts/verify-proofs.mjs` and the tests
 * drive the same functions, so "what the app wrote" and "what the verifier
 * accepts" are the same code path by construction, not by convention.
 *
 * Storage is the disk store in `electron/proof-store.cjs` (one
 * `<userData>/proof-ledgers/<sha256(workspaceId)>/ledger.jsonl` per workspace,
 * append-only, 32 MiB cap); signing is the per-install key in
 * `electron/proof-keyring.cjs`; the record format is `electron/proof-chain.cjs`.
 *
 * Two families of events share the one chain:
 *   - machine observations (`command.run`, `command.denied`, `milestone.verified`)
 *   - self-healing failure receipts (`receipt.failure`, `receipt.update`),
 *     kept in the app-scope ledger `PROOF_APP_SCOPE` so they survive a restart
 *     even when the next session opens a different folder.
 */

const {
  GENESIS_HASH,
  PROOF_EVENT_TYPES,
  buildRecord,
  clipUtf8,
  lineOf,
  nodeEd25519,
  normalizeRecordFields,
  sanitizeData,
  sha256Hex,
  signedPayloadOf,
  verifyChainText
} = require('./proof-chain.cjs');

/** Ledger that receives failure receipts regardless of which folder is open. */
const PROOF_APP_SCOPE = 'shadrox.app';

const RECEIPT_SOURCES = ['test', 'preview', 'verify', 'compiler', 'terminal'];
const RECEIPT_STATUSES = ['captured', 'repair_proposed', 'repair_applied', 'verified_healed', 'healing_failed', 'rejected'];
/** Keys `createFailureReceipt()` always writes, so a reload must restore them. */
const ALWAYS_PRESENT_KEYS = ['stackTrace', 'diffSummary', 'checkpointId'];
const CONDITIONAL_KEYS = ['repairPatch', 'healedAt', 'verificationEvidence'];
const MAX_RECEIPTS_RETURNED = 500;

class ProofServiceError extends Error {}

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Bound a receipt before it enters the chain. Its text comes from command
 * output and model responses, i.e. untrusted data: every string is clipped to
 * a byte budget, arrays are length-capped, and `canonicalJson` escapes the rest
 * so no payload can forge a field or a line boundary.
 */
function normalizeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') throw new ProofServiceError('A failure receipt must be an object.');
  if (typeof receipt.id !== 'string' || receipt.id.length < 1 || receipt.id.length > 120) {
    throw new ProofServiceError('Failure receipt id is invalid.');
  }
  if (!RECEIPT_SOURCES.includes(receipt.source)) throw new ProofServiceError(`Unknown failure receipt source ${String(receipt.source)}.`);
  if (!RECEIPT_STATUSES.includes(receipt.status)) throw new ProofServiceError(`Unknown failure receipt status ${String(receipt.status)}.`);
  if (!Number.isSafeInteger(receipt.timestamp) || receipt.timestamp < 0) throw new ProofServiceError('Failure receipt timestamp is invalid.');

  const out = {
    id: receipt.id,
    source: receipt.source,
    target: clipUtf8(String(receipt.target ?? ''), 4096),
    timestamp: receipt.timestamp,
    exitCode: Number.isSafeInteger(receipt.exitCode) ? receipt.exitCode : null,
    errorMessage: clipUtf8(String(receipt.errorMessage ?? ''), 8192),
    status: receipt.status
  };
  for (const key of ALWAYS_PRESENT_KEYS) {
    if (receipt[key] === undefined) out[key] = undefined;
    else out[key] = clipUtf8(String(receipt[key]), key === 'diffSummary' ? 4096 : 8192);
  }
  out.diagnostics = Array.isArray(receipt.diagnostics)
    ? receipt.diagnostics.slice(0, 32).map((item) => ({
        file: clipUtf8(String(item?.file ?? ''), 512),
        line: Number.isSafeInteger(item?.line) ? item.line : 0,
        message: clipUtf8(String(item?.message ?? ''), 1024),
        ...(item?.severity === undefined ? {} : { severity: clipUtf8(String(item.severity), 32) })
      }))
    : [];
  out.consoleErrors = Array.isArray(receipt.consoleErrors)
    ? receipt.consoleErrors.slice(0, 32).map((item) => clipUtf8(String(item ?? ''), 1024))
    : [];
  out.relevantFiles = Array.isArray(receipt.relevantFiles)
    ? receipt.relevantFiles.slice(0, 64).map((item) => clipUtf8(String(item ?? ''), 512))
    : [];
  for (const key of CONDITIONAL_KEYS) {
    if (receipt[key] === undefined) continue;
    if (key === 'healedAt') {
      // Healing time is a timestamp, not prose: keep it numeric so a receipt
      // reads back with the type the renderer wrote.
      const healedAt = Number(receipt[key]);
      if (Number.isSafeInteger(healedAt) && healedAt >= 0) out[key] = healedAt;
      continue;
    }
    out[key] = clipUtf8(String(receipt[key]), 16384);
  }
  return out;
}

/** Rebuild a receipt exactly as stored: present keys in, absent keys out. */
function receiptFromStored(stored) {
  const out = {
    id: stored.id,
    source: stored.source,
    target: stored.target,
    timestamp: stored.timestamp,
    exitCode: stored.exitCode,
    errorMessage: stored.errorMessage,
    status: stored.status
  };
  for (const key of ALWAYS_PRESENT_KEYS) out[key] = stored[key];
  out.diagnostics = Array.isArray(stored.diagnostics) ? stored.diagnostics : [];
  out.consoleErrors = Array.isArray(stored.consoleErrors) ? stored.consoleErrors : [];
  out.relevantFiles = Array.isArray(stored.relevantFiles) ? stored.relevantFiles : [];
  for (const key of CONDITIONAL_KEYS) if (stored[key] !== undefined) out[key] = stored[key];
  return out;
}

function milestoneToData(proof) {
  if (!proof || typeof proof.id !== 'string' || !Number.isSafeInteger(proof.verifiedAt)) {
    throw new ProofServiceError('Milestone proof is missing an id or a verifiedAt timestamp.');
  }
  return sanitizeData(
    {
      milestoneProofId: proof.id,
      milestoneId: String(proof.milestoneId ?? '').slice(0, 120),
      title: clipUtf8(String(proof.title ?? ''), 512),
      verifiedAt: proof.verifiedAt,
      verdict: ['passed', 'failed', 'unverified'].includes(proof.verdict) ? proof.verdict : 'unverified',
      command: proof.command === undefined ? undefined : clipUtf8(String(proof.command), 4096),
      exitCode: Number.isSafeInteger(proof.exitCode) ? proof.exitCode : proof.exitCode === null ? null : undefined,
      diagnosticsCount: Number.isSafeInteger(proof.diagnosticsCount) ? proof.diagnosticsCount : 0
    },
    { maxStringBytes: 8 * 1024 }
  );
}

/**
 * @param {object} deps
 * @param {{readLedger:Function, appendLine:Function}} deps.store  `electron/proof-store.cjs`
 * @param {{ensure:Function, sign:Function, keyId:Function, registry:Function, rotate?:Function}} deps.keyring
 */
function createProofService({ store, keyring, now = () => Date.now(), maxRecordsForTail = 200_000 }) {
  if (!store || typeof store.readLedger !== 'function' || typeof store.appendLine !== 'function') {
    throw new ProofServiceError('The proof service needs a ledger store.');
  }
  if (!keyring || typeof keyring.sign !== 'function' || typeof keyring.keyId !== 'function') {
    throw new ProofServiceError('The proof service needs a signing keyring.');
  }

  const queues = new Map();

  function serialize(workspaceId, task) {
    const previous = queues.get(workspaceId) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(workspaceId, next.catch(() => undefined));
    return next;
  }

  async function readText(workspaceId) {
    const text = await store.readLedger(workspaceId);
    return typeof text === 'string' ? text : '';
  }

  /**
   * The tail of a chain: the sequence number to continue from and the payload
   * hash the next record must link to. The link is the *recomputed* hash of the
   * last record, so a ledger whose final line was edited makes the next append
   * fail loudly instead of quietly extending a broken chain.
   */
  async function tail(workspaceId) {
    const text = await readText(workspaceId);
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > maxRecordsForTail) throw new ProofServiceError('The proof ledger is implausibly large; refusing to append.');
    const last = lines[lines.length - 1];
    if (!last) return { seq: 0, hash: GENESIS_HASH };
    let parsed;
    try {
      parsed = JSON.parse(last);
    } catch {
      throw new ProofServiceError('The proof ledger ends with a torn record; run `npm run verify:proofs` before appending.');
    }
    let expected;
    try {
      expected = sha256Hex(signedPayloadOf(normalizeRecordFields(parsed)));
    } catch {
      throw new ProofServiceError('The last proof record is malformed; refusing to extend a damaged chain.');
    }
    if (expected !== parsed.hash) {
      throw new ProofServiceError(`Proof record ${parsed.seq} no longer matches its own hash; run \`npm run verify:proofs\` before appending.`);
    }
    return { seq: parsed.seq, hash: expected };
  }

  async function append(workspaceId, event) {
    if (typeof workspaceId !== 'string' || workspaceId.length < 1 || workspaceId.length > 200) {
      throw new ProofServiceError('Proof workspace id is invalid.');
    }
    if (!event || !PROOF_EVENT_TYPES.includes(event.type)) throw new ProofServiceError(`Unknown proof event type ${String(event?.type)}.`);
    return serialize(workspaceId, async () => {
      const identity = await keyring.ensure();
      const previous = await tail(workspaceId);
      const record = await buildRecord(
        {
          v: 1,
          seq: previous.seq + 1,
          ts: positiveInt(now(), Date.now()),
          workspace: workspaceId,
          type: event.type,
          actor: event.actor ?? 'system',
          messageId: event.messageId ?? null,
          data: sanitizeData(event.data ?? {}, event.limits ?? {}),
          prev: previous.hash,
          keyId: identity.keyId ?? (await keyring.keyId())
        },
        { sign: (text) => keyring.sign(text) }
      );
      await store.appendLine(workspaceId, lineOf(record));
      return record;
    });
  }

  async function appendReceipt(receipt, kind = 'receipt.failure') {
    if (!['receipt.failure', 'receipt.update'].includes(kind)) throw new ProofServiceError('Receipt events must be a failure or an update.');
    const stored = normalizeReceipt(receipt);
    const receiptHash = sha256Hex(JSON.stringify(canonicalReceipt(stored)));
    const record = await append(PROOF_APP_SCOPE, {
      type: kind,
      actor: 'system',
      messageId: null,
      data: { receiptId: stored.id, receipt: stored, receiptHash }
    });
    return { record, receiptHash };
  }

  async function appendMilestone(proof) {
    const data = milestoneToData(proof);
    return append(PROOF_APP_SCOPE, { type: 'milestone.verified', actor: 'system', data });
  }

  /**
   * Fold the app-scope chain back into receipts. The latest record for an id
   * wins, and each entry carries the `hash` of the record that produced it —
   * that is the proof hash a caller can re-check after a restart.
   */
  async function readReceipts(workspaceId = PROOF_APP_SCOPE) {
    const text = await readText(workspaceId);
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    // A receipt is only evidence if the chain under it verifies. A forged or
    // tampered line ends the trusted prefix, so nothing from it onward is
    // replayed — a hand-written "verified_healed" must never reach the UI.
    let firstBadSeq = Infinity;
    try {
      const identity = await keyring.ensure();
      const keys = new Map();
      for (const entry of identity.registry.keys) {
        keys.set(entry.keyId, nodeEd25519.publicKeyFromJwk(entry.publicJwk));
      }
      const report = await verifyChainText(text, {
        resolver: (keyId) => keys.get(keyId) ?? null,
        verifySig: (key, hash, signature) => nodeEd25519.verify(key, hash, signature)
      });
      if (!report.ok) {
        const bad = [
          ...report.tamperedRecords,
          ...report.brokenLinks,
          ...report.gaps,
          ...report.signatureFailures,
          ...report.unknownKeys
        ].filter((seq) => Number.isSafeInteger(seq) && seq > 0);
        if (bad.length > 0) firstBadSeq = Math.min(...bad);
        else return [];
      }
    } catch {
      // Without a verifiable key we cannot claim anything is proof-backed.
      return [];
    }
    const byId = new Map();
    const order = [];
    for (let index = 0; index < lines.length; index++) {
      let parsed;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (Number.isSafeInteger(parsed?.seq) && parsed.seq >= firstBadSeq) continue;
      if (!parsed || (parsed.type !== 'receipt.failure' && parsed.type !== 'receipt.update')) continue;
      const stored = parsed.data?.receipt;
      if (!stored || typeof stored.id !== 'string') continue;
      let receipt;
      try {
        receipt = receiptFromStored(stored);
      } catch {
        continue;
      }
      const entry = {
        receipt,
        receiptHash: typeof parsed.data.receiptHash === 'string' ? parsed.data.receiptHash : null,
        proofHash: typeof parsed.hash === 'string' ? parsed.hash : null,
        seq: parsed.seq,
        ts: parsed.ts,
        workspace: parsed.workspace
      };
      if (!byId.has(stored.id)) order.push(stored.id);
      byId.set(stored.id, entry);
    }
    return order
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => b.receipt.timestamp - a.receipt.timestamp)
      .slice(0, MAX_RECEIPTS_RETURNED);
  }

  async function readRecords(workspaceId = PROOF_APP_SCOPE) {
    const text = await readText(workspaceId);
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Chain + signature verification of one ledger, against the install keys. */
  async function verify(workspaceId = PROOF_APP_SCOPE) {
    const text = await readText(workspaceId);
    const registry = keyring.registry();
    const keys = new Map();
    for (const entry of registry.keys) keys.set(entry.keyId, nodeEd25519.publicKeyFromJwk(entry.publicJwk));
    const report = await verifyChainText(text, {
      resolver: (keyId) => keys.get(keyId) ?? null,
      verifySig: (key, hash, signature) => nodeEd25519.verify(key, hash, signature)
    });
    return { workspaceId, ...report, keyIds: [...keys.keys()] };
  }

  function describeFailure(report) {
    if (report.ok && !report.truncatedTail) return '';
    return `tampered ${report.tamperedRecords.length}, broken links ${report.brokenLinks.length}, gaps ${report.gaps.length}, bad signatures ${report.signatureFailures.length}, unknown keys ${report.unknownKeys.length}${report.truncatedTail ? ', torn last line' : ''}`;
  }

  return Object.freeze({
    PROOF_APP_SCOPE,
    append,
    appendMilestone,
    appendReceipt,
    describeFailure,
    normalizeReceipt,
    readReceipts,
    readRecords,
    receiptFromStored,
    rotate: keyring.rotate ? () => keyring.rotate() : undefined,
    verify
  });
}

/** Canonical (key-ordered) form of a receipt, used for its content fingerprint. */
function canonicalReceipt(receipt) {
  const keys = Object.keys(receipt)
    .filter((key) => receipt[key] !== undefined)
    .sort();
  const out = {};
  for (const key of keys) out[key] = receipt[key];
  return out;
}

module.exports = {
  PROOF_APP_SCOPE,
  ProofServiceError,
  canonicalReceipt,
  createProofService,
  normalizeReceipt,
  receiptFromStored
};
