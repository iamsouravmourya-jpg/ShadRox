import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_DEFINITIONS,
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

test('the tool registry holds thirty-five active tools including write, preview, and upgrade tools', () => {
  assert.equal(TOOL_DEFINITIONS.length, 35);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'debugger_state').length, 0);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'write_file').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'edit_file').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'job_control').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'preview_control').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'unlock_tools').length, 1);
  for (const name of [
    'apply_patch', 'verify', 'checkpoint', 'list_checkpoints', 'restore', 'unlock_tools',
    'memory_read', 'memory_note', 'find_references', 'go_to_definition', 'rename_symbol',
    'semantic_search', 'web_search', 'fetch_url', 'preview_inspect', 'ask_user', 'spawn_subagent', 'diff_review'
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
