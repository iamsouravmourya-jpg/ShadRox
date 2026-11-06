#!/usr/bin/env node
/**
 * Offline verifier for the ShadRox proof ledger.
 *
 * Every proof record the app appends is an Ed25519-signed link in a hash chain
 * under `<userData>/proof-ledgers/<workspace-hash>/ledger.jsonl`, signed by the
 * per-install key whose public half lives in `<userData>/proof-keys/keys.pub.json`.
 * This script re-derives each hash, checks every link and signature, and exits
 * non-zero when anything does not add up — with Electron out of the loop.
 *
 * Usage:
 *   npm run verify:proofs                         # the local install
 *   npm run verify:proofs -- --root <dir>         # a copied proof-ledgers folder
 *   npm run verify:proofs -- --ledger <file>      # one exported ledger.jsonl
 *   npm run verify:proofs -- --keys <dir>         # an exported proof-keys folder
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { verifyChainText } = require(path.join(repoRoot, 'electron', 'proof-chain.cjs'));
const { loadPublicRegistry } = require(path.join(repoRoot, 'electron', 'proof-keyring.cjs'));

function appDataDirectory() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ShadRox');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ShadRox');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ShadRox');
}

function parseArgs(argv) {
  const options = {
    root: path.join(appDataDirectory(), 'proof-ledgers'),
    ledger: null,
    keys: path.join(appDataDirectory(), 'proof-keys')
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] ?? '');
    else if (arg === '--ledger') options.ledger = path.resolve(argv[++index] ?? '');
    else if (arg === '--keys') options.keys = path.resolve(argv[++index] ?? '');
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run verify:proofs [-- --root <dir>] [--ledger <file>] [--keys <dir>]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function ledgersUnder(root) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read the proof-ledgers folder ${root}: ${error.message}`);
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ledger = path.join(root, entry.name, 'ledger.jsonl');
    if (fs.existsSync(ledger)) found.push(ledger);
  }
  return found.sort();
}

async function verifyFile(ledgerPath, keys) {
  const text = fs.readFileSync(ledgerPath, 'utf8');
  const report = await verifyChainText(text, {
    resolver: (keyId) => keys.get(keyId) ?? null,
    verifySig: (key, hash, signature) => crypto.verify(null, Buffer.from(hash, 'utf8'), key, Buffer.from(signature, 'base64url'))
  });
  return report;
}

function describeFile(ledgerPath) {
  const relative = path.relative(process.cwd(), ledgerPath);
  return relative && !relative.startsWith('..') ? relative : ledgerPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let keys;
  try {
    keys = loadPublicRegistry({ dir: options.keys });
  } catch (error) {
    console.error(`Cannot load the proof public keys from ${options.keys}: ${error.message}`);
    process.exit(1);
  }
  if (keys.size === 0) {
    console.error(`No public proof keys found in ${options.keys}.`);
    process.exit(1);
  }

  let files;
  try {
    files = options.ledger ? [options.ledger] : ledgersUnder(options.root);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No ledger.jsonl found under ${options.root}. Nothing has been proven yet.`);
    process.exit(1);
  }

  let failed = 0;
  for (const file of files) {
    let report;
    try {
      report = await verifyFile(file, keys);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${describeFile(file)} — ${error.message}`);
      continue;
    }
    const line = `${report.totalRecords} record(s), ${keys.size} key(s)`;
    if (report.ok) {
      console.log(`OK    ${describeFile(file)} — ${line}`);
      continue;
    }
    failed += 1;
    const issues = [
      report.tamperedRecords.length ? `tampered ${report.tamperedRecords.join(',')}` : '',
      report.brokenLinks.length ? `broken links ${report.brokenLinks.join(',')}` : '',
      report.gaps.length ? `gaps ${report.gaps.join(',')}` : '',
      report.signatureFailures.length ? `bad signatures ${report.signatureFailures.join(',')}` : '',
      report.unknownKeys.length ? `unknown keys ${report.unknownKeys.join(',')}` : '',
      report.truncatedTail ? 'torn last line' : ''
    ].filter(Boolean);
    console.error(`FAIL  ${describeFile(file)} — ${line}; ${issues.join('; ')}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${files.length} ledger(s) failed verification.`);
    process.exit(1);
  }
  console.log(`\nAll ${files.length} ledger(s) verified.`);
}

await main();
