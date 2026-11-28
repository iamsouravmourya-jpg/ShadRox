// ShadRox-Bench + Failure Black Box
//
// Runs a fixed set of small tasks (bench/tasks.json) against tiny fixtures
// (bench/fixtures/*), each in an isolated temp workspace, through the REAL
// agent loop (runAgentTurn). For every task it records tokens (input/output/
// cached), tool calls, rounds, latency and pass/fail, then writes:
//   bench/results/<timestamp>.json     full summary (pass rate, median/p95)
//   bench/results/failures.jsonl       one line per failed task (black box)
//
// Usage:
//   npm run bench                       # real BYOK (env keys), all tasks
//   node --import tsx scripts/bench.mjs --stub          # no key, plumbing smoke
//   node --import tsx scripts/bench.mjs --filter vite   # only vite-* tasks
//   node --import tsx scripts/bench.mjs --runs 3        # average over N runs
//
// Env (real mode):
//   SHADROX_BENCH_BASE_URL, SHADROX_BENCH_KEY, SHADROX_BENCH_MODEL

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runAgentTurn } from '../src/lib/agents/turnRunner.ts';
import { runToolRounds } from '../src/lib/agent/toolLoop.ts';
import { describeTools } from '../src/lib/agent/tools.ts';
import { extractUnifiedPatches } from '../src/lib/patchEngine.ts';
import { createByokStream } from './bench-stream.mjs';

const root = path.resolve(import.meta.dirname, '..');
const benchDir = path.join(root, 'bench');
const fixturesDir = path.join(benchDir, 'fixtures');
const resultsDir = path.join(benchDir, 'results');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}
const stub = process.argv.includes('--stub');
const filter = arg('--filter');
const runs = Math.max(1, Number(arg('--runs') ?? 1));
const maxRounds = Math.max(1, Number(arg('--rounds') ?? 12));

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const p95 = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

// A fs-backed desktop bridge over one temp workspace, so the real read/edit/
// write/search tools work without Electron.
function makeBridge(workspaceDir) {
  const resolve = (p) => {
    const abs = path.resolve(workspaceDir, String(p));
    if (abs !== workspaceDir && !abs.startsWith(workspaceDir + path.sep)) {
      throw new Error(`path escapes workspace: ${p}`);
    }
    return abs;
  };
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  };
  return {
    readFile: async (_id, p) => {
      const abs = resolve(p);
      if (!fs.existsSync(abs)) return null;
      const content = fs.readFileSync(abs, 'utf8');
      return { name: path.basename(abs), content, version: `v${hash(content)}` };
    },
    saveFiles: async (_id, files) => {
      const saved = [];
      const errors = [];
      for (const f of files) {
        try {
          const abs = resolve(f.path);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, f.content);
          saved.push(f.path);
        } catch (e) { errors.push({ path: f.path, error: String(e?.message ?? e) }); }
      }
      return { saved, errors };
    },
    listDirectory: async (_id, p) => {
      const abs = resolve(p || '.');
      if (!fs.existsSync(abs)) return [];
      return fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory()
      }));
    },
    searchContent: async (_id, opts) => {
      const q = String(opts?.query ?? '');
      const results = [];
      if (!q) return results;
      for (const file of walk(workspaceDir)) {
        const rel = path.relative(workspaceDir, file).replace(/\\/g, '/');
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
          if (line.includes(q)) {
            results.push({ path: rel, line: i + 1, column: line.indexOf(q) + 1, preview: line.trim().slice(0, 120) });
          }
        });
      }
      return results.slice(0, 200);
    },
    loadFiles: async (_id, paths) => paths.map((p) => {
      const abs = resolve(p);
      return { path: p, content: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '' };
    }),
    createDirectory: async (_id, p) => { fs.mkdirSync(resolve(p), { recursive: true }); return { ok: true }; },
    deletePath: async (_id, p) => { fs.rmSync(resolve(p), { recursive: true, force: true }); return { ok: true }; },
    getStatus: async () => ({ ready: true })
  };
}

function systemInstruction() {
  return [
    'You are a precise coding agent working inside the user\'s opened folder.',
    'Make the requested change with the fewest tool calls. Use read_file to see a file before editing, then edit_file or write_file.',
    'When done, reply with a short summary.',
    '',
    describeTools(maxRounds).join('\n')
  ].filter(Boolean).join('\n');
}

function classifyFailure(task, outcome, checkOk) {
  if (outcome.error && /provider|429|5\d\d|rate|auth|key/i.test(outcome.error)) return 'provider_error';
  if (outcome.aborted) return 'aborted';
  if (outcome.capped) return 'loop_capped';
  if (outcome.toolRounds === 0) return 'no_action';
  if (!checkOk) return 'wrong_result';
  return 'unknown';
}

async function runOne(task, provider) {
  const fixtureDir = path.join(fixturesDir, task.fixture);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `shadrox-bench-${task.id}-`));
  fs.cpSync(fixtureDir, tempDir, { recursive: true });
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const stream = stub
    ? async () => ({ text: 'I cannot make changes in stub mode.', error: null })
    : provider.stream(usage);
  const started = Date.now();
  let outcome;
  try {
    globalThis.window = { shadroxDesktop: makeBridge(tempDir), dispatchEvent: () => true };
    outcome = await runAgentTurn({
      instruction: task.prompt,
      expectedFiles: [],
      systemInstruction: systemInstruction(),
      maxToolRounds: maxRounds,
      applyPolicy: 'auto',
      checkpointBacked: true,
      policy: { mode: 'agent' },
      ports: {
        buildMessages: (instruction) => [{ role: 'user', content: instruction }],
        extractPatches: (text) => extractUnifiedPatches(text, []),
        runToolRounds,
        stream,
        readFile: async (p) => {
          const abs = path.resolve(tempDir, String(p));
          return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
        },
        workspaceId: 'bench',
        writePatches: async (patches) => {
          const applied = [];
          const failures = [];
          for (const patch of patches) {
            try {
              const abs = path.resolve(tempDir, patch.path);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, patch.content);
              applied.push(patch.path);
            } catch (e) { failures.push(`${patch.path}: ${e?.message ?? e}`); }
          }
          return { applied, failures };
        }
      }
    });
  } finally {
    delete globalThis.window;
  }
  const latencyMs = Date.now() - started;
  let checkOk = false;
  let checkError = null;
  try {
    execSync(task.check, { cwd: tempDir, stdio: 'pipe', timeout: 20000 });
    checkOk = true;
  } catch (e) {
    checkError = (e.stderr?.toString?.() ?? e.message ?? '').slice(0, 300);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  const toolCalls = outcome?.toolEvents?.length ?? 0;
  return {
    id: task.id,
    fixture: task.fixture,
    pass: checkOk,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    toolCalls,
    rounds: outcome?.toolRounds ?? 0,
    latencyMs,
    capped: outcome?.capped ?? false,
    error: outcome?.error ?? null,
    checkError,
    failureClass: checkOk ? null : classifyFailure(task, outcome ?? {}, checkOk)
  };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(benchDir, 'tasks.json'), 'utf8'));
  const tasks = config.tasks.filter((t) => !filter || t.id.includes(filter) || t.fixture.includes(filter));
  fs.mkdirSync(resultsDir, { recursive: true });

  let provider = null;
  if (!stub) {
    provider = {
      stream: (usage) => createByokStream({
        baseUrl: process.env.SHADROX_BENCH_BASE_URL,
        apiKey: process.env.SHADROX_BENCH_KEY,
        model: process.env.SHADROX_BENCH_MODEL,
        usage
      })
    };
  }

  console.log(`ShadRox-Bench: ${tasks.length} task(s), runs=${runs}, mode=${stub ? 'STUB (no key)' : 'BYOK ' + (process.env.SHADROX_BENCH_MODEL ?? '?')}, maxRounds=${maxRounds}`);
  const all = [];
  for (let r = 0; r < runs; r += 1) {
    for (const task of tasks) {
      const result = await runOne(task, provider);
      all.push(result);
      console.log(`  [${result.pass ? 'PASS' : 'FAIL'}] ${result.id} · ${result.toolCalls} tools · ${result.inputTokens}+${result.outputTokens} tok · ${result.latencyMs}ms${result.failureClass ? ' · ' + result.failureClass : ''}`);
    }
  }

  const passed = all.filter((x) => x.pass).length;
  const summary = {
    timestamp: new Date().toISOString(),
    mode: stub ? 'stub' : 'byok',
    model: process.env.SHADROX_BENCH_MODEL ?? null,
    runs,
    tasks: all.length,
    passed,
    passRate: all.length ? Number((passed / all.length).toFixed(3)) : 0,
    totals: {
      inputTokens: all.reduce((a, x) => a + x.inputTokens, 0),
      outputTokens: all.reduce((a, x) => a + x.outputTokens, 0),
      cachedInputTokens: all.reduce((a, x) => a + x.cachedInputTokens, 0),
      toolCalls: all.reduce((a, x) => a + x.toolCalls, 0)
    },
    latency: { median: median(all.map((x) => x.latencyMs)), p95: p95(all.map((x) => x.latencyMs)) },
    cacheHitRate: (() => {
      const inTok = all.reduce((a, x) => a + x.inputTokens, 0);
      const cached = all.reduce((a, x) => a + x.cachedInputTokens, 0);
      return inTok ? Number((cached / inTok).toFixed(3)) : 0;
    })(),
    tokensPerTask: {
      inputMedian: median(all.map((x) => x.inputTokens)),
      inputP95: p95(all.map((x) => x.inputTokens)),
      outputMedian: median(all.map((x) => x.outputTokens))
    },
    failureClasses: all.reduce((acc, x) => {
      if (x.failureClass) acc[x.failureClass] = (acc[x.failureClass] ?? 0) + 1;
      return acc;
    }, {}),
    results: all
  };

  const outFile = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));

  const failuresFile = path.join(resultsDir, 'failures.jsonl');
  const lines = all.filter((x) => !x.pass).map((x) => JSON.stringify({
    ts: summary.timestamp, id: x.id, fixture: x.fixture, failureClass: x.failureClass,
    model: summary.model, toolCalls: x.toolCalls, error: x.error, checkError: x.checkError
  }));
  if (lines.length) fs.appendFileSync(failuresFile, lines.join('\n') + '\n');

  console.log(`\nPASS RATE ${(summary.passRate * 100).toFixed(1)}% (${passed}/${all.length})`);
  console.log(`TOKENS  in(median/p95)=${summary.tokensPerTask.inputMedian}/${summary.tokensPerTask.inputP95}  out(median)=${summary.tokensPerTask.outputMedian}  cached=${summary.totals.cachedInputTokens}  cacheHit=${(summary.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`LATENCY median=${summary.latency.median}ms p95=${summary.latency.p95}ms`);
  console.log(`FAILURES ${JSON.stringify(summary.failureClasses)}`);
  console.log(`REPORT  ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });