import assert from 'node:assert/strict';
import test from 'node:test';

import { runToolRounds } from '../agent/toolLoop';
import type { ToolLoopInput } from '../agent/toolLoop';
import type { ApplyPolicyKind } from '../autonomy/types';
import type { AgentTurnPorts, TurnPatch } from './turnRunner';
import { filesReadFromActivity, runAgentTurn, turnReviewLine } from './turnRunner';

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
  signal?: AbortSignal;
  writer?: boolean;
  credits?: number;
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
    workspaceId: 'ws',
    measureCredits: () => options.credits ?? 0.4
  };

  const result = await runAgentTurn({
    instruction: 'TASK t1: change src/a.ts',
    expectedFiles: options.expectedFiles ?? ['src/a.ts'],
    ports,
    applyPolicy: options.applyPolicy,
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

test('a patch outside the declared files is refused and reported, never written', async () => {
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: 'x', version: 'v' }) }, async () => {
    const { result, store, written } = await turn({
      responses: [toolBlock([readCall]), `Touched something else.\n${edits([{ path: 'src/other.ts', kind: 'rewrite', content: 'boom' }])}`],
      files: { 'src/a.ts': 'x' }
    });
    assert.equal(written.length, 0);
    assert.equal(result.patchFailures.length, 1);
    assert.match(result.patchFailures[0], /expectedFiles/);
    assert.equal(store.store.get('src/other.ts'), undefined);
  });
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
  assert.equal(result.creditsSpent, 0.4, 'what the caller already spent is still settled');
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
