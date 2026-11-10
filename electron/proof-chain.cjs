'use strict';
/**
 * The ONE canonical implementation of ShadRox's proof chain.
 *
 * Everything that decides what a proof record *means* lives here, so the
 * main-process writer (`electron/main.cjs` -> `electron/proof-service.cjs`),
 * the renderer ledger (`src/lib/proof/ledger.ts`, which re-exports this module)
 * and the offline verifier (`scripts/verify-proofs.mjs`) cannot drift apart.
 * A verifier that only agrees with its own writer is worthless; these pure
 * functions are the agreement.
 *
 * Record schema (one JSON object per line, `ledger.jsonl`):
 *
 *   { v, seq, ts, workspace, type, actor, messageId, data, prev, keyId, hash, sig }
 *
 *   v         schema version, RECORD_VERSION (1)
 *   seq       1-based, strictly increasing, no gaps
 *   ts        wall-clock ms at append time
 *   workspace the workspace id the event belongs to (app scope: 'shadrox.app')
 *   type      event type, see PROOF_EVENT_TYPES
 *   actor     'agent' | 'user' | 'plugin' | 'automation' | 'system'
 *   messageId correlating chat message id, or null
 *   data      event payload (untrusted, sanitized + size-capped by the writer)
 *   prev      hash of the previous record's payload (GENESIS_HASH for seq 1)
 *   keyId     'k-<12 hex>' = SHA-256 of the canonical public JWK that signed it
 *   hash      SHA-256 (hex) of canonicalJson(signed payload, i.e. everything
 *             except hash and sig)
 *   sig       base64 Ed25519 signature over the UTF-8 bytes of `hash`
 *
 * Tamper-evidence model: rewriting any signed field (including inside `data`)
 * changes `hash`; deleting, duplicating or reordering a line breaks `seq`/`prev`
 * and every later `hash`; and none of it can be re-signed without the private
 * half, which never enters this file. The payload cannot forge a line boundary
 * or a field: `canonicalJson` escapes every string with JSON string escaping
 * (quotes, backslashes, control characters, lone surrogates), drops nothing
 * silently, and refuses values that have no deterministic encoding.
 */

const crypto = typeof process !== 'undefined' && process.versions?.node
  ? require('node:crypto')
  : null;

function byteLength(text) {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
  return new TextEncoder().encode(text).byteLength;
}

const RECORD_VERSION = 1;
const GENESIS_HASH = '0'.repeat(64);
/** Hard ceiling for one ledger line; matches `electron/proof-store.cjs`. */
const MAX_LINE_BYTES = 256 * 1024;
/** Fields covered by the hash + signature, in canonical (sorted) order. */
const SIGNED_FIELDS = ['actor', 'data', 'keyId', 'messageId', 'prev', 'seq', 'ts', 'type', 'v', 'workspace'];
/** Same fields, writer order, for readability only; canonical order is sorted. */
const RECORD_FIELDS = ['v', 'seq', 'ts', 'workspace', 'type', 'actor', 'messageId', 'data', 'prev', 'keyId', 'hash', 'sig'];
const PROOF_ACTORS = ['agent', 'user', 'plugin', 'automation', 'system'];
const PROOF_EVENT_TYPES = [
  'turn.apply',
  'turn.denied',
  'turn.cancelled',
  'turn.usage',
  'turn.delta',
  'command.run',
  'command.denied',
  'milestone.verified',
  'receipt.failure',
  'receipt.update'
];

const MAX_DEPTH = 12;
const MAX_CANONICAL_BYTES = 200 * 1024;

class ProofChainError extends Error {}

function fail(message) {
  throw new ProofChainError(message);
}

/**
 * Deterministic JSON. Sorted object keys, JSON-escaped strings, no undefined
 * (an absent field and an undefined one are the same record), and a hard refusal
 * of anything without a stable encoding (NaN, Infinity, BigInt, functions,
 * symbols, cycles, over-deep or over-large payloads).
 */
function canonicalJson(value, options = {}) {
  const limit = options.maxBytes ?? MAX_CANONICAL_BYTES;
  const text = encodeCanonical(value, 0, { budget: limit });
  if (byteLength(text) > limit) {
    fail(`Canonical proof payload exceeds the ${limit} byte limit.`);
  }
  return text;
}

function encodeCanonical(value, depth, state) {
  if (depth > MAX_DEPTH) fail('Proof payload is nested too deeply.');
  if (value === null || value === undefined) return 'null';
  const kind = typeof value;
  if (kind === 'number') {
    if (!Number.isFinite(value)) fail('Proof payload contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'string') return bounded(() => JSON.stringify(value), state);
  if (kind === 'bigint' || kind === 'function' || kind === 'symbol') {
    fail(`Proof payload contains a ${kind} value with no canonical encoding.`);
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let index = 0; index < value.length; index++) {
      if (index > 0) out += ',';
      const item = value[index];
      // `undefined` inside an array has no meaning here: encode it as null so
      // the pre-image is reproducible from the stored record.
      out += encodeCanonical(item === undefined ? null : item, depth + 1, state);
    }
    return `${out}]`;
  }
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${bounded(() => JSON.stringify(key), state)}:${encodeCanonical(value[key], depth + 1, state)}`);
  return `{${entries.join(',')}}`;
}

function bounded(render, state) {
  const text = render();
  state.budget -= byteLength(text);
  if (state.budget < 0) fail('Proof payload is too large to canonicalize.');
  return text;
}

/** Validate + normalize the fields a record must carry before it is hashed. */
function normalizeRecordFields(record) {
  if (!record || typeof record !== 'object') fail('Proof record must be an object.');
  if (record.v !== RECORD_VERSION) fail(`Proof record version ${String(record.v)} is not supported.`);
  if (!Number.isSafeInteger(record.seq) || record.seq < 1) fail('Proof record seq must be a positive safe integer.');
  if (!Number.isSafeInteger(record.ts) || record.ts < 0) fail('Proof record ts must be a non-negative safe integer.');
  if (typeof record.workspace !== 'string' || record.workspace.length < 1 || record.workspace.length > 200) {
    fail('Proof record workspace is invalid.');
  }
  if (typeof record.type !== 'string' || !PROOF_EVENT_TYPES.includes(record.type)) {
    fail(`Unknown proof event type ${String(record.type)}.`);
  }
  if (typeof record.actor !== 'string' || !PROOF_ACTORS.includes(record.actor)) {
    fail(`Unknown proof actor ${String(record.actor)}.`);
  }
  if (record.messageId !== null && record.messageId !== undefined && typeof record.messageId !== 'string') {
    fail('Proof record messageId must be a string or null.');
  }
  if (record.data === undefined || record.data === null) {
    fail('Proof record data is required (use {} for an empty payload).');
  }
  if (typeof record.data !== 'object' || Array.isArray(record.data)) fail('Proof record data must be an object.');
  if (typeof record.prev !== 'string' || !/^[0-9a-f]{64}$/.test(record.prev)) fail('Proof record prev is not a hash.');
  if (typeof record.keyId !== 'string' || !/^k-[0-9a-f]{12}$/.test(record.keyId)) fail('Proof record keyId is malformed.');
  return {
    v: RECORD_VERSION,
    seq: record.seq,
    ts: record.ts,
    workspace: record.workspace,
    type: record.type,
    actor: record.actor,
    messageId: record.messageId ?? null,
    data: record.data,
    prev: record.prev,
    keyId: record.keyId
  };
}

/** The signed pre-image: canonical JSON of every field except `hash` and `sig`. */
function signedPayloadOf(record) {
  const fields = {};
  for (const name of SIGNED_FIELDS) fields[name] = record[name];
  return canonicalJson(fields);
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Public JWKs as exported by Node (`{crv,kty,x}`) and by WebCrypto
 * (`{crv,kty,x,key_ops}`) describe the same key; normalizing to the three
 * required members makes `keyId` identical across both crypto backends, which
 * is what lets one ledger verify from the main process, the renderer and a CLI.
 */
function normalizePublicJwk(jwk) {
  if (!jwk || typeof jwk !== 'object') fail('Proof public key must be a JWK object.');
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') fail('Proof keys must be OKP/Ed25519.');
  if (typeof jwk.x !== 'string' || jwk.x.length === 0) fail('Proof public key is missing its public part.');
  return { crv: 'Ed25519', kty: 'OKP', x: jwk.x };
}

function keyIdOfPublicJwk(jwk) {
  return `k-${sha256Hex(canonicalJson(normalizePublicJwk(jwk))).slice(0, 12)}`;
}

/**
 * Same fingerprint for callers whose SHA-256 is asynchronous (the renderer's
 * WebCrypto), so a key id computed in Chromium and a key id computed in Node
 * are byte-identical.
 */
async function keyIdOfPublicJwkAsync(jwk, digestHex) {
  return `k-${(await digestHex(canonicalJson(normalizePublicJwk(jwk)))).slice(0, 12)}`;
}

/** base64url <-> bytes, for the raw Ed25519 key material WebCrypto and Node share. */
function base64UrlToBuffer(text) {
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function bufferToBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Node's built-in Ed25519, shaped like the renderer's WebCrypto adapter so
 * `buildRecord` / `verifyChain` take either one.
 */
const nodeEd25519 = {
  digestHex: async (text) => sha256Hex(text),
  generate() {
    const pair = crypto.generateKeyPairSync('ed25519');
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  },
  publicJwkOf(publicKey) {
    return normalizePublicJwk(typeof publicKey === 'string' ? publicKey : publicKey.export({ format: 'jwk' }));
  },
  privateJwkOf(privateKey) {
    return privateKey.export({ format: 'jwk' });
  },
  publicKeyFromJwk(jwk) {
    return crypto.createPublicKey({ key: normalizePublicJwk(jwk), format: 'jwk' });
  },
  privateKeyFromJwk(jwk) {
    return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  },
  async sign(privateKey, text) {
    return crypto.sign(null, Buffer.from(String(text), 'utf8'), privateKey).toString('base64');
  },
  async verify(publicKey, text, signature) {
    try {
      return crypto.verify(null, Buffer.from(String(text), 'utf8'), publicKey, Buffer.from(String(signature), 'base64'));
    } catch {
      return false;
    }
  }
};

/**
 * Hash and sign an unsigned record. `signer` is `{ sign(text) -> base64 }`
 * (main process) or anything else that can produce a base64 Ed25519 signature.
 */
async function buildRecord(unsigned, { sign, digestHex = async (text) => sha256Hex(text) }) {
  const fields = normalizeRecordFields(unsigned);
  const hash = await digestHex(signedPayloadOf(fields));
  const sig = await sign(hash);
  if (typeof sig !== 'string' || sig.length === 0) fail('Proof signer returned no signature.');
  const record = { ...fields, hash, sig };
  return record;
}

/** Serialize one record to a ledger line: canonical field order, no line breaks. */
function lineOf(record) {
  if (!record || typeof record !== 'object') fail('Proof record must be an object.');
  const ordered = {};
  for (const name of RECORD_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, name)) ordered[name] = record[name];
  }
  for (const name of Object.keys(record)) {
    if (!RECORD_FIELDS.includes(name)) ordered[name] = record[name];
  }
  const text = JSON.stringify(ordered);
  if (/[\r\n]/.test(text)) fail('Proof record serialized to a value containing a line break.');
  const bytes = byteLength(text);
  if (bytes > MAX_LINE_BYTES) fail(`Proof record is ${bytes} bytes; the per-line limit is ${MAX_LINE_BYTES}.`);
  return text;
}

function parseRecordLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

/** JSONL split that keeps the torn-tail signal a crashed append leaves behind. */
function splitRecordLines(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const records = [];
  const corruptLines = [];
  let truncatedTail = false;
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseRecordLine(lines[index]);
    if (parsed) records.push(parsed);
    else if (index === lines.length - 1) truncatedTail = true;
    else corruptLines.push(index + 1);
  }
  return { records, corruptLines, truncatedTail };
}

/**
 * Walk a chain. Returns every class of integrity failure separately so a report
 * can say what happened instead of just "invalid".
 *
 * `resolver(keyId)` must return whatever `verifySig` needs (a Node KeyObject, a
 * CryptoKey) or null when the key is unknown.
 */
async function verifyChain(records, { verifySig, digestHex = async (text) => sha256Hex(text), resolver, corruptLines = [], truncatedTail = false }) {
  const tamperedRecords = [...corruptLines];
  const brokenLinks = [];
  const gaps = [];
  const signatureFailures = [];
  const unknownKeys = [];
  let previousHash = GENESIS_HASH;
  let previousSeq = 0;

  for (const record of records) {
    const seq = Number.isSafeInteger(record.seq) && record.seq >= 1 ? record.seq : 0;
    let fields = null;
    try {
      fields = normalizeRecordFields(record);
    } catch {
      tamperedRecords.push(seq);
      continue;
    }
    const expected = await digestHex(signedPayloadOf(fields));
    if (expected !== record.hash) tamperedRecords.push(fields.seq);
    if (fields.prev !== previousHash) brokenLinks.push(fields.seq);
    if (fields.seq !== previousSeq + 1) gaps.push(fields.seq);

    const key = await Promise.resolve(resolver(fields.keyId));
    if (!key) unknownKeys.push(fields.seq);
    else if (!(await verifySig(key, record.hash, record.sig))) signatureFailures.push(fields.seq);

    previousSeq = fields.seq;
    // The recomputed hash, not the stored one: a rewritten record must break the
    // link for every later record too.
    previousHash = expected;
  }

  const failures =
    tamperedRecords.length + brokenLinks.length + gaps.length + signatureFailures.length + unknownKeys.length
    // A half-written last line is a damaged ledger: the record it was writing
    // is gone and nothing after it can be trusted to be contiguous. Reported
    // separately as `truncatedTail`, and it fails the chain.
    + (truncatedTail ? 1 : 0);
  return {
    totalRecords: records.length,
    ok: failures === 0,
    failures,
    tamperedRecords,
    brokenLinks,
    gaps,
    signatureFailures,
    unknownKeys,
    truncatedTail
  };
}

/** Verify a whole ledger file from its text. Used by the CLI and the service. */
async function verifyChainText(text, options) {
  const { records, corruptLines, truncatedTail } = splitRecordLines(text);
  const report = await verifyChain(records, { ...options, corruptLines, truncatedTail });
  return report;
}

/**
 * Size-bounded, copy-only sanitization for payloads built from untrusted data
 * (command output, stderr, model text, receipts). It cannot make the chain
 * forge anything — `canonicalJson` already escapes that — but it keeps one
 * record from filling the ledger with a megabyte of ANSI noise.
 */
const SANITIZE_DEFAULTS = {
  maxStringBytes: 8 * 1024,
  maxArrayLength: 64,
  maxObjectKeys: 64,
  maxDepth: 6
};

function sanitizeValue(value, limits, depth = 0) {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === 'number') return Number.isFinite(value) ? value : null;
  if (kind === 'boolean') return value;
  if (kind === 'string') return clipUtf8(value, limits.maxStringBytes);
  if (depth >= limits.maxDepth) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxArrayLength).map((item) => sanitizeValue(item, limits, depth + 1));
  }
  if (kind === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, limits.maxObjectKeys)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      // An undefined field is an absent field: keeping it would turn
      // `stackTrace: undefined` into `stackTrace: null` and change the record.
      if (value[key] === undefined) continue;
      out[clipUtf8(key, 256)] = sanitizeValue(value[key], limits, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, limits.maxStringBytes);
}

function sanitizeData(data, overrides = {}) {
  const limits = { ...SANITIZE_DEFAULTS, ...overrides };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const key of Object.keys(data).slice(0, limits.maxObjectKeys)) {
    out[key] = sanitizeValue(data[key], limits);
  }
  return out;
}

function clipUtf8(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
  return `${text.slice(0, end)}…[clipped]`;
}

function publicRegistryFromKeys(keys) {
  return {
    v: 1,
    current: null,
    keys: (Array.isArray(keys) ? keys : []).map((entry) => ({
      keyId: entry.keyId,
      publicJwk: normalizePublicJwk(entry.publicJwk),
      createdAt: entry.createdAt
    }))
  };
}

module.exports = {
  GENESIS_HASH,
  MAX_LINE_BYTES,
  PROOF_ACTORS,
  PROOF_EVENT_TYPES,
  RECORD_FIELDS,
  RECORD_VERSION,
  ProofChainError,
  base64UrlToBuffer,
  bufferToBase64Url,
  buildRecord,
  canonicalJson,
  clipUtf8,
  keyIdOfPublicJwk,
  keyIdOfPublicJwkAsync,
  lineOf,
  nodeEd25519,
  normalizePublicJwk,
  normalizeRecordFields,
  parseRecordLine,
  publicRegistryFromKeys,
  sanitizeData,
  sha256Hex,
  signedPayloadOf,
  splitRecordLines,
  verifyChain,
  verifyChainText
};
