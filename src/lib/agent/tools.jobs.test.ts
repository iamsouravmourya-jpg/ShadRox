/**
 * Background jobs end to end through the real tools: the auto-backgrounded
 * run_command result (exit null + job id) and the job_control tool that reads,
 * lists and kills jobs. A stub bridge stands in for the main-process executor;
 * everything between the tool call and the model-facing observation is
 * production code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CALLS_PER_ROUND,
  TOOL_DEFINITIONS,
  classifyToolEffect,
  describeTools,
  isKnownTool,
  nativeToolDefinitions,
  runTool,
  summarizeCall,
  waitForJobExit
} from './tools';
import { getDesktopBridge, type ShadRoxDesktopAPI } from '../desktop';
import { globalProofLedger } from '../proofLedger';
import { globalRepairSession } from '../repairSession';

interface StubBridge {
  runCommand?: (workspaceId: string, command: string, notice?: string) => Promise<unknown>;
  listDirectory?: (workspaceId: string, dir: string, cursor?: number | null) => Promise<unknown>;
  jobControl?: (workspaceId: string, request: Record<string, unknown>) => Promise<unknown>;
}

function withBridge(bridge: StubBridge, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { shadroxDesktop: { platform: 'win32', ...bridge } },
    configurable: true,
    writable: true
  });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

function reset() {
  globalRepairSession.reset();
  globalProofLedger.clear();
}

test('a round holds sixteen calls and job_control reads without counting as a mutation', () => {
  assert.equal(MAX_CALLS_PER_ROUND, 16);
  assert.equal(isKnownTool('job_control'), true);
  // A read: polling a job must not re-stale the verification the finish gate accepted.
  assert.equal(classifyToolEffect('job_control'), 'read');
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.name === 'job_control'));
});

test('a verify that auto-backgrounds waits for the job and reports the real exit', async () => {
  reset();
  await withBridge({
    listDirectory: () => Promise.resolve({ entries: [{ path: 'pytest.ini', kind: 'file' }], nextCursor: null }),
    runCommand: (workspaceId, command) => {
      assert.equal(command, 'python -m pytest -x -q');
      return Promise.resolve({ stdout: 'collecting...', stderr: '', exitCode: null, timedOut: false, backgrounded: true, jobId: 'J1' });
    },
    jobControl: (workspaceId, request) => {
      assert.equal(workspaceId, 'ws');
      if (request.action === 'status') {
        return Promise.resolve({ ok: true, jobId: 'J1', status: 'exited', exitCode: 0, timedOut: false });
      }
      return Promise.resolve({ ok: true, jobId: 'J1', text: '3 passed in 0.2s' });
    }
  }, async () => {
    const outcome = await runTool('ws', { name: 'verify', args: {} });
    assert.equal(outcome.ok, true, `verify should pass through the real exit, got: ${outcome.error ?? outcome.content}`);
    assert.match(outcome.content, /python -m pytest -x -q/);
    assert.doesNotMatch(outcome.content, /became background job/);
    assert.doesNotMatch(outcome.content, /exited 0/, 'exit 0 with no failing tests is a pass, not an error line');
  });
});

test('waitForJobExit returns the job outcome and gives up honestly when it never exits', async () => {
  let polls = 0;
  const exitedBridge: StubBridge = {
    jobControl: (workspaceId, request) => {
      if (request.action === 'status') {
        polls += 1;
        return Promise.resolve({ ok: true, jobId: 'J2', status: 'exited', exitCode: 2, timedOut: false });
      }
      return Promise.resolve({ ok: true, jobId: 'J2', text: '1 failed, 2 passed' });
    }
  };
  await withBridge(exitedBridge, async () => {
    const desktop = getDesktopBridge() as ShadRoxDesktopAPI;
    const outcome = await waitForJobExit(desktop, 'ws', 'J2', 60_000);
    assert.ok(outcome, 'an exited job resolves on the first poll');
    assert.equal(outcome!.exitCode, 2);
    assert.match(outcome!.text, /1 failed/);
  });
  assert.equal(polls, 1);

  await withBridge({
    jobControl: () => Promise.resolve({ ok: true, jobId: 'J9', status: 'running', exitCode: null, timedOut: false })
  }, async () => {
    const desktop = getDesktopBridge() as ShadRoxDesktopAPI;
    assert.equal(await waitForJobExit(desktop, 'ws', 'J9', 250), null, 'a never-exiting job is reported unresolved, not failed');
  });
});

test('job_control has a native schema with the full action set, chars and an optional range', () => {
  const schema = nativeToolDefinitions().find((tool) => tool.name === 'job_control');
  assert.ok(schema, 'job_control needs a JSON schema for native tool calling');
  const parameters = schema!.parameters as {
    properties: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>;
    required: string[];
  };
  assert.deepEqual(parameters.properties.action.enum, ['list', 'read_output', 'status', 'stop', 'kill']);
  assert.deepEqual(parameters.required, ['action']);
  assert.ok(parameters.properties.range.properties);
  assert.ok(parameters.properties.jobId);
  assert.ok(parameters.properties.chars, 'read_output accepts a chars tail window');
});

test('the prompt teaches risk tiers, auto-backgrounding and job_control', () => {
  const prompt = describeTools(3).join('\n');
  assert.match(prompt, /JOBS: a command still running after 30 seconds/);
  assert.match(prompt, /job_control/);
  assert.match(prompt, /risk-tiered/);
  assert.match(prompt, /npm install/);
  assert.match(prompt, /never pre-approved/);
  assert.match(prompt, /- job_control\(/);
});

test('summarizeCall names the job_control action and job id', () => {
  assert.equal(summarizeCall({ name: 'job_control', args: { action: 'read_output', jobId: 'J3' } }), 'job_control · read_output J3');
  assert.equal(summarizeCall({ name: 'job_control', args: { action: 'list' } }), 'job_control · list');
});

test('an auto-backgrounded run_command returns the job id and tail, not a verdict', async (t) => {
  t.after(reset);
  reset();
  await withBridge(
    {
      runCommand: async () => ({
        stdout: 'compiling...\n',
        stderr: '',
        exitCode: null,
        timedOut: false,
        backgrounded: true,
        jobId: 'J2',
        tier: 'BUILD_TEST',
        message: 'still running, job id J2; use job_control'
      })
    },
    async () => {
      const outcome = await runTool('ws', { name: 'run_command', args: { command: 'npm run build:watch' } });
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /job J2/);
      assert.match(outcome.content, /compiling\.\.\./);
      assert.match(outcome.content, /NOT a finished result/);
      assert.match(outcome.content, /job_control/);
      assert.doesNotMatch(outcome.content, /exit null/);
      assert.equal(outcome.proof, undefined, 'a backgrounded command proved nothing yet — no repair capture');
    }
  );
});

test('a backgrounded command does not heal or refute a repair receipt', async (t) => {
  t.after(reset);
  reset();
  let call = 0;
  await withBridge(
    {
      runCommand: async () => {
        call += 1;
        if (call === 1) return { stdout: '', stderr: 'boom', exitCode: 1 };
        return { stdout: 'watching', stderr: '', exitCode: null, backgrounded: true, jobId: 'J1', tier: 'BUILD_TEST' };
      }
    },
    async () => {
      const failed = await runTool('ws', { name: 'run_command', args: { command: 'npm test' } });
      assert.equal(failed.ok, false);
      assert.ok(failed.proof, 'the real failure is captured');
      const backgrounded = await runTool('ws', { name: 'run_command', args: { command: 'npm test' } });
      assert.equal(backgrounded.ok, true);
      assert.equal(backgrounded.proof, undefined, 'backgrounding is not a heal verdict');
      assert.equal(globalRepairSession.getOpenReceipts().length, 1, 'the receipt stays open until a real exit-0 rerun');
    }
  );
});

test('compound and multi-line commands reach the executor unchanged', async (t) => {
  t.after(reset);
  reset();
  const seen: string[] = [];
  await withBridge(
    {
      runCommand: async (_ws: string, command: string) => {
        seen.push(command);
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      }
    },
    async () => {
      const compound = await runTool('ws', { name: 'run_command', args: { command: 'npm i && npm test' } });
      assert.equal(compound.ok, true);
      const heredoc = await runTool('ws', { name: 'run_command', args: { command: "python3 <<'EOF'\nprint(1)\nEOF" } });
      assert.equal(heredoc.ok, true);
      assert.deepEqual(seen, ['npm i && npm test', "python3 <<'EOF'\nprint(1)\nEOF"]);
    }
  );
});

test('job_control list formats every job with status, tier and readiness', async () => {
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async () => ({
        ok: true,
        jobs: [
          { jobId: 'J1', command: 'npm run dev', status: 'running', tier: 'BUILD_TEST', exitCode: null, ready: true, readyUrl: 'http://localhost:5173/', outputChars: 1200 },
          { jobId: 'J2', command: 'npm test', status: 'exited', tier: 'BUILD_TEST', exitCode: 1, timedOut: false, outputChars: 400 }
        ]
      })
    },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'list' } });
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /2 job\(s\)/);
      assert.match(outcome.content, /J1 · running/);
      assert.match(outcome.content, /ready at http:\/\/localhost:5173\//);
      assert.match(outcome.content, /J2 · exited · exit 1/);
      assert.match(outcome.content, /\$ npm run dev/);
    }
  );
});

test('job_control list with no jobs says so', async () => {
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async () => ({ ok: true, jobs: [] })
    },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'list' } });
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /No command jobs/);
    }
  );
});

test('job_control read_output forwards the range and shows the buffered window', async () => {
  const requests: Array<Record<string, unknown>> = [];
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async (_ws: string, request: Record<string, unknown>) => {
        requests.push(request);
        return { ok: true, jobId: 'J1', status: 'running', exitCode: null, start: 100, end: 164, totalChars: 5000, text: 'line one\nline two' };
      }
    },
    async () => {
      const outcome = await runTool('ws', {
        name: 'job_control',
        args: { action: 'read_output', jobId: 'J1', range: { start: 100, end: 164 } }
      });
      assert.equal(outcome.ok, true);
      assert.deepEqual(requests[0], { action: 'read_output', jobId: 'J1', range: { start: 100, end: 164 } });
      assert.match(outcome.content, /job J1 · running/);
      assert.match(outcome.content, /chars 100–164 of 5000/);
      assert.match(outcome.content, /line one\nline two/);
    }
  );
});

test('job_control read_output without a range defaults to the newest window', async () => {
  const requests: Array<Record<string, unknown>> = [];
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async (_ws: string, request: Record<string, unknown>) => {
        requests.push(request);
        return { ok: true, jobId: 'J1', status: 'exited', exitCode: 0, start: 0, end: 3, totalChars: 3, text: 'done' };
      }
    },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'read_output', jobId: 'J1' } });
      assert.equal(outcome.ok, true);
      assert.equal(requests[0].range, undefined);
      assert.match(outcome.content, /exit 0/);
      assert.match(outcome.content, /done/);
    }
  );
});

test('job_control stop reports the terminated tree, kill stays an alias, and a finished job is a no-op', async () => {
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async (_ws: string, request: Record<string, unknown>) =>
        request.jobId === 'J1'
          ? { ok: true, jobId: 'J1', killed: true, status: 'running' }
          : { ok: true, jobId: 'J2', killed: false, status: 'exited', message: 'Job already exited.' }
    },
    async () => {
      const stopped = await runTool('ws', { name: 'job_control', args: { action: 'stop', jobId: 'J1' } });
      assert.equal(stopped.ok, true);
      assert.match(stopped.content, /Stopped job J1 and its process tree/);
      const killed = await runTool('ws', { name: 'job_control', args: { action: 'kill', jobId: 'J1' } });
      assert.equal(killed.ok, true);
      assert.match(killed.content, /Stopped job J1 and its process tree/);
      const finished = await runTool('ws', { name: 'job_control', args: { action: 'stop', jobId: 'J2' } });
      assert.equal(finished.ok, true);
      assert.match(finished.content, /already exited/);
    }
  );
});

test('job_control status reports one job with tier, exit and readiness', async () => {
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async (_ws: string, request: Record<string, unknown>) => {
        assert.equal(request.action, 'status');
        assert.equal(request.jobId, 'J1');
        return {
          ok: true, jobId: 'J1', command: 'npm run dev', status: 'running', tier: 'BUILD_TEST',
          exitCode: null, timedOut: false, backgrounded: true, ready: true,
          readyUrl: 'http://localhost:5173/', startedAt: 1, endedAt: null, outputChars: 1200
        };
      }
    },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'status', jobId: 'J1' } });
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /J1 · running/);
      assert.match(outcome.content, /tier BUILD_TEST/);
      assert.match(outcome.content, /ready at http:\/\/localhost:5173\//);
      assert.match(outcome.content, /\$ npm run dev/);
    }
  );
});

test('job_control read_output forwards a chars tail window', async () => {
  const requests: Array<Record<string, unknown>> = [];
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async (_ws: string, request: Record<string, unknown>) => {
        requests.push(request);
        return { ok: true, jobId: 'J1', status: 'running', exitCode: null, start: 4000, end: 5000, totalChars: 5000, text: 'tail' };
      }
    },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'read_output', jobId: 'J1', chars: 1000 } });
      assert.equal(outcome.ok, true);
      assert.equal(requests[0].chars, 1000);
      assert.match(outcome.content, /chars 4000–5000 of 5000/);
    }
  );
});

test('job_control refuses missing jobId and unknown actions with actionable text', async () => {
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async () => ({ ok: true })
    },
    async () => {
      const noJob = await runTool('ws', { name: 'job_control', args: { action: 'read_output' } });
      assert.equal(noJob.ok, false);
      assert.equal(noJob.refused, true);
      assert.match(noJob.error ?? '', /needs a jobId/);
      const badAction = await runTool('ws', { name: 'job_control', args: { action: 'explode' } });
      assert.equal(badAction.refused, true);
      assert.match(badAction.error ?? '', /list/);
    }
  );
});

test('job_control surfaces a main-process error as an observation, never a silent drop', async () => {
  await withBridge(
    {
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      jobControl: async () => ({ ok: false, error: 'Unknown job id J9 for this workspace. Use job_control with action "list" to see jobs.' })
    },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'read_output', jobId: 'J9' } });
      assert.equal(outcome.ok, false);
      assert.match(outcome.content, /Unknown job id J9/);
      assert.match(outcome.error ?? '', /list/);
    }
  );
});

test('job_control refuses cleanly when the bridge has no job channel yet', async () => {
  await withBridge(
    { runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    async () => {
      const outcome = await runTool('ws', { name: 'job_control', args: { action: 'list' } });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.refused, true);
      assert.match(outcome.error ?? '', /jobControl/);
    }
  );
});