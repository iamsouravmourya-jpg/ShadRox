import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_DEFINITIONS,
  availableToolNames,
  describeTools,
  isKnownTool,
  nativeToolDefinitions,
  runTool,
  summarizeCall
} from './tools';
import { commandApprovalNotice } from './commandGuard';

/**
 * The injection itself is covered by `src/lib/terminal/injectStdin.test.ts`.
 * What matters here is the surface the model sees: it must be offered exactly
 * one way to type into the shell, and that way must read as approval-gated.
 */
test('terminal_answer is offered to the model with a required single line of text', () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'terminal_answer');
  assert.ok(definition, 'terminal_answer must be in the tool list');
  assert.match(definition!.description, /approval dialog/i);

  const schema = nativeToolDefinitions().find((tool) => tool.name === 'terminal_answer');
  assert.ok(schema, 'terminal_answer needs a JSON schema for native tool calling');
  assert.deepEqual(schema!.parameters.required, ['text']);

  assert.equal(isKnownTool('terminal_answer'), true);
  assert.match(availableToolNames(), /terminal_answer/);
});

test('terminal_state now reports the hung, waiting and failure fields', () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'terminal_state');
  assert.ok(definition);
  assert.match(definition!.description, /waiting for input/i);
  assert.match(definition!.description, /classified/i);
  assert.match(definition!.description, /Does not type/i);
});

test('the system rules name terminal_answer as the only typing path', () => {
  const rules = describeTools(4).join('\n');
  assert.match(rules, /terminal_answer is the only way to type/);
  assert.match(rules, /never claim an answer was sent when the tool refused/);
});

test('a terminal answer is labelled with the exact text in the chat surface', () => {
  assert.equal(
    summarizeCall({ name: 'terminal_answer', args: { text: 'y' } }),
    'terminal_answer · y'
  );
  assert.equal(summarizeCall({ name: 'read_file', args: { path: 'src/App.tsx' } }), 'read_file · src/App.tsx');
});

/**
 * The approval dialog lives in the main process; the renderer's only power over
 * it is to hand over text describing the risk. These tests pin that one seam:
 * the tool must actually pass the notice, and must pass nothing at all for a
 * command the guard does not flag.
 */
function withBridge(body: (calls: unknown[][]) => Promise<void>) {
  const calls: unknown[][] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: {
      shadroxDesktop: {
        platform: 'win32',
        runCommand: async (...args: unknown[]) => {
          calls.push(args);
          return { stdout: 'ok', stderr: '', exitCode: 0 };
        }
      }
    },
    configurable: true,
    writable: true
  });
  return body(calls).finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

test('run_command hands the guard\'s risk notice to the desktop bridge', async () => {
  await withBridge(async (calls) => {
    const outcome = await runTool('ws', { name: 'run_command', args: { command: 'rm -rf src' } });
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1);
    const [, command, notice] = calls[0] as [string, string, string | undefined];
    assert.equal(command, 'rm -rf src');
    assert.equal(typeof notice, 'string');
    assert.notEqual(notice, '');
    assert.equal(notice, commandApprovalNotice('rm -rf src'));
  });
});

test('a command the guard does not flag travels with no notice', async () => {
  await withBridge(async (calls) => {
    await runTool('ws', { name: 'run_command', args: { command: 'npm test' } });
    assert.equal(calls[0][2], undefined);
    assert.equal(commandApprovalNotice('npm test'), undefined);
  });
});
