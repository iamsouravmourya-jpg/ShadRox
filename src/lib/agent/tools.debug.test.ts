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

test('the tool registry now holds fourteen tools including debugger_state', () => {
  assert.equal(TOOL_DEFINITIONS.length, 14);
  assert.equal(TOOL_DEFINITIONS.filter((tool) => tool.name === 'debugger_state').length, 1);
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
