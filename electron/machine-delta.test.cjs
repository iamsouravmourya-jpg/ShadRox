const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { createWorkspaceAccess } = require('./workspace.cjs');
const { createMachineDelta, LIMITS } = require('./machine-delta.cjs');
const { createMachineGit } = require('./machine-git.cjs');
const { createPreviewRuntime } = require('./preview-runtime.cjs');
const { buildGitArgv, buildIsolatedGitEnv, resolveGitExecutable } = require('./desktop-security.cjs');

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-machine-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, content) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  };
  await write('a.txt', 'before');
  const access = createWorkspaceAccess();
  const { workspaceId: id } = await access.openFolder(root);
  const state = { git: null, previews: [], terminals: [], tools: { node: process.versions.node } };
  const stopped = [];
  const service = createMachineDelta({ access, readSystem: async () => structuredClone(state),
    prepareGitRestore: async () => { throw new Error('Unexpected Git restore'); },
    stopOwnedPreview: async (_id, identity) => { stopped.push(identity); return true; }, ...options });
  return { root, id, access, state, service, write, stopped,
    read: (name) => fs.readFile(path.join(root, name), 'utf8') };
}

test('captures unopened disk files and rewinds edited, created and deleted files', async (t) => {
  const f = await fixture(t);
  await f.write('removed.txt', 'original');
  await f.service.begin(f.id, 'cp-files');
  await f.write('a.txt', 'after');
  await f.write('new/deep.txt', 'created');
  await fs.unlink(path.join(f.root, 'removed.txt'));
  const report = await f.service.finish(f.id, 'cp-files');
  assert.equal(report.files.length, 3);
  assert.equal(report.canRestore, true);
  assert.equal(JSON.stringify(report).includes('"content"'), false);
  assert.equal((await f.service.restore(f.id, 'cp-files', async () => true)).ok, true);
  assert.equal(await f.read('a.txt'), 'before');
  assert.equal(await f.read('removed.txt'), 'original');
  await assert.rejects(f.read('new/deep.txt'), { code: 'ENOENT' });
  assert.equal(f.access.getWorkspace(f.id).fileMap.has('new/deep.txt'), false);
  assert.equal(f.service.inspect(f.id, 'cp-files').canRestore, false);
});

test('manifest and known text lockfiles are reversible without claiming package rollback', async (t) => {
  const f = await fixture(t);
  await f.write('package.json', '{"name":"before"}');
  await f.write('yarn.lock', '# before');
  await f.service.begin(f.id, 'cp-deps');
  await f.write('package.json', '{"name":"after"}');
  await f.write('yarn.lock', '# after');
  const report = await f.service.finish(f.id, 'cp-deps');
  assert.deepEqual(report.dependencies, ['package.json', 'yarn.lock']);
  const result = await f.service.restore(f.id, 'cp-deps', async () => true);
  assert.match(result.message, /Installed packages.*not restored/);
  assert.equal(await f.read('yarn.lock'), '# before');
});

test('preflight conflict causes zero writes to every captured file', async (t) => {
  const f = await fixture(t);
  await f.write('z.txt', 'old-z');
  await f.service.begin(f.id, 'cp-conflict');
  await f.write('a.txt', 'after-a');
  await f.write('z.txt', 'after-z');
  await f.service.finish(f.id, 'cp-conflict');
  await f.write('z.txt', 'foreign-edit');
  await assert.rejects(f.service.restore(f.id, 'cp-conflict', async () => true), /conflict/);
  assert.equal(await f.read('a.txt'), 'after-a');
  assert.equal(await f.read('z.txt'), 'foreign-edit');
});

test('cancellation never writes or stops a preview; restore blocks concurrent app work', async (t) => {
  const f = await fixture(t);
  await f.service.begin(f.id, 'cp-cancel');
  await f.write('a.txt', 'after');
  f.state.previews = [{ id: 'owned-1', kind: 'frontend', port: 4567 }];
  await f.service.finish(f.id, 'cp-cancel');
  const result = await f.service.restore(f.id, 'cp-cancel', async () => {
    assert.throws(() => f.service.assertWritable(), /rewind/);
    await assert.rejects(f.service.begin(f.id, 'cp-concurrent'), /restore/);
    return false;
  });
  assert.equal(result.ok, false);
  assert.equal(await f.read('a.txt'), 'after');
  assert.deepEqual(f.stopped, []);
  assert.doesNotThrow(() => f.service.assertWritable());
});

test('only newly owned preview identities are stopped', async (t) => {
  const f = await fixture(t);
  f.state.previews = [{ id: 'old', kind: 'frontend', port: 1 }];
  await f.service.begin(f.id, 'cp-preview');
  f.state.previews.push({ id: 'new', kind: 'backend', port: 2 });
  await f.service.finish(f.id, 'cp-preview');
  await f.service.restore(f.id, 'cp-preview', async () => true);
  assert.deepEqual(f.stopped, ['new']);
});

test('changed preview identity after capture blocks restore without stopping anything', async (t) => {
  const f = await fixture(t);
  await f.service.begin(f.id, 'cp-stale');
  await f.write('a.txt', 'after');
  f.state.previews = [{ id: 'first', kind: 'frontend', port: 42 }];
  await f.service.finish(f.id, 'cp-stale');
  f.state.previews = [{ id: 'replacement', kind: 'frontend', port: 42 }];
  await assert.rejects(f.service.restore(f.id, 'cp-stale', async () => true), /preview state changed/);
  assert.equal(await f.read('a.txt'), 'after');
  assert.deepEqual(f.stopped, []);
});

test('overlapping turns cannot be rewound, including while the start snapshot is pending', async (t) => {
  const f = await fixture(t);
  const first = f.service.begin(f.id, 'cp-one');
  assert.equal(f.service.inspect(f.id, 'cp-one'), null);
  const second = f.service.begin(f.id, 'cp-two');
  await Promise.all([first, second]);
  await f.write('a.txt', 'after');
  await f.service.finish(f.id, 'cp-one');
  await f.service.finish(f.id, 'cp-two');
  assert.match(f.service.inspect(f.id, 'cp-one').blockedReason, /Overlapping/);
  assert.equal(f.service.inspect(f.id, 'cp-two').canRestore, false);
});

test('snapshot caps and expiration are explicit and completed snapshots never refresh', async (t) => {
  const f = await fixture(t, { limits: { ...LIMITS, records: 1 } });
  await f.service.begin(f.id, 'cp-first');
  await assert.rejects(f.service.begin(f.id, 'cp-overflow'), /Too many concurrent/);
  await f.write('a.txt', 'after');
  const first = await f.service.finish(f.id, 'cp-first');
  await f.write('a.txt', 'foreign');
  assert.deepEqual(await f.service.finish(f.id, 'cp-first'), first);
  await f.service.begin(f.id, 'cp-next');
  assert.equal(f.service.inspect(f.id, 'cp-first'), null);
});

test('capture limits fail closed', async (t) => {
  const f = await fixture(t, { limits: { ...LIMITS, files: 1 } });
  await f.write('b.txt', 'b');
  await f.service.begin(f.id, 'cp-limit');
  await f.write('a.txt', 'after');
  const report = await f.service.finish(f.id, 'cp-limit');
  assert.equal(report.canRestore, false);
  assert.match(report.omissions.join(' '), /limit/);
});

test('invalid UTF-8 cannot be captured and later rewritten as replacement characters', async (t) => {
  const f = await fixture(t);
  await f.write('bad.txt', Buffer.from([0xff, 0xfe, 0x80]));
  const report = await f.service.begin(f.id, 'cp-encoding');
  assert.match(report.omissions.join(' '), /bad.txt/);
});

test('hardlinked files block rewind instead of modifying a foreign inode', async (t) => {
  const f = await fixture(t);
  await f.service.begin(f.id, 'cp-links');
  await f.write('a.txt', 'after');
  await f.service.finish(f.id, 'cp-links');
  await fs.link(path.join(f.root, 'a.txt'), path.join(f.root, 'alias.txt'));
  await assert.rejects(f.service.restore(f.id, 'cp-links', async () => true), /safely/);
  assert.equal(await f.read('a.txt'), 'after');
});

test('snapshot identity is validated and cannot cross workspaces', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.begin(f.id, '../wrong'), /identity/);
  await f.service.begin(f.id, 'cp-id');
  await assert.rejects(f.service.begin(f.id, 'cp-id'), /already/);
  f.access.closeWorkspace(f.id);
  const other = await f.access.openFolder(f.root);
  assert.equal(f.service.inspect(other.workspaceId, 'cp-id'), null);
});

test('real owned static preview identity cannot stop a replacement on the same workspace', async (t) => {
  const f = await fixture(t);
  await f.write('index.html', '<h1>test</h1>');
  const runtime = createPreviewRuntime({ onOutput: () => {} });
  t.after(() => runtime.stopAll());
  await runtime.startStatic(f.id, f.root);
  const [first] = runtime.ownedPreviews(f.id);
  await runtime.startStatic(f.id, f.root);
  const [next] = runtime.ownedPreviews(f.id);
  assert.notEqual(first.id, next.id);
  assert.equal(await runtime.stopOwnedPreview(f.id, first.id), false);
  assert.equal(runtime.ownedPreviews(f.id).length, 1);
  assert.equal(await runtime.stopOwnedPreview(f.id, next.id), true);
  assert.equal(runtime.ownedPreviews(f.id).length, 0);
});

async function gitFixture(t, wrapGitRun) {
  const f = await fixture(t);
  const executable = resolveGitExecutable({});
  assert.ok(executable, 'Git is required for the native rewind tests');
  const env = buildIsolatedGitEnv({});
  const run = (root, args, _safety, input) => new Promise((resolve) => {
    const child = execFile(executable, buildGitArgv(args, { safeDirectories: [root] }), { cwd: root, env, windowsHide: true }, (error, stdout, stderr) => {
      if (error && input) console.error(stderr);
      resolve({ ok: !error, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  const cmd = async (...args) => { const result = await run(f.root, args); assert.equal(result.ok, true, result.stderr); return result.stdout.trim(); };
  await cmd('init', '-b', 'main');
  await cmd('add', '--', 'a.txt');
  const commit = () => cmd('-c', 'user.name=Machine Test', '-c', 'user.email=machine@example.invalid', 'commit', '-m', 'fixture');
  await commit();
  const git = createMachineGit({ run: wrapGitRun ? wrapGitRun(run) : run, context: async () => ({ complete: true, filterDrivers: [] }), getWorkspace: (id) => f.access.getWorkspace(id) });
  const service = createMachineDelta({ access: f.access, readSystem: async () => ({ ...f.state, git: await git.read(f.id) }), prepareGitRestore: git.prepare, stopOwnedPreview: async () => true });
  return { ...f, service, git, cmd, commit };
}

test('real Git HEAD/index and files return to baseline on the same branch', async (t) => {
  const f = await gitFixture(t);
  const baseline = await f.git.read(f.id);
  await f.service.begin(f.id, 'cp-git');
  await f.write('a.txt', 'committed later');
  await f.cmd('add', '--', 'a.txt');
  await f.commit();
  const report = await f.service.finish(f.id, 'cp-git');
  assert.equal(report.git.positionChanged, true);
  assert.equal(report.canRestore, true);
  assert.equal((await f.service.restore(f.id, 'cp-git', async () => true)).ok, true);
  assert.equal((await f.git.read(f.id)).head, baseline.head);
  assert.equal((await f.git.read(f.id)).index, baseline.index);
  assert.equal(await f.read('a.txt'), 'before');
});

test('a branch switch inside the compare-and-swap window fails the rewind and rolls the ref and files back', async (t) => {
  let armed = false;
  let escapeSha = null;
  const f = await gitFixture(t, (gitRun) => async (root, args, safety, input) => {
    if (armed && args[0] === 'update-ref' && args[1] === '--no-deref') {
      armed = false;
      await gitRun(root, ['branch', 'escape', escapeSha], safety);
      await gitRun(root, ['symbolic-ref', 'HEAD', 'refs/heads/escape'], safety);
    }
    return gitRun(root, args, safety, input);
  });
  await f.service.begin(f.id, 'cp-race');
  await f.write('a.txt', 'committed later');
  await f.cmd('add', '--', 'a.txt');
  await f.commit();
  await f.service.finish(f.id, 'cp-race');
  const after = await f.git.read(f.id);
  assert.equal(after.ref, 'refs/heads/main');
  escapeSha = after.head;
  armed = true;
  await assert.rejects(f.service.restore(f.id, 'cp-race', async () => true), /Git changed during rewind/);
  assert.equal(await f.cmd('rev-parse', 'refs/heads/main'), after.head);
  const state = await f.git.read(f.id);
  assert.deepEqual([state.head, state.ref, state.index], [after.head, 'refs/heads/escape', after.index]);
  assert.equal(await f.read('a.txt'), 'committed later');
  await assert.rejects(f.read('.git/HEAD.lock'), { code: 'ENOENT' });
  await assert.rejects(f.read('.git/index.lock'), { code: 'ENOENT' });
});

test('foreign Git locks are never removed and prevent all file writes', async (t) => {
  const f = await gitFixture(t);
  await f.service.begin(f.id, 'cp-lock');
  await f.write('a.txt', 'after');
  await f.cmd('add', '--', 'a.txt');
  await f.service.finish(f.id, 'cp-lock');
  await f.write('.git/index.lock', 'foreign-lock');
  await assert.rejects(f.service.restore(f.id, 'cp-lock', async () => true), /EEXIST/);
  assert.equal(await f.read('a.txt'), 'after');
  assert.equal(await f.read('.git/index.lock'), 'foreign-lock');
  await assert.rejects(f.read('.git/HEAD.lock'), { code: 'ENOENT' });
});

test('Git changes to excluded files disable rewind instead of leaving an inconsistent checkout', async (t) => {
  const f = await gitFixture(t);
  await f.service.begin(f.id, 'cp-outside');
  await f.write('.hidden.txt', 'excluded fixture');
  await f.cmd('add', '--', '.hidden.txt');
  await f.commit();
  const report = await f.service.finish(f.id, 'cp-outside');
  assert.equal(report.git.reversible, false);
  assert.equal(report.canRestore, false);
});

test('Git transaction failure rolls file restoration back to the after-state', async (t) => {
  const state = { head: 'a'.repeat(40), ref: 'refs/heads/main', status: '', index: 'before', staged: {}, tree: {} };
  let ended = false;
  const f = await fixture(t, { readSystem: async () => ({ git: { ...state, index: ended ? 'after' : 'before' }, previews: [], terminals: [], tools: {} }),
    prepareGitRestore: async () => ({ commit: async () => { throw new Error('Injected commit failure'); }, abort: async () => {} }) });
  await f.service.begin(f.id, 'cp-rollback');
  ended = true;
  await f.write('a.txt', 'after');
  await f.service.finish(f.id, 'cp-rollback');
  await assert.rejects(f.service.restore(f.id, 'cp-rollback', async () => true), /Injected/);
  assert.equal(await f.read('a.txt'), 'after');
  assert.doesNotThrow(() => f.service.assertWritable());
});
