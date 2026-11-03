import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiToolCallCollector, nativeToolDefinitions, rejectsNativeTools } from './_toolCalls.js';

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
