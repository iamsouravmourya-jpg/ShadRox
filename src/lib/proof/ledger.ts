/**
 * Proof Ledger — an append-only, Ed25519 hash-chained record of every agent
 * action that touched the machine. One JSON line per event:
 *
 *   timestamp · workspace · action type · before/after SHA-256 · command argv
 *   · cwd · exit code · stdout/stderr HASHES (never content) · model+provider
 *   · token counts · cost estimate · denials/cancellations.
 *
 * Storage is app-local and indexed by workspace id; the key registry is kept
 * behind Electron safeStorage rather than in the opened project. The trust model, stated
 * honestly: the chain detects edits to the ledger file itself (someone
 * rewriting a claim after the fact); it is tamper-*evidence*, not tamper-
 * *proof* — an attacker who can edit every file in the workspace wholesale is
 * out of scope for a local-first tool. Keys are per-workspace and local;
 * rotation appends a new public key and later events sign with it, so old
 * events stay verifiable.
 *
 * All IO is injected so this module runs unchanged in the renderer (desktop
 * bridge), in tests (in-memory), and later in a CLI.
 */

export type ProofEventType =
  | 'turn.apply'
  | 'turn.denied'
  | 'turn.cancelled'
  | 'turn.usage'
  | 'turn.delta'
  | 'command.run'
  | 'command.denied';

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

/** Deterministic JSON: object keys sorted so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** The signed pre-image: everything except the sig field itself. */
export function unsignedOf(record: Omit<ProofRecord, 'sig'>): string {
  return canonicalJson({
    v: record.v, seq: record.seq, ts: record.ts, workspace: record.workspace,
    type: record.type, actor: record.actor, messageId: record.messageId,
    data: record.data, prev: record.prev, keyId: record.keyId
  });
}

async function keyIdFor(publicJwk: JsonWebKey): Promise<string> {
  return `k-${(await sha256Hex(canonicalJson(publicJwk))).slice(0, 12)}`;
}

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
  }

  /** True when the last line of the stored file was half-written (crash cut). */
  get sawTruncatedTail(): boolean { return this.truncatedTail; }

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
          const keyId = await keyIdFor(publicJwk);
          registry = { current: keyId, keys: [{ keyId, publicJwk, createdAt: this.now() }], private: { keyId, jwk: privateJwk } };
          await this.io.writeKeys(JSON.stringify(registry, null, 2));
        }
        if (!registry.current || !Array.isArray(registry.keys) || registry.keys.length === 0 || !registry.private) {
          throw new Error('The proof-key registry is incomplete; refusing to replace it.');
        }
        const publicKeys = new Map<string, CryptoKey>();
        for (const entry of registry.keys) {
          if (await keyIdFor(entry.publicJwk) !== entry.keyId) {
            throw new Error(`Proof key ${entry.keyId} does not match its public-key fingerprint.`);
          }
          publicKeys.set(entry.keyId, await this.crypto.importPublic(entry.publicJwk));
        }
        let expectedSeq = 1;
        let previousHash = '0'.repeat(64);
        for (const record of records) {
          const publicKey = publicKeys.get(record.keyId);
          if (
            record.workspace !== this.workspace ||
            record.seq !== expectedSeq ||
            record.prev !== previousHash ||
            !publicKey ||
            !(await this.crypto.verify(publicKey, record.hash, record.sig)) ||
            (await sha256Hex(unsignedOf(record))) !== record.hash
          ) {
            throw new Error(`Proof ledger record ${expectedSeq} failed chain or signature verification; refusing to append.`);
          }
          expectedSeq += 1;
          previousHash = record.hash;
        }
        this.tail = records.length > 0
          ? { seq: records[records.length - 1].seq, hash: records[records.length - 1].hash }
          : null;
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
   * demand (or by deleting `.shadrox/proof-keys.json` and starting a new chain).
   */
  async rotateKey(): Promise<string> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const { privateKey, publicKey } = await this.crypto.generate();
      const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', publicKey);
      const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', privateKey);
      const keyId = await keyIdFor(publicJwk);
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
      const seq = (this.tail?.seq ?? 0) + 1;
      const prev = this.tail?.hash ?? '0'.repeat(64);
      const unsigned: Omit<ProofRecord, 'sig' | 'hash'> = {
        v: 1,
        seq,
        ts: this.now(),
        workspace: this.workspace,
        type: event.type,
        actor: event.actor,
        messageId: event.messageId ?? null,
        data: event.data,
        prev,
        keyId: this.privateSigner!.keyId
      };
      const hash = await sha256Hex(canonicalJson(unsigned));
      const sig = await this.crypto.sign(this.privateSigner!.key, hash);
      const record: ProofRecord = { ...unsigned, hash, sig };
      const line = JSON.stringify(record);
      if (line.length > 256 * 1024) throw new Error('Proof event exceeds 256KB; refusing to bloat the ledger.');
      await this.io.appendLine(line);
      this.tail = { seq, hash };
      return record;
    });
  }
}
