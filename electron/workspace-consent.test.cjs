'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createWorkspaceConsent,
  resolveFileReopen,
  resolveFolderReopen
} = require('./workspace-consent.cjs');

async function temporaryDirectory(context, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('folder consent is exact, canonical and scoped to one registry lifetime', async (context) => {
  const parent = await temporaryDirectory(context, 'shadrox-consent-');
  const folder = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'sibling');
  await Promise.all([fs.mkdir(folder), fs.mkdir(sibling)]);

  const consent = createWorkspaceConsent();
  await consent.grantFolder(folder);
  assert.equal(await consent.hasFolder(folder), true);
  assert.equal(await consent.hasFolder(sibling), false);
  assert.equal(await consent.hasFolder(path.join(folder, 'nested')), false);
  assert.equal(await createWorkspaceConsent().hasFolder(folder), false);
});

test('canonical folder aliases match consent but linked folders outside it do not', async (context) => {
  const parent = await temporaryDirectory(context, 'shadrox-consent-links-');
  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(outside)]);

  const alias = path.join(parent, 'workspace-alias');
  const escape = path.join(workspace, 'linked-outside');
  try {
    await fs.symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    context.skip('Directory symlinks are unavailable in this environment.');
    return;
  }

  const consent = createWorkspaceConsent();
  await consent.grantFolder(workspace);
  assert.equal(await consent.hasFolder(alias), true);
  assert.equal(await consent.hasFolder(escape), false);
});

test('file consent is per-file and does not expand to siblings', async (context) => {
  const folder = await temporaryDirectory(context, 'shadrox-file-consent-');
  const first = path.join(folder, 'first.ts');
  const second = path.join(folder, 'second.ts');
  await Promise.all([fs.writeFile(first, 'first'), fs.writeFile(second, 'second')]);

  const consent = createWorkspaceConsent();
  await consent.grantFiles([first]);
  assert.equal(await consent.hasFiles([first]), true);
  assert.equal(await consent.hasFiles([first, second]), false);
  assert.equal(await consent.hasFolder(folder), false);
});

test('unknown folder reopen uses only the native selection and cancellation changes nothing', async () => {
  const consent = createWorkspaceConsent();
  let calls = 0;
  const canceled = await resolveFolderReopen('renderer-path', consent, async () => {
    calls++;
    return { canceled: true, filePaths: [] };
  });
  assert.equal(canceled, null);
  assert.equal(calls, 1);

  const chosenPath = 'user-selected-folder';
  const selected = await resolveFolderReopen('renderer-path', consent, async () => ({
    canceled: false,
    filePaths: [chosenPath]
  }));
  assert.equal(selected, chosenPath);
});

test('a restart keeps consent so a recent folder reopens in one click', async (context) => {
  const root = await temporaryDirectory(context, 'shadrox-consent-restart-');
  const folder = path.join(root, 'workspace');
  const file = path.join(root, 'notes.md');
  const unknown = path.join(root, 'never-picked');
  await Promise.all([fs.mkdir(folder), fs.writeFile(file, 'notes'), fs.mkdir(unknown)]);
  const storageFile = path.join(root, 'workspace-consent.json');

  const first = createWorkspaceConsent({ storageFile });
  await first.grantFolder(folder);
  await first.grantFiles([file]);

  const restarted = createWorkspaceConsent({ storageFile });
  assert.equal(await restarted.hasFolder(folder), true);
  assert.equal(await restarted.hasFiles([file]), true);

  let calls = 0;
  const reopened = await resolveFolderReopen(folder, restarted, async () => {
    calls++;
    return { canceled: true, filePaths: [] };
  });
  assert.equal(reopened, folder);
  assert.equal(calls, 0, 'a consented folder must not open a picker');

  assert.deepEqual(await resolveFileReopen([file], restarted, async () => {
    calls++;
    return { canceled: true, filePaths: [] };
  }), [file]);
  assert.equal(calls, 0, 'a consented file must not open a picker');

  const picked = path.join(root, 'picked-later');
  await resolveFolderReopen(unknown, restarted, async () => {
    calls++;
    return { canceled: false, filePaths: [picked] };
  });
  assert.equal(calls, 1, 'an unseen path still requires the native picker');
});

test('a damaged consent file is ignored instead of blocking the app', async (context) => {
  const root = await temporaryDirectory(context, 'shadrox-consent-corrupt-');
  const folder = path.join(root, 'workspace');
  await fs.mkdir(folder);
  const storageFile = path.join(root, 'workspace-consent.json');
  await fs.writeFile(storageFile, '{ not json');

  const consent = createWorkspaceConsent({ storageFile });
  assert.equal(await consent.hasFolder(folder), false);
  await consent.grantFolder(folder);
  const restarted = createWorkspaceConsent({ storageFile });
  assert.equal(await restarted.hasFolder(folder), true);
});

test('unknown file reopen uses only native selections and cancellation returns no paths', async () => {
  const consent = createWorkspaceConsent();
  const canceled = await resolveFileReopen(['renderer-file'], consent, async () => ({
    canceled: true,
    filePaths: []
  }));
  assert.equal(canceled, null);

  const selectedPaths = ['selected-first.ts', 'selected-second.ts'];
  const selected = await resolveFileReopen(['renderer-file'], consent, async () => ({
    canceled: false,
    filePaths: selectedPaths
  }));
  assert.deepEqual(selected, selectedPaths);
  assert.equal(await resolveFileReopen(['renderer-file'], consent, async () => ({
    canceled: false,
    filePaths: [null]
  })), null);
});
