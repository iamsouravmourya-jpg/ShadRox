import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALWAYS_ON_TOOL_NAMES,
  buildWorkspaceToolContext,
  hasPreviewableFiles,
  isToolEnabledInContext,
  resolveActiveTools
} from './toolGatekeeper';
import { describeTools, nativeToolDefinitions } from './tools';

test('idle workspace context strips preview_inspect, job_control, terminal_answer, and removed checkpoint tools', () => {
  const idleContext = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['README.md'],
    previewStatus: 'idle',
    activeJobCount: 0,
    terminalAwaitingInput: false,
    hasActiveTerminal: false
  });

  const defs = nativeToolDefinitions(true, idleContext);
  const names = new Set(defs.map((d) => d.name));

  for (const baseTool of ALWAYS_ON_TOOL_NAMES) {
    assert.ok(names.has(baseTool), `always-on tool ${baseTool} remains active`);
  }
  assert.equal(names.has('preview_inspect'), false);
  assert.equal(names.has('preview_control'), false);
  assert.equal(names.has('job_control'), false);
  assert.equal(names.has('terminal_state'), false);
  assert.equal(names.has('terminal_answer'), false);
  assert.equal(names.has('list_checkpoints'), false);
  assert.equal(names.has('restore'), false);
  assert.equal(names.has('checkpoint'), false);

  const promptSection = describeTools(10, [], [], idleContext).join('\n');
  assert.equal(promptSection.includes('- preview_inspect('), false);
  assert.equal(promptSection.includes('- job_control('), false);
  assert.equal(promptSection.includes('JOBS:'), false);
  assert.equal(promptSection.includes('CHECKPOINTS:'), false);
});

test('active preview + jobs + awaiting terminal unlock gated tools without checkpoint tools', () => {
  const activeContext = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['src/index.ts', 'package.json'],
    previewStatus: 'ready',
    activeJobCount: 2,
    terminalAwaitingInput: true,
    hasActiveTerminal: true
  });

  const defs = nativeToolDefinitions(true, activeContext);
  const names = new Set(defs.map((d) => d.name));

  assert.ok(names.has('preview_inspect'));
  assert.ok(names.has('preview_control'));
  assert.ok(names.has('job_control'));
  assert.ok(names.has('terminal_state'));
  assert.ok(names.has('terminal_answer'));
  assert.equal(names.has('list_checkpoints'), false);
  assert.equal(names.has('restore'), false);
  assert.equal(names.has('checkpoint'), false);

  const promptSection = describeTools(10, [], [], activeContext).join('\n');
  assert.ok(promptSection.includes('preview_inspect'));
  assert.ok(promptSection.includes('job_control'));
});

test('workspace with no folder open keeps only web_search, fetch_url, update_tasks, and finish', () => {
  const noWorkspace = buildWorkspaceToolContext({ workspaceOpen: false });
  assert.equal(isToolEnabledInContext('read_file', noWorkspace), false);
  assert.equal(isToolEnabledInContext('web_search', noWorkspace), true);
  assert.equal(isToolEnabledInContext('fetch_url', noWorkspace), true);
  assert.equal(isToolEnabledInContext('finish', noWorkspace), true);
  const filtered = resolveActiveTools(noWorkspace, [
    { name: 'read_file' },
    { name: 'web_search' },
    { name: 'finish' }
  ]);
  assert.deepEqual(
    filtered.map((t) => t.name),
    ['web_search', 'finish']
  );
});

test('hasPreviewableFiles detects previewable project entry files cleanly', () => {
  assert.equal(hasPreviewableFiles(['README.md']), false);
  assert.equal(hasPreviewableFiles(['package.json']), true);
});

test('verify tool is gated off on read-only or zero-write turns while problems remains available', () => {
  const readOnlyCtx = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['src/App.tsx', 'package.json'],
    isReadOnlyTurn: true
  });
  const zeroWriteCtx = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['src/App.tsx', 'package.json'],
    touchedFiles: []
  });
  const mutatedCtx = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['src/App.tsx', 'package.json'],
    hasMutatedFiles: true,
    touchedFiles: ['src/App.tsx']
  });

  assert.equal(isToolEnabledInContext('verify', readOnlyCtx), false);
  assert.equal(isToolEnabledInContext('problems', readOnlyCtx), true);
  assert.equal(isToolEnabledInContext('verify', zeroWriteCtx), false);
  assert.equal(isToolEnabledInContext('verify', mutatedCtx), true);

  const readOnlyPrompt = describeTools(10, [], [], readOnlyCtx).join('\n');
  assert.equal(readOnlyPrompt.includes('VERIFY: after changing files'), false);
  assert.match(readOnlyPrompt, /use problems .* instead of verify/i);
  assert.equal(
    nativeToolDefinitions(true, readOnlyCtx).some((tool) => tool.name === 'verify'),
    false
  );
  assert.equal(
    nativeToolDefinitions(true, mutatedCtx).some((tool) => tool.name === 'verify'),
    true
  );
});

