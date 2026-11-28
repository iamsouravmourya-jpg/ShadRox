import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_DEFINITIONS,
  clipToolOutput,
  describeTools,
  isKnownTool,
  nativeToolDefinitions,
  summarizeCall
} from './tools';

test('debugger_state has been removed from the active built-in tools', () => {
  assert.equal(isKnownTool('debugger_state'), false);
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'debugger_state');
  assert.equal(definition, undefined);
});

test('the tool registry holds thirty-six active tools including write, preview, and upgrade tools', () => {
  assert.equal(TOOL_DEFINITIONS.length, 36);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'debugger_state').length, 0);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'write_file').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'edit_file').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'job_control').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'preview_control').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'unlock_tools').length, 1);
  for (const name of [
    'apply_patch', 'verify', 'test_changed', 'unlock_tools',
    'memory_read', 'memory_note', 'find_references', 'go_to_definition', 'rename_symbol', 'get_dependents',
    'semantic_search', 'web_search', 'fetch_url', 'preview_inspect', 'ask_user', 'spawn_subagent', 'diff_review',
    'find_by_glob', 'git_diff'
  ]) {
    assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === name).length, 1, `${name} is registered once`);
    assert.ok(nativeToolDefinitions().some((tool) => tool.name === name), `${name} is exposed to native providers`);
  }
});

test('preview_control is exposed to native providers with an action enum', () => {
  const entry = nativeToolDefinitions().find((tool) => tool.name === 'preview_control');
  assert.ok(entry, 'a built-in without a native schema is invisible to function-calling providers');
  const schema = entry.parameters as { properties: { action: { enum: string[] } }; required: string[] };
  assert.deepEqual(schema.properties.action.enum, ['start', 'stop', 'restart', 'status']);
  assert.deepEqual(schema.required, ['action']);
});

test('preview_inspect is listed in prompt descriptions and exposed to native providers', () => {
  const prompt = describeTools(3).join('\n');
  assert.match(prompt, /preview_inspect/);
  assert.doesNotMatch(prompt, /debugger_state/);
  assert.ok(nativeToolDefinitions().some((tool) => tool.name === 'preview_inspect'));
});

test('summarizeCall labels a verify call without inventing arguments', () => {
  assert.equal(summarizeCall({ name: 'verify', args: {} }), 'verify');
});

test('describeTools states that installs require a native approval dialog', () => {
  const prompt = describeTools(3).join('\n');
  assert.match(prompt, /installs \(npm install included\).*native approval dialog/i);
  assert.doesNotMatch(prompt, /reads, builds\/tests and installs.*run automatically/i);
});

test('clipToolOutput keeps both head and tail around an explicit truncation marker', () => {
  const head = 'HEAD_START_' + 'a'.repeat(400);
  const middle = '_MIDDLE_'.repeat(300);
  const tail = 'b'.repeat(400) + '_TAIL_END';
  const clipped = clipToolOutput(head + middle + tail, 900);
  assert.ok(clipped.length <= 900, `Expected clipped length <= 900, got ${clipped.length}`);
  assert.ok(clipped.startsWith('HEAD_START_'), 'Head of tool output must survive');
  assert.ok(clipped.endsWith('_TAIL_END'), 'Tail of tool output must survive');
  assert.ok(clipped.includes('output cut at 900 characters'), 'Should preserve output cut marker');
  assert.ok(clipped.includes('[truncated'), 'Should include truncated marker');
});
