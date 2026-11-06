/**
 * Proof Ledger — an append-only, Ed25519 hash-chained record of every agent
 * action that touched the machine. One JSON line per event:
 *
 *   timestamp · workspace · action type · before/after SHA-256 · command argv
 *   · cwd · exit code · stdout/stderr HASHES (never content) · model+provider
 *   · token counts · cost estimate · denials/cancellations · failure receipts.
 *
 * The record format and every piece of chain math (canonical serialization,
 * payload hashing, prev-linking, sequence rules) come from
 * `electron/proof-chain.cjs` — the single implementation shared with the real
 * main-process writer (`electron/main.cjs` via `electron/proof-service.cjs`)
 * and the offline verifier (`npm run verify:proofs`). Nothing in this file
 * re-derives a hash: if the two ever disagreed, the app's own ledger would
 * fail its own audit, and that is exactly the bug this module exists to prevent.
 *
 * Storage is app-local and indexed by workspace id; the signing key lives in
 * the OS-encrypted store rather than in the opened project. The trust model,
 * stated honestly: the chain detects edits to the ledger file itself (someone
 * rewriting a claim after the fact); it is tamper-*evidence*, not tamper-
 * *proof* — an attacker who can edit every file in the workspace wholesale is
 * out of scope for a local-first tool. Keys are local; rotation appends a new
 * public key and later events sign with it, so old events stay verifiable.
 *
 * All IO is injected so this module runs unchanged in the renderer (desktop
 * bridge), in tests (in-memory), and in a CLI.
 */

import {
  GENESIS_HASH,
  RECORD_VERSION,
  buildRecord,
  canonicalJson as sharedCanonicalJson,
  keyIdOfPublicJwkAsync,
  lineOf,
  normalizeRecordFields,
  sanitizeData,
  signedPayloadOf,
  verifyChain
} from '../../../electron/proof-chain.cjs';

export type ProofEventType =
  | 'turn.apply'
  | 'turn.denied'
  | 'turn.cancelled'
  | 'turn.usage'
  | 'turn.delta'
  | 'command.run'
  | 'command.denied'
  | 'milestone.verified'
  | 'receipt.failure'
  | 'receipt.update';

export type ProofActor = 'agent' | 'user' | 'plugin' | 'automation' | 'system';

export interface ProofEventInput {
  type: ProofEventType;
  actor: ProofActor;
  messageId?: string | null;
  data: Record<string, unknown>;
}

export interface ProofRecord {
  v: 1;
  seq: number;
  ts: number;
  workspace: string;
  type: ProofEventType;
  actor: ProofActor;
  messageId: string | null;
  data: Record<string, unknown>;
  prev: string;
  keyId: string;
  hash: string;
  sig: string;
}

export interface ProofLedgerIo {
  readLedger(): Promise<string | null>;
  appendLine(line: string): Promise<void>;
  readKeys(): Promise<string | null>;
  writeKeys(text: string): Promise<void>;
}

export interface KeyEntry {
  keyId: string;
  publicJwk: JsonWebKey;
  createdAt: number;
}

export interface KeyRegistry {
  current: string;
  keys: KeyEntry[];
  private?: { keyId: string; jwk: JsonWebKey };
}

/** Ed25519 via WebCrypto — the same code path in Chromium (Electron 44) and Node ≥22. */
export interface ProofCrypto {
  generate(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>;
  importPrivate(jwk: JsonWebKey): Promise<CryptoKey>;
  importPublic(jwk: JsonWebKey): Promise<CryptoKey>;
  sign(key: CryptoKey, text: string): Promise<string>;
  verify(key: CryptoKey, text: string, signature: string): Promise<boolean>;
  /**
   * Optional SHA-256 override. Hashing defaults to Node's; a renderer that
   * bundles this module without `node:crypto` injects `crypto.subtle.digest`.
   */
  digestHex?: (text: string) => Promise<string>;
}

const ED25519 = { name: 'Ed25519' } as unknown as AlgorithmIdentifier;

export const webcryptoEd25519: ProofCrypto = {
  async generate() {
    const pair = await globalThis.crypto.subtle.generateKey(ED25519, true, ['sign', 'verify']);
    if (!('privateKey' in pair)) throw new Error('Ed25519 key generation did not return a key pair.');
    return { privateKey: pair.privateKey, publicKey: pair.publicKey };
  },
  async importPrivate(jwk) {
    return globalThis.crypto.subtle.importKey('jwk', jwk, ED25519, true, ['sign']);
  },
  async importPublic(jwk) {
    return globalThis.crypto.subtle.importKey('jwk', jwk, ED25519, true, ['verify']);
  },
  async sign(key, text) {
    const bytes = await globalThis.crypto.subtle.sign(ED25519, key, asBufferSource(new TextEncoder().encode(text)));
    return base64(new Uint8Array(bytes));
  },
  async verify(key, text, signature) {
    try {
      return await globalThis.crypto.subtle.verify(
        ED25519,
        key,
        asBufferSource(fromBase64(signature)),
        asBufferSource(new TextEncoder().encode(text))
      );
    } catch {
      return false;
    }
  },
  async digestHex(text) {
    return sha256Hex(text);
  }
};

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', asBufferSource(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function asBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Deterministic JSON, delegated to the shared chain module so a payload that
 * hashes to one value in the main process hashes to the same value here.
 */
export const canonicalJson = sharedCanonicalJson;

/** The signed pre-image: everything except the `hash` and `sig` fields. */
export function unsignedOf(record: Omit<ProofRecord, 'sig'> | ProofRecord): string {
  return signedPayloadOf(record);
}

const PROOF_GENESIS = GENESIS_HASH;

export interface ProofLedgerOptions {
  workspace: string;
  crypto?: ProofCrypto;
  now?: () => number;
  maxLineBytes?: number;
}

/**
 * One ledger per workspace. Appends are serialized through an internal chain
 * so two events recorded in the same tick still get a strictly ordered chain.
 * Every failure surfaces as a thrown error to the recorder, which is the
 * component that decides to mark the turn unverified — the ledger itself never
 * swallows a corruption silently.
 */
export class ProofLedger {
  readonly workspace: string;
  private io: ProofLedgerIo;
  private crypto: ProofCrypto;
  private now: () => number;
  private maxLineBytes: number;
  private tail: { seq: number; hash: string } | null = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private privateSigner: { keyId: string; key: CryptoKey } | null = null;
  private registry: KeyRegistry | null = null;
  private truncatedTail = false;

  constructor(io: ProofLedgerIo, options: ProofLedgerOptions) {
    this.io = io;
    this.workspace = options.workspace;
    this.crypto = options.crypto ?? webcryptoEd25519;
    this.now = options.now ?? (() => Date.now());
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024;
  }

  /** True when the last line of the stored file was half-written (crash cut). */
  get sawTruncatedTail(): boolean { return this.truncatedTail; }

  private digestHex(text: string): Promise<string> {
    return this.crypto.digestHex ? this.crypto.digestHex(text) : sha256Hex(text);
  }

  private async keyIdOf(publicJwk: JsonWebKey): Promise<string> {
    return keyIdOfPublicJwkAsync(publicJwk, (text) => this.digestHex(text));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.tail && this.registry && this.privateSigner) return;
    if (!this.loading) {
      this.loading = (async () => {
        const text = await this.io.readLedger();
        const lines = (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
        const records: ProofRecord[] = [];
        for (let i = 0; i < lines.length; i++) {
          try {
            records.push(JSON.parse(lines[i]) as ProofRecord);
          } catch {
            if (i === lines.length - 1) this.truncatedTail = true;
            else throw new Error(`Proof ledger line ${i + 1} is corrupt; refusing to append onto a damaged chain.`);
          }
        }
        if (this.truncatedTail) {
          throw new Error('The proof ledger ends with a torn record; verify or repair it before appending.');
        }
        const keysText = await this.io.readKeys();
        let registry: KeyRegistry | null = null;
        try {
          registry = keysText ? JSON.parse(keysText) as KeyRegistry : null;
        } catch (error) {
          throw new Error('The encrypted proof-key registry is unreadable; refusing to replace it.', { cause: error });
        }
        if (!registry) {
          if (keysText !== null) throw new Error('The proof-key registry is invalid; refusing to replace it.');
          if (records.length > 0) throw new Error('Proof records exist without a key registry; refusing to append an unverifiable event.');
          const { privateKey, publicKey } = await this.crypto.generate();
          const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', publicKey);
          const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
          const keyId = await this.keyIdOf(publicJwk);
          registry = { current: keyId, keys: [{ keyId, publicJwk, createdAt: this.now() }], private: { keyId, jwk: privateJwk } };
          await this.io.writeKeys(JSON.stringify(registry, null, 2));
        }
        if (!registry.current || !Array.isArray(registry.keys) || registry.keys.length === 0 || !registry.private) {
          throw new Error('The proof-key registry is incomplete; refusing to replace it.');
        }
        const publicKeys = new Map<string, CryptoKey>();
        for (const entry of registry.keys) {
          if (await this.keyIdOf(entry.publicJwk) !== entry.keyId) {
            throw new Error(`Proof key ${entry.keyId} does not match its public-key fingerprint.`);
          }
          publicKeys.set(entry.keyId, await this.crypto.importPublic(entry.publicJwk));
        }

        // Chain integrity comes from the shared verifier, not a local re-run.
        const report = await verifyChain(records as unknown as Record<string, unknown>[], {
          digestHex: (value) => this.digestHex(value),
          resolver: (keyId: string) => publicKeys.get(keyId) ?? null,
          verifySig: (key: CryptoKey, hash: string, signature: string) => this.crypto.verify(key, hash, signature)
        });
        if (report.totalRecords !== records.length) {
          throw new Error('The proof ledger changed shape while it was being read; refusing to append.');
        }
        if (!report.ok) {
          throw new Error(
            `Proof ledger failed chain verification at records ${[
              ...new Set([...report.tamperedRecords, ...report.brokenLinks, ...report.gaps, ...report.signatureFailures, ...report.unknownKeys])
            ].join(', ')}; refusing to append.`
          );
        }

        const last = records[records.length - 1];
        this.tail = last ? { seq: last.seq, hash: await this.digestHex(unsignedOf(last)) } : null;
        const currentEntry = registry.keys.find((item) => item.keyId === registry!.current);
        if (!currentEntry || registry.private.keyId !== currentEntry.keyId) {
          throw new Error('The current proof signing key is not present in the registry.');
        }
        this.registry = registry;
        const key = await this.crypto.importPrivate(registry.private.jwk);
        const signingPublic = publicKeys.get(registry.private.keyId);
        if (!signingPublic) throw new Error('The active proof key has no registered public key.');
        const challenge = `ShadRox proof key check:${registry.private.keyId}`;
        const signature = await this.crypto.sign(key, challenge);
        if (!(await this.crypto.verify(signingPublic, challenge, signature))) {
          throw new Error('The encrypted proof signing key does not match its public key.');
        }
        this.privateSigner = { keyId: registry.private.keyId, key };
      })().finally(() => { this.loading = null; });
    }
    await this.loading;
  }

  /**
   * Key rotation: a fresh Ed25519 pair becomes the signer for *later* events;
   * the public half of every previous key stays in the registry so old events
   * keep verifying. Documented policy: one keypair per workspace, rotated on
   * demand (or by deleting the registry and starting a new chain).
   */
  async rotateKey(): Promise<string> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const { privateKey, publicKey } = await this.crypto.generate();
      const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', publicKey);
      const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
      const keyId = await this.keyIdOf(publicJwk);
      const registry: KeyRegistry = {
        current: keyId,
        keys: [...(this.registry?.keys ?? []), { keyId, publicJwk, createdAt: this.now() }],
        private: { keyId, jwk: privateJwk }
      };
      await this.io.writeKeys(JSON.stringify(registry, null, 2));
      this.registry = registry;
      this.privateSigner = { keyId, key: await this.crypto.importPrivate(privateJwk) };
      return keyId;
    }) as Promise<string>;
  }

  serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async append(event: ProofEventInput): Promise<ProofRecord> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const record = await buildRecord(
        {
          v: RECORD_VERSION,
          seq: (this.tail?.seq ?? 0) + 1,
          ts: this.now(),
          workspace: this.workspace,
          type: event.type,
          actor: event.actor,
          messageId: event.messageId ?? null,
          // Untrusted payloads are size-bounded and escaped before they are
          // hashed, so command output can never forge a field or a line.
          data: sanitizeData(event.data ?? {}),
          prev: this.tail?.hash ?? PROOF_GENESIS,
          keyId: this.privateSigner!.keyId
        },
        {
          sign: (text: string) => this.crypto.sign(this.privateSigner!.key, text),
          digestHex: (text: string) => this.digestHex(text)
        }
      );
      const line = lineOf(record);
      if (new TextEncoder().encode(line).length > this.maxLineBytes) {
        throw new Error(`Proof event is over ${this.maxLineBytes} bytes; refusing to bloat the ledger.`);
      }
      await this.io.appendLine(line);
      this.tail = { seq: record.seq, hash: record.hash };
      return record as ProofRecord;
    });
  }
}
