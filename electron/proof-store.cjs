'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_KEYS_BYTES = 32 * 1024;

function createProofStore({ root, safeStorage, fileSystem = fs, randomId = crypto.randomUUID }) {
  const queues = new Map();

  function workspaceHash(workspaceId) {
    if (typeof workspaceId !== 'string' || workspaceId.length < 1 || workspaceId.length > 200) {
      throw new Error('Invalid proof workspace id.');
    }
    return crypto.createHash('sha256').update(workspaceId).digest('hex');
  }

  function paths(workspaceId) {
    const directory = path.join(root, workspaceHash(workspaceId));
    return {
      directory,
      ledger: path.join(directory, 'ledger.jsonl'),
      keys: path.join(directory, 'keys.enc')
    };
  }

  async function serialized(workspaceId, task) {
    const key = workspaceHash(workspaceId);
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.then(task, task);
    queues.set(key, next.catch(() => undefined));
    return next;
  }

  async function readLedger(workspaceId) {
    const file = paths(workspaceId).ledger;
    try {
      const stat = await fileSystem.promises.stat(file);
      if (stat.size > MAX_LEDGER_BYTES) throw new Error('Proof ledger exceeds the 32 MiB safety limit.');
      return await fileSystem.promises.readFile(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function appendLine(workspaceId, line) {
    return serialized(workspaceId, async () => {
      if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES || /[\r\n]/.test(line)) {
        throw new Error('Invalid or oversized proof record.');
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('Proof record must be valid JSON.');
      }
      if (!record || record.workspace !== workspaceId || !Number.isSafeInteger(record.seq) || record.seq < 1) {
        throw new Error('Proof record workspace or sequence is invalid.');
      }
      const { directory, ledger } = paths(workspaceId);
      await fileSystem.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      let size = 0;
      try {
        size = (await fileSystem.promises.stat(ledger)).size;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const bytes = Buffer.byteLength(line, 'utf8') + 1;
      if (size + bytes > MAX_LEDGER_BYTES) throw new Error('Proof ledger reached the 32 MiB safety limit.');
      await fileSystem.promises.appendFile(ledger, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    });
  }

  async function readKeys(workspaceId) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed encryption is unavailable; proof signing keys cannot be read safely.');
    }
    const file = paths(workspaceId).keys;
    let encrypted;
    try {
      encrypted = await fileSystem.promises.readFile(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (encrypted.length > MAX_KEYS_BYTES) throw new Error('Encrypted proof-key registry is oversized.');
    try {
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      throw new Error('OS-backed decryption failed for the proof-key registry.', { cause: error });
    }
  }

  async function writeKeys(workspaceId, text) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed encryption is unavailable; proof signing keys cannot be saved safely.');
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_KEYS_BYTES) {
      throw new Error('Proof-key registry is invalid or oversized.');
    }
    JSON.parse(text);
    const { directory, keys } = paths(workspaceId);
    await fileSystem.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const encrypted = safeStorage.encryptString(text);
    const temporary = `${keys}.${randomId()}.tmp`;
    try {
      await fileSystem.promises.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await fileSystem.promises.rename(temporary, keys);
    } catch (error) {
      try { await fileSystem.promises.unlink(temporary); } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }

  return Object.freeze({ readLedger, appendLine, readKeys, writeKeys });
}

module.exports = { createProofStore };
