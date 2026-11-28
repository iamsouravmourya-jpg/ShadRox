import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyToolEffect, describeTools, hasConflictMarkers, locateUniqueMatch, runTool } from './tools';
import { beginTurn, noteRead, noteWrite, resetTurns } from './turnState';
import {
  acceptAllPendingChanges,
  clearWorkspacePendingChanges,
  listPendingChanges,
  rejectAllPendingChanges,
  setWorkspaceAutoSave
} from './pendingChanges';

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

test('lean profile keeps every tool name but drops the verbose advanced guidance', () => {
  const full = describeTools(5).join('\n');
  const lean = describeTools(5, [], [], undefined, 'lean').join('\n');
  for (const name of ['read_file', 'write_file', 'edit_file', 'run_command', 'verify']) {
    assert.ok(lean.includes(name), `lean still lists ${name}`);
  }
  assert.ok(lean.length < full.length, 'lean prompt is smaller than full');
  assert.doesNotMatch(lean, /WRITE TOOL CHOICE/, 'lean drops the write-choice detail');
  assert.doesNotMatch(lean, /ATOMIC PATCHES/, 'lean drops the atomic-patch detail');
  assert.doesNotMatch(lean, /PORT CONFLICTS/, 'lean drops the port-conflict detail');
  assert.match(full, /WRITE TOOL CHOICE/, 'full keeps the detail lean drops');
});

test('edit_file matches uniquely across CRLF differences and trailing whitespace', async () => {
  const disk = diskStub({ 'src/crlf.ts': 'const a = 1;  \r\nconst b = 2;\r\n' });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', {
      name: 'edit_file',
      args: { path: 'src/crlf.ts', original: 'const a = 1;\nconst b = 2;', updated: 'const a = 10;\r\nconst b = 2;' }
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /normalization/);
    assert.equal(disk.files.get('src/crlf.ts')?.content, 'const a = 10;\r\nconst b = 2;\r\n');
  });
});

test('edit_file safely matches unique multi-line indentation differences while refusing ambiguous matches', async () => {
  const source = 'function run() {\n    const x = 1;\n    return x + 1;\n}\n';
  const disk = diskStub({ 'src/indent.ts': source });
  await withBridge(disk.bridge, async () => {
    const ok = await runTool('ws', {
      name: 'edit_file',
      args: {
        path: 'src/indent.ts',
        original: 'const x = 1;\nreturn x + 1;',
        updated: '    const x = 2;\n    return x + 2;'
      }
    });
    assert.equal(ok.ok, true);
    assert.match(ok.content, /indent-normalized/);
    assert.equal(disk.files.get('src/indent.ts')?.content, 'function run() {\n    const x = 2;\n    return x + 2;\n}\n');
  });

  const duplicateDisk = diskStub({
    'src/dup.ts': 'if (a) {\n  const x = 1;\n  return x;\n}\nif (b) {\n    const x = 1;\n    return x;\n}\n'
  });
  await withBridge(duplicateDisk.bridge, async () => {
    const refused = await runTool('ws', {
      name: 'edit_file',
      args: { path: 'src/dup.ts', original: 'const x = 1;\nreturn x;', updated: 'const x = 2;' }
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error as string, /more than once/);
    assert.equal(duplicateDisk.writes.length, 0);
  });

  assert.equal(locateUniqueMatch('  const x = 1;\n', '    const x = 1;').status, 'not_found');
});

test('large existing file rewrite uses backupFile outside workspace and never writes shadrox-backups into disk', async () => {
  const large = Array.from({ length: 850 }, (_, i) => `export const item_${i} = ${i};`).join('\n');
  assert.ok(large.length >= 20_000);
  const backups: Array<{ path: string; content: string }> = [];
  const disk = diskStub({ 'src/large.ts': large });
  const bridge = {
    ...disk.bridge,
    backupFile: async (_id: string, path: string, content: string) => {
      backups.push({ path, content });
      return { backupPath: `/userData/file-backups/${path}.bak` };
    }
  };
  await withBridge(bridge, async () => {
    const replacement = Array.from({ length: 850 }, (_, i) => `export const item_${i} = ${i + 1};`).join('\n');
    const outcome = await runTool('ws', { name: 'write_file', args: { path: 'src/large.ts', content: replacement } });
    assert.equal(outcome.ok, true);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].path, 'src/large.ts');
    assert.equal(disk.writes.some((w) => w.name.includes('shadrox-backups')), false);
  });
});

test('write_file and edit_file reject placeholder stub code before saving', async () => {
  const disk = diskStub({ 'src/api.ts': 'export const title = "Intro";\n' });
  await withBridge(disk.bridge, async () => {
    const badWrite = await runTool('ws', {
      name: 'write_file',
      args: { path: 'src/stub.ts', content: "export const data = { courseTitle: '', // Retrieve course title if needed\n};" }
    });
    assert.equal(badWrite.ok, false);
    assert.match(badWrite.error as string, /Placeholder/i);
    assert.equal(disk.writes.length, 0);

    const badEdit = await runTool('ws', {
      name: 'edit_file',
      args: {
        path: 'src/api.ts',
        original: 'export const title = "Intro";',
        updated: "export const title = ''; // TODO populate title"
      }
    });
    assert.equal(badEdit.ok, false);
    assert.match(badEdit.error as string, /Placeholder/i);
    assert.equal(disk.writes.length, 0);
  });
});

test('write_file allows monolith shrinking inside an active turn after creating extracted files and taking a backup', async () => {
  const monolith = Array.from({ length: 120 }, (_, i) => `export const sym${i} = ${i};`).join('\n');
  const backups: string[] = [];
  const disk = diskStub({ 'src/monolith.ts': monolith });
  const bridge = {
    ...disk.bridge,
    backupFile: async (_id: string, path: string) => {
      backups.push(path);
      return { backupPath: `/userData/backups/${path}.bak` };
    }
  };
  await withBridge(bridge, async () => {
    const turn = beginTurn('ws', 'decompose src/monolith.ts', { scaffold: false, addPage: false });
    try {
      const created = await runTool('ws', {
        name: 'write_file',
        args: { path: 'src/extracted.ts', content: 'export const sym0 = 0;\n' }
      });
      assert.equal(created.ok, true);
      noteWrite(turn, created.changedPaths ?? ['src/extracted.ts'], created.createdPaths ?? ['src/extracted.ts']);
      noteRead(turn, 'src/monolith.ts');

      const slim = "export { sym0 } from './extracted';\n";
      const outcome = await runTool('ws', {
        name: 'write_file',
        args: { path: 'src/monolith.ts', content: slim }
      });
      assert.equal(outcome.ok, true, outcome.error ?? 'expected monolith extraction rewrite to succeed');
      assert.match(outcome.content, /backed up outside workspace/);
      assert.deepEqual(backups, ['src/monolith.ts']);
      assert.equal(disk.files.get('src/monolith.ts')?.content, slim);
    } finally {
      resetTurns();
    }
  });
});

test('read_file returns up to 400 lines in one call and write_file allows substantial rewrites read this turn while blocking stubs', async () => {
  const lines450 = Array.from({ length: 450 }, (_, i) => `export const val${i} = ${i};`).join('\n');
  const lines60 = Array.from({ length: 60 }, (_, i) => `export const item${i} = ${i};`).join('\n');
  const rewritten20 = Array.from({ length: 20 }, (_, i) => `export const nextItem${i} = ${i * 2};`).join('\n');
  const stub3 = 'export const a = 1;\nexport const b = 2;\n';

  const disk = diskStub({
    'src/long.ts': lines450,
    'src/component.ts': lines60
  });

  await withBridge(disk.bridge, async () => {
    beginTurn('ws', 'update component and inspect long file', { scaffold: false, addPage: false });
    try {
      const readOutcome = await runTool('ws', { name: 'read_file', args: { path: 'src/long.ts' } });
      assert.equal(readOutcome.ok, true);
      assert.match(readOutcome.content, /Total lines: 450 \| Showing lines 1-400/);

      // Stub truncation (<15 lines on >=20-line file) is still blocked even after reading
      await runTool('ws', { name: 'read_file', args: { path: 'src/component.ts' } });
      const stubOutcome = await runTool('ws', {
        name: 'write_file',
        args: { path: 'src/component.ts', content: stub3 }
      });
      assert.equal(stubOutcome.ok, false);
      assert.equal(stubOutcome.refused, true);
      assert.match(stubOutcome.error ?? '', /stub|whole-file rewrite/i);

      // Complete replacement (>=15 non-blank lines) succeeds when explicitly read this turn
      const fullRewriteOutcome = await runTool('ws', {
        name: 'write_file',
        args: { path: 'src/component.ts', content: rewritten20 }
      });
      assert.equal(fullRewriteOutcome.ok, true, fullRewriteOutcome.error ?? 'expected substantial rewrite after read to succeed');
      assert.equal(disk.files.get('src/component.ts')?.content, rewritten20);
    } finally {
      resetTurns();
    }
  });
});

test('Auto-Save OFF stages write_file and edit_file edits without flushing to disk until accepted', async () => {
  const disk = diskStub({ 'src/app.ts': 'export const count = 1;\n' });
  await withBridge(disk.bridge, async () => {
    clearWorkspacePendingChanges('ws-staging');
    setWorkspaceAutoSave('ws-staging', false);
    try {
      const writeOutcome = await runTool('ws-staging', {
        name: 'write_file',
        args: { path: 'src/newUtil.ts', content: 'export const util = true;\n' }
      });
      assert.equal(writeOutcome.ok, true);
      assert.match(writeOutcome.content, /staged pending review/i);

      const editOutcome = await runTool('ws-staging', {
        name: 'edit_file',
        args: { path: 'src/app.ts', original: 'count = 1', updated: 'count = 2' }
      });
      assert.equal(editOutcome.ok, true);
      assert.match(editOutcome.content, /staged pending review/i);

      // Nothing flushed to disk yet!
      assert.equal(disk.writes.length, 0);
      assert.equal(disk.files.get('src/app.ts')?.content, 'export const count = 1;\n');
      assert.equal(listPendingChanges('ws-staging').length, 2);

      // Subsequent read_file sees the staged virtual content cleanly
      const readStaged = await runTool('ws-staging', { name: 'read_file', args: { path: 'src/app.ts' } });
      assert.equal(readStaged.ok, true);
      assert.match(readStaged.content, /count = 2/);

      // Reject discards staged changes; Accept flushes them to disk
      const rejected = rejectAllPendingChanges('ws-staging');
      assert.equal(rejected.revertedPaths.length, 2);
      assert.equal(disk.writes.length, 0);

      await runTool('ws-staging', {
        name: 'edit_file',
        args: { path: 'src/app.ts', original: 'count = 1', updated: 'count = 3' }
      });
      const accepted = await acceptAllPendingChanges('ws-staging');
      assert.equal(accepted.ok, true);
      assert.equal(disk.files.get('src/app.ts')?.content, 'export const count = 3;\n');
    } finally {
      clearWorkspacePendingChanges('ws-staging');
      setWorkspaceAutoSave('ws-staging', true);
    }
  });
});

test('hasConflictMarkers detects real git markers without false positives', () => {
  assert.equal(hasConflictMarkers('const a = 1;\n'), false);
  assert.equal(hasConflictMarkers('========\n'), false, 'an 8-char rule line is not a conflict separator');
  assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> feature\n'), true);
  assert.equal(hasConflictMarkers('=======\n'), true, 'a bare 7-char separator counts');
});

test('read_file warns up front on a conflicted file so the model resolves it in one write', async () => {
  const conflicted = [
    'const x = 1;',
    '<<<<<<< HEAD',
    'const y = 2;',
    '=======',
    'const y = 3;',
    '>>>>>>> feature',
    ''
  ].join('\n');
  const disk = diskStub({ 'src/conflict.ts': conflicted });
  await withBridge(disk.bridge, async () => {
    const outcome = await runTool('ws', { name: 'read_file', args: { path: 'src/conflict.ts' } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /merge conflict markers/);
    assert.match(outcome.content, /write_file/);
  });
});

test('edit_file on a conflicted file names the markers and the write_file escape', async () => {
  const conflicted = [
    'const x = 1;',
    '<<<<<<< HEAD',
    'const z = 0;',
    'const y = 2;',
    '=======',
    'const z = 0;',
    'const y = 3;',
    '>>>>>>> feature',
    ''
  ].join('\n');
  const disk = diskStub({ 'src/conflict.ts': conflicted });
  await withBridge(disk.bridge, async () => {
    // `const z = 0;` is identical on both sides of the conflict, so it is ambiguous.
    const outcome = await runTool('ws', { name: 'edit_file', args: { path: 'src/conflict.ts', original: 'const z = 0;', updated: 'const z = 9;' } });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /more than once|not found/);
    assert.match(outcome.error ?? '', /merge conflict markers/);
    assert.match(outcome.error ?? '', /write_file/);
    assert.equal(disk.writes.length, 0, 'a refused ambiguous edit writes nothing');
  });
});

test('patch_lines replaces 1-based inclusive spans, preserves CRLF, enforces expected_anchor, and stages when Auto-Save is OFF', async () => {
  const crlf = 'const first = 1;\r\nconst targetA = 10;\r\nconst targetB = 20;\r\nconst last = 99;\r\n';
  const disk = diskStub({ 'src/crlf.ts': crlf });
  await withBridge(disk.bridge, async () => {
    const mismatch = await runTool('ws', {
      name: 'patch_lines',
      args: {
        path: 'src/crlf.ts',
        start_line: 2,
        end_line: 3,
        expected_anchor: 'targetZ',
        replacement: 'const targetA = 11;\nconst targetB = 22;'
      }
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.error ?? '', /anchor mismatch/i);
    assert.equal(disk.writes.length, 0);

    const oob = await runTool('ws', {
      name: 'patch_lines',
      args: { path: 'src/crlf.ts', start_line: 2, end_line: 99, replacement: 'x' }
    });
    assert.equal(oob.ok, false);
    assert.match(oob.error ?? '', /out of range/i);

    const patched = await runTool('ws', {
      name: 'patch_lines',
      args: {
        path: 'src/crlf.ts',
        start_line: 2,
        end_line: 3,
        expected_anchor: 'targetA',
        replacement: 'const targetA = 11;\nconst targetB = 22;'
      }
    });
    assert.equal(patched.ok, true);
    assert.match(patched.content, /Patched src\/crlf\.ts/);
    assert.equal(
      disk.files.get('src/crlf.ts')?.content,
      'const first = 1;\r\nconst targetA = 11;\r\nconst targetB = 22;\r\nconst last = 99;\r\n'
    );

    setWorkspaceAutoSave('ws-patch-stage', false);
    clearWorkspacePendingChanges('ws-patch-stage');
    try {
      const staged = await runTool('ws-patch-stage', {
        name: 'patch_lines',
        args: { path: 'src/crlf.ts', start_line: 1, end_line: 1, replacement: 'const first = 2;' }
      });
      assert.equal(staged.ok, true);
      assert.match(staged.content, /staged pending review/);
      assert.equal(listPendingChanges('ws-patch-stage').length, 1);
    } finally {
      clearWorkspacePendingChanges('ws-patch-stage');
      setWorkspaceAutoSave('ws-patch-stage', true);
    }
  });
});

test('closestRegion finds matches past line 4,000 and read_files unlocks large-file patch_lines gate', async () => {
  const giantLines = Array.from({ length: 4505 }, (_, i) =>
    i === 4320
      ? 'export function calculateReferralBonus(credits: number) { return credits + 50; }'
      : `const fillerLine${i} = ${i};`
  );
  const giant = giantLines.join('\n');
  assert.ok(giant.length > 24_000);
  const disk = diskStub({ 'src/giant.ts': giant });
  resetTurns();
  beginTurn('ws-giant', 'patch giant', { scaffold: false, addPage: false });
  await withBridge(disk.bridge, async () => {
    const blocked = await runTool('ws-giant', {
      name: 'patch_lines',
      args: { path: 'src/giant.ts', start_line: 4321, end_line: 4321, replacement: 'export const x = 1;' }
    });
    assert.equal(blocked.refused, true, 'large unread file blocks blind write');

    const readOk = await runTool('ws-giant', {
      name: 'read_files',
      args: { ranges: [{ path: 'src/giant.ts', start_line: 4318, end_line: 4324 }] }
    });
    assert.equal(readOk.ok, true);

    const missedEdit = await runTool('ws-giant', {
      name: 'edit_file',
      args: {
        path: 'src/giant.ts',
        original: 'export function calculateReferralBonus(credits: number) { return credits + 999; }',
        updated: 'export function calculateReferralBonus(credits: number) { return credits + 75; }'
      }
    });
    assert.equal(missedEdit.ok, false);
    assert.match(missedEdit.error ?? '', /Closest region on disk \(around line 432\d\)/);

    const patchOk = await runTool('ws-giant', {
      name: 'patch_lines',
      args: {
        path: 'src/giant.ts',
        start_line: 4321,
        end_line: 4321,
        expected_anchor: 'calculateReferralBonus',
        replacement: 'export function calculateReferralBonus(credits: number) { return credits + 100; }'
      }
    });
    assert.equal(patchOk.ok, true);
    assert.match(disk.files.get('src/giant.ts')?.content ?? '', /credits \+ 100/);
  });
  resetTurns();
});

test('verify detects monorepo package manifests in modified subdirectories when root has no manifest', async () => {
  const ranCommands: string[] = [];
  const files: Record<string, string> = {
    'frontend/package.json': JSON.stringify({ name: 'frontend', scripts: { typecheck: 'tsc --noEmit' } }),
    'frontend/src/App.tsx': 'export const App = () => null;\n'
  };
  resetTurns();
  const turn = beginTurn('ws-mono', 'verify monorepo', { scaffold: false, addPage: false });
  noteRead(turn, 'frontend/src/App.tsx');
  noteWrite(turn, ['frontend/src/App.tsx']);
  await withBridge({
    readFile: async (_id: string, p: string) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: p, content: files[p], version: 'v1' };
    },
    listDirectory: async (_id: string, dir: string) => {
      if (dir === '') return { entries: [{ path: 'frontend', kind: 'directory' }], nextCursor: null };
      if (dir === 'frontend') return { entries: [{ path: 'frontend/package.json', kind: 'file' }], nextCursor: null };
      return { entries: [], nextCursor: null };
    },
    runCommand: async (_id: string, cmd: string) => {
      ranCommands.push(cmd);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    diagnostics: async () => ({ diagnostics: [], truncated: false })
  }, async () => {
    const res = await runTool('ws-mono', { name: 'verify', args: {} });
    assert.equal(res.ok, true);
    assert.ok(ranCommands.some((cmd) => cmd.includes('frontend') && cmd.includes('typecheck')), `expected subdir verify command, got ${ranCommands.join(', ')}`);
  });
  resetTurns();
});