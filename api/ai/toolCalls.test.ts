import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiToolCallCollector, geminiFunctionParameters, nativeToolDefinitions, rejectsNativeTools, rejectsToolCall } from './_toolCalls.js';

test('OpenAI tool call deltas are reassembled in provider index order', () => {
  const collector = new OpenAiToolCallCollector();
  collector.add([
    { index: 1, id: 'call_b', function: { name: 'read_', arguments: '{"path":' } },
    { index: 0, id: 'call_a', function: { name: 'finish', arguments: '{"summary":"done"}' } }
  ]);
  collector.add([
    { index: 1, function: { name: 'file', arguments: '"src/App.tsx"}' } }
  ]);

  assert.deepEqual(collector.values(), [
    { id: 'call_a', name: 'finish', arguments: '{"summary":"done"}' },
    { id: 'call_b', name: 'read_file', arguments: '{"path":"src/App.tsx"}' }
  ]);
});

test('incomplete OpenAI tool calls without a name are ignored', () => {
  const collector = new OpenAiToolCallCollector();
  collector.add([{ index: 0, function: { arguments: '{}' } }]);
  assert.deepEqual(collector.values(), []);
});

test('provider tool rejection is recognized for fallback', () => {
  assert.equal(rejectsNativeTools('Unknown parameter: tools'), true);
  assert.equal(rejectsNativeTools('Model does not support function_call'), true);
  assert.equal(rejectsNativeTools('Invalid API key'), false);
});

test('native tool definitions are validated before forwarding upstream', () => {
  assert.deepEqual(nativeToolDefinitions(undefined), undefined);
  assert.deepEqual(nativeToolDefinitions([{
    name: 'read_file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  }]), [{
    name: 'read_file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  }]);

  assert.throws(() => nativeToolDefinitions([{
    name: 'read file',
    description: 'Read one file.',
    parameters: { type: 'object', properties: {} }
  }]), /Invalid tool definition/);
});

test('Gemini schemas drop unsupported keys and upper-case types', () => {
  const cleaned = geminiFunctionParameters({
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path.', examples: ['a.ts'] },
      start_line: { type: 'integer', minimum: 1 },
      flags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } }
    },
    required: ['path', 'ghost'],
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema'
  });
  assert.deepEqual(cleaned, {
    type: 'OBJECT',
    properties: {
      path: { type: 'STRING', description: 'File path.' },
      start_line: { type: 'INTEGER', minimum: 1 },
      flags: { type: 'ARRAY', items: { type: 'STRING', enum: ['x', 'y'] } }
    },
    required: ['path']
  });
});

test('a no-argument Gemini tool is declared without parameters', () => {
  // Gemini 400s an OBJECT schema with empty properties, so the whole
  // parameters block must disappear rather than ship an empty object.
  assert.equal(geminiFunctionParameters({ type: 'object', properties: {}, additionalProperties: false }), undefined);
});

test('Groq tool-call validation failures are recognized for the tools-drop retry', () => {
  assert.equal(
    rejectsToolCall("Tool call validation failed: attempted to call tool 'create_file' which was not in request.tools"),
    true
  );
  assert.equal(rejectsToolCall('Rate limit reached for model llama'), false);
  assert.equal(rejectsToolCall('Invalid API key'), false);
});
