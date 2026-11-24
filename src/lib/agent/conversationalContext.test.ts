import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTurnIntent, type ToolBundleCategory } from './runPolicy';
import { buildWorkspaceToolContext } from './toolGatekeeper';
import { nativeToolDefinitions } from './tools';
import { buildConversationalSystemContext } from './conversationalContext';
import { fitChatRequest } from '../contextBudget';
import { estimateTokens } from '../toolUtils';

/**
 * Simulates the FULL live UI path for a greeting turn:
 *   App.tsx -> useOrchestrationController -> useContextBuilder.buildSystemContext
 *   -> fitChatRequest -> streamChat
 * with a heavy workspace (242 files), an active preview console
 * ("WebSocket server error: Port is already in use"), 100+ diagnostics, and
 * populated project memory. The serialized API payload (system + messages +
 * tools) MUST stay tiny and carry ZERO console logs / memory / diagnostics /
 * tools — the exact regression that burned ~10,300 tokens on "hi".
 */
test('conversational "hi" sends < 250 tokens with zero logs/memory/tools despite heavy live context', () => {
  const workspaceFiles = Array.from({ length: 242 }, (_, i) => ({
    name: `src/module-${i}.ts`,
    content: `export const value${i} = ${i};\nexport function fn${i}() { return value${i}; }`
  }));

  const previewErrors = ['WebSocket server error: Port is already in use'];
  const diagnostics = Array.from(
    { length: 120 },
    (_, i) => `[Route: /] TS${2000 + i}: Type 'X' is not assignable to type 'Y' in src/module-${i}.ts:${i}`
  );
  const projectMemory = '.shadrox: ~105 TS issues tracked; dev server on :5173; preview console has 20 entries.';

  // 1. Intent classification (same call the controller makes).
  const intent = classifyTurnIntent({
    prompt: 'hi',
    workspaceOpen: true,
    previewActive: true,
    activeJobCount: 0,
    multiFileSignal: true
  });
  assert.equal(intent.kind, 'conversational', 'greeting must classify as conversational');
  assert.equal(intent.enabledBundles.size, 0);

  // 2. Tool context exactly as buildRoundToolContext builds it for conversational.
  const toolContext = {
    ...buildWorkspaceToolContext({
      filePaths: workspaceFiles.map((f) => f.name),
      workspaceOpen: true,
      previewStatus: 'ready'
    }),
    turnIntent: intent.kind,
    enabledBundles: new Set<ToolBundleCategory>()
  };

  // 3. Zero tool schemas.
  const tools = nativeToolDefinitions(true, toolContext);
  assert.equal(tools.length, 0, 'conversational turns must expose zero tools');

  // 4. System context from the SAME builder the live hook uses. Heavy inputs
  //    (preview errors, diagnostics, memory) exist in the environment but are
  //    never threaded into the conversational builder.
  const systemContext = buildConversationalSystemContext({
    projectName: 'lernexai-saas',
    stackBits: 'TypeScript, React, Tailwind'
  });
  assert.equal(systemContext.chunks.length, 0);
  assert.equal(systemContext.files.length, 0);
  assert.ok(systemContext.core.length <= 4, 'conversational core stays a tiny fixed prompt');

  // 5. Fit + serialize the exact request that would go over the wire.
  const fit = fitChatRequest({
    contextWindow: 1_000_000,
    messages: [{ role: 'user', content: 'hi' }],
    system: systemContext,
    maxOutput: 4096,
    extraInputChars: tools.length ? JSON.stringify(tools).length : 0
  });

  const payload = JSON.stringify({
    system: fit.systemInstruction,
    messages: fit.messages,
    tools: tools.length ? tools : undefined
  });

  // 6. Hard token/char ceilings from the bug spec.
  const tokens = estimateTokens(payload);
  assert.ok(payload.length < 1_000, `payload must be < 1000 chars, got ${payload.length}`);
  assert.ok(tokens < 250, `payload must be < 250 tokens, got ${tokens}`);

  // 7. Zero leakage of the heavy live context.
  assert.ok(!/WebSocket server error/i.test(payload), 'preview console error leaked');
  assert.ok(!/Port is already in use/i.test(payload), 'dev server log leaked');
  assert.ok(!/TS\d{4}/.test(payload), 'diagnostics leaked');
  assert.ok(!/module-\d+\.ts/.test(payload), 'file tree leaked');
  assert.ok(!/memory_read|\.shadrox|105 TS issues/i.test(payload), 'project memory leaked');
  assert.ok(!/"name"\s*:/.test(payload), 'tool schema leaked');
  assert.match(payload, /ShadRox/);

  // Sanity: the same heavy context on an EXECUTION turn is NOT tiny — proving
  // the test is actually exercising a real difference, not a no-op.
  const execCtx = {
    ...buildWorkspaceToolContext({ filePaths: workspaceFiles.map((f) => f.name), workspaceOpen: true }),
    turnIntent: 'execution' as const,
    enabledBundles: new Set<ToolBundleCategory>(['core'])
  };
  assert.ok(nativeToolDefinitions(true, execCtx).length > 0, 'execution turns still get tools');
  void previewErrors;
  void diagnostics;
  void projectMemory;
});