import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolRounds } from '../agent/toolLoop';
import type { ToolActivity, ToolLoopInput, ToolLoopResult } from '../agent/toolLoop';
import type { RunPolicy } from '../agent/runPolicy';
import type { ApplyPolicyKind } from '../autonomy/types';
import { createFailureReceipt } from '../repairProof';
import { globalProofLedger } from '../proofLedger';
import { globalRepairSession } from '../repairSession';
import type { AgentTurnPorts, TurnPatch } from './turnRunner';
import { executedToolCallCount, filesReadFromActivity, runAgentTurn, turnReviewLine } from './turnRunner';

/**
 * The real chat tool loop is driven here, not a stand-in: the whole point of this
 * module is that a headless turn now takes exactly the path a chat turn takes, so
 * the test has to exercise that composition instead of a copy of it.
 */
const fence = (body: string) => '```shadrox:tools\n' + body + '\n```';
const toolBlock = (calls: unknown) => fence(JSON.stringify(calls));
const edits = (patches: TurnPatch[]) => '```shadrox:edits\n' + JSON.stringify(patches) + '\n```';
const EDIT_ONE: TurnPatch = { path: 'src/a.ts', kind: 'searchReplace', blocks: [{ original: 'const a = 1;', updated: 'const a = 2;' }] };
const readCall = { name: 'read_file', args: { path: 'src/a.ts' } };

/** The "disk" both the tool bridge and the policy's reader look at. */
interface Disk {
  store: Map<string, string>;
  readFile: (path: string) => Promise<string | null>;
  write: (patches: TurnPatch[]) => Promise<{ applied: string[]; failures: string[] }>;
}

function disk(files: Record<string, string>): Disk {
  const store = new Map(Object.entries(files));
  const key = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '');
  return {
    store,
    readFile: async (path: string) => {
      const name = key(path);
      return store.has(name) ? (store.get(name) as string) : null;
    },
    write: async (patches: TurnPatch[]) => {
      for (const patch of patches) {
        if (patch.kind === 'rewrite') {
          store.set(key(patch.path), patch.content ?? '');
          continue;
        }
        const next = (patch.blocks ?? []).reduce(
          (content, block) => content.replace(block.original, block.updated),
          store.get(key(patch.path)) ?? ''
        );
        store.set(key(patch.path), next);
      }
      return { applied: patches.map((patch) => patch.path), failures: [] as string[] };
    }
  };
}

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

interface TurnOptions {
  responses: string[];
  files?: Record<string, string>;
  expectedFiles?: string[];
  applyPolicy?: ApplyPolicyKind;
  checkpointBacked?: boolean;
  policy?: RunPolicy;
  signal?: AbortSignal;
  writer?: boolean;
  maxToolRounds?: number;
  systemInstruction?: string;
  streamError?: string;
  /** Stands in for the desktop bridge's `read_file`; aborts and failures start here. */
  bridgeRead?: (path: string) => Promise<{ name: string; content: string; version: string }>;
  inspect?: (input: ToolLoopInput) => void;
}

async function turn(options: TurnOptions) {
  const store = disk(options.files ?? {});
  const written: TurnPatch[][] = [];
  const instructions: string[] = [];
  let calls = 0;

  const ports: AgentTurnPorts = {
    stream: async () => {
      calls += 1;
      if (options.streamError) return { text: '', error: options.streamError };
      const text = options.responses[Math.min(calls - 1, options.responses.length - 1)];
      return { text, error: null };
    },
    runToolRounds: (input) => {
      options.inspect?.(input);
      return runToolRounds(input);
    },
    buildMessages: (instruction) => {
      instructions.push(instruction);
      return [{ role: 'user', content: instruction }];
    },
    extractPatches: (text) => {
      const match = /```shadrox:edits\n([\s\S]*?)\n```/.exec(text);
      return match ? (JSON.parse(match[1]) as TurnPatch[]) : [];
    },
    readFile: (path) => store.readFile(path),
    writePatches:
      options.writer === false
        ? undefined
        : async (patches) => {
            written.push(patches);
            return store.write(patches);
          },
    workspaceId: 'ws'
  };

  const result = await runAgentTurn({
    instruction: 'TASK t1: change src/a.ts',
    expectedFiles: options.expectedFiles ?? ['src/a.ts'],
    ports,
    applyPolicy: options.applyPolicy,
    checkpointBacked: options.checkpointBacked,
    policy: options.policy,
    signal: options.signal,
    maxToolRounds: options.maxToolRounds,
    systemInstruction: options.systemInstruction
  });
  return { result, store, written, instructions, calls };
}

test('a turn reads the file with a tool before editing it, then writes the edit', async () => {
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: 'const a = 1;\n', version: 'v1' }) }, async () => {
    const { result, store, written } = await turn({
      responses: [toolBlock([readCall]), `Made the change.\n${edits([EDIT_ONE])}`],
      files: { 'src/a.ts': 'const a = 1;\n' }
    });
    assert.equal(result.toolRounds, 2, 'one tool round plus the answer');
    assert.deepEqual(result.filesRead, ['src/a.ts']);
    assert.deepEqual(result.applied, ['src/a.ts']);
    assert.deepEqual(result.pendingReview, []);
    assert.equal(written.length, 1);
    assert.equal(store.store.get('src/a.ts'), 'const a = 2;\n');
    assert.equal(result.aborted, false);
    assert.equal(result.error, null);
    assert.match(result.reply, /Made the change/);
    assert.doesNotMatch(result.reply, /shadrox:tools/, 'the tool fence is not the reply');
  });
});

test('an edit to a file the turn never read is held for review and left on disk', async () => {
  const { result, store, written } = await turn({
    responses: [`Edited it.\n${edits([EDIT_ONE])}`],
    files: { 'src/a.ts': 'const a = 1;\n' }
  });
  assert.deepEqual(result.pendingReview, ['src/a.ts']);
  assert.deepEqual(result.applied, []);
  assert.equal(written.length, 0, 'the writer was never called');
  assert.equal(store.store.get('src/a.ts'), 'const a = 1;\n', 'the file is untouched');
  assert.match(result.reviewNotes[0], /never read/);
  assert.equal(result.patchFailures.length, 0, 'held back is not the same as refused');
  assert.match(turnReviewLine(result), /1 file awaits your review/);
});

test('a brand-new file is written without needing a read first', async () => {
  const { result, store } = await turn({
    responses: [`Added it.\n${edits([{ path: 'src/new.ts', kind: 'rewrite', content: 'export const x = 1;\n' }])}`],
    files: {},
    expectedFiles: ['src/new.ts']
  });
  assert.deepEqual(result.applied, ['src/new.ts']);
  assert.equal(store.store.get('src/new.ts'), 'export const x = 1;\n');
});

test('a gutting rewrite of a file the turn read is still held for review', async () => {
  const big = Array.from({ length: 30 }, (_, index) => `export const v${index} = ${index};`).join('\n');
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: big, version: 'v1' }) }, async () => {
    const { result, store } = await turn({
      responses: [toolBlock([readCall]), `Rewrote it.\n${edits([{ path: 'src/a.ts', kind: 'rewrite', content: 'export const v0 = 0;' }])}`],
      files: { 'src/a.ts': big }
    });
    assert.deepEqual(result.pendingReview, ['src/a.ts']);
    assert.equal(store.store.get('src/a.ts'), big);
    assert.match(result.reviewNotes[0], /keeps almost none/);
  });
});

test('the review policy holds every change back, new files included', async () => {
  const { result, written } = await turn({
    responses: [`Added it.\n${edits([{ path: 'src/new.ts', kind: 'rewrite', content: 'x' }])}`],
    files: {},
    expectedFiles: ['src/new.ts'],
    applyPolicy: 'review'
  });
  assert.deepEqual(result.pendingReview, ['src/new.ts']);
  assert.equal(written.length, 0);
  assert.equal(result.reviewPatches.length, 1);
});

test('a checkpoint-backed turn writes an edit to a file it never read', async () => {
  const { result, store, written } = await turn({
    responses: [`Edited it.\n${edits([EDIT_ONE])}`],
    files: { 'src/a.ts': 'const a = 1;\n' },
    checkpointBacked: true
  });
  assert.deepEqual(result.applied, ['src/a.ts']);
  assert.deepEqual(result.pendingReview, []);
  assert.equal(written.length, 1);
  assert.equal(store.store.get('src/a.ts'), 'const a = 2;\n', 'the run verifies real bytes, not a review queue');
});

test('a checkpoint-backed turn writes a gutting rewrite the turn read', async () => {
  const big = Array.from({ length: 30 }, (_, index) => `export const v${index} = ${index};`).join('\n');
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: big, version: 'v1' }) }, async () => {
    const { result, store } = await turn({
      responses: [toolBlock([readCall]), `Rewrote it.\n${edits([{ path: 'src/a.ts', kind: 'rewrite', content: 'export const v0 = 0;' }])}`],
      files: { 'src/a.ts': big },
      checkpointBacked: true
    });
    assert.deepEqual(result.applied, ['src/a.ts']);
    assert.deepEqual(result.pendingReview, []);
    assert.equal(store.store.get('src/a.ts'), 'export const v0 = 0;');
  });
});

test('checkpoint backing never overrides an explicit review policy', async () => {
  const { result, written } = await turn({
    responses: [`Edited it.\n${edits([EDIT_ONE])}`],
    files: { 'src/a.ts': 'const a = 1;\n' },
    applyPolicy: 'review',
    checkpointBacked: true
  });
  assert.deepEqual(result.pendingReview, ['src/a.ts']);
  assert.equal(written.length, 0);
});

test('checkpoint backing never lets Ask mode write', async () => {
  const { result, written, store } = await turn({
    responses: [`Edited it.\n${edits([EDIT_ONE])}`],
    files: { 'src/a.ts': 'const a = 1;\n' },
    checkpointBacked: true,
    policy: { mode: 'ask' }
  });
  assert.deepEqual(result.pendingReview, ['src/a.ts']);
  assert.equal(written.length, 0);
  assert.equal(store.store.get('src/a.ts'), 'const a = 1;\n');
});

test('without a writer the cleared patches come back for the caller to route', async () => {
  const { result } = await turn({
    responses: [`Added it.\n${edits([{ path: 'src/new.ts', kind: 'rewrite', content: 'x' }])}`],
    files: {},
    expectedFiles: ['src/new.ts'],
    writer: false
  });
  assert.deepEqual(result.autoApply.map((patch) => patch.path), ['src/new.ts']);
  assert.deepEqual(result.applied, []);
});

test('a patch modifying an existing file outside the declared set is refused and reported, never written', async () => {
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: 'x', version: 'v' }) }, async () => {
    const { result, store, written } = await turn({
      responses: [toolBlock([readCall]), `Touched something else.\n${edits([{ path: 'src/other.ts', kind: 'rewrite', content: 'boom' }])}`],
      // The unlisted file pre-exists on disk: modifying it stays refused even
      // though confinement now lets brand-new in-workspace files through.
      files: { 'src/a.ts': 'x', 'src/other.ts': 'original' }
    });
    assert.equal(written.length, 0);
    assert.equal(result.patchFailures.length, 1);
    assert.match(result.patchFailures[0], /outside the files this turn may write/);
    assert.equal(store.store.get('src/other.ts'), 'original');
  });
});

test('a brand-new unlisted file inside the workspace is allowed and written', async () => {
  const { result, store, written } = await turn({
    responses: [`Added the types too.\n${edits([{ path: 'src/types.ts', kind: 'rewrite', content: 'export type User = { id: string };\n' }])}`],
    files: { 'src/a.ts': 'x' },
    expectedFiles: ['src/a.ts']
  });
  assert.deepEqual(result.applied, ['src/types.ts']);
  assert.deepEqual(result.patchFailures, []);
  assert.equal(written.length, 1);
  assert.equal(store.store.get('src/types.ts'), 'export type User = { id: string };\n');
});

test('new files outside the workspace root are refused, whatever the disk says', async () => {
  const { result, written } = await turn({
    responses: [
      `Escaped.\n${edits([
        { path: '../outside.ts', kind: 'rewrite', content: 'boom' },
        { path: 'C:/temp/evil.ts', kind: 'rewrite', content: 'boom' },
        { path: 'src/../../etc/passwd', kind: 'rewrite', content: 'boom' }
      ])}`
    ],
    files: { 'src/a.ts': 'x' },
    expectedFiles: ['src/a.ts']
  });
  assert.equal(written.length, 0);
  assert.deepEqual(result.applied, []);
  assert.equal(result.patchFailures.length, 3);
  for (const failure of result.patchFailures) assert.match(failure, /outside the workspace root/);
});

test('a narrowed request scope still refuses new files it did not target', async () => {
  const { result, written } = await turn({
    responses: [`Done.\n${edits([{ path: 'src/new.ts', kind: 'rewrite', content: 'x' }])}`],
    files: {},
    expectedFiles: ['src/a.ts', 'src/new.ts'],
    policy: { mode: 'agent', scope: { workspaceId: 'ws', allowedPaths: ['src/a.ts'] } }
  });
  assert.equal(written.length, 0);
  assert.deepEqual(result.applied, []);
  assert.equal(result.patchFailures.length, 1);
  assert.match(result.patchFailures[0], /^src\/new\.ts/);
});

/**
 * The request scope is the user's narrowing of a milestone's contract, so it
 * only ever subtracts: a file the milestone declared but the scope cut cannot
 * be written, and a file the scope names the milestone never declared cannot
 * be added to the writable set.
 */
test('a request scope narrower than the milestone refuses the file it cut', async () => {
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: 'const a = 1;\n', version: 'v1' }) }, async () => {
    const { result, store } = await turn({
      responses: [
        toolBlock([readCall]),
        `Done.\n${edits([EDIT_ONE, { path: 'src/b.ts', kind: 'rewrite', content: 'boom' }])}`
      ],
      files: { 'src/a.ts': 'const a = 1;\n', 'src/b.ts': 'const b = 1;\n' },
      expectedFiles: ['src/a.ts', 'src/b.ts'],
      policy: { mode: 'agent', scope: { workspaceId: 'ws', allowedPaths: ['src/a.ts'] } }
    });
    assert.deepEqual(result.applied, ['src/a.ts']);
    assert.equal(store.store.get('src/a.ts'), 'const a = 2;\n');
    assert.equal(store.store.get('src/b.ts'), 'const b = 1;\n', 'the cut file keeps its bytes');
    assert.equal(result.patchFailures.length, 1);
    assert.match(result.patchFailures[0], /^src\/b\.ts/);
  });
});

test('a request scope never widens what the milestone declared', async () => {
  const { result, store } = await turn({
    responses: [`Done.\n${edits([EDIT_ONE])}`],
    files: { 'src/a.ts': 'const a = 1;\n' },
    expectedFiles: ['src/a.ts'],
    policy: { mode: 'agent', scope: { workspaceId: 'ws', allowedPaths: ['src/elsewhere.ts'] } }
  });
  assert.deepEqual(result.applied, []);
  assert.equal(result.patchFailures.length, 1);
  assert.match(result.patchFailures[0], /^src\/a\.ts/);
  assert.equal(store.store.get('src/a.ts'), 'const a = 1;\n');
});

test('an empty or absent scope leaves the milestone contract unchanged', async () => {
  for (const scope of [undefined, { workspaceId: 'ws' }, { workspaceId: 'ws', allowedPaths: [] }]) {
    const { result } = await turn({
      responses: [`Done.\n${edits([{ path: 'src/new.ts', kind: 'rewrite', content: 'x' }])}`],
      files: {},
      expectedFiles: ['src/new.ts'],
      writer: false,
      policy: { mode: 'agent', scope }
    });
    assert.equal(result.patchFailures.length, 0, JSON.stringify(scope));
    assert.deepEqual(result.autoApply.map((patch) => patch.path), ['src/new.ts'], JSON.stringify(scope));
  }
});

test('an investigation task that emits edits has every patch refused', async () => {
  const { result, written } = await turn({
    responses: [`Found it.\n${edits([{ path: 'src/a.ts', kind: 'rewrite', content: 'x' }, { path: 'src/b.ts', kind: 'rewrite', content: 'y' }])}`],
    files: { 'src/a.ts': 'a' },
    expectedFiles: []
  });
  assert.equal(written.length, 0);
  assert.equal(result.patchFailures.length, 2);
  assert.match(result.patchFailures[0], /declared no files/);
  assert.equal(result.wroteNothing, true);
});

test('a stop before the turn starts costs no model call', async () => {
  const controller = new AbortController();
  controller.abort();
  const { result, calls } = await turn({ responses: ['never used'], signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.stopped, true);
  assert.equal(result.wroteNothing, true);
});

test('a stop during a tool round ends the turn and writes nothing', async () => {
  const controller = new AbortController();
  await withBridge(
    {
      readFile: async (_id: string, path: string) => {
        controller.abort();
        return { name: path, content: 'const a = 1;', version: 'v' };
      }
    },
    async () => {
      const { result, store, written, calls } = await turn({
        responses: [toolBlock([readCall]), `Edited.\n${edits([EDIT_ONE])}`],
        files: { 'src/a.ts': 'const a = 1;' },
        signal: controller.signal
      });
      assert.equal(calls, 1, 'the round after the stop never streamed');
      assert.equal(result.aborted, true);
      assert.equal(result.stopped, true);
      assert.equal(written.length, 0);
      assert.equal(store.store.get('src/a.ts'), 'const a = 1;');
    }
  );
});

test('a dead model call is reported as an error and attempts no change', async () => {
  const { result, written } = await turn({ responses: ['ignored'], streamError: 'Key rejected', files: { 'src/a.ts': 'x' } });
  assert.equal(result.error, 'Key rejected');
  assert.equal(result.aborted, false);
  assert.equal(result.wroteNothing, true);
  assert.equal(written.length, 0);
});

test('a refused tool is an outcome, not a dead turn', async () => {
  await withBridge(
    {
      readFile: async () => {
        throw new Error('disk offline');
      }
    },
    async () => {
      const { result } = await turn({
        responses: [toolBlock([readCall]), `Answered anyway.\n${edits([EDIT_ONE])}`],
        files: { 'src/a.ts': 'const a = 1;' }
      });
      assert.equal(result.error, null);
      assert.equal(result.applied.length, 0);
      assert.equal(result.toolActivity.length, 1);
      assert.equal(result.toolActivity[0].ok, false);
    }
  );
});

test('the finish tool summary becomes the turn summary', async () => {
  const { result } = await turn({
    responses: [fence(JSON.stringify([{ name: 'finish', args: { summary: 'Read a.ts; it exports one function.' } }]))],
    expectedFiles: []
  });
  assert.equal(result.summary, 'Read a.ts; it exports one function.');
  assert.equal(result.finish?.summary, 'Read a.ts; it exports one function.');
});

test('the system instruction, workspace and round cap reach the tool loop', async () => {
  const asking = Array.from({ length: 4 }, (_, index) => toolBlock([{ name: 'list_directory', args: { path: `d${index}` } }]));
  let seen: ToolLoopInput | null = null;
  const { result } = await turn({
    responses: [...asking, 'final answer'],
    expectedFiles: [],
    maxToolRounds: 3,
    systemInstruction: 'SYSTEM CONTEXT',
    inspect: (input) => {
      seen = input;
    }
  });
  assert.equal(result.capped, true, 'the cap reached the tool loop');
  assert.equal((seen as ToolLoopInput | null)?.systemInstruction, 'SYSTEM CONTEXT');
  assert.equal((seen as ToolLoopInput | null)?.workspaceId, 'ws');
  assert.equal((seen as ToolLoopInput | null)?.maxRounds, 3);
});

test('the instruction is handed to the message builder, not to the port config', async () => {
  const { instructions } = await turn({ responses: ['answer'], expectedFiles: [] });
  assert.deepEqual(instructions, ['TASK t1: change src/a.ts']);
});

test('read files come from successful read tool activity only', () => {
  const paths = filesReadFromActivity([
    { name: 'read_file', label: 'read_file · src/a.ts', ok: true },
    { name: 'read_file', label: 'read_file · src/b.ts', ok: false, error: 'no such file' },
    { name: 'search_text', label: 'search_text · todo', ok: true },
    { name: 'outline', label: 'outline · ./src\\C.ts', ok: true }
  ]);
  assert.deepEqual(paths, ['src/a.ts', 'src/c.ts']);
});

/**
 * The receipt a failing command captures is the chat card's evidence and the
 * run attempt's evidence alike: the headless turn must not drop it on the way
 * out. Everything between the shell stub and the outcome is production code —
 * the real tool loop, the real run_command tool, the real proof capture.
 */
test('a failing run_command receipt flows through the real tool loop into the turn outcome', async (t) => {
  const reset = () => {
    globalRepairSession.reset();
    globalProofLedger.clear();
  };
  t.after(reset);
  reset();
  await withBridge(
    {
      platform: 'win32',
      runCommand: async () => ({ stdout: '', stderr: '2 tests failed', exitCode: 1 })
    },
    async () => {
      const { result } = await turn({
        responses: [
          toolBlock([{ name: 'run_command', args: { command: 'npm test' } }]),
          'The tests failed; here is what the output says.'
        ],
        expectedFiles: []
      });
      assert.equal(result.error, null, 'a failed command is an outcome, not a dead turn');
      assert.ok(result.failureProof, 'the receipt is not dropped on the autonomy path');
      assert.equal(result.failureProof?.source, 'test');
      assert.equal(result.failureProof?.exitCode, 1);
      assert.equal(result.failureProof?.status, 'captured');
      assert.match(result.failureProof?.errorMessage ?? '', /2 tests failed/);
      assert.equal(result.toolActivity[0]?.ok, false);
      assert.equal(
        globalProofLedger.getFailureReceipt(result.failureProof!.id)?.id,
        result.failureProof?.id,
        'the receipt on the outcome is the one on the ledger'
      );
    }
  );
});

test('a successful mutating command is counted as a workspace write by the real loop', async (t) => {
  const reset = () => {
    globalRepairSession.reset();
    globalProofLedger.clear();
  };
  t.after(reset);
  reset();
  await withBridge(
    {
      platform: 'win32',
      runCommand: async () => ({ stdout: '10 tests passed', stderr: '', exitCode: 0 })
    },
    async () => {
      const { result } = await turn({
        responses: [
          toolBlock([{ name: 'run_command', args: { command: 'npm test' } }]),
          'The tests pass.'
        ],
        expectedFiles: []
      });
      assert.equal(result.error, null);
      assert.equal(result.applied.length, 0, 'no patch was applied');
      assert.equal(result.changedFiles, 1, 'the command mutated the workspace without a patch');
      assert.equal(result.failureProof ?? null, null, 'a passing command captures no failure receipt');
    }
  );
});

test('the loop\'s changedFiles count and failure receipt pass through untouched', async () => {
  const receipt = createFailureReceipt({ source: 'terminal', target: 'node build.mjs', errorMessage: 'boom', exitCode: 2 });
  // The documented DI seam: a scripted loop result carrying the cross-module
  // contract fields, so the passthrough is pinned regardless of how the real
  // loop counts writes internally.
  const scripted: ToolLoopResult & { changedFiles?: number } = {
    text: 'Done.',
    rounds: 1,
    activity: [],
    capped: false,
    error: null,
    plan: [],
    changedFiles: 2,
    failureProof: receipt
  };
  const result = await runAgentTurn({
    instruction: 'do it',
    expectedFiles: [],
    ports: {
      stream: async () => ({ text: 'Done.', error: null }),
      runToolRounds: async () => scripted,
      buildMessages: (instruction) => [{ role: 'user', content: instruction }],
      extractPatches: () => [],
      readFile: async () => null,
      workspaceId: null
    }
  });
  assert.equal(result.changedFiles, 2);
  assert.equal(result.failureProof, receipt);
});

test('a turn stopped before it starts reports zero changed files', async () => {
  const controller = new AbortController();
  controller.abort();
  const { result } = await turn({ responses: ['never used'], signal: controller.signal });
  assert.equal(result.changedFiles, 0);
});

test('executedToolCallCount charges only calls that ran, never control tools', () => {
  const activity: ToolActivity[] = [
    { name: 'read_file', label: 'read_file · src/a.ts', ok: true },
    // Ran and failed on the way to disk: real work, still charged.
    { name: 'run_command', label: 'run_command · npm test', ok: false, error: 'exit 1' },
    // The guard stopped it before it ran: never charged.
    { name: 'delete_file', label: 'delete_file · src/old.ts', ok: false, refused: true },
    // Control tools steer the loop; they are not workspace work.
    { name: 'update_tasks', label: 'update_tasks', ok: true },
    { name: 'finish', label: 'finish', ok: true },
    { name: 'search_text', label: 'search_text · todo', ok: false, refused: false }
  ];
  assert.equal(executedToolCallCount(activity), 3);
  assert.equal(executedToolCallCount([]), 0);
  assert.equal(
    executedToolCallCount([{ name: 'finish', label: 'finish', ok: true }]),
    0,
    'a turn that only planned and finished charges nothing'
  );
});
