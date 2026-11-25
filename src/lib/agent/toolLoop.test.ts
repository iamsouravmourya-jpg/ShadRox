import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  MAX_CALLS_PER_ROUND,
  MUTATION_REQUIRED_NUDGE,
  runToolRounds,
  ZERO_PROGRESS_LIMIT
} from './toolLoop';
import { createMcpToolHandle } from './mcpTools';
import type { McpBridge } from './mcpTools';
import type { ChatTurn } from '../ai';
import { flightRecorder } from '../observability/flightRecorder';

const fence = (body: string) => '```shadrox:tools\n' + body + '\n```';
const toolBlock = (calls: unknown) => fence(JSON.stringify(calls));
const readCall = { name: 'read_file', args: { path: 'src/a.ts' } };

const baseMessages: ChatTurn[] = [{ role: 'user', content: 'what is in a.ts?' }];

/**
 * The bridge is what these tests substitute: the loop itself must not know
 * whether a tool hit a real folder or a stub.
 */
function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

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

test('an answer with no tool block streams once', async () => {
  const model = scripted(['The file exports a function.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.text, 'The file exports a function.');
  assert.deepEqual(result.activity, []);
  assert.equal(model.seen.length, 1);
});

test('a tool call runs and its result is handed back on the next round', async () => {
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: 'const a = 1;', version: 'v1' })
  }, async () => {
    const model = scripted([toolBlock([readCall]), 'It declares const a.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream
    });
    assert.equal(result.rounds, 2);
    assert.equal(result.text, 'It declares const a.');
    assert.equal(result.activity.length, 1);
    assert.equal(result.activity[0].ok, true);
    assert.equal(result.activity[0].label, 'read_file · src/a.ts');
    const followUp = model.seen[1].slice(-2);
    assert.equal(followUp[0].role, 'assistant');
    assert.equal(followUp[0].content, toolBlock([readCall]));
    assert.match(followUp[1].content, /shadrox:results/);
    assert.match(followUp[1].content, /const a = 1;/);
    assert.equal(model.seen[1].length, baseMessages.length + 2);
  });
});

test('several calls in one round run together', async () => {
  let reads = 0;
  await withBridge({
    readFile: async (_id: string, path: string) => { reads += 1; return { name: path, content: path, version: 'v' }; }
  }, async () => {
    const model = scripted([
      toolBlock([readCall, { name: 'read_file', args: { path: 'src/b.ts' } }]),
      'Both read.'
    ]);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(reads, 2);
    assert.equal(result.activity.length, 2);
    assert.equal(result.rounds, 2);
  });
});

test('the same call twice is refused without re-running it', async () => {
  let reads = 0;
  await withBridge({
    readFile: async (_id: string, path: string) => { reads += 1; return { name: path, content: 'x', version: 'v' }; }
  }, async () => {
    const model = scripted([
      toolBlock([readCall, readCall]),
      'Understood.'
    ]);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(reads, 1);
    assert.equal(result.activity.length, 1);
    assert.equal(result.rounds, 2);
  });
});

test('a call dropped by the per-round cap is not recorded as already run', async () => {
  const read: string[] = [];
  await withBridge({
    readFile: async (_id: string, path: string) => { read.push(path); return { name: path, content: path, version: 'v' }; }
  }, async () => {
    const full = Array.from({ length: MAX_CALLS_PER_ROUND }, (_, index) => ({ name: 'read_file', args: { path: `a${index}.ts` } }));
    const extra = { name: 'read_file', args: { path: 'dropped.ts' } };
    const model = scripted([`${toolBlock(full)}\n${toolBlock([extra])}`, toolBlock([extra]), 'Answer.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    const observation = model.seen[1].at(-1).content;
    assert.equal((observation.match(/"tool":/g) ?? []).length, MAX_CALLS_PER_ROUND, 'one round runs the imported cap');
    assert.match(observation, /dropped\.ts did not run this round/, 'the model is told the call was cut');
    assert.match(observation, new RegExp(`at most ${MAX_CALLS_PER_ROUND} calls`), 'the cut message reflects the imported cap');
    assert.equal(read.length, MAX_CALLS_PER_ROUND + 1, 'the cut call is still runnable in the next round');
    assert.equal(read.at(-1), 'dropped.ts');
    assert.equal(result.text, 'Answer.');
  });
});

test('an unknown tool is answered with the available list, not executed', async () => {
  const model = scripted([toolBlock([{ name: 'create_file', args: { path: 'a' } }]), 'Noted.']);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.activity, []);
  assert.match(model.seen[1].at(-1).content, /is not a tool/);
  assert.match(model.seen[1].at(-1).content, /read_file/);
});

test('round patches are applied before the round\'s tool calls run', async () => {
  const order: string[] = [];
  await withBridge({
    readFile: async (_id: string, path: string) => {
      order.push(`read:${path}`);
      return { name: path, content: 'fresh bytes', version: 'v2' };
    }
  }, async () => {
    const model = scripted([
      '```path=src/a.ts\nconst a = 2;\n```\n\n' + toolBlock([readCall]),
      'It declares const a = 2.'
    ]);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      applyRoundPatches: async (text, round) => {
        order.push(`apply:${round}`);
        assert.match(text, /path=src\/a\.ts/, 'the hook receives the raw round text');
      }
    });
    assert.deepEqual(order, ['apply:0', 'read:src/a.ts'], 'the edit lands before the read observes it');
    assert.equal(result.rounds, 2);
    assert.equal(result.activity.length, 1);
    assert.equal(result.activity[0].ok, true);
  });
});

test('the apply hook runs once per tool round and never for a prose answer', async () => {
  const applied: number[] = [];
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: 'x', version: 'v' })
  }, async () => {
    const model = scripted([toolBlock([readCall]), toolBlock([{ name: 'read_file', args: { path: 'src/b.ts' } }]), 'Done.']);
    await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      applyRoundPatches: async (_text, round) => { applied.push(round); }
    });
    assert.deepEqual(applied, [0, 1]);
  });
});

test('an abort during the round apply stops the loop before any tool runs', async () => {
  let stopped = false;
  let reads = 0;
  await withBridge({
    readFile: async () => { reads += 1; return { name: 'a', content: 'x', version: 'v' }; }
  }, async () => {
    const model = scripted([toolBlock([readCall]), 'ignored']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => stopped,
      stream: model.stream,
      applyRoundPatches: async () => { stopped = true; }
    });
    assert.equal(reads, 0, 'no tool runs after the stop');
    assert.equal(result.activity.length, 0);
    assert.equal(result.text, '', 'the tool fence is stripped from the stopped reply');
  });
});

test('the apply hook still runs when every call in the round was a duplicate', async () => {
  let applies = 0;
  let reads = 0;
  await withBridge({
    readFile: async (_id: string, path: string) => { reads += 1; return { name: path, content: 'x', version: 'v' }; }
  }, async () => {
    const model = scripted([toolBlock([readCall]), toolBlock([readCall]), 'Answer.']);
    await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      applyRoundPatches: async () => { applies += 1; }
    });
    assert.equal(reads, 1);
    assert.equal(applies, 2, 'a round whose calls were all deduped still lands its edits');
  });
});

test('a malformed block is fed back so the model can retry', async () => {
  const model = scripted(['```shadrox:tools\n[{"name": "read_file"\n```', 'Answer.']);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  assert.equal(result.rounds, 2);
  assert.match(model.seen[1].at(-1).content, /not valid JSON/);
  assert.equal(result.text, 'Answer.');
});

test('a tool request with no folder open explains itself instead of looping', async () => {
  const model = scripted([toolBlock([readCall]), 'ignored']);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: null, aborted: () => false, stream: model.stream });
  assert.match(result.error as string, /no folder workspace is open/);
  assert.equal(result.rounds, 1);
});

test('the default budget is 60 rounds with one soft wrap-up note at 80%', async () => {
  assert.equal(DEFAULT_MAX_TOOL_ROUNDS, 60);
  const asking = Array.from({ length: DEFAULT_MAX_TOOL_ROUNDS },
    (_, index) => toolBlock([{ name: 'list_directory', args: { path: `dir${index}` } }]));
  const model = scripted([...asking, 'Final answer.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.capped, true);
  assert.equal(result.stopReason, 'step_cap');
  assert.equal(result.text, 'Final answer.');
  assert.match(model.seen.at(-1)!.at(-1).content, /Tool budget for this answer is finished/);
  const notes = model.seen.at(-1)!.filter((turn) => turn.role === 'system' && /Step budget nearly spent/.test(turn.content));
  assert.equal(notes.length, 1, 'exactly one soft note');
  assert.match(notes[0].content, /48\/60/);
  assert.match(notes[0].content, /wrap up/);
  // The soft note lands before round 49's stream, not earlier.
  const firstNote = model.seen.findIndex((turns) => turns.some((turn) => turn.role === 'system' && /Step budget nearly spent/.test(turn.content)));
  assert.equal(firstNote, 48, 'the note appears once 48 rounds are spent');
});

test('a hard stop carries a resumable state summary for a Continue button', async () => {
  const asking = Array.from({ length: DEFAULT_MAX_TOOL_ROUNDS },
    (_, index) => toolBlock([{ name: 'list_directory', args: { path: `dir${index}` } }]));
  const model = scripted([...asking, 'Final answer.']);
  const result = await runToolRounds({
    messages: [{ role: 'user', content: 'refactor the parser' }],
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream,
    initialPlan: [{ id: 't1', subject: 'read the parser', status: 'doing' }]
  });
  assert.equal(result.stopReason, 'step_cap');
  const resume = result.resume;
  assert.ok(resume, 'a capped stop exposes resume data');
  assert.equal(resume.stopReason, 'step_cap');
  assert.equal(resume.maxRounds, 60);
  assert.equal(resume.pendingIntent, 'read the parser', 'the first open task is the pending intent');
  assert.equal(resume.plan[0].id, 't1');
  assert.ok(resume.messages.length > 0);
  assert.equal(resume.messages[0].content, 'refactor the parser');
  assert.ok(resume.round >= 60);
  // The transcript is complete: the forced-final ask is the last turn, so a
  // Continue button can re-stream from exactly where the stop landed.
  assert.match(resume.messages.at(-1)!.content, /Tool budget for this answer is finished/);
});

test('a clean prose answer carries no resume payload', async () => {
  const model = scripted(['The file exports a function.']);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  assert.equal(result.stopReason, 'complete');
  assert.equal(result.resume, undefined);
});

test('repeating one call until the cap still yields an answer, not an empty reply', async () => {
  const asking = toolBlock([readCall]);
  const model = scripted([asking, asking, asking, asking, asking, 'Final answer.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    maxRounds: 5,
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.capped, true);
  assert.equal(result.text, 'Final answer.');
});

test('a provider error stops the loop and reports it', async () => {
  let calls = 0;
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: async () => { calls += 1; return { text: '', error: 'Key rejected' }; }
  });
  assert.equal(calls, 1);
  assert.equal(result.error, 'Key rejected');
});

test('an abort mid-round ends the loop without further streams', async () => {
  let calls = 0;
  let aborted = false;
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => aborted,
    stream: async () => {
      calls += 1;
      aborted = true;
      return { text: 'partial', error: null };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.text, 'partial');
  assert.equal(result.error, null);
});

const updateTasks = (tasks: unknown) => toolBlock([{ name: 'update_tasks', args: { tasks } }]);
const finishWith = (summary: string) => toolBlock([{ name: 'finish', args: { summary } }]);

test('update_tasks builds a plan the caller can render', async () => {
  const model = scripted([updateTasks([{ subject: 'read a.ts', status: 'doing' }]), 'Done reading.']);
  const plans: number[] = [];
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream,
    onPlan: (plan) => plans.push(plan.length)
  });
  assert.equal(result.plan.length, 1);
  assert.equal(result.plan[0].subject, 'read a.ts');
  assert.equal(result.plan[0].status, 'doing');
  assert.deepEqual(plans, [1]);
  assert.equal(result.text, 'Done reading.');
});

test('a plan update does not need a workspace and costs no disk read', async () => {
  const model = scripted([updateTasks([{ id: 'x', subject: 'answer', status: 'done' }]), 'The answer.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.error, null);
  assert.equal(result.plan[0].status, 'done');
  assert.equal(result.activity.length, 1);
  assert.equal(result.activity[0].name, 'update_tasks');
  assert.equal(result.activity[0].ok, true);
});

test('finish ends the turn and its summary becomes the answer', async () => {
  const model = scripted([finishWith('I read a.ts; it exports one function.')]);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.text, 'I read a.ts; it exports one function.');
  assert.equal(result.finish?.summary, 'I read a.ts; it exports one function.');
  assert.equal(model.seen.length, 1, 'no further stream after finish');
});

test('finish is refused once while the plan still has an open task', async () => {
  const model = scripted([
    updateTasks([{ id: 'a', subject: 'read b.ts', status: 'doing' }]),
    finishWith('all done'),
    toolBlock([{ name: 'read_file', args: { path: 'src/b.ts' } }]),
    finishWith('all done now')
  ]);
  await withBridge({ readFile: async (_id: string, path: string) => ({ name: path, content: 'x', version: 'v' }) }, async () => {
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream
    });
    assert.equal(result.finish?.summary, 'all done now');
    assert.equal(result.plan[0].status, 'doing');
    const refused = JSON.stringify(model.seen[2]);
    assert.ok(refused.includes('Your task list is not finished'), refused);
  });
});

test('8 zero-progress steps earn one stuck nudge summarizing what was tried', async () => {
  // A known tool the guard refuses (no path): refused calls are never cached,
  // so each round really attempts it and returns the identical error — no new
  // information, no progress signals. Repetition alone is not the trigger;
  // ZERO_PROGRESS_LIMIT consecutive dead steps are.
  assert.equal(ZERO_PROGRESS_LIMIT, 8);
  const repeated = toolBlock([{ name: 'read_file', args: {} }]);
  // Round 1 is new information (first attempt); rounds 2-9 are the 8 dead steps.
  const model = scripted(Array.from({ length: ZERO_PROGRESS_LIMIT + 2 }, () => repeated).concat('Answering with what I have.'));
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.text, 'Answering with what I have.');
  const nudges = model.seen.at(-1)!.filter((turn) => turn.role === 'user' && turn.content.includes('You are looping'));
  // One nudge mid-loop; forceFinal then re-issues the same order as its ask.
  assert.equal(nudges.length, 2, 'the nudge plus the forced-final order');
  assert.match(nudges[0].content, /last 8 steps made no progress/);
  assert.match(nudges[0].content, /read_file/, 'the nudge summarizes what was tried');
  // The nudge lands once 8 consecutive dead steps have accumulated.
  const firstNudge = model.seen.findIndex((turns) => turns.some((turn) => turn.content.includes('You are looping')));
  assert.equal(firstNudge, ZERO_PROGRESS_LIMIT + 1, 'the nudge waits for 8 dead steps');
  assert.ok(!model.seen[ZERO_PROGRESS_LIMIT].some((turn) => turn.content.includes('You are looping')), 'no early nudge');
});

test('a model that stays stuck past the nudge is forced to answer with stop reason stuck', async () => {
  const repeated = toolBlock([{ name: 'read_file', args: {} }]);
  const model = scripted(Array.from({ length: ZERO_PROGRESS_LIMIT + 2 }, () => repeated).concat('Forced answer.'));
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.capped, true);
  assert.equal(result.stopReason, 'stuck');
  assert.equal(result.text, 'Forced answer.');
  assert.ok(result.resume, 'a stuck stop is resumable');
  assert.equal(result.resume!.stopReason, 'stuck');
});

test('real progress between dead steps keeps the stuck detector quiet', async () => {
  // Alternate a dead refused call with a genuinely new file read: each new
  // read is a progress signal AND new information, so the zero-progress
  // counter never reaches 8 even across 16 rounds.
  const dead = toolBlock([{ name: 'read_file', args: {} }]);
  const responses: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    responses.push(dead, toolBlock([{ name: 'read_file', args: { path: `src/f${index}.ts` } }]));
  }
  responses.push('All files read.');
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: `content of ${path}`, version: 'v' })
  }, async () => {
    const model = scripted(responses);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(result.text, 'All files read.');
    assert.equal(result.stopReason, 'complete');
    const nudged = model.seen.some((turns) => turns.some((turn) => turn.content.includes('You are looping')));
    assert.equal(nudged, false, 'progress resets the dead-step counter');
  });
});

test('marking todo items done is progress even without disk reads', async () => {
  const responses: string[] = [];
  for (let index = 0; index < ZERO_PROGRESS_LIMIT + 1; index += 1) {
    responses.push(updateTasks([{ id: `t${index}`, subject: `step ${index}`, status: 'done' }]));
  }
  responses.push('Plan complete.');
  const model = scripted(responses);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: null, aborted: () => false, stream: model.stream });
  assert.equal(result.text, 'Plan complete.');
  assert.equal(result.stopReason, 'complete');
  assert.equal(result.plan.length, ZERO_PROGRESS_LIMIT + 1);
});

const externalRead = { name: 'mcp__search__web', args: { q: 'aider' } };

const exploreMessages: ChatTurn[] = [{ role: 'user', content: 'scan the project and explain what it is' }];
const NUDGE = 'You have not inspected the workspace yet';

test('an exploration answered with zero tool calls earns one nudge and one more round', async () => {
  const model = scripted(['This looks like a React app, probably.', 'Having read the files: it is a Vite + React app with an Electron shell.']);
  const result = await runToolRounds({
    messages: exploreMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(model.seen.length, 2, 'the lazy answer did not end the turn');
  assert.match(model.seen[1].at(-1).content, new RegExp(NUDGE));
  assert.equal(model.seen[1].at(-1).role, 'user');
  assert.equal(model.seen[1].at(-2).role, 'assistant');
  assert.equal(result.rounds, 2);
  assert.equal(result.text, 'Having read the files: it is a Vite + React app with an Electron shell.');
});

test('the nudge is spent once: a second zero-tool ending completes the turn anyway', async () => {
  const model = scripted(['Lazy first answer.', 'Still no tools, but this is final.']);
  const result = await runToolRounds({
    messages: exploreMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(model.seen.length, 2, 'no third stream — one nudge per turn');
  assert.equal(result.rounds, 2);
  assert.equal(result.text, 'Still no tools, but this is final.');
  assert.equal(result.error, null);
  assert.equal(result.capped, false);
});

test('a finish tool with zero workspace reads earns the nudge; the next finish ends the turn', async () => {
  const model = scripted([finishWith('It is a React app, I think.'), finishWith('After reading package.json: a Vite + React app.')]);
  const result = await runToolRounds({
    messages: exploreMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(model.seen.length, 2);
  assert.match(model.seen[1].at(-1).content, new RegExp(NUDGE));
  assert.equal(result.rounds, 2);
  assert.equal(result.finish?.summary, 'After reading package.json: a Vite + React app.');
});

test('a non-exploration request with zero tool calls keeps its single-round path', async () => {
  const model = scripted(['Use ?? instead of || here.']);
  const result = await runToolRounds({
    messages: [{ role: 'user', content: 'why does this line throw?' }],
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(model.seen.length, 1, 'no nudge, no extra round');
  assert.equal(result.rounds, 1);
  assert.equal(result.text, 'Use ?? instead of || here.');
});

function mcpFixture(options: {
  servers?: Array<{ id: string; enabled: boolean }>;
  tools?: Record<string, unknown[]>;
  replies?: Record<string, { isError?: boolean; text?: string }>;
  unreachable?: string[];
  /**
   * These tests are about the loop, so the user's answer to the external-tool
   * prompt is taken as given unless a test says otherwise.
   */
  approved?: boolean;
} = {}) {
  const calls: string[] = [];
  const bridge: McpBridge = {
    listMcpServers: async () => options.servers ?? [{ id: 'search', enabled: true }],
    listMcpTools: async (serverId: string) => {
      if (options.unreachable?.includes(serverId)) throw new Error('the server went away');
      return (options.tools?.[serverId] ?? (serverId === 'search' ? [{ serverId, name: 'web' }] : [])) as never;
    },
    callMcpTool: async (serverId: string, name: string) => {
      calls.push(`${serverId}:${name}`);
      return options.replies?.[`${serverId}:${name}`] ?? { isError: false, text: 'external answer' };
    }
  };
  return { handle: createMcpToolHandle(bridge, { approve: async () => options.approved !== false }), calls };
}

test('an MCP call runs with no folder open and comes back as an observation', async () => {
  const external = mcpFixture();
  const model = scripted([toolBlock([externalRead]), 'The search found two projects.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.deepEqual(external.calls, ['search:web']);
  assert.equal(result.error, null, 'an external call is not blocked on a workspace');
  assert.equal(result.changedFiles, 1, 'a successful external call is one progress unit');
  assert.match(model.seen[1].at(-1).content, /external answer/);
  assert.equal(result.text, 'The search found two projects.');
});

test('an MCP call takes one of the per-round slots', async () => {
  const external = mcpFixture();
  const reads: string[] = [];
  await withBridge({
    readFile: async (_id: string, path: string) => { reads.push(path); return { name: path, content: path, version: 'v' }; }
  }, async () => {
    const full = Array.from({ length: MAX_CALLS_PER_ROUND }, (_, index) => ({ name: 'read_file', args: { path: `r${index}.ts` } }));
    const model = scripted([toolBlock([externalRead, ...full]), 'Answer.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      external: external.handle
    });
    assert.equal(reads.length, MAX_CALLS_PER_ROUND - 1, 'the MCP call cost a disk slot');
    assert.equal(result.activity.length, MAX_CALLS_PER_ROUND);
    assert.match(model.seen[1].at(-1).content, new RegExp(`r${MAX_CALLS_PER_ROUND - 1}\\.ts did not run this round`));
  });
});

test('the same MCP call twice in one round runs once', async () => {
  const external = mcpFixture();
  const model = scripted([toolBlock([externalRead, externalRead]), 'Answer.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.deepEqual(external.calls, ['search:web']);
  assert.equal(result.activity.length, 1);
});

test('an invented MCP name is refused and the offered name is listed', async () => {
  const external = mcpFixture();
  const model = scripted([
    toolBlock([{ name: 'mcp__search__browse', args: {} }, externalRead]),
    'Answer.'
  ]);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.deepEqual(external.calls, ['search:web'], 'the real call still ran');
  assert.match(model.seen[1].at(-1).content, /is not a tool/);
  assert.match(model.seen[1].at(-1).content, /mcp__search__web/);
});

test('a server that will not list costs the turn one note, not the round', async () => {
  const external = mcpFixture({ unreachable: ['search'] });
  const model = scripted([toolBlock([readCall]), 'Answered from the file.']);
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: 'const a = 1;', version: 'v' })
  }, async () => {
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      external: external.handle
    });
    assert.equal(result.activity.length, 1);
    assert.equal(result.activity[0].ok, true);
    assert.equal(result.text, 'Answered from the file.');
  });
});

test('an MCP error is a failed activity, and the turn keeps going', async () => {
  const external = mcpFixture({ replies: { 'search:web': { isError: true, text: 'quota exceeded' } } });
  const model = scripted([toolBlock([externalRead]), 'The server is out of quota.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.equal(result.activity[0].ok, false);
  assert.match(result.activity[0].error as string, /quota exceeded/);
  assert.equal(result.text, 'The server is out of quota.');
});

test('the user saying no to an MCP tool is a refusal the loop reports, not a server call', async () => {
  const external = mcpFixture({ approved: false });
  const model = scripted([toolBlock([externalRead]), 'I answered from what I already knew.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: null,
    aborted: () => false,
    stream: model.stream,
    external: external.handle
  });
  assert.deepEqual(external.calls, [], 'nothing was sent to the server');
  assert.equal(result.activity[0].ok, false);
  assert.equal(result.activity[0].refused, true, 'a user "no" is a held refusal, not a failed operation');
  assert.match(result.activity[0].error as string, /did not allow/);
  assert.match(result.activity[0].error as string, /Do not retry/);
  assert.equal(result.text, 'I answered from what I already knew.', 'the turn still finishes');
});

test('a guard refusal is marked as held, not as a failed operation', async () => {
  const model = scripted([
    toolBlock([{ name: 'read_file', args: {} }]),
    'I need a path before I can read anything.'
  ]);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.activity[0].ok, false);
  assert.equal(result.activity[0].refused, true, 'the guard stopped the call before it ran');
});

test('tool activity records stage, durationMs, input, output, and emits onStatus', async () => {
  const statusUpdates: string[] = [];
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: 'export const X = 42;', version: 'v1' })
  }, async () => {
    const model = scripted([toolBlock([readCall]), 'I read the file.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      onStatus: (status) => statusUpdates.push(status)
    });
    assert.equal(result.activity.length, 1);
    const act = result.activity[0];
    assert.equal(act.name, 'read_file');
    assert.equal(act.ok, true);
    assert.equal(act.stage, 'reading');
    assert.equal(typeof act.durationMs, 'number');
    assert.deepEqual(act.input, { path: 'src/a.ts' });
    assert.ok(act.output && act.output.includes('export const X = 42;'));
    assert.ok(statusUpdates.length > 0, 'onStatus emitted live status updates');
  });
});


test('the chat can run a real command and reads its exit code and output', async () => {
  const ran: string[] = [];
  await withBridge({
    runCommand: async (_id: string, command: string) => {
      ran.push(command);
      return { stdout: ' 3000  4242\n', stderr: '', exitCode: 0 };
    }
  }, async () => {
    const model = scripted([toolBlock([{ name: 'run_command', args: { command: 'netstat -ano | findstr :3000' } }]), 'Port 3000 is held by PID 4242.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream
    });
    assert.deepEqual(ran, ['netstat -ano | findstr :3000']);
    assert.equal(result.activity[0].ok, true);
    assert.equal(result.activity[0].stage, 'checking');
    assert.match(result.activity[0].output ?? '', /PID|3000/);
  });
});

test('a command denied by the native approval gate is reported as refused', async () => {
  let requested = false;
  await withBridge({
    runCommand: async () => {
      requested = true;
      return { stdout: '', stderr: 'Command was not approved.', exitCode: 1, deniedReason: 'Command was not approved.' };
    }
  }, async () => {
    const model = scripted([toolBlock([{ name: 'run_command', args: { command: 'rm -rf src' } }]), 'I did not touch it.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream
    });
    assert.equal(requested, true, 'the command reached the main-process approval boundary');
    assert.equal(result.activity[0].ok, false);
    assert.equal(result.activity[0].refused, true);
    assert.match(result.activity[0].output ?? '', /not approved/);
  });
});

const runCall = { name: 'run_command', args: { command: 'echo hi' } };

test('ask mode refuses an execute call before it reaches the bridge', async () => {
  let ran = 0;
  await withBridge({
    runCommand: async () => { ran += 1; return { stdout: 'hi\n', stderr: '', exitCode: 0 }; }
  }, async () => {
    const model = scripted([toolBlock([runCall]), 'I did not run it.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      policy: { mode: 'ask' },
      stream: model.stream
    });
    assert.equal(ran, 0, 'the command never reached the main-process bridge');
    assert.equal(result.activity.length, 1);
    assert.equal(result.activity[0].ok, false);
    assert.equal(result.activity[0].refused, true);
    assert.match(result.activity[0].error ?? '', /ask mode does not allow execute/);
    assert.match(model.seen[1].at(-1).content, /was refused/);
  });
});

test('agent mode runs the same execute call', async () => {
  let ran = 0;
  await withBridge({
    runCommand: async () => { ran += 1; return { stdout: 'hi\n', stderr: '', exitCode: 0 }; }
  }, async () => {
    const model = scripted([toolBlock([runCall]), 'It printed hi.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      policy: { mode: 'agent' },
      stream: model.stream
    });
    assert.equal(ran, 1);
    assert.equal(result.activity[0].ok, true);
    assert.equal(result.activity[0].refused, undefined);
  });
});

test('a read is allowed in ask mode: the boundary is the effect, not the mode', async () => {
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: 'const a = 1;', version: 'v1' })
  }, async () => {
    const model = scripted([toolBlock([readCall]), 'It declares const a.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      policy: { mode: 'ask' },
      stream: model.stream
    });
    assert.equal(result.activity.length, 1);
    assert.equal(result.activity[0].ok, true);
    assert.equal(result.activity[0].refused, undefined);
  });
});

test('plan mode refuses a write, and the delete never touches disk', async () => {
  let deleted = 0;
  await withBridge({
    deletePath: async () => { deleted += 1; return { path: 'src/a.ts', kind: 'file' }; }
  }, async () => {
    const model = scripted([toolBlock([{ name: 'delete_file', args: { path: 'src/a.ts', confirm: true } }]), 'Left it alone.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      policy: { mode: 'plan' },
      stream: model.stream
    });
    assert.equal(deleted, 0);
    assert.equal(result.activity[0].ok, false);
    assert.equal(result.activity[0].refused, true);
    assert.match(result.activity[0].error ?? '', /plan mode does not allow write/);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 0: cached duplicates (never refused), hash/epoch invalidation,
 * and the flight recorder's view of the turn.
 * ------------------------------------------------------------------ */

test('a repeated read across rounds returns the cached result, never a refusal', async () => {
  let reads = 0;
  await withBridge({
    readFile: async (_id: string, path: string) => { reads += 1; return { name: path, content: 'const a = 1;', version: 'v' }; }
  }, async () => {
    const model = scripted([toolBlock([readCall]), toolBlock([readCall]), 'It declares const a.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(reads, 1, 'the duplicate never touched disk');
    assert.equal(result.activity.length, 1, 'a cache hit is not a new execution');
    const observation = model.seen[2].at(-1).content;
    assert.match(observation, /\[unchanged since step 1\]/, 'the cached result is honestly labelled');
    assert.match(observation, /const a = 1;/, 'the earlier result is returned, not a refusal');
    assert.doesNotMatch(observation, /already succeeded|Ask for something different/);
    assert.equal(result.stopReason, 'complete');
    assert.equal(result.changedFiles, 0);
  });
});

test('a failed call is never cached, so the identical retry really runs', async () => {
  let reads = 0;
  await withBridge({
    readFile: async () => { reads += 1; throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); }
  }, async () => {
    const model = scripted([toolBlock([readCall]), toolBlock([readCall]), 'The file is not there.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(reads, 2, 'failures stay retryable');
    assert.equal(result.activity.length, 2);
    assert.equal(result.activity[1].ok, false);
    assert.doesNotMatch(model.seen[2].at(-1).content, /unchanged since step/);
  });
});

test('a write invalidates the cached read of that path by content hash', async () => {
  const files = new Map<string, string>([['src/a.ts', 'const a = 1;']]);
  let diskReads = 0;
  await withBridge({
    readFile: async (_id: string, path: string) => {
      diskReads += 1;
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: path, content: files.get(path), version: 'v' };
    },
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((entry) => ({ name: entry.name })) };
    }
  }, async () => {
    const write = { name: 'write_file', args: { path: 'src/a.ts', content: 'const a = 2;' } };
    const model = scripted([
      toolBlock([readCall]),
      toolBlock([write]),
      toolBlock([readCall]),
      toolBlock([readCall]),
      'Updated and verified.'
    ]);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    // r1 read + the write's own pre-read + r3 re-read = 3; r4 is a cache hit.
    assert.equal(diskReads, 3, 'the write invalidated the stale read, the re-read re-cached it');
    assert.equal(result.activity.length, 3);
    assert.equal(result.activity[1].name, 'write_file');
    assert.equal(result.activity[1].ok, true);
    assert.match(result.activity[2].output ?? '', /const a = 2;/, 'the fresh read saw the new bytes');
    assert.match(model.seen[3].at(-1).content, /const a = 2;/);
    assert.match(model.seen[4].at(-1).content, /\[unchanged since step 3\]/, 'the post-write read is cached at its new step');
    assert.equal(result.changedFiles, 1);
    assert.equal(result.text, 'Updated and verified.');
  });
});

test('a command mutation invalidates cached observations through the epoch', async () => {
  let reads = 0;
  let commands = 0;
  await withBridge({
    readFile: async (_id: string, path: string) => { reads += 1; return { name: path, content: 'x', version: 'v' }; },
    runCommand: async () => { commands += 1; return { stdout: 'ok\n', stderr: '', exitCode: 0 }; }
  }, async () => {
    const model = scripted([
      toolBlock([readCall]),
      toolBlock([{ name: 'run_command', args: { command: 'echo ok' } }]),
      toolBlock([readCall]),
      'Read again after the command.'
    ]);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(commands, 1);
    assert.equal(reads, 2, 'the epoch bump made the earlier observation re-runnable');
    assert.doesNotMatch(model.seen[3].at(-1).content, /already succeeded/);
    assert.equal(result.changedFiles, 1);
  });
});

test('a successful command no longer resets the same-error counter: a kill/restart loop still blocks', async () => {
  await withBridge({
    runCommand: async (_id: string, command: string) =>
      command.includes('taskkill')
        ? { stdout: 'SUCCESS: The process with PID 4242 has been terminated.', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:3001', exitCode: 1 }
  }, async () => {
    const dev = { name: 'run_command', args: { command: 'npm run dev' } };
    const kill = { name: 'run_command', args: { command: 'taskkill /PID 4242 /F' } };
    const model = scripted([
      toolBlock([dev]),
      toolBlock([kill]),
      toolBlock([dev]),
      toolBlock([kill]),
      toolBlock([dev]),
      'Stopping the loop.'
    ]);
    await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.match(model.seen[3].at(-1).content, /failed the same way twice/,
      'the second identical dev failure nudges even though a kill succeeded in between');
    assert.match(model.seen[5].at(-1).content, /is blocked: it failed the same way three times/,
      'the third identical dev failure blocks — the successful kill did not wipe the counter');
  });
});

test('a port-in-use failure loop earns advice that killing cannot fix a fixed-port config', async () => {
  await withBridge({
    runCommand: async () => ({ stdout: '', stderr: 'WebSocket server error: Port 3001 is already in use', exitCode: 1 })
  }, async () => {
    const dev = { name: 'run_command', args: { command: 'npm run dev' } };
    const model = scripted([toolBlock([dev]), toolBlock([dev]), 'I will change the port in the config instead.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    const advice = model.seen[2].at(-1).content;
    assert.match(advice, /failed the same way twice/, 'the second identical failure nudges');
    assert.match(advice, /port is fixed in the project/, 'the nudge carries the port-loop advice');
    assert.match(advice, /preview_control/, 'the advice names the preview alternative');
    assert.equal(result.text, 'I will change the port in the config instead.');
  });
});

test('a cached mutation neither re-runs nor re-counts changedFiles', async () => {
  let commands = 0;
  await withBridge({
    runCommand: async () => { commands += 1; return { stdout: 'hi\n', stderr: '', exitCode: 0 }; }
  }, async () => {
    const asking = toolBlock([{ name: 'run_command', args: { command: 'echo hi' } }]);
    const model = scripted([asking, asking, asking, 'It printed hi.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    assert.equal(commands, 1, 'the identical mutation ran exactly once');
    assert.equal(result.changedFiles, 1, 'cache hits do not inflate the mutation count');
    assert.match(model.seen[2].at(-1).content, /\[unchanged since step 1\]/);
    assert.match(model.seen[3].at(-1).content, /\[unchanged since step 1\]/);
    assert.equal(result.stopReason, 'complete');
  });
});

test('an aborted turn stops with reason aborted and a resume payload', async () => {
  let aborted = false;
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => aborted,
    stream: async () => { aborted = true; return { text: 'partial', error: null }; }
  });
  assert.equal(result.stopReason, 'aborted');
  assert.ok(result.resume);
  assert.equal(result.resume!.pendingIntent, 'what is in a.ts?');
});

test('the flight recorder captures the turn sequence, cache hits and the stop reason', async () => {
  flightRecorder.reset();
  await withBridge({
    readFile: async (_id: string, path: string) => ({ name: path, content: 'const a = 1;', version: 'v' })
  }, async () => {
    const model = scripted([toolBlock([readCall]), toolBlock([readCall]), 'Done.']);
    await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  });
  const runs = flightRecorder.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].kind, 'tool-loop');
  assert.equal(runs[0].stopReason, 'complete');
  const events = flightRecorder.readEvents(runs[0].runId);
  const types = events.map((event) => event.type);
  assert.equal(types[0], 'turn_started');
  assert.ok(types.includes('context_assembled'));
  assert.ok(types.includes('tool_call_started'));
  assert.ok(types.includes('tool_result'));
  assert.ok(types.includes('cache_hit'), 'the duplicate is visible in the trace');
  assert.equal(types.at(-1), 'stop');
  const toolResult = events.find((event) => event.type === 'tool_result');
  assert.equal(toolResult!.data.tool, 'read_file');
  assert.equal(toolResult!.data.status, 'ok');
  assert.equal(typeof toolResult!.data.ms, 'number');
  const stop = events.at(-1)!;
  assert.equal(stop.data.reason, 'complete');
  // Sequence numbers are strictly increasing: append-only order is the truth.
  events.forEach((event, index) => assert.equal(event.seq, index));
  flightRecorder.reset();
});

test('the recorder scrubs credentials out of command events before they are kept', async () => {
  flightRecorder.reset();
  const secret = 'sk-abcdefghijklmnopqrstuvwx123456';
  await withBridge({
    runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 })
  }, async () => {
    const model = scripted([
      toolBlock([{ name: 'run_command', args: { command: `echo API_KEY=${secret}` } }]),
      'Ran it.'
    ]);
    await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  });
  const runs = flightRecorder.listRuns();
  const events = flightRecorder.readEvents(runs[0].runId);
  const requested = events.find((event) => event.type === 'command_requested');
  assert.ok(requested, 'the command boundary is recorded');
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(secret), 'the raw key never reaches the log');
  assert.match(String(requested!.data.command), /\[REDACTED_SECRET\]/);
  assert.ok(events.some((event) => event.type === 'command_finished' && event.data.exit === 0));
  flightRecorder.reset();
});

test('expectedFiles confines native write tools on existing unlisted files while allowing brand-new files and reporting changedPaths', async () => {
  const files = new Map<string, string>([
    ['src/a.ts', 'export const a = 1;\n'],
    ['src/secret.ts', 'export const keep = true;\n']
  ]);
  await withBridge({
    readFile: async (_id: string, path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: path, content: files.get(path), version: 'v' };
    },
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((e) => ({ name: e.name })) };
    }
  }, async () => {
    const model = scripted([
      toolBlock([
        { name: 'write_file', args: { path: 'src/secret.ts', content: 'clobbered' } },
        { name: 'write_file', args: { path: 'src/newHelper.ts', content: 'export const h = 1;\n' } },
        { name: 'edit_file', args: { path: 'src/a.ts', original: 'export const a = 1;', updated: 'export const a = 2;' } }
      ]),
      'Finished.'
    ]);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      expectedFiles: ['src/a.ts'],
      existsOnDisk: async (p) => files.has(p),
      stream: model.stream
    });
    assert.equal(files.get('src/secret.ts'), 'export const keep = true;\n', 'unlisted existing file stays untouched');
    assert.equal(result.activity[0].refused, true);
    assert.match(result.activity[0].error ?? '', /expectedFiles|outside|confine/i);
    assert.equal(files.get('src/newHelper.ts'), 'export const h = 1;\n', 'brand-new unlisted file is allowed');
    assert.equal(files.get('src/a.ts'), 'export const a = 2;\n');
    assert.ok(result.changedPaths?.includes('src/a.ts'));
    assert.ok(result.changedPaths?.includes('src/newHelper.ts'));
    assert.deepEqual(result.createdPaths, ['src/newHelper.ts']);
  });
});

test('runToolRounds injects and updates pinned WORKING MEMORY scratchpad from round 4 onward', async () => {
  const files = new Map<string, string>([['src/a.ts', 'line1\nline2\n']]);
  await withBridge({
    readFile: async (_id: string, path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: path, content: files.get(path), version: 'v' };
    },
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((e) => ({ name: e.name })) };
    }
  }, async () => {
    const model = scripted([
      toolBlock([{ name: 'read_file', args: { path: 'src/a.ts', start_line: 1, end_line: 2 } }]),
      toolBlock([{ name: 'edit_file', args: { path: 'src/a.ts', original: 'line1', updated: 'line1_updated' } }]),
      toolBlock([{ name: 'write_file', args: { path: 'src/b.ts', content: 'export const b = 1;\n' } }]),
      toolBlock([{ name: 'write_file', args: { path: 'src/c.ts', content: 'export const c = 1;\n' } }]),
      'All done.'
    ]);
    await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      initialRequirements: ['Create src/b.ts and update src/a.ts'],
      stream: model.stream
    });
    const round4Transcript = model.seen[4].map((m) => m.content).join('\n');
    assert.match(round4Transcript, /\[WORKING MEMORY/);
    assert.match(round4Transcript, /src\/a\.ts/);
    assert.match(round4Transcript, /Create src\/b\.ts and update src\/a\.ts/);
  });
});

test('requireFileMutation intercepts zero-write finish call once with MUTATION_REQUIRED_NUDGE and succeeds once write_file runs', async () => {
  const files = new Map<string, string>([['src/a.ts', 'export const x = 1;\n']]);
  await withBridge({
    readFile: async (_id: string, path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: path, content: files.get(path), version: 'v1' };
    },
    diagnostics: async () => ({ diagnostics: [], truncated: false }),
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((entry) => ({ name: entry.name })) };
    }
  }, async () => {
    const model = scripted([
      toolBlock([readCall]),
      finishWith('Looked at src/a.ts and summarized changes.'),
      toolBlock([{ name: 'write_file', args: { path: 'src/a.ts', content: 'export const x = 2;\n' } }]),
      toolBlock([{ name: 'problems', args: { paths: ['src/a.ts'] } }]),
      finishWith('Updated src/a.ts cleanly.')
    ]);
    const result = await runToolRounds({
      messages: [{ role: 'user', content: 'Update src/a.ts to export 2' }],
      workspaceId: 'ws',
      aborted: () => false,
      requireFileMutation: true,
      stream: model.stream
    });
    assert.equal(files.get('src/a.ts'), 'export const x = 2;\n');
    assert.equal(result.changedFiles, 1);
    assert.match(result.finish?.summary ?? '', /^Updated src\/a\.ts cleanly\./);
    assert.ok(result.toolEvents.some((ev) => ev.name === 'write_file' && ev.ok));
    assert.ok(
      model.seen.some((turns) => turns.some((turn) => turn.content.includes(MUTATION_REQUIRED_NUDGE))),
      'expected zero-write finish to trigger MUTATION_REQUIRED_NUDGE'
    );
  });
});

test('requireFileMutation intercepts zero-write plain-text reply once before allowing completion', async () => {
  const files = new Map<string, string>();
  await withBridge({
    readFile: async (_id: string, path: string) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: path, content: files.get(path), version: 'v1' };
    },
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((entry) => ({ name: entry.name })) };
    }
  }, async () => {
    const model = scripted([
      'Here is a summary without applying edits.',
      toolBlock([{ name: 'write_file', args: { path: 'src/created.ts', content: 'export const ok = true;\n' } }]),
      'Created src/created.ts.'
    ]);
    const result = await runToolRounds({
      messages: [{ role: 'user', content: 'Create src/created.ts' }],
      workspaceId: 'ws',
      aborted: () => false,
      requireFileMutation: true,
      stream: model.stream
    });
    assert.equal(files.get('src/created.ts'), 'export const ok = true;\n');
    assert.equal(result.rounds, 3);
    assert.equal(result.text, 'Created src/created.ts.');
    assert.equal(model.seen[1].at(-1)?.content, MUTATION_REQUIRED_NUDGE);
  });
});

test('finish is rejected in an execution turn when the user asked for file work but nothing was written', async () => {
  const model = scripted([finishWith('I created src/notes.txt with a greeting.'), finishWith('I created src/notes.txt with a greeting.')]);
  const result = await runToolRounds({
    messages: [{ role: 'user', content: 'Create a new file src/notes.txt with a greeting.' }],
    workspaceId: 'ws',
    aborted: () => false,
    policy: { mode: 'agent' },
    maxRounds: 2,
    stream: model.stream
  });
  assert.equal(result.finish, undefined, 'finish must be refused when no write/edit tool ran');
  assert.ok(model.seen.some((turns) => turns.some((turn) => typeof turn.content === 'string' && turn.content.includes('You have not created or edited any files yet'))), 'refusal surfaced to the model');
});

test('apply_patch counts as mutation progress across 9+ rounds without tripping stuck detector', async () => {
  const files = new Map<string, string>([['src/a.ts', 'export const v = 0;\n']]);
  const staged = new Map<string, Array<{ name: string; content: string }>>();
  await withBridge({
    readFile: async (_id: string, p: string) => ({ name: p, content: files.get(p) ?? '', version: 'v1' }),
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((e) => e.name) };
    },
    stageFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      const tx = `tx-${staged.size + 1}`;
      staged.set(tx, entries);
      return { transactionId: tx };
    },
    commitTransaction: async (_id: string, tx: string) => {
      const entries = staged.get(tx) ?? [];
      staged.delete(tx);
      for (const entry of entries) files.set(entry.name, entry.content);
      return { saved: entries.map((e) => e.name), errors: [], rolledBack: false };
    }
  }, async () => {
    const patches: string[] = [];
    for (let i = 0; i < ZERO_PROGRESS_LIMIT + 2; i += 1) {
      patches.push(toolBlock([{
        name: 'apply_patch',
        args: { patches: [{ path: 'src/a.ts', old: `export const v = ${i};`, new: `export const v = ${i + 1};` }] }
      }]));
    }
    patches.push('All 10 patches applied cleanly.');
    const model = scripted(patches);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream
    });
    assert.equal(result.stopReason, 'complete');
    assert.equal(result.text, 'All 10 patches applied cleanly.');
    assert.deepEqual(result.changedPaths, ['src/a.ts']);
    const nudged = model.seen.some((turns) => turns.some((turn) => turn.content.includes('You are looping')));
    assert.equal(nudged, false, 'apply_patch must emit progress signals so stuck detector stays silent');
  });
});

test('existingWorkspace skips scaffoldNudge when finish is called after creating fewer than 3 files', async () => {
  const files = new Map<string, string>([['src/existing.ts', 'export const ok = true;\n']]);
  await withBridge({
    readFile: async (_id: string, p: string) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { name: p, content: files.get(p)!, version: 'v1' };
    },
    diagnostics: async () => ({ diagnostics: [], truncated: false }),
    verifyChangeSet: async () => ({ ok: true, issues: [] }),
    saveFiles: async (_id: string, entries: Array<{ name: string; content: string }>) => {
      for (const entry of entries) files.set(entry.name, entry.content);
      return { errors: [], saved: entries.map((e) => e.name) };
    }
  }, async () => {
    const model = scripted([
      toolBlock([{ name: 'write_file', args: { path: 'src/quiz.ts', content: 'export const quiz = true;\n' } }]),
      toolBlock([{ name: 'problems', args: { paths: ['src/quiz.ts'] } }]),
      finishWith('Added quiz module to existing app.')
    ]);
    const result = await runToolRounds({
      messages: [{ role: 'user', content: 'Build a daily quiz dashboard' }],
      workspaceId: 'ws',
      existingWorkspace: true,
      aborted: () => false,
      stream: model.stream
    });
    assert.equal(result.rounds, 3);
    assert.match(result.finish?.summary ?? '', /^Added quiz module to existing app\./);
    const nudgedScaffold = model.seen.some((turns) => turns.some((turn) => turn.content.includes('finish refused: this is a new-project request')));
    assert.equal(nudgedScaffold, false, 'existingWorkspace must not demand 3-file static scaffold');
  });
});



