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
  assert.deepEqual(opened.files.map((file) => file.name), ['src/App.tsx']);
  await fs.writeFile(path.join(root, 'src', 'unseen.ts'), 'do not overwrite');

  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'src/App.tsx', content: 'export default 2;' },
    { name: 'src/new/Widget.tsx', content: 'export default 3;' },
    { name: 'src/unseen.ts', content: 'must not overwrite' },
    { name: '../outside.txt', content: 'must not escape' }
  ]);

  assert.deepEqual(result.saved, ['src/App.tsx', 'src/new/Widget.tsx']);
  assert.equal(result.errors.length, 2);
  assert.equal(await fs.readFile(path.join(root, 'src', 'App.tsx'), 'utf8'), 'export default 2;');
  assert.equal(await fs.readFile(path.join(root, 'src', 'new', 'Widget.tsx'), 'utf8'), 'export default 3;');
  assert.equal(await fs.readFile(path.join(root, 'src', 'unseen.ts'), 'utf8'), 'do not overwrite');
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
  const result = await access.saveFiles(opened.workspaceId, [
    { name: 'Selected.ts', content: 'after' },
    { name: 'New.ts', content: 'not allowed' }
  ]);

  assert.deepEqual(result.saved, ['Selected.ts']);
  assert.equal(result.errors.length, 1);
  assert.equal(await fs.readFile(selected, 'utf8'), 'after');
  assert.equal(await fs.access(path.join(root, 'New.ts')).then(() => true, () => false), false);
});
