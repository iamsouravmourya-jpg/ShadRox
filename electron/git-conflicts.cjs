'use strict';

const MAX_STAGE_BYTES = 1024 * 1024;
const MAX_PATHS = 500;
const MAX_PATH_LENGTH = 4000;
const BINARY_SNIFF_CHARS = 8000;
const TRUNCATION_MARKER = '\n… truncated';

function isValidPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  if (candidate.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (candidate.includes('\0')) {
    return false;
  }
  if (candidate.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(candidate)) {
    return false;
  }
  if (candidate.includes('\\')) {
    return false;
  }
  if (candidate.startsWith('-')) {
    return false;
  }
  if (candidate.split('/').includes('..')) {
    return false;
  }
  return true;
}

function parseUnmergedRecord(record) {
  const tabIndex = record.indexOf('\t');
  if (tabIndex < 0) {
    return null;
  }
  const fields = record.slice(0, tabIndex).split(' ');
  if (fields.length !== 3) {
    return null;
  }
  const stage = fields[2];
  if (stage !== '1' && stage !== '2' && stage !== '3') {
    return null;
  }
  const path = record.slice(tabIndex + 1);
  return isValidPath(path) ? path : null;
}

async function listUnmergedPaths(runGit) {
  if (typeof runGit !== 'function') {
    return [];
  }
  let result;
  try {
    result = await runGit(['ls-files', '-u', '-z']);
  } catch {
    return [];
  }
  if (!result || !result.ok || typeof result.stdout !== 'string') {
    return [];
  }
  const seen = new Set();
  const paths = [];
  for (const record of result.stdout.split('\0')) {
    if (!record) {
      continue;
    }
    const path = parseUnmergedRecord(record);
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_PATHS) {
      break;
    }
  }
  return paths;
}

function truncateStage(text) {
  if (text.length <= MAX_STAGE_BYTES) {
    return text;
  }
  return text.slice(0, MAX_STAGE_BYTES) + TRUNCATION_MARKER;
}

async function readStage(runGit, stage, path) {
  try {
    const result = await runGit(['show', `:${stage}:${path}`]);
    if (!result || !result.ok || typeof result.stdout !== 'string') {
      return null;
    }
    return truncateStage(result.stdout);
  } catch {
    return null;
  }
}

function isBinaryStage(stage) {
  return typeof stage === 'string' && stage.slice(0, BINARY_SNIFF_CHARS).includes('\0');
}

async function readConflictStages({ runGit, paths } = {}) {
  if (typeof runGit !== 'function' || !Array.isArray(paths)) {
    return [];
  }
  const results = [];
  for (const path of paths) {
    if (!isValidPath(path)) {
      continue;
    }
    let base = null;
    let ours = null;
    let theirs = null;
    try {
      [base, ours, theirs] = await Promise.all([
        readStage(runGit, 1, path),
        readStage(runGit, 2, path),
        readStage(runGit, 3, path),
      ]);
    } catch {
      base = null;
      ours = null;
      theirs = null;
    }
    results.push({
      path,
      base,
      ours,
      theirs,
      binary: isBinaryStage(base) || isBinaryStage(ours) || isBinaryStage(theirs),
    });
  }
  return results;
}

module.exports = { listUnmergedPaths, readConflictStages, MAX_STAGE_BYTES };
