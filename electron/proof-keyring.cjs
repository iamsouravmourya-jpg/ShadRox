'use strict';
/**
 * Per-install proof signing key.
 *
 * One Ed25519 keypair identifies this ShadRox install. It signs every proof
 * record the app writes, for every workspace. Two files live in
 * `<userData>/proof-keys/`:
 *
 *   keys.pub.json      the public registry: `{ v, current, keys: [ { keyId,
 *                      publicJwk, createdAt } ] }`. Plaintext on purpose — it
 *                      holds no secret, and `scripts/verify-proofs.mjs` has to
 *                      read it without Electron's `safeStorage` in scope.
 *   keys.private.enc   the private half, JSON-encrypted through the same
 *                      `safeStorage` mechanism `electron/main.cjs` already uses
 *                      for provider API keys (`secure:set` writes base64 of
 *                      `safeStorage.encryptString(...)`, mode 0600). Nothing
 *                      here invents a new secrets mechanism, and the private
 *                      key is never written in the clear or into the ledger.
 *
 * Rotation policy: `rotate()` appends the new public key and keeps the old ones,
 * so records signed earlier still verify. When the OS keychain is unavailable
 * (Linux session without a keyring, a stripped CI box), the private half is
 * kept in memory only for this process, and its public half is still recorded
 * so the chain written during that session stays verifiable afterwards. The
 * ledger is then honest about its limits rather than silently unsigned.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { keyIdOfPublicJwk, nodeEd25519, normalizePublicJwk } = require('./proof-chain.cjs');

const PUBLIC_FILE = 'keys.pub.json';
const PRIVATE_FILE = 'keys.private.enc';
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_PRIVATE_BYTES = 64 * 1024;

class ProofKeyringError extends Error {}

function createProofKeyring({
  dir,
  safeStorage,
  fileSystem = fs,
  now = () => Date.now(),
  randomId = () => crypto.randomUUID()
}) {
  if (typeof dir !== 'string' || dir.length === 0) throw new ProofKeyringError('Proof keyring needs a directory.');
  const publicPath = path.join(dir, PUBLIC_FILE);
  const privatePath = path.join(dir, PRIVATE_FILE);

  let state = null;

  function encryptionAvailable() {
    try {
      return Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  function readPublic() {
    let text;
    try {
      text = fileSystem.readFileSync(publicPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { v: 1, current: null, keys: [] };
      throw new ProofKeyringError(`The proof public-key registry could not be read: ${error.message}`, { cause: error });
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_BYTES) throw new ProofKeyringError('The proof public-key registry is oversized.');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ProofKeyringError('The proof public-key registry is corrupt.', { cause: error });
    }
    if (!parsed || !Array.isArray(parsed.keys)) throw new ProofKeyringError('The proof public-key registry is malformed.');
    const keys = [];
    for (const entry of parsed.keys) {
      if (!entry || typeof entry.keyId !== 'string' || !entry.publicJwk) continue;
      const jwk = normalizePublicJwk(entry.publicJwk);
      if (keyIdOfPublicJwk(jwk) !== entry.keyId) {
        throw new ProofKeyringError(`Proof key ${entry.keyId} does not match its public key fingerprint.`);
      }
      keys.push({ keyId: entry.keyId, publicJwk: jwk, createdAt: Number.isSafeInteger(entry.createdAt) ? entry.createdAt : 0 });
    }
    return { v: 1, current: typeof parsed.current === 'string' ? parsed.current : null, keys };
  }

  function writePublic(registry) {
    fileSystem.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${publicPath}.${randomId()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fileSystem.renameSync(temporary, publicPath);
    } catch (error) {
      try {
        fileSystem.rmSync(temporary, { force: true });
      } catch {
        /* nothing to clean */
      }
      throw new ProofKeyringError(`The proof public-key registry could not be written: ${error.message}`, { cause: error });
    }
  }

  function readPrivate() {
    let buffer;
    try {
      buffer = fileSystem.readFileSync(privatePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new ProofKeyringError(`The encrypted proof key could not be read: ${error.message}`, { cause: error });
    }
    if (buffer.length > MAX_PRIVATE_BYTES) throw new ProofKeyringError('The encrypted proof key is oversized.');
    if (!encryptionAvailable()) {
      // The file exists but this session cannot decrypt it. Refuse to silently
      // start a second identity over the top of the first one.
      throw new ProofKeyringError('OS-backed encryption is unavailable, but a stored proof key exists; refusing to orphan it.');
    }
    let text;
    try {
      text = safeStorage.decryptString(buffer);
    } catch (error) {
      throw new ProofKeyringError('OS-backed decryption failed for the proof key.', { cause: error });
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.keyId !== 'string' || !parsed.jwk) throw new ProofKeyringError('The stored proof key is malformed.');
    return parsed;
  }

  function writePrivate(entry) {
    if (!encryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(JSON.stringify(entry));
    fileSystem.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${privatePath}.${randomId()}.tmp`;
    try {
      fileSystem.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      fileSystem.renameSync(temporary, privatePath);
      return true;
    } catch (error) {
      try {
        fileSystem.rmSync(temporary, { force: true });
      } catch {
        /* nothing to clean */
      }
      throw new ProofKeyringError(`The proof key could not be written: ${error.message}`, { cause: error });
    }
  }

  function rememberPublicKey(registry, keyId, publicJwk) {
    if (!registry.keys.some((entry) => entry.keyId === keyId)) {
      registry.keys.push({ keyId, publicJwk, createdAt: now() });
    }
    return registry;
  }

  function newIdentity(registry) {
    const pair = nodeEd25519.generate();
    const publicJwk = nodeEd25519.publicJwkOf(pair.publicKey);
    const keyId = keyIdOfPublicJwk(publicJwk);
    return {
      keyId,
      publicJwk,
      privateKey: pair.privateKey,
      privateKeyText: null,
      persisted: false,
      ephemeral: true,
      registry: rememberPublicKey(registry, keyId, publicJwk)
    };
  }

  async function ensure() {
    if (state) return state;
    const registry = readPublic();
    const stored = readPrivate();
    if (stored) {
      const publicJwk = nodeEd25519.publicJwkOf(nodeEd25519.publicKeyFromJwk(stored.jwk));
      const keyId = keyIdOfPublicJwk(publicJwk);
      if (stored.keyId !== keyId) throw new ProofKeyringError('The stored proof key does not match its recorded key id.');
      state = {
        keyId,
        publicJwk,
        privateKey: nodeEd25519.privateKeyFromJwk(stored.jwk),
        persisted: true,
        ephemeral: false,
        registry: rememberPublicKey(registry, keyId, publicJwk)
      };
    } else {
      state = newIdentity(registry);
      if (writePrivate({ keyId: state.keyId, jwk: nodeEd25519.privateJwkOf(state.privateKey) })) {
        state.ephemeral = false;
        state.persisted = true;
      }
    }
    state.registry.current = state.keyId;
    writePublic(state.registry);
    return state;
  }

  async function sign(text) {
    const identity = await ensure();
    return nodeEd25519.sign(identity.privateKey, text);
  }

  async function keyId() {
    return (await ensure()).keyId;
  }

  /**
   * A new keypair signs later records; the previous public halves stay in the
   * registry so older records remain verifiable.
   */
  async function rotate() {
    const registry = (await ensure()).registry;
    const next = newIdentity(registry);
    if (writePrivate({ keyId: next.keyId, jwk: nodeEd25519.privateJwkOf(next.privateKey) })) {
      next.ephemeral = false;
      next.persisted = true;
    }
    next.registry.current = next.keyId;
    writePublic(next.registry);
    state = next;
    return next.keyId;
  }

  function registryView() {
    if (!state) throw new ProofKeyringError('The proof keyring has not been loaded yet.');
    return { v: 1, current: state.keyId, keys: state.registry.keys.map((entry) => ({ ...entry })) };
  }

  return Object.freeze({
    ensure,
    keyId,
    rotate,
    sign,
    registry: registryView,
    isEphemeral: () => (state ? state.ephemeral : null),
    publicPath,
    privatePath
  });
}

/** Read-only view used by the offline verifier: public halves only, no Electron. */
function loadPublicRegistry({ dir, fileSystem = fs }) {
  const text = fileSystem.readFileSync(path.join(dir, PUBLIC_FILE), 'utf8');
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.keys)) throw new ProofKeyringError('The proof public-key registry is malformed.');
  const keys = new Map();
  for (const entry of parsed.keys) {
    if (!entry || typeof entry.keyId !== 'string' || !entry.publicJwk) continue;
    const jwk = normalizePublicJwk(entry.publicJwk);
    if (keyIdOfPublicJwk(jwk) !== entry.keyId) throw new ProofKeyringError(`Proof key ${entry.keyId} does not match its public key fingerprint.`);
    keys.set(entry.keyId, nodeEd25519.publicKeyFromJwk(jwk));
  }
  return keys;
}

module.exports = {
  PRIVATE_FILE,
  PUBLIC_FILE,
  ProofKeyringError,
  createProofKeyring,
  loadPublicRegistry
};
