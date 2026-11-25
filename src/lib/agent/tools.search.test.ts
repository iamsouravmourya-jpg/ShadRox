import assert from 'node:assert/strict';
import test from 'node:test';

import { runTool } from './tools';

function withBridge(stub: Record<string, unknown>, body: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { shadroxDesktop: stub }, configurable: true, writable: true });
  return body().finally(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
}

const empty = { matches: [], truncated: false, filesScanned: 0 };
const hit = (path: string, line: number, preview: string) => ({ path, line, column: 1, preview });

const PARAPHRASE = 'copyright 2026 ;ermexai techno pvt ltd all right reservd';
const FOOTER = 'src/components/Footer.tsx';

function paraphraseBridge(calls: string[]) {
  const byToken: Record<string, ReturnType<typeof hit>[]> = {
    '2026': [hit(FOOTER, 88, '© 2026 LernexAI Technologies Pvt. Ltd. All rights reserved.')],
    copyright: [hit('LICENSE', 1, 'copyright notice')],
    techno: [hit(FOOTER, 88, 'LernexAI Technologies Pvt. Ltd.')],
    right: [hit(FOOTER, 88, 'All rights reserved.')],
    reservd: [],
    ermexai: []
  };
  return {
    searchContent: async (_id: string, options: { query: string }) => {
      calls.push(options.query);
      if (options.query === PARAPHRASE) return empty;
      return { ...empty, matches: byToken[options.query] ?? [] };
    }
  };
}

test('a paraphrased full-phrase miss falls back to ranked partial word matches', async () => {
  const calls: string[] = [];
  await withBridge(paraphraseBridge(calls), async () => {
    const outcome = await runTool('ws', { name: 'search_text', args: { query: PARAPHRASE } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /No exact match for the full phrase/);
    assert.match(outcome.content, /src\/components\/Footer\.tsx · 3\/6 query words/);
    assert.ok(
      outcome.content.indexOf(FOOTER) < outcome.content.indexOf('LICENSE'),
      'the file hitting more query words ranks first'
    );
    assert.match(outcome.content, /do not report the text as absent/);
  });
  assert.equal(calls[0], PARAPHRASE, 'the exact phrase is tried first');
  assert.ok(calls.includes('2026') && calls.includes('copyright'), 'distinctive words are retried');
  assert.ok(!calls.includes('all') && !calls.includes('the'), 'function words are not searched');
});

test('a regex miss stays a miss: no token fallback rewrote the pattern', async () => {
  const calls: string[] = [];
  await withBridge(paraphraseBridge(calls), async () => {
    const outcome = await runTool('ws', { name: 'search_text', args: { query: PARAPHRASE, regex: true } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /No text matches/);
  });
  assert.deepEqual(calls, [PARAPHRASE]);
});

test('a single-word miss reports absence with a retry hint, not a fallback', async () => {
  const calls: string[] = [];
  await withBridge(paraphraseBridge(calls), async () => {
    const outcome = await runTool('ws', { name: 'search_text', args: { query: 'zzznotthere' } });
    assert.equal(outcome.ok, true);
    assert.match(outcome.content, /No text matches/);
    assert.match(outcome.content, /1-3 distinctive words/);
  });
  assert.deepEqual(calls, ['zzznotthere']);
});

test('read_file shows env secret presence, never the secret value', async () => {
  const content = 'OPENAI_API_KEY=sk-live-abc123\nPORT=3000\nEMPTY_TOKEN=\n';
  await withBridge(
    { readFile: async () => ({ name: '.env', content, version: 'v1' }) },
    async () => {
      const outcome = await runTool('ws', { name: 'read_file', args: { path: '.env' } });
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /OPENAI_API_KEY=<set>/);
      assert.match(outcome.content, /EMPTY_TOKEN=<empty>/);
      assert.match(outcome.content, /PORT=3000/, 'non-secret config stays readable');
      assert.ok(!outcome.content.includes('sk-live-abc123'));
    }
  );
  await withBridge(
    { readFile: async () => ({ name: 'notes.txt', content, version: 'v1' }) },
    async () => {
      const outcome = await runTool('ws', { name: 'read_file', args: { path: 'notes.txt' } });
      assert.ok(outcome.content.includes('sk-live-abc123'), 'masking applies to env files only');
    }
  );
});

test('preview_control stop halts the preview and start reports the ready url', async () => {
  const stopped: string[] = [];
  await withBridge(
    {
      stopPreview: async (id: string) => {
        stopped.push(id);
        return true;
      },
      startPreview: async () => ({ status: 'ready', url: 'http://127.0.0.1:3000', script: 'dev', hmr: true })
    },
    async () => {
      const stop = await runTool('ws', { name: 'preview_control', args: { action: 'stop' } });
      assert.equal(stop.ok, true);
      assert.match(stop.content, /Preview stopped/);
      const restart = await runTool('ws', { name: 'preview_control', args: { action: 'restart' } });
      assert.equal(restart.ok, true);
      assert.match(restart.content, /http:\/\/127\.0\.0\.1:3000/);
    }
  );
  assert.deepEqual(stopped, ['ws', 'ws'], 'restart stops before starting');
});

test('preview_control refuses a cancelled consent instead of claiming a running preview', async () => {
  await withBridge(
    {
      stopPreview: async () => true,
      startPreview: async () => ({ status: 'approval-required', approval: { projectPath: '.', manifestHash: 'h' } })
    },
    async () => {
      const outcome = await runTool('ws', { name: 'preview_control', args: { action: 'start' } });
      assert.equal(outcome.ok, false);
      assert.equal(outcome.refused, true);
      assert.match(outcome.content, /consent dialog/);
      const bad = await runTool('ws', { name: 'preview_control', args: { action: 'explode' } });
      assert.equal(bad.refused, true);
    }
  );
});

test('preview_control status reports URL, port, recent logs, and runtime error verdict without mutating', async () => {
  await withBridge(
    {
      getPreviewStatus: async () => ({
        status: 'ready',
        url: 'http://127.0.0.1:5173/',
        port: 5173,
        script: 'dev',
        hmr: true,
        lastError: null,
        recentOutput: 'VITE v6.0.0 ready in 120 ms'
      }),
      assertPreview: async () => ({ ok: false, errorCount: 1, detail: 'Uncaught ReferenceError: foo is not defined' })
    },
    async () => {
      const outcome = await runTool('ws', { name: 'preview_control', args: { action: 'status' } });
      assert.equal(outcome.ok, true);
      assert.match(outcome.content, /status: ready/);
      assert.match(outcome.content, /port: 5173/);
      assert.match(outcome.content, /hmr: on/);
      assert.match(outcome.content, /VITE v6\.0\.0 ready/);
      assert.match(outcome.content, /ReferenceError: foo is not defined/);
    }
  );
});

test('preview_control start and restart succeed when startPreview omits status or optional fields', async () => {
  await withBridge(
    {
      stopPreview: async () => true,
      startPreview: async () => ({ url: 'http://127.0.0.1:5173/', port: 5173, script: 'dev', hmr: true })
    },
    async () => {
      const start = await runTool('ws', { name: 'preview_control', args: { action: 'start' } });
      assert.equal(start.ok, true);
      assert.match(start.content, /Preview ready at http:\/\/127\.0\.0\.1:5173\//);
      assert.match(start.content, /port 5173/);
    }
  );

  await withBridge(
    {
      stopPreview: async () => true,
      startPreview: async () => ({ url: 'shadrox-preview://ws/index.html', script: 'static' })
    },
    async () => {
      const restart = await runTool('ws', { name: 'preview_control', args: { action: 'restart' } });
      assert.equal(restart.ok, true);
      assert.match(restart.content, /Preview ready at shadrox-preview:\/\/ws\/index\.html/);
      assert.match(restart.content, /script: static/);
    }
  );
});

test('preview_control start/restart/status never throw when selection projects or optional verdict fields are undefined', async () => {
  await withBridge(
    {
      stopPreview: async () => true,
      startPreview: async () => ({ status: 'selection-required', projects: undefined })
    },
    async () => {
      const start = await runTool('ws', { name: 'preview_control', args: { action: 'start' } });
      assert.equal(start.ok, false);
      assert.equal(start.error, 'preview selection required');
    }
  );

  await withBridge(
    {
      stopPreview: async () => true,
      startPreview: async () => undefined
    },
    async () => {
      const restart = await runTool('ws', { name: 'preview_control', args: { action: 'restart' } });
      assert.equal(restart.ok, false);
      assert.equal(restart.error, 'invalid preview start result');
    }
  );

  await withBridge(
    {
      getPreviewStatus: async () => ({
        status: 'starting',
        url: undefined,
        port: undefined,
        script: undefined,
        hmr: undefined,
        lastError: undefined,
        recentOutput: undefined
      }),
      assertPreview: async () => ({
        ok: false,
        status: 'fatal',
        errorCount: undefined,
        detail: undefined,
        consoleErrors: undefined,
        failedSelectors: undefined,
        warningSelectors: undefined
      })
    },
    async () => {
      const status = await runTool('ws', { name: 'preview_control', args: { action: 'status' } });
      assert.equal(status.ok, true);
      assert.match(status.content, /status: starting/);
      assert.match(status.content, /runtime verdict: 0 error\(s\)/);
    }
  );
});