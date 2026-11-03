import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAX_TOOL_ROUNDS, runToolRounds } from './toolLoop';
import { createMcpToolHandle } from './mcpTools';
import type { McpBridge } from './mcpTools';
import type { ChatTurn } from '../ai';

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
    const six = Array.from({ length: 6 }, (_, index) => ({ name: 'read_file', args: { path: `a${index}.ts` } }));
    const seventh = { name: 'read_file', args: { path: 'dropped.ts' } };
    const model = scripted([`${toolBlock(six)}\n${toolBlock([seventh])}`, toolBlock([seventh]), 'Answer.']);
    const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
    const observation = model.seen[1].at(-1).content;
    assert.equal((observation.match(/"tool":/g) ?? []).length, 6, 'one round runs six');
    assert.match(observation, /dropped\.ts did not run this round/, 'the model is told the call was cut');
    assert.equal(read.length, 7, 'the cut call is still runnable in the next round');
    assert.equal(read.at(-1), 'dropped.ts');
    assert.equal(result.text, 'Answer.');
  });
});

test('an unknown tool is answered with the available list, not executed', async () => {
  const model = scripted([toolBlock([{ name: 'write_file', args: { path: 'a' } }]), 'Noted.']);
  const result = await runToolRounds({ messages: baseMessages, workspaceId: 'ws', aborted: () => false, stream: model.stream });
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.activity, []);
  assert.match(model.seen[1].at(-1).content, /is not a tool/);
  assert.match(model.seen[1].at(-1).content, /read_file/);
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

test('the budget ends with a forced final answer, tool-free', async () => {
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
  assert.equal(result.text, 'Final answer.');
  assert.match(model.seen.at(-1)!.at(-1).content, /Tool budget for this answer is finished/);
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

test('the same refused call three rounds running earns a stuck instruction', async () => {
  const repeated = toolBlock([{ name: 'not_a_tool', args: {} }]);
  const model = scripted([repeated, repeated, repeated, 'Answering with what I have.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.text, 'Answering with what I have.');
  const nudged = model.seen.at(-1)!.some((turn) => turn.content.includes('You are looping'));
  assert.equal(nudged, true, 'the loop told the model it was repeating');
});

test('a model that stays stuck past the nudge is forced to answer', async () => {
  const repeated = toolBlock([{ name: 'not_a_tool', args: {} }]);
  const model = scripted([repeated, repeated, repeated, repeated, repeated, 'Forced answer.']);
  const result = await runToolRounds({
    messages: baseMessages,
    workspaceId: 'ws',
    maxRounds: 5,
    aborted: () => false,
    stream: model.stream
  });
  assert.equal(result.capped, true);
  assert.equal(result.text, 'Forced answer.');
});

const externalRead = { name: 'mcp__search__web', args: { q: 'aider' } };

function mcpFixture(options: {
  servers?: Array<{ id: string; enabled: boolean }>;
  tools?: Record<string, unknown[]>;
  replies?: Record<string, { isError?: boolean; text?: string }>;
  unreachable?: string[];
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
  return { handle: createMcpToolHandle(bridge), calls };
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
  assert.match(model.seen[1].at(-1).content, /external answer/);
  assert.equal(result.text, 'The search found two projects.');
});

test('an MCP call takes one of the six slots in a round', async () => {
  const external = mcpFixture();
  const reads: string[] = [];
  await withBridge({
    readFile: async (_id: string, path: string) => { reads.push(path); return { name: path, content: path, version: 'v' }; }
  }, async () => {
    const six = Array.from({ length: 6 }, (_, index) => ({ name: 'read_file', args: { path: `r${index}.ts` } }));
    const model = scripted([toolBlock([externalRead, ...six]), 'Answer.']);
    const result = await runToolRounds({
      messages: baseMessages,
      workspaceId: 'ws',
      aborted: () => false,
      stream: model.stream,
      external: external.handle
    });
    assert.equal(reads.length, 5, 'the MCP call cost a disk slot');
    assert.equal(result.activity.length, 6);
    assert.match(model.seen[1].at(-1).content, /r5\.ts did not run this round/);
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

