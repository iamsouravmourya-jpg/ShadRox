import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTurnIntent,
  type ToolBundleCategory
} from './runPolicy';
import {
  buildWorkspaceToolContext
} from './toolGatekeeper';
import { nativeToolDefinitions } from './tools';
import { runToolRounds } from './toolLoop';
import {
  CHAT_PROMPT_CORE,
  CONVERSATIONAL_PROMPT_CORE,
  TOOL_DISCIPLINE_RULES
} from './promptDiscipline';
import {
  appendCoreSectionWithinBudget,
  dedupeAndCapDiagnostics,
  dedupeContextPaths,
  dedupeManifestData,
  dedupeWorkspaceFiles,
  filterFilesForRetrieval,
  serializeDescribeToolsCacheKey
} from '../contextDedup';
import { buildContextManifest } from '../contextManifest';
import { evictSemanticIndex } from './semanticIndex';
import { decideOrchestration } from '../orchestrate';
import { estimateTokens } from '../toolUtils';

test('conversational fast-path classifies greetings and conceptual Q&A with 0 tools and < 800 tokens', () => {
  for (const prompt of ['hi', 'hello!', 'thanks', 'how are you?', 'what is a closure?', 'namaste']) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.equal(intent.kind, 'conversational', `Expected conversational for "${prompt}"`);
    assert.equal(intent.writesFiles, false);
    assert.equal(intent.skipVerify, true);
    assert.equal(intent.enabledBundles.size, 0);

    const ctx = {
      ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx', 'package.json'], workspaceOpen: true }),
      turnIntent: intent.kind,
      enabledBundles: intent.enabledBundles
    };
    const tools = nativeToolDefinitions(true, ctx);
    assert.equal(tools.length, 0, `Expected 0 native tools for "${prompt}"`);
  }

  const conversationalTokens = estimateTokens(
    [...CONVERSATIONAL_PROMPT_CORE, 'Active IDE project: shadrox (TypeScript, React, Tailwind).'].join('\n')
  );
  assert.ok(conversationalTokens < 800, `Expected < 800 tokens, got ${conversationalTokens}`);

  // Baseline comparison: full 35 schemas + static rules vs new conversational & execution paths
  const allToolSchemas = nativeToolDefinitions(true);
  const legacyBaselineChars =
    JSON.stringify(allToolSchemas).length +
    [...CHAT_PROMPT_CORE, ...TOOL_DISCIPLINE_RULES].join('\n').length;
  const legacyBaselineTokens = Math.ceil(legacyBaselineChars / 4);

  const execCtx = {
    ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx', 'package.json'], workspaceOpen: true }),
    turnIntent: 'execution' as const,
    enabledBundles: new Set<ToolBundleCategory>(['core'])
  };
  const coreTools = nativeToolDefinitions(true, execCtx);
  const executionPromptTokens = Math.ceil(
    (JSON.stringify(coreTools).length + [...CHAT_PROMPT_CORE, ...TOOL_DISCIPLINE_RULES].join('\n').length) / 4
  );

  const conversationalReduction = 1 - conversationalTokens / legacyBaselineTokens;
  const executionSchemaReduction = 1 - JSON.stringify(coreTools).length / JSON.stringify(allToolSchemas).length;

  assert.ok(conversationalReduction >= 0.9, `Expected >=90% reduction on conversational turns, got ${(conversationalReduction * 100).toFixed(1)}%`);
  assert.ok(executionSchemaReduction >= 0.55, `Expected >=55% tool schema reduction on core execution turns vs compacted 35-tool baseline, got ${(executionSchemaReduction * 100).toFixed(1)}%`);
  assert.ok(executionPromptTokens < legacyBaselineTokens);
});

test('codebase and Hinglish action prompts never misclassify as conversational', () => {
  const mustNotBeConversational = [
    { prompt: 'scan the repo', attachedFiles: [] as string[] },
    { prompt: 'explain how server.ts works', attachedFiles: [] as string[] },
    { prompt: 'make a plan to add dark mode', attachedFiles: [] as string[] },
    { prompt: 'fix button CSS', attachedFiles: [] as string[] },
    { prompt: 'hello', attachedFiles: ['src/App.tsx'] },
    { prompt: 'fix TypeError at src/App.tsx:10:2', attachedFiles: [] as string[] },
    { prompt: 'bhai is app me navbar bana de', attachedFiles: [] as string[] }
  ];

  for (const sample of mustNotBeConversational) {
    const intent = classifyTurnIntent({
      prompt: sample.prompt,
      attachedFiles: sample.attachedFiles,
      workspaceOpen: true
    });
    assert.notEqual(
      intent.kind,
      'conversational',
      `Prompt "${sample.prompt}" must not misclassify as conversational`
    );
  }
});

test('advisory intent enforces strict read-only tools even if mutating bundles are unlocked', () => {
  for (const prompt of [
    'explain how server.ts works',
    'make a plan to add dark mode',
    'review App.tsx without editing',
    'scan the repo'
  ]) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.equal(intent.kind, 'advisory', `Expected advisory for "${prompt}"`);
    assert.equal(intent.writesFiles, false);
    assert.equal(intent.skipVerify, true);

    const ctx = {
      ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx', 'server.ts'], workspaceOpen: true }),
      turnIntent: intent.kind,
      enabledBundles: intent.enabledBundles,
      unlockedBundles: new Set<ToolBundleCategory>(['delete', 'git', 'apply_patch']),
      isReadOnlyTurn: true
    };
    const tools = nativeToolDefinitions(true, ctx).map((t) => t.name);
    assert.ok(tools.includes('read_file'));
    assert.ok(tools.includes('search_text'));
    for (const forbidden of ['edit_file', 'write_file', 'apply_patch', 'delete_file', 'run_command', 'verify']) {
      assert.ok(!tools.includes(forbidden), `Advisory mode must not expose ${forbidden}`);
    }
  }
});

test('Tier-1 core tools exclude specialized bundles until triggered by intent or unlock_tools', () => {
  const baseIntent = classifyTurnIntent({ prompt: 'fix header alignment in App.tsx', workspaceOpen: true });
  assert.equal(baseIntent.kind, 'execution');
  assert.ok(!baseIntent.enabledBundles.has('git'));
  assert.ok(!baseIntent.enabledBundles.has('web'));

  const coreOnlyNames = new Set(
    nativeToolDefinitions(true, {
      ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx'], workspaceOpen: true }),
      turnIntent: 'execution',
      enabledBundles: baseIntent.enabledBundles
    }).map((t) => t.name)
  );
  assert.ok(coreOnlyNames.has('read_file'));
  assert.ok(coreOnlyNames.has('edit_file'));
  assert.ok(coreOnlyNames.has('unlock_tools'));
  assert.ok(!coreOnlyNames.has('git_state'));
  assert.ok(!coreOnlyNames.has('web_search'));

  const previewIntent = classifyTurnIntent({ prompt: 'fix preview white screen on /dashboard', workspaceOpen: true });
  assert.ok(previewIntent.enabledBundles.has('preview'));
  const previewNames = new Set(
    nativeToolDefinitions(true, {
      ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx'], workspaceOpen: true, previewStatus: 'ready' }),
      turnIntent: 'execution',
      enabledBundles: previewIntent.enabledBundles
    }).map((t) => t.name)
  );
  assert.ok(previewNames.has('preview_control'));
  assert.ok(previewNames.has('preview_inspect'));
  assert.ok(!previewNames.has('git_state'));
});

test('unlock_tools mid-loop immediately expands available native tools for the next round', async () => {
  const unlocked = new Set<ToolBundleCategory>();
  const seenToolsPerRound: string[][] = [];
  let roundCounter = 0;

  const loop = await runToolRounds({
    messages: [{ role: 'user', content: 'inspect git status and finish' }],
    workspaceId: 'ws-test',
    maxRounds: 4,
    aborted: () => false,
    policy: { mode: 'agent' },
    onUnlockTools: (bundles) => {
      for (const b of bundles) unlocked.add(b);
    },
    stream: async (_messages, round) => {
      const ctx = {
        ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx'], workspaceOpen: true }),
        turnIntent: 'execution' as const,
        enabledBundles: new Set<ToolBundleCategory>(['core']),
        unlockedBundles: unlocked
      };
      const names = nativeToolDefinitions(true, ctx).map((t) => t.name);
      seenToolsPerRound.push(names);
      roundCounter = round;
      if (round === 0) {
        return {
          text: '```shadrox:tools\n[{"name":"unlock_tools","args":{"categories":["git","web"]}}]\n```',
          error: null
        };
      }
      return {
        text: 'Unlocked tools and ready.',
        error: null
      };
    }
  });

  assert.equal(loop.error, null);
  assert.equal(roundCounter, 1);
  assert.ok(!seenToolsPerRound[0].includes('git_state'), 'Round 0 should not have git_state before unlock');
  assert.ok(seenToolsPerRound[1].includes('git_state'), 'Round 1 should immediately expose git_state');
  assert.ok(seenToolsPerRound[1].includes('web_search'), 'Round 1 should immediately expose web_search');
});

test('decideOrchestration does not escalate advisory or conversational turns to autonomy', () => {
  const advisory = decideOrchestration({
    prompt: 'make a plan to refactor src/App.tsx, server.ts, and routes.ts',
    mode: 'code',
    permissionMode: 'agent',
    workspaceFileCount: 120,
    hasKey: true,
    canRun: true,
    busy: false
  });
  assert.equal(advisory.kind, 'chat');

  const greeting = decideOrchestration({
    prompt: 'hi',
    mode: 'code',
    permissionMode: 'agent',
    workspaceFileCount: 120,
    hasKey: true,
    canRun: true,
    busy: false
  });
  assert.equal(greeting.kind, 'chat');
});

test('contextDedup deduplicates diagnostics with (xN) counts, caps at 5, and avoids duplicate file retrieval', () => {
  const raw = [
    '[Route: /] TypeError: Cannot read properties of undefined',
    '[Route: /] TypeError: Cannot read properties of undefined',
    '[Route: /] TypeError: Cannot read properties of undefined',
    'err 2',
    'err 3',
    'err 4',
    'err 5',
    'err 6',
    'err 7'
  ].join('\n');
  const deduped = dedupeAndCapDiagnostics(raw, 5);
  assert.ok(deduped.includes('(x3)'));
  assert.ok(deduped.includes('(+2 more unique runtime/diagnostic errors omitted)'));

  const files = dedupeWorkspaceFiles([
    { name: './src/App.tsx', content: 'buffered first copy', language: 'typescript' },
    { name: 'src\\App.tsx', content: 'disk second copy', language: 'typescript' },
    { name: 'src/main.tsx', content: 'main', language: 'typescript' }
  ]);
  assert.equal(files.length, 2);
  assert.equal(files.find((f) => f.name.endsWith('App.tsx'))?.content, 'buffered first copy');

  const forRetrieval = filterFilesForRetrieval(files, new Set(['src/app.tsx']));
  assert.equal(forRetrieval.length, 1);
  assert.equal(forRetrieval[0].name, 'src/main.tsx');
});

test('static prompt rules include inline SVG logo discipline', () => {
  const staticPrompt = TOOL_DISCIPLINE_RULES.join('\n');
  assert.match(staticPrompt, /LOGO & VISUAL ASSETS/i);
  assert.match(staticPrompt, /<svg[^>]*>/i);
  assert.match(staticPrompt, /viewBox/i);
});

test('contextDedup serializes deterministic describeTools keys, deduplicates manifests, and bounds core sections', () => {
  const ctxA = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['src/App.tsx'],
    enabledBundles: new Set(['git', 'core']),
    unlockedBundles: new Set(['web', 'memory'])
  });
  const ctxB = buildWorkspaceToolContext({
    workspaceOpen: true,
    filePaths: ['src/App.tsx', 'src/other.ts'],
    enabledBundles: new Set(['core', 'git']),
    unlockedBundles: new Set(['memory', 'web'])
  });
  assert.equal(
    serializeDescribeToolsCacheKey(10, [], [], ctxA),
    serializeDescribeToolsCacheKey(10, [], [], ctxB)
  );
  const ctxChanged = { ...ctxA, previewActive: true };
  assert.notEqual(
    serializeDescribeToolsCacheKey(10, [], [], ctxA),
    serializeDescribeToolsCacheKey(10, [], [], ctxChanged)
  );

  const dedupedPaths = dedupeContextPaths(['./src/App.tsx', 'src\\App.tsx', 'src/main.tsx']);
  assert.deepEqual(dedupedPaths, ['./src/App.tsx', 'src/main.tsx']);

  const core: string[] = ['base section'];
  let chars = 'base section'.length;
  chars = appendCoreSectionWithinBudget(core, chars, ['a'.repeat(500)], 900);
  assert.equal(core.length, 2);
  const beforeOverflow = chars;
  chars = appendCoreSectionWithinBudget(core, chars, ['b'.repeat(800)], 900);
  assert.ok(chars <= 900);
  assert.ok(chars >= beforeOverflow);

  const manifestInput = dedupeManifestData({
    selectedSymbols: [{ name: 'App', file: 'src/App.tsx', line: 4 }],
    selectedFiles: ['src/App.tsx', 'src/utils.ts'],
    workspaceFiles: [
      { name: 'src/App.tsx', content: 'export const App = () => null;', language: 'typescript' },
      { name: 'src/utils.ts', content: 'export const util = 1;', language: 'typescript' }
    ],
    activeFile: { name: './src/App.tsx', content: 'export const App = () => null;', language: 'typescript' },
    diskFiles: [
      { name: 'src\\utils.ts', content: 'export const util = 1;', language: 'typescript' },
      { name: 'src/extra.ts', content: 'export const extra = 2;', language: 'typescript' }
    ],
    repoMap: 'src/App.tsx'
  });
  assert.deepEqual(manifestInput.resolvedPaths, ['src/App.tsx', 'src/utils.ts', 'src/extra.ts']);
  const manifest = buildContextManifest(manifestInput);
  assert.equal(manifest.sources.filter((s) => s.path.toLowerCase().includes('utils.ts')).length, 1);
  assert.equal(manifest.missing.length, 0);

  evictSemanticIndex('ws-nonexistent');
});

test('agent, parallel, subagent, and multi-directory prompts expose spawn_subagent while plain advisory stays clean', () => {
  for (const prompt of [
    'use 2 parallel subagents to inspect frontend and backend',
    'launch an agent swarm to trace auth flow',
    'update src/api/routes.ts and electron/workspace.cjs'
  ]) {
    const intent = classifyTurnIntent({ prompt, workspaceOpen: true });
    assert.ok(intent.enabledBundles.has('interaction'), `Expected interaction bundle for "${prompt}"`);
    const tools = nativeToolDefinitions(true, {
      ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx', 'electron/workspace.cjs'], workspaceOpen: true }),
      turnIntent: intent.kind,
      enabledBundles: intent.enabledBundles,
      isReadOnlyTurn: intent.kind !== 'execution'
    }).map((t) => t.name);
    assert.ok(tools.includes('spawn_subagent'), `Expected spawn_subagent to be exposed for "${prompt}"`);
  }

  const plainAdvisory = classifyTurnIntent({ prompt: 'explain the repo without editing', workspaceOpen: true });
  assert.equal(plainAdvisory.kind, 'advisory');
  assert.ok(!plainAdvisory.enabledBundles.has('interaction'));
  const advisoryTools = nativeToolDefinitions(true, {
    ...buildWorkspaceToolContext({ filePaths: ['src/App.tsx'], workspaceOpen: true }),
    turnIntent: 'advisory',
    enabledBundles: plainAdvisory.enabledBundles,
    isReadOnlyTurn: true
  }).map((t) => t.name);
  assert.ok(!advisoryTools.includes('spawn_subagent'));
});

