const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeRelativePath, isWithinRoot } = require('./workspace.cjs');

const LIMITS = { files: 400, bytes: 8 * 1024 * 1024, directories: 300, records: 8 };
const LOCKFILES = ['yarn.lock', 'poetry.lock', 'uv.lock', 'Cargo.lock', 'Pipfile.lock', 'bun.lock'];
const DEPENDENCY = /(?:^|\/)(?:package\.json|package-lock\.json|requirements\.txt|pyproject\.toml|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.(?:toml|lock)|Pipfile(?:\.lock)?|bun\.lock)$/i;
const EXCLUDED = /(?:^|\/)(?:\.[^/]*|node_modules|vendor|dist[^/]*|build|out|coverage|reference|__pycache__|[^/]*(?:secret|credential)[^/]*)(?:\/|$)|\.(?:pem|key|pfx|p12|exe|dll)$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function changesBetween(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().flatMap((name) => {
    const a = before.files[name];
    const b = after.files[name];
    return a?.hash === b?.hash ? [] : [{
      path: name, kind: !a ? 'created' : !b ? 'deleted' : 'edited', dependency: DEPENDENCY.test(name),
      beforeHash: a?.hash ?? null, afterHash: b?.hash ?? null
    }];
  });
}

function createMachineDelta({ access, readSystem, prepareGitRestore, stopOwnedPreview, limits = LIMITS }) {
  const records = new Map();
  const busy = new Set();

  function workspace(id) {
    const result = access.getWorkspace(id);
    if (!result || result.mode !== 'folder') throw new Error('Machine Delta requires an opened folder.');
    return result;
  }

  async function capture(id) {
    const opened = workspace(id);
    const files = Object.create(null);
    const pending = [''];
    let bytes = 0;
    let count = 0;
    let directories = 0;
    const omissions = [];
    while (pending.length) {
      if (++directories > limits.directories) { omissions.push('Directory capture limit reached.'); break; }
      const directory = pending.shift();
      let cursor = 0;
      do {
        const page = await access.listDirectory(id, directory, cursor);
        if (cursor === 0) {
          for (const name of LOCKFILES) {
            const relative = directory ? `${directory}/${name}` : name;
            const destination = await target(opened.root, relative);
            if (await fs.stat(destination).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error))) {
              if (!page.entries.some((entry) => entry.path === relative)) page.entries.push({ path: relative, kind: 'file' });
            }
          }
        }
        for (const entry of page.entries) {
          if (EXCLUDED.test(entry.path)) continue;
          if (entry.kind === 'directory') { pending.push(entry.path); continue; }
          if (++count > limits.files) { omissions.push('File capture limit reached.'); break; }
          try {
            const destination = await target(opened.root, entry.path);
            const stat = await fs.stat(destination);
            if (stat.size > 2 * 1024 * 1024) throw new Error('File too large.');
            const buffer = await fs.readFile(destination);
            const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
            if (content.includes('\0')) { omissions.push(`Unsupported text: ${entry.path}`); continue; }
            bytes += buffer.length;
            if (bytes > limits.bytes) { omissions.push('Content capture limit reached.'); break; }
            files[entry.path] = { hash: hash(buffer), content };
          } catch {
            omissions.push(`Could not capture: ${entry.path}`);
          }
        }
        if (count > limits.files || bytes > limits.bytes) break;
        cursor = page.nextCursor;
      } while (cursor !== null);
      if (count > limits.files || bytes > limits.bytes) break;
    }
    const system = await readSystem(id);
    if (workspace(id) !== opened) throw new Error('The workspace changed during capture.');
    return { capturedAt: Date.now(), files, system, omissions };
  }

  function recordFor(id, checkpointId) {
    const record = records.get(checkpointId);
    const opened = workspace(id);
    if (!record || record.workspaceId !== id || record.root !== opened.root) return null;
    return record;
  }

  function view(record) {
    if (!record?.before) return null;
    const after = record.after;
    const before = record.before;
    const changes = after ? changesBetween(before, after) : [];
    const gitBefore = before.system.git;
    const gitAfter = after?.system.git;
    const gitChanged = Boolean(after) && !same(gitBefore, gitAfter);
    const previewBefore = before.system.previews;
    const previewAfter = after?.system.previews ?? [];
    const beforeIds = new Set(previewBefore.map((preview) => preview.id));
    const addedPreviews = previewAfter.filter((preview) => !beforeIds.has(preview.id));
    const missingPreviews = previewBefore.filter((preview) => !previewAfter.some((current) => current.id === preview.id));
    const limitations = [
      'Local session only: the last 8 snapshots are retained in memory; restarting expires rewind.',
      'Captured UTF-8 text and known text lockfiles only; hidden, secret-named, generated, binary and reference files are excluded.',
      'File checks are optimistic, not an OS transaction: stop concurrent external writers. File permissions, empty directories and symlink targets are not rewound.',
      'Changes during a turn are observations, not proof that the agent caused them.',
      'Installed packages, remote effects and closed processes are observed but not reversible.',
      'Terminal launch directories are recorded; live shell cwd and shell-local env/PATH are not observable.'
    ];
    if (missingPreviews.length) limitations.push('Earlier preview processes cannot be resurrected; restart them manually.');
    const positionChanged = Boolean(after) && ['head', 'ref', 'index'].some((key) => !same(gitBefore?.[key], gitAfter?.[key]));
    const outsideCapture = ['staged', 'tree'].some((key) => {
      const a = gitBefore?.[key] ?? {};
      const b = gitAfter?.[key] ?? {};
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].some((name) => a[name] !== b[name] && (!before.files[name] && !after?.files[name]));
    });
    const canRestoreGit = !positionChanged || Boolean(gitBefore && gitAfter && gitBefore.index !== null && gitAfter.index !== null && gitBefore.ref && gitBefore.ref === gitAfter.ref && gitBefore.head && gitAfter.head && !outsideCapture);
    if (!canRestoreGit) limitations.push('Git branch/unborn/external-worktree or uncaptured tracked changes are observed but not reversible here.');
    const omissions = [...new Set([...before.omissions, ...(after?.omissions ?? [])])];
    return {
      checkpointId: record.id, startedAt: before.capturedAt, endedAt: after?.capturedAt ?? null,
      state: record.restored ? 'restored' : after ? 'complete' : 'recording',
      files: changes, dependencies: changes.filter((change) => change.dependency).map((change) => change.path),
      git: { before: gitBefore ? { head: gitBefore.head, branch: gitBefore.ref, dirty: Boolean(gitBefore.status) } : null,
        after: gitAfter ? { head: gitAfter.head, branch: gitAfter.ref, dirty: Boolean(gitAfter.status) } : null,
        changed: gitChanged, positionChanged, reversible: canRestoreGit },
      previews: { started: addedPreviews, stopped: missingPreviews },
      terminals: { before: before.system.terminals, after: after?.system.terminals ?? [] },
      tools: before.system.tools,
      environment: 'No persistent env/PATH changes are made by this collector; child-shell changes cannot modify the parent environment.',
      limitations, omissions,
      canRestore: Boolean(after && !record.restored && !record.overlapped && !omissions.length && canRestoreGit && (changes.length || addedPreviews.length || gitChanged)),
      blockedReason: record.overlapped ? 'Overlapping turns: ownership is ambiguous; rewind is disabled.' : null
    };
  }

  async function begin(id, checkpointId) {
    if (typeof checkpointId !== 'string' || !/^cp-[a-zA-Z0-9-]{1,100}$/.test(checkpointId)) throw new Error('Invalid checkpoint identity.');
    if (records.has(checkpointId)) throw new Error('This checkpoint already has a machine snapshot.');
    const opened = workspace(id);
    const record = { id: checkpointId, workspaceId: id, root: opened.root, before: null, after: null, overlapped: false, restored: false, finished: false };
    if (busy.has(id)) throw new Error('A machine restore is in progress.');
    while (records.size >= limits.records) {
      const expired = [...records.values()].find((entry) => entry.finished);
      if (!expired) throw new Error('Too many concurrent machine snapshots.');
      records.delete(expired.id);
    }
    for (const previous of records.values()) {
      if (previous.workspaceId === id && !previous.finished) { previous.overlapped = true; record.overlapped = true; }
    }
    records.set(checkpointId, record);
    try { record.before = await capture(id); }
    catch (error) { records.delete(checkpointId); throw error; }
    return view(record);
  }

  async function finish(id, checkpointId) {
    const record = recordFor(id, checkpointId);
    if (!record?.before || record.restored) return null;
    if (record.finished || record.finishing) return view(record);
    if (busy.has(id)) throw new Error('A machine restore is in progress.');
    record.finishing = true;
    try { record.after = await capture(id); }
    catch (error) { record.before.omissions.push('End snapshot failed; rewind is unavailable.'); throw error; }
    finally { record.finished = true; record.finishing = false; }
    return view(record);
  }

  async function target(root, name) {
    const clean = normalizeRelativePath(name);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.resolve(await fs.realpath(root)) !== path.resolve(root)) throw new Error('The workspace root changed.');
    if (EXCLUDED.test(clean)) throw new Error('Excluded paths cannot be restored.');
    const parts = clean.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      const stat = await fs.lstat(parent).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory() || !isWithinRoot(root, await fs.realpath(parent))) throw new Error('Unsafe restore directory.');
    }
    const destination = path.join(root, clean);
    const stat = await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) throw new Error('Restore refuses links and non-files.');
    return destination;
  }

  async function readCurrent(root, name) {
    const destination = await target(root, name);
    const content = await fs.readFile(destination, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    return { destination, content, hash: content === null ? null : hash(content) };
  }

  async function replace(root, name, content, expectedHash) {
    const current = await readCurrent(root, name);
    if (current.hash !== expectedHash) throw new Error(`Restore conflict: ${name} changed on disk.`);
    if (content === null) {
      await fs.unlink(current.destination);
      return;
    }
    await fs.mkdir(path.dirname(current.destination), { recursive: true });
    await target(root, name);
    const mode = await fs.stat(current.destination).then((stat) => stat.mode).catch(() => 0o600);
    const temporary = path.join(path.dirname(current.destination), `.shadrox-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: 'wx', mode });
      const checked = await readCurrent(root, name);
      if (checked.hash !== expectedHash) throw new Error(`Restore conflict: ${name} changed while writing.`);
      if (expectedHash === null) { await fs.link(temporary, current.destination); await fs.unlink(temporary); }
      else await fs.rename(temporary, current.destination);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async function restore(id, checkpointId, confirm) {
    if (busy.has(id)) throw new Error('A machine restore is already in progress.');
    const record = recordFor(id, checkpointId);
    if (!view(record)?.canRestore) throw new Error('This machine snapshot cannot be restored.');
    if ([...records.values()].some((entry) => entry.workspaceId === id && !entry.finished)) throw new Error('Wait for all agent turns to finish.');
    busy.add(id);
    let gitTransaction;
    const applied = [];
    try {
      const summary = view(record);
      if (!await confirm(summary)) return { ok: false, message: 'Restore cancelled.', report: summary };
      if (!recordFor(id, checkpointId)) throw new Error('The workspace changed before restore.');
      const current = await capture(id);
      if (current.omissions.length) throw new Error('Current files cannot be captured safely; nothing was restored.');
      if (!same(current.system.git, record.after.system.git) || !same(current.system.previews, record.after.system.previews)) throw new Error('Git or preview state changed after this turn; nothing was restored.');
      for (const change of summary.files) {
        if ((current.files[change.path]?.hash ?? null) !== change.afterHash) throw new Error(`Restore conflict: ${change.path} changed after this turn.`);
        await target(record.root, change.path);
      }
      if (summary.git.positionChanged) gitTransaction = await prepareGitRestore(id, record.before.system.git, record.after.system.git);
      try {
        for (const change of summary.files) {
          await replace(record.root, change.path, record.before.files[change.path]?.content ?? null, change.afterHash);
          applied.push(change);
        }
        await gitTransaction?.commit();
      } catch (error) {
        const rollbackErrors = [];
        for (const change of applied.reverse()) {
          try { await replace(record.root, change.path, record.after.files[change.path]?.content ?? null, change.beforeHash); }
          catch { rollbackErrors.push(change.path); }
        }
        if (rollbackErrors.length) throw new Error(`Restore failed; recovery needed for ${rollbackErrors.join(', ')}.`);
        throw error;
      }
      const stopped = [];
      const failed = [];
      for (const preview of summary.previews.started) {
        try { if (await stopOwnedPreview(id, preview.id)) stopped.push(preview.id); else failed.push(preview.id); }
        catch { failed.push(preview.id); }
      }
      for (const change of applied) {
        if (change.beforeHash === null) workspace(id).fileMap.delete(change.path);
        else workspace(id).fileMap.set(change.path, path.join(record.root, change.path));
      }
      record.restored = true;
      return { ok: !failed.length, report: view(record), message: `${applied.length} files restored; ${stopped.length} owned previews stopped.${failed.length ? ' Some previews could not be stopped.' : ''} Installed packages, closed terminals and external side effects were not restored.` };
    } finally {
      try { await gitTransaction?.abort(); }
      finally { busy.delete(id); }
    }
  }

  return { begin, finish, inspect: (id, checkpointId) => view(recordFor(id, checkpointId)), restore,
    assertWritable: () => { if (busy.size) throw new Error('Wait for machine rewind to finish.'); } };
}

module.exports = { createMachineDelta, changesBetween, LIMITS };
