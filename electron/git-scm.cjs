'use strict';

function parseGitStatus(text) {
  const changes = [];
  let branch = '';
  const entries = String(text || '').split('\0');

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.startsWith('## ')) {
      branch = entry.slice(3).split('...')[0].replace(/^No commits yet on /, '');
      continue;
    }
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    let oldPath;
    if (/[RC]/.test(status)) oldPath = entries[++index] || undefined;
    changes.push({
      status,
      path,
      ...(oldPath ? { oldPath } : {}),
      staged: status[0] !== ' ' && status[0] !== '?',
      unstaged: status[1] !== ' ' && status[1] !== '?' || status === '??',
      untracked: status === '??'
    });
  }
  return { branch, changes };
}

function parseGitBranches(text) {
  const branches = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const current = line.startsWith('* ');
    const candidate = line.replace(/^[*+ ]{1,2}/, '');
    const match = /^(\S+)\s+([0-9a-f]+)(?:\s+(.*))?$/i.exec(candidate);
    if (!match) continue;
    branches.push({
      name: match[1],
      current,
      lastCommit: match[2],
      message: match[3] || ''
    });
  }
  return branches;
}

function validateGitPaths(rawPaths) {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > 1000) {
    throw new Error('Select between 1 and 1000 Git paths.');
  }
  const paths = [];
  const seen = new Set();
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== 'string' || rawPath.length > 4096 || rawPath.includes('\0')) {
      throw new Error('A Git path is invalid.');
    }
    const normalized = rawPath.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('Git paths must be workspace-relative and must not traverse directories.');
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  return paths;
}

function sanitizeCommitMessage(value) {
  if (typeof value !== 'string') throw new Error('A commit message is required.');
  const message = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 500).trim();
  if (!message) throw new Error('A commit message is required.');
  return message;
}

function validateBranchName(value) {
  if (typeof value !== 'string' || !value || value.length > 250 ||
    value.startsWith('-') || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error('A valid local branch name is required.');
  }
  return value;
}

module.exports = {
  parseGitBranches,
  parseGitStatus,
  sanitizeCommitMessage,
  validateBranchName,
  validateGitPaths
};
