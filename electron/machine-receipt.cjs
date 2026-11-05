'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeRelativePath, isWithinRoot } = require('./workspace.cjs');

const RECEIPT_FORMAT = 'shadrox-machine-delta-receipt';
const RECEIPT_VERSION = 1;
const RECEIPT_ID = /^rc-cp-[A-Za-z0-9_-]{1,110}$/;

const hash = (value) => createHash('sha256').update(value).digest('hex');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function receiptFingerprint(receipt) {
  const { selfHash, ...payload } = receipt;
  return hash(stableStringify(payload));
}

function buildReceipt(report, { workspaceRoot, limits, exportedAt = Date.now() }) {
  const payload = {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    receiptId: `rc-${report.checkpointId}`,
    checkpointId: report.checkpointId,
    workspaceRoot,
    exportedAt,
    hashKind: 'sha256',
    partial: (report.omissions ?? []).length > 0,
    limits,
    report
  };
  return { ...payload, selfHash: receiptFingerprint(payload) };
}

async function safeCurrentHash(root, name) {
  let clean;
  try {
    clean = normalizeRelativePath(name);
  } catch {
    return { status: 'unsafe' };
  }
  const realRoot = await fs.realpath(root).catch(() => null);
  if (realRoot === null) return { status: 'unsafe' };
  const parts = clean.split('/');
  let parent = realRoot;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = await fs.lstat(parent).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!stat) return { status: 'missing' };
    if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithinRoot(realRoot, await fs.realpath(parent))) return { status: 'unsafe' };
  }
  const destination = path.join(parent, parts[parts.length - 1]);
  const stat = await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { status: 'missing' };
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) return { status: 'unsafe' };
  return { status: 'present', hash: hash(await fs.readFile(destination)) };
}

function createMachineReceipt({ access, receiptsDir, getReport, limits }) {
  function requireFolder(workspaceId) {
    const opened = access.getWorkspace(workspaceId);
    if (!opened || opened.mode !== 'folder') throw new Error('Machine Delta receipts require an opened folder.');
    return opened;
  }

  function receiptPath(receiptId) {
    if (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)) throw new Error('Invalid receipt identity.');
    return path.join(receiptsDir, `${receiptId}.json`);
  }

  async function exportReceipt(workspaceId, checkpointId) {
    const opened = requireFolder(workspaceId);
    const report = getReport(workspaceId, checkpointId);
    if (!report) {
      throw new Error('No Machine Delta snapshot for this checkpoint. Only machine-turn checkpoints have exportable receipts.');
    }
    if (report.state === 'recording') throw new Error('This turn is still recording; export the receipt after it finishes.');
    const receipt = buildReceipt(report, { workspaceRoot: opened.root, limits, exportedAt: Date.now() });
    const filePath = receiptPath(receipt.receiptId);
    await fs.mkdir(receiptsDir, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    return { receiptId: receipt.receiptId, filePath, partial: receipt.partial };
  }

  async function verifyReceipt(workspaceId, receiptId) {
    const opened = requireFolder(workspaceId);
    const receipt = JSON.parse(await fs.readFile(receiptPath(receiptId), 'utf8'));
    if (receipt.format !== RECEIPT_FORMAT || receipt.version !== RECEIPT_VERSION) {
      throw new Error('That file is not a supported Machine Delta receipt.');
    }
    if (receipt.selfHash !== receiptFingerprint(receipt)) {
      return { valid: false, checked: 0, matched: 0, invalidatedBy: [], selfHashMismatch: true,
        message: 'Invalidated: the receipt file itself was altered — its self-hash no longer matches its contents.' };
    }
    const liveRoot = await fs.realpath(opened.root).catch(() => opened.root);
    if (path.resolve(liveRoot) !== path.resolve(receipt.workspaceRoot)) {
      return { valid: false, checked: 0, matched: 0, invalidatedBy: [], selfHashMismatch: false,
        message: 'This receipt was exported for a different workspace folder; open it to verify offline.' };
    }
    const invalidatedBy = [];
    let matched = 0;
    for (const change of receipt.report.files) {
      const current = await safeCurrentHash(opened.root, change.path).catch(() => ({ status: 'unsafe' }));
      const holds = change.kind === 'deleted'
        ? current.status === 'missing'
        : current.status === 'present' && current.hash === change.afterHash;
      if (holds) matched += 1;
      else invalidatedBy.push(change.path);
    }
    const checked = receipt.report.files.length;
    return {
      valid: invalidatedBy.length === 0,
      checked,
      matched,
      invalidatedBy,
      selfHashMismatch: false,
      message: invalidatedBy.length === 0
        ? `Receipt holds — ${matched}/${checked} file hashes still match the post-turn state.`
        : `Invalidated by ${invalidatedBy.length} file change(s): ${invalidatedBy.join(', ')}.`
    };
  }

  return { exportReceipt, verifyReceipt };
}

module.exports = { createMachineReceipt, buildReceipt, receiptFingerprint, stableStringify, RECEIPT_FORMAT, RECEIPT_VERSION };
