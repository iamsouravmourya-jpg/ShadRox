const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createWorkspaceAccess, normalizeRelativePath } = require('./workspace.cjs');

test('normalizes Windows separators and rejects absolute or traversal paths', () => {
  assert.equal(normalizeRelativePath('src\\components\\App.tsx'), 'src/components/App.tsx');
  assert.throws(() => normalizeRelativePath('../outside.txt'), /unsafe path segment/);
  assert.throws(() => normalizeRelativePath('C:\\outside.txt'), /Absolute paths/);
  assert.throws(() => normalizeRelativePath('/outside.txt'), /Absolute paths/);
  assert.throws(() => normalizeRelativePath('folder/file.txt:stream'), /unsafe or invalid on Windows/);
  assert.throws(() => normalizeRelativePath('folder/CON.txt'), /unsafe or invalid on Windows/);
});

test('loads a folder and writes existing and new files only inside that workspace', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-workspace-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export default 1;');
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  assert.deepEqual(opened.files, [], 'Opening a folder should not eagerly read all files.');
  assert.equal(opened.fileCount, 1, 'the folder count should match what the explorer shows (node_modules is skipped)');
  assert.equal(opened.fileCountTruncated, false);
  assert.deepEqual(
    opened.fileTree.map((entry) => [entry.path, entry.size]),
    [['src/App.tsx', 'export default 1;'.length]],
    'the prompt needs paths + sizes for every file even when no buffer is loaded'
  );
  const rootPage = await access.listDirectory(opened.workspaceId);
  assert.deepEqual(rootPage.entries.map(({ name, kind }) => [name, kind]), [['src', 'directory']]);
  const sourcePage = await access.listDirectory(opened.workspaceId, 'src');
  assert.deepEqual(sourcePage.entries.map(({ name, kind }) => [name, kind]), [['App.tsx', 'file']]);
  const appFile = await access.readFile(opened.workspaceId, 'src/App.tsx');
  assert.equal(appFile.content, 'export default 1;');
  await fs.writeFile(path.join(root, 'src', 'unseen.ts'), 'do not overwrite');

  // `src/unseen.ts` is a regular text file inside the folder, so the save path
  // adopts it instead of refusing: writing a file that has no renderer buffer
  // is the whole point of folder mode.
  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'src/App.tsx', content: 'export default 2;', expectedVersion: appFile.version },
    { name: 'src/new/Widget.tsx', content: 'export default 3;', expectedVersion: null },
    { name: 'src/unseen.ts', content: 'now adopted and written' },
    { name: '../outside.txt', content: 'must not escape' }
  ]);

  assert.deepEqual(
    result.saved,
    ['src/App.tsx', 'src/new/Widget.tsx', 'src/unseen.ts'],
    JSON.stringify(result.errors)
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].name, '../outside.txt');
  assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), 'export default 2;');
  assert.equal(await fs.readFile(path.join(root, 'src', 'new', 'Widget.tsx'), 'utf8'), 'export default 3;');
  assert.equal(await fs.readFile(path.join(root, 'src', 'unseen.ts'), 'utf8'), 'now adopted and written');
  assert.equal(await fs.access(path.join(path.dirname(root), 'outside.txt')).then(() => true, () => false), false);
});

test('refuses writes through a directory symlink', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-symlink-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-symlink-outside-'));
  context.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, 'App.ts'), 'inside');
  try {
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    context.skip('Directory symlinks are unavailable in this environment.');
    return;
  }

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'linked/escaped.ts', content: 'must remain outside the workspace' }
  ]);

  assert.equal(result.saved.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(await fs.access(path.join(outside, 'escaped.ts')).then(() => true, () => false), false);
});

test('multi-file workspaces may update selected files but cannot create arbitrary files', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-selected-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const selected = path.join(root, 'Selected.ts');
  await fs.writeFile(selected, 'before');

  const access = createWorkspaceAccess();
  const opened = await access.openFiles([selected]);
  assert.equal(opened.files[0].content, 'before');
  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'Selected.ts', content: 'after', expectedVersion: opened.files[0].version },
    { name: 'New.ts', content: 'not allowed' }
  ]);

  assert.deepEqual(result.saved, ['Selected.ts'], JSON.stringify(result.errors));
  assert.equal(result.errors.length, 1);
  assert.equal(await fs.readFile(selected, 'utf8'), 'after');
  assert.equal(await fs.access(path.join(root, 'New.ts')).then(() => true, () => false), false);
});

test('reads and saves only the two .shadrox config files, never other hidden paths', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-config-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.shadrox', 'plugins', 'demo-plugin'), { recursive: true });
  await fs.writeFile(path.join(root, '.shadrox', 'automations.json'), '[]');
  await fs.writeFile(
    path.join(root, '.shadrox', 'plugins', 'demo-plugin', 'plugin.json'),
    '{"id":"demo-plugin"}'
  );
  await fs.writeFile(path.join(root, '.shadrox', 'secrets.txt'), 'hidden');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const automations = await access.readFile(opened.workspaceId, '.shadrox/automations.json');
  assert.equal(automations.content, '[]');

  const plugin = await access.readFile(opened.workspaceId, '.shadrox/plugins/demo-plugin/plugin.json');
  assert.equal(plugin.content, '{"id":"demo-plugin"}');

  const saved = await access.saveFiles(opened.workspaceId, [
    { name: '.shadrox/automations.json', content: '[]', expectedVersion: automations.version },
    { name: '.shadrox/plugins/other-plugin/plugin.json', content: '{}' },
    { name: '.shadrox/secrets.txt', content: 'nope' },
    { name: '.shadrox/plugins/../../escape.json', content: 'nope' }
  ]);
  assert.deepEqual(saved.saved, ['.shadrox/automations.json', '.shadrox/plugins/other-plugin/plugin.json']);
  assert.equal(saved.errors.length, 2);
  await assert.rejects(access.readFile(opened.workspaceId, '.shadrox/secrets.txt'), /Hidden and generated/);
  assert.equal(await fs.readFile(path.join(root, '.shadrox', 'secrets.txt'), 'utf8'), 'hidden');
});

test('createDirectory makes explorer folders and refuses hidden, generated and taken paths', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-mkdir-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'App.tsx'), 'export default 1;');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);

  assert.deepEqual(await access.createDirectory(opened.workspaceId, 'new-dir'), { path: 'new-dir' });
  assert.equal((await fs.stat(path.join(root, 'new-dir'))).isDirectory(), true);

  // resolveWorkspaceDirectory is called with create = true, so the missing
  // parent is made rather than the nested path being refused.
  assert.deepEqual(await access.createDirectory(opened.workspaceId, 'deep/nested/dir'), { path: 'deep/nested/dir' });
  assert.equal((await fs.stat(path.join(root, 'deep', 'nested', 'dir'))).isDirectory(), true);

  await assert.rejects(access.createDirectory(opened.workspaceId, '.git'), /Hidden and generated directories cannot be created/);
  await assert.rejects(access.createDirectory(opened.workspaceId, 'node_modules'), /Hidden and generated directories cannot be created/);
  await assert.rejects(access.createDirectory(opened.workspaceId, 'src/dist'), /Hidden and generated directories cannot be created/);
  await assert.rejects(access.createDirectory(opened.workspaceId, 'new-dir'), /A folder already exists at that path/);
  await assert.rejects(access.createDirectory(opened.workspaceId, '../escape'), /unsafe path segment/);
  assert.equal(await fs.access(path.join(path.dirname(root), 'escape')).then(() => true, () => false), false);

  const filesOnly = await access.openFiles([path.join(root, 'App.tsx')]);
  await assert.rejects(access.createDirectory(filesOnly.workspaceId, 'new-dir'), /folder workspace/);
});

test('createDirectory and deletePath refuse anything reaching a directory symlink', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-link-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-link-outside-'));
  context.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(outside, 'kept.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    context.skip('Directory symlinks are unavailable in this environment.');
    return;
  }

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);

  await assert.rejects(access.createDirectory(opened.workspaceId, 'linked/inner'), /symbolic link or non-directory/);
  await assert.rejects(access.deletePath(opened.workspaceId, 'linked'), /Symbolic links are not deleted/);
  assert.equal(await fs.access(path.join(outside, 'inner')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(outside, 'kept.txt'), 'utf8'), 'outside');
});

test('deletePath removes files and empty folders but refuses every riskier shape', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-delete-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'gone.txt'), 'bye');
  await fs.mkdir(path.join(root, 'empty-dir'));
  await fs.mkdir(path.join(root, 'full-dir'), { recursive: true });
  await fs.writeFile(path.join(root, 'full-dir', 'inside.txt'), 'kept');
  await fs.writeFile(path.join(root, '.hidden.txt'), 'hidden');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);

  assert.deepEqual(await access.deletePath(opened.workspaceId, 'gone.txt'), { path: 'gone.txt', kind: 'file' });
  assert.equal(await fs.access(path.join(root, 'gone.txt')).then(() => true, () => false), false);

  assert.deepEqual(await access.deletePath(opened.workspaceId, 'empty-dir'), { path: 'empty-dir', kind: 'directory' });
  assert.equal(await fs.access(path.join(root, 'empty-dir')).then(() => true, () => false), false);

  await assert.rejects(access.deletePath(opened.workspaceId, 'full-dir'), /Only an empty folder can be deleted/);
  assert.equal((await fs.stat(path.join(root, 'full-dir'))).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(root, 'full-dir', 'inside.txt'), 'utf8'), 'kept');
  await assert.rejects(access.deletePath(opened.workspaceId, '.hidden.txt'), /Hidden and generated project directories cannot be deleted/);
  await assert.rejects(access.deletePath(opened.workspaceId, 'node_modules/leftover.js'), /Hidden and generated project directories cannot be deleted/);
  await assert.rejects(access.deletePath(opened.workspaceId, 'never-existed.txt'), /no longer in the workspace/);
  await assert.rejects(access.deletePath(opened.workspaceId, 'gone.txt'), /no longer in the workspace/);

  // The deleted file is now an ordinary create again: the stage path no longer
  // sees a disk entry it cannot account for.
  const staged = await access.stageFiles(opened.workspaceId, [{ name: 'gone.txt', content: 'reborn' }]);
  assert.equal(staged.files[0].before, null);
  assert.equal(staged.files[0].after, 'reborn');
  const committed = await access.commitTransaction(opened.workspaceId, staged.transactionId);
  assert.deepEqual(committed.saved, ['gone.txt'], JSON.stringify(committed.errors));
  assert.equal(await fs.readFile(path.join(root, 'gone.txt'), 'utf8'), 'reborn');
});

test('loadFiles batch-reads buffers the renderer never asked for and reports the unreadable', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-load-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'README.md'), 'readme');
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export default 1;');
  await fs.writeFile(path.join(root, '.secret.txt'), 'hidden');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  assert.deepEqual(opened.files, []);

  const loaded = await access.loadFiles(opened.workspaceId, [
    'README.md',
    'src/App.tsx',
    'missing.ts',
    '.secret.txt',
    'node_modules/pkg/index.js'
  ]);

  assert.deepEqual(loaded.files.map(({ name, content }) => [name, content]), [
    ['README.md', 'readme'],
    ['src/App.tsx', 'export default 1;']
  ]);
  for (const file of loaded.files) assert.match(file.version, /^[0-9a-f]{64}$/);
  assert.deepEqual(loaded.missing.map(({ path: missingPath }) => missingPath), [
    'missing.ts',
    '.secret.txt',
    'node_modules/pkg/index.js'
  ]);
  assert.match(loaded.missing[0].reason, /ENOENT/);
  assert.match(loaded.missing[1].reason, /Hidden and generated/);
  assert.match(loaded.missing[2].reason, /Hidden and generated/);
  await assert.rejects(access.loadFiles('closed-workspace-id', ['README.md']), /no longer open/);

  // Loading populated the map and hashed the disk copy, so the file is
  // pre-existing for the transaction and its version passes the guard.
  const staged = await access.stageFiles(opened.workspaceId, [
    { name: 'README.md', content: 'edited readme', expectedVersion: loaded.files[0].version }
  ]);
  assert.equal(staged.files[0].before, 'readme');
  const committed = await access.commitTransaction(opened.workspaceId, staged.transactionId);
  assert.deepEqual(committed.saved, ['README.md'], JSON.stringify(committed.errors));
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'edited readme');
});

test('staging a never-opened folder file writes it instead of refusing', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-adopt-stage-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'README.md'), 'old text');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  assert.deepEqual(opened.files, [], 'README.md must not be a renderer buffer.');

  const staged = await access.stageFiles(opened.workspaceId, [{ name: 'README.md', content: 'new text' }]);
  assert.equal(staged.files[0].before, 'old text');
  assert.equal(staged.files[0].after, 'new text');

  const result = await access.commitTransaction(opened.workspaceId, staged.transactionId);
  assert.deepEqual(result.saved, ['README.md'], JSON.stringify(result.errors));
  assert.equal(result.errors.length, 0);
  assert.equal(result.rolledBack, undefined);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'new text');
});

test('adopted files keep the optimistic-concurrency guard on both write paths', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-adopt-stale-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'README.md'), 'old text');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);

  await assert.rejects(
    access.stageFiles(opened.workspaceId, [{ name: 'README.md', content: 'new text', expectedVersion: 'stale' }]),
    /README\.md changed on disk\. Reload it before staging changes\./
  );
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'old text');

  const result = await access.saveFiles(opened.workspaceId, [{ name: 'README.md', content: 'new text', expectedVersion: 'stale' }]);
  assert.deepEqual(result.saved, []);
  assert.match(result.errors[0].message, /changed on disk/);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'old text');
});

test('a transaction validates every file before writing any — a late external edit blocks the whole set', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-txn-atomic-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 2;\n');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const staged = await access.stageFiles(opened.workspaceId, [
    { name: 'a.ts', content: 'export const A = 1;\n' },
    { name: 'b.ts', content: 'export const B = 2;\n' }
  ]);

  // The user edits b.ts by hand after the proposal was staged.
  await fs.writeFile(path.join(root, 'b.ts'), 'export const b = 999; // vim\n', 'utf8');

  await assert.rejects(
    access.commitTransaction(opened.workspaceId, staged.transactionId),
    /b\.ts changed after the proposal was prepared\. Generate it again\./
  );
  // Commit-time validation runs over the whole transaction before any save,
  // so the still-valid a.ts must NOT have landed. Ten files landing and one
  // failing is exactly the half-applied refactor this rail must never do.
  assert.equal(await fs.readFile(path.join(root, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await fs.readFile(path.join(root, 'b.ts'), 'utf8'), 'export const b = 999; // vim\n');

  // The refused transaction is untouched and can be discarded; the disk keeps
  // the external edit.
  access.discardTransaction(opened.workspaceId, staged.transactionId);
  await assert.rejects(access.commitTransaction(opened.workspaceId, staged.transactionId), /expired/);
});

test('a file the turn never read cannot be replaced: never-adoptable paths stay foreign to the save path', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-never-read-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const pngBytes = Buffer.from('89504e470d0a1a0a0000000dIHDR', 'hex');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', 'logo.png'), pngBytes);

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);

  // Assets are not adoptable text, so the save path must refuse to overwrite
  // a file it could never have read — the whole-file-wipe shape at disk level.
  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'assets/logo.png', content: 'export const evil = 1;' }
  ]);
  assert.deepEqual(result.saved, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /not part of the opened workspace/);
  assert.deepEqual(await fs.readFile(path.join(root, 'assets', 'logo.png')), pngBytes);

  // The staging path refuses the same shape before any transaction exists.
  await assert.rejects(
    access.stageFiles(opened.workspaceId, [{ name: 'assets/logo.png', content: 'nope' }]),
    /is not an editable workspace file/
  );
});

test('saveFiles writes a never-opened folder file and still guards hidden ones', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-adopt-save-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'notes'));
  await fs.writeFile(path.join(root, 'notes', 'todo.md'), 'first');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);

  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'notes/todo.md', content: 'second' },
    { name: '.env', content: 'SECRET=2' }
  ]);
  assert.deepEqual(result.saved, ['notes/todo.md'], JSON.stringify(result.errors));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /not part of the opened workspace/);
  assert.equal(await fs.readFile(path.join(root, 'notes', 'todo.md'), 'utf8'), 'second');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'SECRET=1');
});

test('searchContent finds text with line, column and a centred preview', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-search-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'export default function App() {\n  return <button>Open the pod bay doors</button>;\n}\n');
  await fs.writeFile(path.join(root, 'src', 'other.ts'), 'const hal = "OPEN THE POD BAY DOORS";\n');
  await fs.writeFile(path.join(root, 'node_modules', 'lib.js'), 'open the pod bay doors\n');
  await fs.writeFile(path.join(root, 'src', 'nested.md'), 'x'.repeat(200) + ' pod bay doors ' + 'y'.repeat(400));

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const result = await access.searchContent(opened.workspaceId, { query: 'pod bay doors' });
  assert.equal(result.error, null);
  assert.deepEqual(result.matches.map((match) => [match.path, match.line, match.column]), [
    ['src/App.tsx', 2, 27],
    ['src/nested.md', 1, 202],
    ['src/other.ts', 1, 23]
  ], 'hidden and ignored paths stay out, and matching is case-insensitive');
  assert.match(result.matches[0].preview, /<button>Open the pod bay doors<\/button>/);
  assert.ok(result.matches[1].preview.length < 260, 'a long line is clipped around the hit, not dumped');
  assert.equal(result.truncated, false);
});

test('searchContent include patterns narrow by glob or by name', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-search-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'App.tsx'), 'needle here\n');
  await fs.writeFile(path.join(root, 'src', 'deep', 'App.tsx'), 'needle here\n');
  await fs.writeFile(path.join(root, 'src', 'App.ts'), 'needle here\n');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const nested = await access.searchContent(opened.workspaceId, { query: 'needle', include: 'src/**/*.tsx' });
  assert.deepEqual(nested.matches.map((match) => match.path), ['src/App.tsx', 'src/deep/App.tsx']);
  const byName = await access.searchContent(opened.workspaceId, { query: 'needle', include: ['App.ts'] });
  assert.deepEqual(byName.matches.map((match) => match.path).sort(), ['src/App.ts', 'src/App.tsx', 'src/deep/App.tsx'],
    'a pattern with no wildcard is a substring of the file name, so App.ts* also matches');
  const noMatches = await access.searchContent(opened.workspaceId, { query: 'needle', include: 'docs/*.md' });
  assert.deepEqual(noMatches.matches, []);
});

test('searchContent regex mode reports a bad pattern instead of throwing', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-search-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.ts'), 'const count = 42;\nconst counter = 7;\n');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const found = await access.searchContent(opened.workspaceId, { query: 'count\\w* = \\d+', regex: true });
  assert.deepEqual(found.matches.map((match) => [match.line, match.column, match.preview]), [
    [1, 7, 'const count = 42;'],
    [2, 7, 'const counter = 7;']
  ]);
  const broken = await access.searchContent(opened.workspaceId, { query: 'count(', regex: true });
  assert.match(broken.error, /Invalid regular expression/);
  assert.deepEqual(broken.matches, []);
  const tooShort = await access.searchContent(opened.workspaceId, { query: 'c' });
  assert.match(tooShort.error, /at least 2 characters/);
});

test('searchContent namesOnly lists paths and the limit reports truncation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-search-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['alpha-controller.ts', 'beta-controller.ts', 'gamma.ts']) {
    await fs.writeFile(path.join(root, name), 'controller\n');
  }

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const byPath = await access.searchContent(opened.workspaceId, { query: 'controller', namesOnly: true });
  assert.deepEqual(byPath.matches.map((match) => match.path).sort(), ['alpha-controller.ts', 'beta-controller.ts']);
  assert.deepEqual(byPath.matches[0], { path: 'alpha-controller.ts', line: 0, column: 0, preview: '' });

  const capped = await access.searchContent(opened.workspaceId, { query: 'controller', limit: 1 });
  assert.equal(capped.matches.length, 1);
  assert.equal(capped.truncated, true);
});

test('a file-only workspace searches its attached files, not the folder beside them', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-files-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const attached = path.join(root, 'kept.ts');
  await fs.writeFile(attached, 'pod bay doors\n');
  await fs.writeFile(path.join(root, 'neighbour.ts'), 'pod bay doors\n');

  const access = createWorkspaceAccess();
  const opened = await access.openFiles([attached]);
  const result = await access.searchContent(opened.workspaceId, { query: 'pod bay' });
  assert.deepEqual(result.matches.map((match) => match.path), ['kept.ts']);
});

test('loadFiles honours byte caps so the repo map read stays bounded', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-mapread-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a'.repeat(1_000));
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'b'.repeat(1_000));
  await fs.writeFile(path.join(root, 'src', 'huge.ts'), 'h'.repeat(9_000));

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const capped = await access.loadFiles(opened.workspaceId, ['src/a.ts', 'src/b.ts', 'src/huge.ts'], { maxBytesPerFile: 2_000 });
  assert.deepEqual(capped.files.map((file) => file.name), ['src/a.ts', 'src/b.ts']);
  assert.equal(capped.missing.length, 1);
  assert.match(capped.missing[0].reason, /larger than the 2000 byte limit/);

  const budgeted = await access.loadFiles(opened.workspaceId, ['src/a.ts', 'src/b.ts'], { maxBytesPerFile: 2_000, maxTotalBytes: 1_200 });
  assert.deepEqual(budgeted.files.map((file) => file.name), ['src/a.ts']);
  assert.match(budgeted.missing[0].reason, /byte budget for this read is full/);

  const uncapped = await access.loadFiles(opened.workspaceId, ['src/a.ts', 'src/huge.ts']);
  assert.deepEqual(uncapped.files.map((file) => file.name), ['src/a.ts', 'src/huge.ts'],
    'the patch path still reads large files; only the map opts into caps');
});

test('finds the prompt documents the explorer hides, and reads them', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-project-docs-'));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.shadrox', 'rules'), { recursive: true });
  await fs.mkdir(path.join(root, '.shadrox', 'skills'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(root, '.shadrox', 'rules', 'style.md'), '# always use 2 spaces');
  await fs.writeFile(path.join(root, '.shadrox', 'skills', 'ship.md'), '---\nname: ship\n---\nrun the checks');
  await fs.writeFile(path.join(root, '.shadrox', 'automations.json'), '[]');
  await fs.writeFile(path.join(root, '.shadrox', 'secrets.txt'), 'hidden');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# talk to the agent');
  await fs.writeFile(path.join(root, '.cursorrules'), 'cursor said so');
  await fs.writeFile(path.join(root, 'node_modules', 'dep', 'AGENTS.md'), 'vendored');

  const access = createWorkspaceAccess();
  const opened = await access.openFolder(root);
  const docs = await access.projectDocs(opened.workspaceId);
  assert.deepEqual(docs.map((doc) => doc.path), [
    '.cursorrules',
    '.shadrox/rules/style.md',
    '.shadrox/skills/ship.md',
    'AGENTS.md'
  ], 'hidden config docs surface, vendored ones do not');

  const read = await access.loadFiles(opened.workspaceId, docs.map((doc) => doc.path));
  assert.deepEqual(read.files.map((file) => file.name), docs.map((doc) => doc.path));
  await assert.rejects(access.readFile(opened.workspaceId, '.shadrox/secrets.txt'), /Hidden and generated/);

  // Reading a rule is allowed; rewriting one from a reply is not.
  const saved = await access.saveFiles(opened.workspaceId, [
    { name: '.shadrox/rules/style.md', content: '# rewritten' }
  ]);
  assert.deepEqual(saved.saved, [], 'the save path does not accept a rule document');
  assert.equal(saved.errors.length, 1);
  assert.equal(await fs.readFile(path.join(root, '.shadrox', 'rules', 'style.md'), 'utf8'), '# always use 2 spaces');
});

test('a single-file workspace has no project documents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-docs-files-'));
  const file = path.join(root, 'only.ts');
  await fs.writeFile(file, 'const a = 1;');
  const access = createWorkspaceAccess();
  const opened = await access.openFiles([file]);
  assert.deepEqual(await access.projectDocs(opened.workspaceId), []);
});
