import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOOL_DEFINITIONS,
  availableToolNames,
  describeTools,
  isKnownTool,
  nativeToolDefinitions,
  summarizeCall
} from './tools';

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
