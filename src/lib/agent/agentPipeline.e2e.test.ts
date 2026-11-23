import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decideOrchestration } from '../orchestrate';
import type { ChatTurn } from '../ai';
import type {
  DesktopCommandResult,
  DesktopDiagnostic,
  DesktopPreviewOutput,
  DesktopPreviewStatus,
  DiagnosticsResult,
  ShadRoxDesktopAPI
} from '../desktop';
import { filterLogsForLatestPreviewRun } from '../../hooks/useLocalPreviewController';
import type { PreviewInspectResponse } from './webTools';
import { runToolRounds } from './toolLoop';
import { resetToolTurnTracking, runTool } from './tools';
import { resetTurns } from './turnState';

const require = createRequire(import.meta.url);
const { createPreviewRuntime } = require('../../../electron/preview-runtime.cjs') as {
  createPreviewRuntime: (opts?: Record<string, unknown>) => {
    startStatic: (workspaceId: string, root: string) => Promise<{ url: string; script: string }>;
    stop: (workspaceId: string) => Promise<boolean>;
    stopAll: () => Promise<unknown>;
    getStatus: (workspaceId: string) => DesktopPreviewStatus;
  };
};

const fence = (body: string) => '```shadrox:tools\n' + body + '\n```';
const toolBlock = (calls: unknown) => fence(JSON.stringify(calls));

function withBridge(stub: Partial<ShadRoxDesktopAPI> & Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    value: { shadroxDesktop: stub },
    configurable: true,
    writable: true
  });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

async function withTempWorkspace(body: (rootDir: string) => Promise<void>) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shadrox-e2e-'));
  try {
    await body(rootDir);
  } finally {
    resetTurns();
    resetToolTurnTracking();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

interface DiskBridgeOptions {
  onRunCommand?: (command: string) => Promise<DesktopCommandResult>;
  onDiagnostics?: (paths?: string[]) => Promise<DesktopDiagnostic[]>;
  onPreviewStatus?: () => Promise<DesktopPreviewStatus>;
  onPreviewInspect?: (action: string) => Promise<PreviewInspectResponse>;
}

/** Creates a real temp-filesystem desktop bridge so agent tools read and write actual files on disk. */
function createDiskDesktopBridge(rootDir: string, options: DiskBridgeOptions = {}) {
  const savedLog: Array<{ name: string; content: string }> = [];
  const versions = new Map<string, number>();

  const resolveSafe = (rel: string): string => {
    const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    const full = path.resolve(rootDir, clean);
    if (full !== rootDir && !full.startsWith(`${rootDir}${path.sep}`)) {
      throw new Error(`Path escapes workspace: ${rel}`);
    }
    return full;
  };

  const nextVersion = (rel: string): string => {
    const v = (versions.get(rel) ?? 0) + 1;
    versions.set(rel, v);
    return `v${v}-${rel}`;
  };

  const bridge: Partial<ShadRoxDesktopAPI> & Record<string, unknown> = {
    platform: 'win32',
    listDirectory: async (_wsId: string, subPath = '') => {
      const target = subPath ? resolveSafe(subPath) : rootDir;
      const entries = await fs.readdir(target, { withFileTypes: true });
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          path: subPath ? `${subPath}/${entry.name}` : entry.name,
          kind: entry.isDirectory() ? 'directory' : 'file',
          size: 0
        })),
        nextCursor: null
      };
    },
    readFile: async (_wsId: string, rel: string) => {
      const full = resolveSafe(rel);
      const content = await fs.readFile(full, 'utf8');
      const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
      const version = `v${versions.get(clean) ?? 0}-${clean}`;
      return { name: clean, content, version };
    },
    verifyChangeSet: async (_wsId: string, files: Array<{ path: string; content: string }>) => ({
      ok: true,
      checked: files.length,
      issues: [],
      skipped: []
    }),
    saveFiles: async (_wsId: string, writes: Array<{ name: string; content: string; expectedVersion?: string | null }>) => {
      const saved: string[] = [];
      for (const write of writes) {
        const clean = write.name.replace(/\\/g, '/').replace(/^\.\//, '');
        const full = resolveSafe(clean);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, write.content, 'utf8');
        nextVersion(clean);
        saved.push(clean);
        savedLog.push({ name: clean, content: write.content });
      }
      return { saved, errors: [] };
    },
    diagnostics: async (_wsId: string, _overrides?: unknown, paths?: string[]): Promise<DiagnosticsResult> => {
      const list = options.onDiagnostics ? await options.onDiagnostics(paths) : [];
      return { diagnostics: list, truncated: false, projectFiles: 2, configPath: 'tsconfig.json' };
    },
    runCommand: async (_wsId: string, command: string): Promise<DesktopCommandResult> => {
      if (options.onRunCommand) return options.onRunCommand(command);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    getPreviewStatus: async (_wsId: string): Promise<DesktopPreviewStatus> => {
      if (options.onPreviewStatus) return options.onPreviewStatus();
      return {
        running: true,
        status: 'ready',
        url: 'http://127.0.0.1:4173/',
        port: 4173,
        script: 'dev',
        hmr: true,
        lastError: null,
        recentOutput: ''
      };
    },
    previewInspect: async (_wsId: string, req: { action: string }): Promise<PreviewInspectResponse> => {
      if (options.onPreviewInspect) return options.onPreviewInspect(req.action);
      return { ok: true, logs: [], previewRunId: 1 };
    }
  };

  return { bridge, savedLog };
}

function scriptedModel(responses: string[]) {
  const seenTranscripts: ChatTurn[][] = [];
  let idx = 0;
  return {
    seenTranscripts,
    stream: async (messages: ChatTurn[]) => {
      seenTranscripts.push(messages.map((m) => ({ ...m })));
      const text = responses[Math.min(idx, responses.length - 1)];
      idx += 1;
      return { text, error: null };
    }
  };
}

test('E2E 1: Simple UI Edit stays in Agent single-loop (no unwanted Specialist Team escalation) and recovers from blank post-tool reply', async () => {
  // Routing check: Agent mode NEVER auto-escalates to Specialist Team even with multi-team keywords
  const agentDecision = decideOrchestration({
    prompt: 'Fix the full-stack UI button team layout across frontend and backend',
    mode: 'code',
    permissionMode: 'agent',
    workspaceFileCount: 5,
    hasKey: true,
    canRun: true,
    busy: false
  });
  assert.equal(agentDecision.kind, 'chat');

  // Team mode ONLY runs when explicitly selected by user
  const teamDecision = decideOrchestration({
    prompt: 'Update button styling across the primary navigation and settings views',
    mode: 'code',
    permissionMode: 'team',
    workspaceFileCount: 5,
    hasKey: true,
    canRun: true,
    busy: false
  });
  assert.equal(teamDecision.kind, 'team');

  await withTempWorkspace(async (rootDir) => {
    await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ name: 'ui-app', scripts: { typecheck: 'tsc --noEmit' } }),
      'utf8'
    );
    await fs.writeFile(
      path.join(rootDir, 'src/Button.tsx'),
      'export function Button() {\n  return <button className="btn-old">Save</button>;\n}\n',
      'utf8'
    );

    const { bridge } = createDiskDesktopBridge(rootDir);
    const model = scriptedModel([
      toolBlock([{ name: 'read_file', args: { path: 'src/Button.tsx' } }]),
      toolBlock([{
        name: 'edit_file',
        args: {
          path: 'src/Button.tsx',
          original: '  return <button className="btn-old">Save</button>;',
          updated: '  return <button className="btn-primary">Save changes</button>;'
        }
      }]),
      toolBlock([{ name: 'verify', args: {} }]),
      '', // Blank response right after tools triggers single empty-response recovery nudge
      'Updated the button label and class in src/Button.tsx and verified zero errors.'
    ]);

    await withBridge(bridge, async () => {
      const result = await runToolRounds({
        messages: [{ role: 'user', content: 'Change Button label to Save changes' }],
        workspaceId: 'ws-ui',
        aborted: () => false,
        stream: model.stream
      });

      assert.equal(result.stopReason, 'complete');
      assert.equal(result.changedFiles, 1);
      assert.deepEqual(result.changedPaths, ['src/Button.tsx']);
      assert.match(result.text, /Updated the button label/i);
      const updated = await fs.readFile(path.join(rootDir, 'src/Button.tsx'), 'utf8');
      assert.match(updated, /btn-primary/);
      assert.match(updated, /Save changes/);
    });
  });
});

test('E2E 2: Large file (>500 lines) + CRLF (\\r\\n) edit reports line metadata, supports ranged reads, and preserves 100% CRLF', async () => {
  await withTempWorkspace(async (rootDir) => {
    await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
    const lines = Array.from({ length: 550 }, (_, idx) => {
      const n = idx + 1;
      if (n === 5) return 'export const TOP_HEADER = "v1";';
      if (n === 545) return 'export const BOTTOM_FOOTER = "end-v1";';
      return `export const line_${n} = ${n};`;
    });
    const crlfContent = lines.join('\r\n') + '\r\n';
    await fs.writeFile(path.join(rootDir, 'src/LargeService.ts'), crlfContent, 'utf8');

    const { bridge } = createDiskDesktopBridge(rootDir);
    const model = scriptedModel([
      // Unranged read on >300 line file
      toolBlock([{ name: 'read_file', args: { path: 'src/LargeService.ts' } }]),
      // Targeted ranged read of bottom section (supports camelCase startLine/endLine)
      toolBlock([{ name: 'read_file', args: { path: 'src/LargeService.ts', startLine: 520, endLine: 551 } }]),
      // Edit top + bottom using standard LF inside snippets while disk uses CRLF
      toolBlock([
        {
          name: 'edit_file',
          args: {
            path: 'src/LargeService.ts',
            original: 'export const line_4 = 4;\nexport const TOP_HEADER = "v1";\nexport const line_6 = 6;',
            updated: 'export const line_4 = 4;\nexport const TOP_HEADER = "v2";\nexport const line_6 = 6;'
          }
        },
        {
          name: 'edit_file',
          args: {
            path: 'src/LargeService.ts',
            original: 'export const line_544 = 544;\nexport const BOTTOM_FOOTER = "end-v1";\nexport const line_546 = 546;',
            updated: 'export const line_544 = 544;\nexport const BOTTOM_FOOTER = "end-v2";\nexport const line_546 = 546;'
          }
        }
      ]),
      toolBlock([{ name: 'verify', args: {} }]),
      'Updated both top and bottom sections while preserving CRLF line endings.'
    ]);

    await withBridge(bridge, async () => {
      const result = await runToolRounds({
        messages: [{ role: 'user', content: 'Update TOP_HEADER and BOTTOM_FOOTER in src/LargeService.ts' }],
        workspaceId: 'ws-crlf',
        aborted: () => false,
        stream: model.stream
      });

      assert.equal(result.stopReason, 'complete');
      // Inspect observation after round 1 un-ranged read
      const afterFirstRead = model.seenTranscripts[1].map((m) => m.content).join('\n');
      assert.match(afterFirstRead, /Total lines: 551/);
      assert.match(afterFirstRead, /Showing lines 1-250/);
      assert.match(afterFirstRead, /startLine\/endLine/);

      // Inspect observation after round 2 ranged read
      const afterSecondRead = model.seenTranscripts[2].map((m) => m.content).join('\n');
      assert.match(afterSecondRead, /545\| export const BOTTOM_FOOTER/);

      // Verify on-disk contents and pure CRLF preservation (zero bare LF)
      const onDisk = await fs.readFile(path.join(rootDir, 'src/LargeService.ts'), 'utf8');
      assert.match(onDisk, /TOP_HEADER = "v2"/);
      assert.match(onDisk, /BOTTOM_FOOTER = "end-v2"/);
      assert.equal(onDisk.includes('\r\n'), true);
      const bareLf = onDisk.replace(/\r\n/g, '').includes('\n');
      assert.equal(bareLf, false, 'Expected zero bare LF characters after CRLF edit');
    });
  });
});

test('E2E 3: Edit fallback unlocks write_file after 2 failed edits, caps identical retries per turn, and scopes verify to modified files despite untouched errors & null exitCode', async () => {
  await withTempWorkspace(async (rootDir) => {
    await fs.mkdir(path.join(rootDir, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, 'package.json'),
      JSON.stringify({ name: 'repair-app', scripts: { typecheck: 'tsc --noEmit' } }),
      'utf8'
    );
    const initialTarget = Array.from({ length: 24 }, (_, idx) => `export const item_${idx} = ${idx};`).join('\n') + '\n';
    await fs.writeFile(path.join(rootDir, 'src/target.ts'), initialTarget, 'utf8');
    await fs.writeFile(path.join(rootDir, 'src/legacy-broken.ts'), 'export const bad: number = "oops";\n', 'utf8');

    const { bridge } = createDiskDesktopBridge(rootDir, {
      onRunCommand: async (cmd) => {
        if (cmd.includes('typecheck')) {
          return {
            stdout: 'src/legacy-broken.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'.\n',
            stderr: '',
            exitCode: 2
          };
        }
        // Simulate Windows shim direct exit returning null without backgrounding
        return { stdout: 'win-shim-clean', stderr: '', exitCode: null };
      },
      onDiagnostics: async () => [
        {
          file: 'src\\legacy-broken.ts',
          line: 0,
          character: 13,
          endLine: 0,
          endCharacter: 20,
          severity: 'error',
          code: 'TS2322',
          message: 'Type string is not assignable to number'
        }
      ]
    });

    const model = scriptedModel([
      // Read target first
      toolBlock([{ name: 'read_file', args: { path: '.\\src\\target.ts' } }]),
      // Attempt write_file gutting BEFORE 2 failed edits -> must fail rewrite-risk guard
      toolBlock([{ name: 'write_file', args: { path: 'src/target.ts', content: 'export const rewritten = true;\n' } }]),
      // Failed edit #1
      toolBlock([{ name: 'edit_file', args: { path: 'src/target.ts', original: 'MISSING_ONE', updated: 'x' } }]),
      // Failed edit #2 (different snippet so we hit 2 file edit failures cleanly)
      toolBlock([{ name: 'edit_file', args: { path: 'src/target.ts', original: 'MISSING_TWO', updated: 'x' } }]),
      // Identical repeat of MISSING_TWO twice more -> triggers per-turn identical retry cap at 2
      toolBlock([{ name: 'edit_file', args: { path: 'src/target.ts', original: 'MISSING_TWO', updated: 'x' } }]),
      toolBlock([{ name: 'edit_file', args: { path: 'src/target.ts', original: 'MISSING_TWO', updated: 'x' } }]),
      // Now write_file overwrite is UNLOCKED for src/target.ts
      toolBlock([{ name: 'write_file', args: { path: 'src/target.ts', content: 'export const rewritten = true;\n' } }]),
      // Verify Windows non-background exitCode === null command works cleanly too
      toolBlock([{ name: 'run_command', args: { command: 'echo ok' } }]),
      // Scoped verify must PASS because src/target.ts has zero errors and TS errors are only in untouched src/legacy-broken.ts
      toolBlock([{ name: 'verify', args: {} }]),
      'Rewrote src/target.ts after fallback and verified zero modified-file errors.'
    ]);

    await withBridge(bridge, async () => {
      const result = await runToolRounds({
        messages: [{ role: 'user', content: 'Update src/target.ts safely' }],
        workspaceId: 'ws-verify',
        aborted: () => false,
        stream: model.stream
      });

      assert.equal(result.stopReason, 'complete');
      assert.deepEqual(result.changedPaths, ['src/target.ts']);
      assert.ok(result.changedFiles >= 1);
      const transcript = model.seenTranscripts.at(-1)?.map((m) => m.content).join('\n') ?? '';
      // 1st write_file was blocked by rewrite-risk guard
      assert.match(transcript, /whole-file rewrite/);
      // 3rd identical failure triggered the 2-attempt cap
      assert.match(transcript, /already failed 2 times this turn/i);
      // After 2 edit failures, write_file succeeded
      assert.match(transcript, /write_file allowed after repeated edit_file failures/);
      // Windows exitCode === null without backgrounding completed cleanly as exit 0
      assert.match(transcript, /exit 0/);
      // Scoped verify passed while reporting untouched legacy error as warning
      assert.match(transcript, /verify: OK/i);
      assert.match(transcript, /pre-existing errors in untouched files/i);
      assert.match(transcript, /legacy-broken\.ts/);

      const finalContent = await fs.readFile(path.join(rootDir, 'src/target.ts'), 'utf8');
      assert.equal(finalContent, 'export const rewritten = true;\n');

      // Turn isolation check: a fresh turn resets failure tracking & write_file unlock
      resetToolTurnTracking('ws-verify');
      await fs.writeFile(path.join(rootDir, 'src/fresh.ts'), initialTarget, 'utf8');
      const freshAttempt = await runTool('ws-verify', {
        name: 'write_file',
        args: { path: 'src/fresh.ts', content: 'export const x = 1;\n' }
      });
      assert.equal(freshAttempt.ok, false);
      assert.match(freshAttempt.error ?? '', /whole-file rewrite/);
    });
  });
});

test('E2E 4: Preview error capture drops stale previous previewRunId logs and delivers only latest run errors', async () => {
  // 1. Unit check of useLocalPreviewController pure helper
  const mixedLogs: DesktopPreviewOutput[] = [
    { workspaceId: 'ws-p', type: 'error', message: 'STALE_CRASH_RUN_1', previewRunId: 1 },
    { workspaceId: 'ws-p', type: 'console', level: 'error', message: 'STALE_CONSOLE_RUN_1', previewRunId: 1 },
    { workspaceId: 'ws-p', type: 'status', message: 'Restarting preview...', previewRunId: 2 },
    { workspaceId: 'ws-p', type: 'console', level: 'error', message: 'CURRENT_ERROR_RUN_2', previewRunId: 2 }
  ];
  const latestOnly = filterLogsForLatestPreviewRun(mixedLogs);
  assert.equal(latestOnly.length, 2);
  assert.equal(latestOnly.some((entry) => entry.message.includes('RUN_1')), false);
  assert.equal(latestOnly.some((entry) => entry.message.includes('CURRENT_ERROR_RUN_2')), true);

  // 2. Real Electron preview-runtime static server restart cycle verifying previewRunId increments & status resets
  await withTempWorkspace(async (rootDir) => {
    await fs.writeFile(path.join(rootDir, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>', 'utf8');
    const emitted: DesktopPreviewOutput[] = [];
    const runtime = createPreviewRuntime({
      onOutput: (entry: DesktopPreviewOutput) => emitted.push(entry)
    });
    try {
      await runtime.startStatic('ws-prev', rootDir);
      const status1 = runtime.getStatus('ws-prev');
      assert.equal(status1.previewRunId, 1);

      await runtime.startStatic('ws-prev', rootDir);
      const status2 = runtime.getStatus('ws-prev');
      assert.equal(status2.previewRunId, 2);

      const latestEmitted = filterLogsForLatestPreviewRun(emitted);
      assert.ok(latestEmitted.length >= 1);
      assert.equal(latestEmitted.every((entry) => entry.previewRunId === 2), true);
    } finally {
      await runtime.stopAll();
    }

    // 3. Full agent tool loop inspecting preview status & console logs scoped to run #2
    const { bridge } = createDiskDesktopBridge(rootDir, {
      onPreviewStatus: async () => ({
        running: false,
        status: 'error',
        url: null,
        port: 4173,
        script: 'dev',
        hmr: true,
        lastError: 'Uncaught ReferenceError: latestBrokenSymbol is not defined',
        recentOutput: 'vite v5 ready\nUncaught ReferenceError: latestBrokenSymbol is not defined',
        previewRunId: 2
      }),
      onPreviewInspect: async (action) => {
        if (action === 'console') {
          return {
            ok: true,
            previewRunId: 2,
            logs: [{ level: 'error', message: 'ReferenceError: latestBrokenSymbol is not defined', timestamp: Date.now() }]
          };
        }
        return { ok: true, previewRunId: 2 };
      }
    });

    const model = scriptedModel([
      toolBlock([
        { name: 'preview_control', args: { action: 'status' } },
        { name: 'preview_inspect', args: { action: 'console' } }
      ]),
      'Detected run #2 error: latestBrokenSymbol is not defined.'
    ]);

    await withBridge(bridge, async () => {
      const result = await runToolRounds({
        messages: [{ role: 'user', content: 'Check why preview failed' }],
        workspaceId: 'ws-prev',
        aborted: () => false,
        stream: model.stream
      });
      assert.equal(result.stopReason, 'complete');
      const obsTranscript = model.seenTranscripts[1].map((m) => m.content).join('\n');
      assert.match(obsTranscript, /preview runId: 2/);
      assert.match(obsTranscript, /\(run #2\)/);
      assert.match(obsTranscript, /latestBrokenSymbol/);
      assert.doesNotMatch(obsTranscript, /STALE_/);
    });
  });
});
