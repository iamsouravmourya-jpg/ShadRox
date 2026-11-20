import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_DEFINITIONS,
  describeTools,
  isKnownTool,
  nativeToolDefinitions,
  summarizeCall
} from './tools';

test('debugger_state is a known built-in tool', () => {
  assert.equal(isKnownTool('debugger_state'), true);
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'debugger_state');
  assert.ok(definition);
  assert.match(definition.description, /paused/i);
  assert.match(definition.description, /read-only/i);
  assert.equal(definition.parameters, 'none');
});

test('the tool registry holds thirty-five tools including the write tools, job_control, preview_control and the upgrade tools', () => {
  assert.equal(TOOL_DEFINITIONS.length, 35);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'debugger_state').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'write_file').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'edit_file').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'job_control').length, 1);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'preview_control').length, 1);
  for (const name of [
    'apply_patch', 'verify', 'checkpoint', 'list_checkpoints', 'restore',
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

test('debugger_state has an empty native schema and is exposed to providers', () => {
  const native = nativeToolDefinitions();
  const entry = native.find((tool) => tool.name === 'debugger_state');
  assert.ok(entry);
  assert.deepEqual(entry.parameters, { type: 'object', properties: {}, additionalProperties: false });
});

test('the prompt teaches the debugger rule and lists the tool', () => {
  const prompt = describeTools(3).join('\n');
  assert.match(prompt, /DEBUGGER: debugger_state reads a session paused/);
  assert.match(prompt, /- debugger_state\(none\)/);
});

test('summarizeCall labels a debugger_state call without inventing arguments', () => {
  assert.equal(summarizeCall({ name: 'debugger_state', args: {} }), 'debugger_state');
});
