import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runToolRounds } from './toolLoop';
import { createMcpToolHandle, type McpBridge } from './mcpTools';
import { settleConfirm, subscribeConfirm } from '../confirm';
import type { ChatTurn } from '../ai';

/**
 * End-to-end loop tests: the only scripted part is `stream`, the loop's
 * documented dependency-injection seam. Everything downstream is real —
 * runToolRounds drives the real tools.ts against a real mkdtemp workspace
 * through the same window.shadroxDesktop seam the unit tests use, but here the
 * bridge is backed by the real filesystem and a real shell, deletes go through
 * the real confirm dialog module, and MCP calls go through the real
 * createMcpToolHandle.
 */

const fence = (body: string) => '```shadrox:tools\n' + body + '\n```';
const toolBlock = (calls: unknown) => fence(JSON.stringify(calls));
const readCall = (file: string) => ({ name: 'read_file', args: { path: file } });
const deleteCall = (file: string) => ({ name: 'delete_file', args: { path: file, confirm: true } });

const baseMessages: ChatTurn[] = [{ role: 'user', content: 'work with the files in this folder' }];

function scripted(responses: string[]) {
  const seen: ChatTurn[][] = [];
  let index = 0;
  return {
    seen,
    stream: async (messages: ChatTurn[]) => {
      seen.push(messages.map((message) => ({ ...message })));
      const text = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { text, error: null };
    }
  };
}

/** The real workspace-access seam, backed by real disk instead of a stub. */
function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

/** The real confirm module: a person clicks Delete (or Cancel) on every dialog. */
function withApproval(accepted: boolean, body: () => Promise<void>) {
  const off = subscribeConfirm(() => {
    settleConfirm(accepted);
  });
  return body().finally(off);
}

interface RealWorkspace {
  root: string;
  bridge: Record<string, unknown>;
  reads: string[];
  deletes: string[];
  commands: string[];
  cleanup: () => void;
}

function realWorkspace(): RealWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadrox-loop-'));
  const resolve = (relative: string): string => {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('path escapes the workspace');
    return full;
  };
  const reads: string[] = [];
  const deletes: string[] = [];
  const commands: string[] = [];
  const bridge: Record<string, unknown> = {
    platform: process.platform,
    readFile: async (_id: string, relative: string) => {
      reads.push(relative);
      const full = resolve(relative);
      const content = fs.readFileSync(full, 'utf8'); // a missing file throws a real ENOENT
      return { name: relative, content, version: String(fs.statSync(full).mtimeMs) };
    },
    deletePath: async (_id: string, relative: string) => {
      deletes.push(relative);
      const full = resolve(relative);
      if (fs.lstatSync(full).isDirectory()) {
        fs.rmdirSync(full);
        return { path: relative, kind: 'directory' };
      }
      fs.unlinkSync(full);
      return { path: relative, kind: 'file' };
    },
    runCommand: async (_id: string, command: string) => {
      commands.push(command);
      const ran = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: 30_000 });
      return { stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', exitCode: ran.status ?? 1 };
    },
    listDirectory: async (_id: string, relative = '') => {
      const entries = fs.readdirSync(resolve(relative || '.'), { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        path: relative ? `${relative}/${entry.name}` : entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file'
      }));
      return { entries, nextCursor: null };
    },
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) fs.writeFileSync(resolve(entry.name), entry.content);
      return { errors: [], saved: entries.map((entry) => ({ name: entry.name })) };
    }
  };
  return { root, bridge, reads, deletes, commands, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function withWorkspace(body: (workspace: RealWorkspace) => Promise<void>): Promise<void> {
  const workspace = realWorkspace();
  try {
    await withBridge(workspace.bridge, () => body(workspace));
  } finally {
    workspace.cleanup();
  }
}

test('a read repeated across rounds is served from the cache, never refused', async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'const a = 1;\n');
    const model = scripted([toolBlock([readCall('a.txt')]), toolBlock([readCall('a.txt')]), 'It declares const a.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.deepEqual(workspace.reads, ['a.txt'], 'the second read never touched disk');
    assert.equal(result.activity.length, 1);
    assert.equal(result.activity[0].ok, true);
    assert.equal(result.changedFiles, 0, 'reads are not mutations');
    const observation = model.seen[2].at(-1).content;
    assert.match(observation, /\[unchanged since step 1\]/, 'the cached result is labelled with its step');
    assert.match(observation, /const a = 1;/, 'the earlier result is returned, not a refusal');
    assert.doesNotMatch(observation, /already succeeded|Ask for something different/);
    assert.equal(result.text, 'It declares const a.');
    assert.equal(result.capped, false);
    assert.equal(result.stopReason, 'complete');
  });
});

test('a real delete bumps the epoch so an earlier read runs again', async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'const a = 1;\n');
    fs.writeFileSync(path.join(workspace.root, 'b.txt'), 'delete me\n');
    const model = scripted([
      toolBlock([readCall('a.txt')]),
      toolBlock([deleteCall('b.txt')]),
      toolBlock([readCall('a.txt')]),
      'Deleted b.txt; a.txt still declares const a.'
    ]);
    await withApproval(true, async () => {
      const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
      assert.equal(workspace.reads.filter((file) => file === 'a.txt').length, 2, 'the read re-ran against the changed workspace');
      assert.deepEqual(workspace.deletes, ['b.txt']);
      assert.equal(fs.existsSync(path.join(workspace.root, 'b.txt')), false, 'the file is really gone');
      assert.equal(fs.existsSync(path.join(workspace.root, 'a.txt')), true);
      assert.equal(result.activity.length, 3);
      assert.equal(result.activity[1].name, 'delete_file');
      assert.equal(result.activity[1].ok, true);
      assert.equal(result.activity[1].stage, 'editing', 'a successful write-effect call is editing, not reading');
      assert.equal(result.changedFiles, 1);
      const refused = model.seen.some((turns) => turns.some((turn) => turn.content.includes('already succeeded')));
      assert.equal(refused, false, 'the epoch bump made the earlier read re-runnable');
      assert.equal(result.text, 'Deleted b.txt; a.txt still declares const a.');
    });
  });
});

test('an identical successful delete re-requested next round returns the cached receipt', async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'b.txt'), 'delete me once\n');
    const model = scripted([toolBlock([deleteCall('b.txt')]), toolBlock([deleteCall('b.txt')]), 'It is gone.']);
    await withApproval(true, async () => {
      const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
      assert.deepEqual(workspace.deletes, ['b.txt'], 'the mutation ran exactly once');
      assert.equal(result.activity.length, 1);
      assert.equal(result.changedFiles, 1, 'the cached repeat does not re-count the deletion');
      const observation = model.seen[2].at(-1).content;
      assert.match(observation, /\[unchanged since step 1\]/);
      assert.match(observation, /Deleted .*b\.txt/, 'the verified deletion receipt is returned, not a refusal');
      assert.doesNotMatch(observation, /already succeeded/);
      assert.equal(result.text, 'It is gone.');
    });
  });
});

test('a command that really creates a file is progress, not a stuck loop', async () => {
  await withWorkspace(async (workspace) => {
    const command = `node -e "require('fs').writeFileSync('made.txt','created')"`;
    const asking = toolBlock([{ name: 'run_command', args: { command } }]);
    const model = scripted([asking, asking, asking, asking, asking, 'The command created made.txt.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(fs.existsSync(path.join(workspace.root, 'made.txt')), true, 'the command really ran on disk');
    assert.equal(fs.readFileSync(path.join(workspace.root, 'made.txt'), 'utf8'), 'created');
    assert.equal(workspace.commands.length, 1, 'the identical mutation is refused until something else changes');
    assert.ok(result.changedFiles > 0, 'a successful command is a progress unit');
    assert.equal(result.changedFiles, 1);
    assert.equal(result.capped, false, 'real progress must not be cut off as exhausted');
    assert.equal(result.rounds, 6);
    assert.equal(result.text, 'The command created made.txt.');
    const nudged = model.seen.some((turns) => turns.some((turn) => turn.content.includes('You are looping')));
    assert.equal(nudged, false, 'changedFiles > 0 keeps the stuck detector quiet');
  });
});

test('a failed read of a missing file stays retryable across rounds', async () => {
  await withWorkspace(async (workspace) => {
    const model = scripted([toolBlock([readCall('missing.txt')]), toolBlock([readCall('missing.txt')]), 'The file is not there.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.deepEqual(workspace.reads, ['missing.txt', 'missing.txt'], 'a failure is never recorded as succeeded');
    assert.equal(result.activity.length, 2);
    assert.equal(result.activity[0].ok, false);
    assert.equal(result.activity[1].ok, false);
    assert.notEqual(result.activity[0].refused, true, 'a mid-read failure is not a guard refusal');
    assert.match(result.activity[0].error as string, /ENOENT|no such file/);
    assert.doesNotMatch(model.seen[1].at(-1).content, /already succeeded/);
    assert.equal(result.changedFiles, 0);
    assert.equal(result.text, 'The file is not there.');
  });
});

function mcpFixture(approved: boolean) {
  const calls: string[] = [];
  const bridge: McpBridge = {
    listMcpServers: async () => [{ id: 'db', enabled: true }],
    listMcpTools: async () => [{ serverId: 'db', name: 'query' }],
    callMcpTool: async (serverId, name) => {
      calls.push(`${serverId}:${name}`);
      return { isError: false, text: 'external answer' };
    }
  };
  return { handle: createMcpToolHandle(bridge, { approve: async () => approved }), calls };
}

const mcpCall = { name: 'mcp__db__query', args: { sql: 'SELECT 1' } };

test('an MCP refusal carries refused: true through the real loop', async () => {
  const external = mcpFixture(false);
  const model = scripted([toolBlock([mcpCall]), 'I answered from what I already knew.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.deepEqual(external.calls, [], 'nothing was sent to the server');
  assert.equal(result.activity.length, 1);
  assert.equal(result.activity[0].ok, false);
  assert.equal(result.activity[0].refused, true, 'a user "no" renders as a held refusal');
  assert.match(result.activity[0].error as string, /did not allow/);
  assert.equal(result.changedFiles, 0);
  assert.equal(result.text, 'I answered from what I already knew.');
});

test('a successful MCP call counts as progress and dedupes until the workspace changes', async () => {
  const external = mcpFixture(true);
  const model = scripted([toolBlock([mcpCall]), toolBlock([mcpCall]), 'The query returned one row.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.deepEqual(external.calls, ['db:query'], 'the identical external call ran once');
  assert.equal(result.changedFiles, 1);
  assert.match(model.seen[2].at(-1).content, /\[unchanged since step 1\]/);
  assert.doesNotMatch(model.seen[2].at(-1).content, /already succeeded/);
  assert.equal(result.text, 'The query returned one row.');
});

test('the no-workspace early return still carries changedFiles', async () => {
  const model = scripted([toolBlock([readCall('a.txt')]), 'ignored']);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: null, aborted: () => false, stream: model.stream });
  assert.match(result.error as string, /no folder workspace is open/);
  assert.equal(result.changedFiles, 0);
  assert.equal(result.rounds, 1);
});

test('a native call with truncated arguments gets the honest refusal and stays retryable', async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'const a = 1;\n');
    const truncated = {
      name: 'read_file',
      args: { __nativeArgumentError: 'The tool arguments were incomplete or invalid JSON — likely the reply was cut off by the output limit. Re-issue this call with complete arguments.' }
    };
    const model = scripted([toolBlock([truncated]), toolBlock([readCall('a.txt')]), 'It declares const a.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.deepEqual(workspace.reads, ['a.txt'], 'only the re-issued call touched disk');
    assert.equal(result.activity.length, 2);
    assert.equal(result.activity[0].refused, true, 'a truncated call never executed');
    assert.match(result.activity[0].error as string, /cut off by the output limit/);
    assert.match(model.seen[1].at(-1).content, /cut off by the output limit/, 'the model is told why, not "needs a path"');
    assert.equal(result.activity[1].ok, true, 'the corrected retry ran');
    assert.equal(result.text, 'It declares const a.');
  });
});

test('a real write invalidates the cached read: the re-read sees the new bytes on disk', async () => {
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'const a = 1;\n');
    const write = { name: 'write_file', args: { path: 'a.txt', content: 'const a = 2;\n' } };
    const model = scripted([
      toolBlock([readCall('a.txt')]),
      toolBlock([write]),
      toolBlock([readCall('a.txt')]),
      toolBlock([readCall('a.txt')]),
      'Rewrote a.txt and verified the new content.'
    ]);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    // read + the write's own pre-read + the invalidated re-read; round 4 is cached.
    assert.equal(workspace.reads.filter((file) => file === 'a.txt').length, 3);
    assert.equal(fs.readFileSync(path.join(workspace.root, 'a.txt'), 'utf8'), 'const a = 2;\n', 'the write really hit disk');
    assert.equal(result.activity.length, 3);
    assert.match(result.activity[2].output ?? '', /const a = 2;/, 'the re-read observed the mutation');
    assert.match(model.seen[4].at(-1).content, /\[unchanged since step 3\]/, 'the fresh result is cached at its new step');
    assert.equal(result.changedFiles, 1);
    assert.equal(result.stopReason, 'complete');
  });
});

test('the flight recorder ends a real turn with a stop event and a clean-run summary', async () => {
  const { flightRecorder } = await import('../observability/flightRecorder');
  flightRecorder.reset();
  await withWorkspace(async (workspace) => {
    fs.writeFileSync(path.join(workspace.root, 'a.txt'), 'const a = 1;\n');
    const model = scripted([toolBlock([readCall('a.txt')]), 'It declares const a.']);
    await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  });
  const runs = flightRecorder.listRuns();
  assert.ok(runs.length >= 1);
  const run = runs[0];
  assert.equal(run.kind, 'tool-loop');
  assert.equal(run.stopReason, 'complete');
  assert.equal(run.failure, undefined, 'a clean run carries no failure tag');
  const events = flightRecorder.readEvents(run.runId);
  const types = events.map((event) => event.type);
  assert.equal(types[0], 'turn_started');
  assert.ok(types.includes('tool_call_started'));
  assert.ok(types.includes('tool_result'));
  assert.equal(types.at(-1), 'stop');
  flightRecorder.reset();
});