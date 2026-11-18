import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyToolEffect, describeTools, runTool } from './tools';

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

interface StubWrite { name: string; content: string; expectedVersion?: string | null }

/** An in-memory disk behind the same bridge surface the real save path uses. */
function diskStub(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial).map(([path, content]) => [path, { content, version: `v-${path}` }]));
  const writes: StubWrite[] = [];
  const order: string[] = [];
  return {
    files,
    writes,
    order,
    bridge: {
      readFile: async (_id: string, path: string) => {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error(`ENOENT: no such file '${path}'`), { code: 'ENOENT' });
        return { name: path, content: file.content, version: file.version };
      },
      verifyChangeSet: async (_id: string, changed: Array<{ path: string; content: string }>) => {
        order.push(`verify:${changed[0].path}`);
        return { ok: true, checked: 1, issues: [], skipped: [] };
      },
      saveFiles: async (_id: string, requested: StubWrite[]) => {
        order.push(`save:${requested[0].name}`);
        writes.push(...requested);
        for (const write of requested) files.set(write.name, { content: write.content, version: 'v-next' });
        return { saved: requested.map((write) => write.name), errors: [] };
      }
    }
  };
}

const bigFile = Array.from({ length: 20 }, (_, index) => `export const line${index} = ${index};`).join('\n');

test('write_file creates a new file through the verified, version-pinned save', async () => {
  const disk = diskStub({});
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'src/new.ts', content: 'export const a = 1;\n' } });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.changedFiles, 1);
    assert.match(outcome.content, /Created src\/new\.ts/);
    assert.deepEqual(disk.order, ['verify:src/new.ts', 'save:src/new.ts'], 'verification gates the save');
    assert.equal(disk.writes[0].content, 'export const a = 1;\n');
    assert.equal(disk.writes[0].expectedVersion, null, 'a new file pins absence, so a race cannot clobber it');
    assert.equal(disk.files.get('src/new.ts')?.content, 'export const a = 1;\n');
  });
});

test('write_file overwrites an existing file pinned to the version it read', async () => {
  const disk = diskStub({ 'a.txt': 'one\ntwo\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'a.txt', content: 'three\n' } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /Rewrote a\.txt/);
    assert.equal(disk.writes[0].expectedVersion, 'v-a.txt');
  });
});

test('write_file refuses to gut a substantial existing file', async () => {
  const disk = diskStub({ 'src/big.ts': bigFile });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'src/big.ts', content: 'export const line0 = 0;\n' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error as string, /whole-file rewrite/);
    assert.match(outcome.error as string, /edit_file/);
    assert.equal(disk.writes.length, 0, 'the rewrite-risk guard stops the save');
    assert.equal(disk.files.get('src/big.ts')?.content, bigFile);
  });
});

test('edit_file replaces the exact snippet and keeps the rest of the file', async () => {
  const disk = diskStub({ 'src/a.ts': 'const a = 1;\nconst b = 2;\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'src/a.ts', original: 'const a = 1;', updated: 'const a = 42;' } });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.changedFiles, 1);
    assert.match(outcome.content, /Edited src\/a\.ts/);
    assert.equal(disk.writes[0].content, 'const a = 42;\nconst b = 2;\n', 'only the snippet changed');
    assert.equal(disk.writes[0].expectedVersion, 'v-src/a.ts');
  });
});

test('edit_file fails cleanly when original is not found, writing nothing', async () => {
  const disk = diskStub({ 'src/a.ts': 'const a = 1;\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'src/a.ts', original: 'const a = 999;', updated: 'x' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error as string, /not found/);
    assert.match(outcome.error as string, /exact current text/, 'the model can self-correct from the error');
    assert.equal(disk.writes.length, 0);
    assert.equal(disk.files.get('src/a.ts')?.content, 'const a = 1;\n');
  });
});

test('edit_file refuses an original that matches more than one place', async () => {
  const disk = diskStub({ 'a.ts': 'x();\ny();\nx();\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'a.ts', original: 'x();', updated: 'z();' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error as string, /more than once/);
    assert.equal(disk.writes.length, 0);
  });
});

test('edit_file on a missing file points at write_file instead of creating silently', async () => {
  const disk = diskStub({});
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'gone.ts', original: 'a', updated: 'b' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error as string, /does not exist/);
    assert.match(outcome.error as string, /write_file/);
    assert.equal(disk.writes.length, 0);
  });
});

test('edit_file with an empty original is refused, never an insert-everywhere', async () => {
  const disk = diskStub({ 'a.ts': 'content\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'a.ts', original: '', updated: 'x' } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refused, true);
    assert.equal(disk.writes.length, 0);
  });
});

test('edit_file with identical original and updated changes nothing', async () => {
  const disk = diskStub({ 'a.ts': 'same\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'a.ts', original: 'same', updated: 'same' } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /nothing to change/);
    assert.equal(disk.writes.length, 0);
  });
});

test('write tools refuse protected manifests and paths outside the workspace', async () => {
  const disk = diskStub({});
  await withBridge(disk.bridge, async () => {
    const manifest = await runTool('ws', { name: 'write_file', args: { path: '.shadrox/automations.json', content: '{}' } });
    assert.equal(manifest.ok, false);
    assert.equal(manifest.refused, true);
    const escape = await runTool('ws', { name: 'edit_file', args: { path: '../outside.txt', original: 'a', updated: 'b' } });
    assert.equal(escape.ok, false);
    assert.equal(escape.refused, true);
    const absolute = await runTool('ws', { name: 'write_file', args: { path: 'C:/windows/x.txt', content: 'x' } });
    assert.equal(absolute.ok, false);
    assert.equal(disk.writes.length, 0);
  });
});

test('a change the verifier refuses never reaches the save', async () => {
  const disk = diskStub({});
  const bridge = {
    ...disk.bridge,
    verifyChangeSet: async () => ({
      ok: false,
      checked: 1,
      issues: [{ path: 'bad.ts', line: 3, character: 0, severity: 'error', code: 'SYNTAX', message: 'Unexpected token' }],
      skipped: []
    })
  };
  await withBridge(bridge, async () => {
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'bad.ts', content: 'const = ;' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error as string, /bad\.ts:4 Unexpected token/);
    assert.equal(disk.writes.length, 0);
  });
});

test('a save the bridge reports as failed is not a success', async () => {
  const disk = diskStub({});
  const bridge = {
    ...disk.bridge,
    saveFiles: async () => ({ saved: [], errors: [{ name: 'a.ts', message: 'This file changed on disk. Reload it before saving to avoid overwriting external changes.' }] })
  };
  await withBridge(bridge, async () => {
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'a.ts', content: 'x' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error as string, /changed on disk/);
    assert.equal(outcome.changedFiles, undefined);
  });
});

test('write tools are write-effect and documented in the prompt', () => {
  assert.equal(classifyToolEffect('write_file'), 'write');
  assert.equal(classifyToolEffect('edit_file'), 'write');
  const prompt = describeTools(5).join('\n');
  assert.match(prompt, /write_file/);
  assert.match(prompt, /edit_file/);
  assert.doesNotMatch(prompt, /there is no create_file, write_file or edit_file tool/, 'the prompt must not deny the tools it lists');
  assert.match(prompt, /read and write access/);
});