const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// main.cjs boots Electron when required, so the command engine and its quoting
// helpers are extracted from source and evaluated as the pure functions they
// are (the same source-inspection approach ts-ipc.test.cjs uses). Free variables
// (spawn, timers, the job registry, IPC emission) are injected as parameters.
const mainSource = [
  fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'ipc', 'terminalJobsIpc.cjs'), 'utf8')
].join('\n');
const { classifyCommand, READINESS_LOG_PATTERN, extractReadyUrl } = require('./command-risk.cjs');
const { findPlantedShim, WINDOWS_CMD_SHIMS } = require('./verify-allowlist.cjs');

function extractFunction(name) {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in main.cjs`);
  const end = mainSource.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name} must end with a top-level closing brace`);
  return mainSource.slice(start, end + 2);
}

function extractConstant(name) {
  const match = mainSource.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(match, `${name} must be defined in main.cjs`);
  return new Function(`return ${match[1]};`)();
}

const COMMAND_IDLE_TIMEOUT_MS = extractConstant('COMMAND_IDLE_TIMEOUT_MS');
const COMMAND_AUTO_BACKGROUND_MS = extractConstant('COMMAND_AUTO_BACKGROUND_MS');
const JOB_CEILING_MS = extractConstant('JOB_CEILING_MS');
const JOB_BUFFER_BYTES = extractConstant('JOB_BUFFER_BYTES');
const JOB_TAIL_CHARS = extractConstant('JOB_TAIL_CHARS');
const JOB_READ_DEFAULT_CHARS = extractConstant('JOB_READ_DEFAULT_CHARS');
const FOREGROUND_OUTPUT_CAP = extractConstant('FOREGROUND_OUTPUT_CAP');
const OUTPUT_FLUSH_MS = extractConstant('OUTPUT_FLUSH_MS');
const MAX_FINISHED_JOBS = extractConstant('MAX_FINISHED_JOBS');

const { tokenizeCommand, quoteCmdToken } = new Function(
  `${extractFunction('tokenizeCommand')}\n${extractFunction('quoteCmdToken')}\nreturn { tokenizeCommand, quoteCmdToken };`
)();

const stripAnsi = new Function(`${extractFunction('stripAnsi')}\nreturn stripAnsi;`)();

const createOutputRing = new Function(
  `${extractFunction('createOutputRing')}\nreturn createOutputRing;`
)();

function createRegistry() {
  return new Function(
    'JOB_BUFFER_BYTES', 'MAX_FINISHED_JOBS',
    `${extractFunction('createOutputRing')}\n${extractFunction('createJobRegistry')}\nreturn createJobRegistry();`
  )(JOB_BUFFER_BYTES, MAX_FINISHED_JOBS);
}

/* ------------------------------------------------------------------ *
 * The old metacharacter refusal gate is gone (owner decisions
 * 2026-11-18): compound commands are parsed and risk-tiered instead.
 * ------------------------------------------------------------------ */

test('the COMMAND_METACHARACTERS refusal gate no longer exists', () => {
  assert.equal(mainSource.includes('COMMAND_METACHARACTERS'), false);
  assert.equal(mainSource.includes('COMMAND_TIMEOUT_MS'), false);
});

test('job:control is registered with renderer trust, workspace confinement and the full action set', () => {
  const handlerStart = mainSource.indexOf("handleMachineSensitive('job:control'");
  assert.notEqual(handlerStart, -1, 'the job:control channel must exist');
  assert.equal(mainSource.includes("'terminal:job-control'"), false, 'the old channel name is gone');
  const handlerEnd = mainSource.indexOf('handleMachineSensitive(', handlerStart + 10);
  const handler = mainSource.slice(handlerStart, handlerEnd === -1 ? undefined : handlerEnd);
  assert.ok(handler.includes('assertTrustedRenderer(event)'));
  assert.ok(handler.includes('job.workspaceId !== workspaceId'), 'jobs are confined to their workspace');
  for (const action of ['list', 'status', 'read_output', 'stop', 'kill']) {
    assert.ok(handler.includes(`'${action}'`), `action ${action} must be handled`);
  }
  assert.ok(handler.includes('payload.chars'), 'read_output accepts a chars tail window');
  assert.ok(mainSource.includes("send('terminal:job-output'"), 'coalesced output has its own channel');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8');
  assert.ok(preload.includes("ipcRenderer.invoke('job:control'"), 'preload bridges job:control');
  assert.ok(preload.includes("subscribe('terminal:job-output'"), 'preload bridges job output events');
  assert.ok(preload.includes("subscribe('terminal:job'"), 'preload bridges job lifecycle events');
});

test('compound commands classify by worst segment instead of being refused', () => {
  assert.equal(classifyCommand('npm i && npm test', { root: 'C:\\proj', platform: 'win32' }).tier, 'INSTALL');
  assert.equal(classifyCommand('git status | grep src', { root: 'C:\\proj', platform: 'win32' }).tier, 'READ');
  assert.equal(classifyCommand('npm test; rm -rf /', { root: 'C:\\proj', platform: 'win32' }).tier, 'DANGEROUS');
  assert.equal(classifyCommand('type a.txt > out.txt', { root: 'C:\\proj', platform: 'win32' }).tier, 'MUTATE');
});

test('tokenizeCommand keeps backslash path tokens intact', () => {
  assert.deepEqual(tokenizeCommand('node src\\index.js'), ['node', 'src\\index.js']);
  assert.deepEqual(tokenizeCommand('node "my dir\\index.js"'), ['node', 'my dir\\index.js']);
});

test('quoteCmdToken quotes backslash tokens safely for the cmd.exe shim line', () => {
  // No whitespace: the token rides the cmd.exe line unquoted; cmd.exe treats
  // backslashes as ordinary characters, so nothing needs escaping.
  assert.equal(quoteCmdToken('src\\index.js'), 'src\\index.js');
  assert.equal(quoteCmdToken('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  // A trailing backslash run must be doubled or it escapes the closing quote
  // when the child parses its command line (MSVCRT rules).
  assert.equal(quoteCmdToken('C:\\my dir\\'), '"C:\\my dir\\\\"');
  assert.equal(quoteCmdToken('a b\\\\'), '"a b\\\\\\\\"');
});

test('the shim line executeCommand builds carries no unquoted cmd.exe metacharacter', () => {
  const argv = tokenizeCommand('npm.cmd run build -- src\\index.js "my dir\\out.txt"');
  const resolved = 'C:\\Program Files\\nodejs\\npm.cmd';
  const line = [resolved, ...argv.slice(1)].map(quoteCmdToken).join(' ');
  assert.equal(
    line,
    '"C:\\Program Files\\nodejs\\npm.cmd" run build -- src\\index.js "my dir\\out.txt"'
  );
  assert.equal(/[&|<>^]/.test(line.replace(/"[^"]*"/g, '')), false);
});

/* ------------------------------------------------------------------ *
 * Pure helpers: ANSI stripping, output ring, job registry.
 * ------------------------------------------------------------------ */

test('stripAnsi removes CSI, OSC and single-char escapes', () => {
  assert.equal(stripAnsi('\u001B[32mok\u001B[0m\n'), 'ok\n');
  assert.equal(stripAnsi('\u001B]0;title\u0007text'), 'text');
  assert.equal(stripAnsi('\u001B[2J\u001B[Hclean'), 'clean');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('the output ring keeps the last bytes with stable absolute offsets', () => {
  const ring = createOutputRing(10);
  ring.append('abcde');
  assert.equal(ring.length, 5);
  assert.equal(ring.start, 0);
  assert.equal(ring.text(), 'abcde');
  ring.append('fghijkl'); // total 12, buffer keeps last 10
  assert.equal(ring.length, 12);
  assert.equal(ring.start, 2);
  assert.equal(ring.text(), 'cdefghijkl');
  assert.equal(ring.tail(4), 'ijkl');
  assert.equal(ring.slice(0, 4), 'cd'); // absolute 0..4 clamps to buffered 2..4
  assert.equal(ring.slice(8, 12), 'ijkl');
  assert.equal(ring.slice(12, 20), '');
  assert.equal(ring.slice(5, 5), '');
});

test('the job registry assigns J<n> ids, filters by workspace and prunes finished jobs', () => {
  const registry = createRegistry();
  const a = registry.create({ command: 'a', workspaceId: 'w1' });
  const b = registry.create({ command: 'b', workspaceId: 'w2' });
  assert.equal(a.id, 'J1');
  assert.equal(b.id, 'J2');
  assert.equal(registry.get('J1'), a);
  assert.equal(registry.get('nope'), null);
  assert.deepEqual(registry.list('w1').map((job) => job.id), ['J1']);
  assert.equal(registry.list().length, 2);
  for (let i = 0; i < MAX_FINISHED_JOBS + 5; i += 1) {
    const job = registry.create({ command: `x${i}`, workspaceId: 'w1' });
    job.status = 'exited';
    job.endedAt = i + 1;
  }
  registry.prune();
  const remaining = registry.list();
  assert.equal(remaining.filter((job) => job.status === 'exited').length, MAX_FINISHED_JOBS);
  assert.ok(registry.get('J1'), 'running jobs are never pruned');
});

/* ------------------------------------------------------------------ *
 * executeCommand streaming behavior, with injected spawn and timers.
 * ------------------------------------------------------------------ */

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + (ms || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.at)) next = { id, ...timer };
        }
        if (!next) break;
        now = next.at;
        timers.delete(next.id);
        next.fn();
      }
      now = target;
    },
    pending: () => timers.size
  };
}

function createFakeChild(pid = 4321) {
  const handlers = { stdout: [], stderr: [], close: [], error: [] };
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    stdout: { on: (event, fn) => { if (event === 'data') handlers.stdout.push(fn); } },
    stderr: { on: (event, fn) => { if (event === 'data') handlers.stderr.push(fn); } },
    once(event, fn) { (handlers[event] || (handlers[event] = [])).push(fn); },
    kill() { child.exitCode = 1; },
    emitData(stream, text) { for (const fn of handlers[stream]) fn(Buffer.from(text)); },
    emitClose(code) { child.exitCode = code; for (const fn of handlers.close) fn(code, null); },
    emitError(error) { for (const fn of handlers.error) fn(error); }
  };
  return child;
}

function buildExecutor(overrides = {}) {
  const timers = createFakeTimers();
  const events = [];
  const proofs = [];
  const kills = [];
  const spawns = [];
  const registry = createRegistry();
  const platform = overrides.platform || 'win32';
  const spawn = overrides.spawn || ((file, args, options) => {
    const child = createFakeChild();
    spawns.push({ file, args, options, child });
    return child;
  });
  const executeCommand = new Function(
    'process', 'fs', 'spawn', 'classifyCommand', 'findPlantedShim', 'WINDOWS_CMD_SHIMS',
    'resolveTerminalPlan', 'tokenizeCommand', 'quoteCmdToken', 'resolveWindowsExecutable',
    'commandJobs', 'setTimeout', 'clearTimeout', 'emitJobEvent', 'emitJobOutput', 'killProcessTree',
    'checkReadyUrl', 'recordCommandProof', 'READINESS_LOG_PATTERN', 'extractReadyUrl', 'stripAnsi',
    'COMMAND_IDLE_TIMEOUT_MS', 'COMMAND_AUTO_BACKGROUND_MS', 'JOB_CEILING_MS',
    'JOB_TAIL_CHARS', 'FOREGROUND_OUTPUT_CAP', 'OUTPUT_FLUSH_MS', 'JOB_BUFFER_BYTES',
    `${extractFunction('executeCommand')}\nreturn executeCommand;`
  )(
    { platform },
    overrides.fs || { existsSync: () => false },
    spawn,
    classifyCommand,
    findPlantedShim,
    WINDOWS_CMD_SHIMS,
    () => ({ env: { PATH: 'C:\\trusted' } }),
    tokenizeCommand,
    quoteCmdToken,
    overrides.resolveWindowsExecutable || ((name) => `C:\\trusted\\${name}.exe`),
    registry,
    timers.setTimeout.bind(timers),
    timers.clearTimeout.bind(timers),
    (event) => events.push(event),
    // Coalesced output rides its own channel in production; the harness records
    // both streams in one array so lifecycle assertions stay simple.
    (event) => events.push(event),
    overrides.killProcessTree || (async (child) => { kills.push(child); child.emitClose(1); return true; }),
    overrides.checkReadyUrl || (async () => true),
    async (workspaceId, command, run) => proofs.push({ workspaceId, command, run }),
    READINESS_LOG_PATTERN,
    extractReadyUrl,
    stripAnsi,
    COMMAND_IDLE_TIMEOUT_MS,
    COMMAND_AUTO_BACKGROUND_MS,
    JOB_CEILING_MS,
    JOB_TAIL_CHARS,
    FOREGROUND_OUTPUT_CAP,
    OUTPUT_FLUSH_MS,
    JOB_BUFFER_BYTES
  );
  return { executeCommand, timers, events, proofs, kills, spawns, registry };
}

test('a simple shim command keeps the hardened quoted-line spawn', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('npm.cmd run build', 'C:\\proj', { workspaceId: 'w1' });
  assert.equal(harness.spawns.length, 1);
  const spawnCall = harness.spawns[0];
  assert.equal(spawnCall.options.shell, true);
  assert.deepEqual(spawnCall.args, []);
  assert.equal(spawnCall.file, 'C:\\trusted\\npm.exe run build');
  spawnCall.child.emitData('stdout', 'built\r\n');
  spawnCall.child.emitClose(0);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'built\r\n');
  assert.equal(result.timedOut, false);
  assert.equal(harness.events[0].type, 'started');
  assert.equal(harness.events.at(-1).type, 'exit');
});

test('a compound command runs verbatim through the shell after classification', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('npm i && npm test', 'C:\\proj', { workspaceId: 'w1' });
  assert.equal(harness.spawns.length, 1);
  assert.equal(harness.spawns[0].file, 'npm i && npm test');
  assert.equal(harness.spawns[0].options.shell, true);
  harness.spawns[0].child.emitClose(0);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.tier, 'INSTALL');
});

test('a planted workspace binary is refused before spawn', async () => {
  const harness = buildExecutor({
    fs: { existsSync: (candidate) => candidate === 'C:\\proj\\node.exe' }
  });
  const result = await harness.executeCommand('node index.js', 'C:\\proj', { workspaceId: 'w1' });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Refusing to run "node"/);
  assert.equal(harness.spawns.length, 0);
});

test('foreground output is ANSI-stripped and capped to the tail', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node index.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  child.emitData('stdout', '\u001B[32mok\u001B[0m\n');
  child.emitData('stderr', '\u001B[31mwarn\u001B[0m');
  child.emitClose(0);
  const result = await pending;
  assert.equal(result.stdout, 'ok\n');
  assert.equal(result.stderr, 'warn');
});

test('a silent foreground command auto-backgrounds at 120s with a job id and tail', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  child.emitData('stdout', 'working...\n');
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  const result = await pending;
  assert.equal(result.exitCode, null);
  assert.equal(result.backgrounded, true);
  assert.equal(result.jobId, 'J1');
  assert.equal(result.timedOut, false);
  assert.match(result.message, /still running, job id J1; use job_control/);
  assert.equal(result.stdout, 'working...\n');
  const job = harness.registry.get('J1');
  assert.equal(job.backgrounded, true);
  assert.equal(job.status, 'running');
  assert.ok(harness.events.some((event) => event.type === 'backgrounded'));
  // The real exit later lands as a job event and its own proof entry.
  child.emitData('stdout', 'done\n');
  child.emitClose(0);
  assert.equal(job.status, 'exited');
  assert.equal(job.exitCode, 0);
  assert.equal(harness.proofs.length, 1);
  assert.equal(harness.proofs[0].run.exitCode, 0);
  assert.match(harness.proofs[0].run.stdout, /done/);
  assert.ok(harness.events.some((event) => event.type === 'exit' && event.exitCode === 0));
});

test('silence never kills a backgrounded job; the ceiling is its only bound', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  child.emitData('stdout', 'working...\n');
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  await pending;
  assert.equal(harness.registry.get('J1').backgrounded, true);
  // A quiet tsc/build job is healthy, not hung: silence is not evidence of a
  // hang once the command is a job the agent polls and can stop. Idle-killing
  // it returned healthy commands as failures.
  harness.timers.advance(COMMAND_IDLE_TIMEOUT_MS * 3);
  assert.equal(harness.kills.length, 0);
  assert.equal(harness.registry.get('J1').status, 'running');
  // Only the absolute ceiling may end it.
  harness.timers.advance(JOB_CEILING_MS);
  assert.equal(harness.kills.length, 1);
});

test('stderr output reaches the job too, and its later silence never kills it', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  child.emitData('stderr', 'booting\n');
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  await pending;
  harness.timers.advance(100_000);
  child.emitData('stderr', 'still alive\n');
  harness.timers.advance(COMMAND_IDLE_TIMEOUT_MS * 2);
  assert.equal(harness.kills.length, 0);
  assert.equal(harness.registry.get('J1').status, 'running');
});

test('a quiet dev server is healthy: idle silence never kills it', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('npm run dev', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  await pending;
  child.emitData('stdout', 'Local: http://127.0.0.1:3000/\n');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const job = harness.registry.get('J1');
  assert.equal(job.devServer, true);
  // A serving server logs once then goes quiet; that silence is health, not a
  // hang. It must survive many idle windows (only the ceiling may end it).
  harness.timers.advance(COMMAND_IDLE_TIMEOUT_MS * 3);
  assert.equal(harness.kills.length, 0);
  assert.equal(harness.registry.get('J1').status, 'running');
});

test('the 30-minute ceiling kills even a chatty job', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  await pending;
  let elapsed = COMMAND_AUTO_BACKGROUND_MS;
  while (elapsed < JOB_CEILING_MS) {
    const step = Math.min(60_000, JOB_CEILING_MS - elapsed);
    harness.timers.advance(step);
    elapsed += step;
    if (harness.registry.get('J1').status === 'running') child.emitData('stdout', 'noise\n');
  }
  assert.equal(harness.kills.length, 1);
  const job = harness.registry.get('J1');
  assert.equal(job.status, 'timed_out');
  assert.equal(job.killedReason, 'ceiling');
});

test('a dev server backgrounds immediately and reports readiness via URL probe', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('npm run dev', 'C:\\proj', { workspaceId: 'w1' });
  const result = await pending;
  assert.equal(result.backgrounded, true);
  assert.equal(result.exitCode, null);
  const job = harness.registry.get(result.jobId);
  assert.equal(job.devServer, true);
  assert.equal(job.ready, false);
  const child = harness.spawns[0].child;
  child.emitData('stdout', '\u001B[36m  ➜  Local:   http://localhost:5173/\u001B[0m\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.ready, true);
  assert.equal(job.readyUrl, 'http://localhost:5173/');
  const readyEvent = harness.events.find((event) => event.type === 'ready');
  assert.equal(readyEvent.url, 'http://localhost:5173/');
  harness.timers.advance(OUTPUT_FLUSH_MS);
  const outputEvent = harness.events.find((event) => event.type === 'output');
  assert.ok(outputEvent.chunk.includes('http://localhost:5173/'));
  assert.equal(outputEvent.chunk.includes('\u001B'), false);
});

test('readiness without a URL falls back to the log pattern', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('npm run dev', 'C:\\proj', { workspaceId: 'w1' });
  const result = await pending;
  harness.spawns[0].child.emitData('stdout', 'Compiled successfully!\n');
  await new Promise((resolve) => setImmediate(resolve));
  const job = harness.registry.get(result.jobId);
  assert.equal(job.ready, true);
  assert.equal(job.readyUrl, null);
});

test('a failed readiness probe does not mark the job ready', async () => {
  const harness = buildExecutor({ checkReadyUrl: async () => false });
  const pending = harness.executeCommand('npm run dev', 'C:\\proj', { workspaceId: 'w1' });
  const result = await pending;
  harness.spawns[0].child.emitData('stdout', 'Local: http://localhost:5173/\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.registry.get(result.jobId).ready, false);
});

test('a spawn error returns an actionable observation, never a silent drop', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('nosuchtool --run', 'C:\\proj', { workspaceId: 'w1' });
  harness.spawns[0].child.emitError(Object.assign(new Error('spawn nosuchtool ENOENT'), { code: 'ENOENT' }));
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Command not found: nosuchtool/);
  assert.equal(harness.registry.get('J1').status, 'exited');
});

test('an empty command is refused without spawning', async () => {
  const harness = buildExecutor();
  const result = await harness.executeCommand('   ', 'C:\\proj', {});
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /empty/i);
  assert.equal(harness.spawns.length, 0);
});

test('POSIX simple commands spawn argv directly without a shell', async () => {
  const harness = buildExecutor({ platform: 'linux' });
  const pending = harness.executeCommand('git status --short', '/proj', { workspaceId: 'w1' });
  assert.equal(harness.spawns[0].file, 'git');
  assert.deepEqual(harness.spawns[0].args, ['status', '--short']);
  assert.equal(harness.spawns[0].options.shell, false);
  assert.equal(harness.spawns[0].options.detached, true);
  harness.spawns[0].child.emitClose(0);
  assert.equal((await pending).exitCode, 0);
});

test('the job ring keeps only the last 200KB for read_output', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  const result = await pending;
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 5; i += 1) child.emitData('stdout', chunk);
  const job = harness.registry.get(result.jobId);
  assert.equal(job.output.length, 5 * 64 * 1024);
  assert.equal(job.output.text().length, JOB_BUFFER_BYTES);
  assert.equal(job.output.start, 5 * 64 * 1024 - JOB_BUFFER_BYTES);
  assert.equal(job.output.slice(job.output.start, job.output.start + 4), 'xxxx');
});

test('the foreground tail handed to the model is bounded', async () => {
  const harness = buildExecutor();
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const child = harness.spawns[0].child;
  child.emitData('stdout', 'y'.repeat(JOB_TAIL_CHARS + 500));
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  const result = await pending;
  assert.equal(result.stdout.length, JOB_TAIL_CHARS);
});

test('constants match the owner decisions: 300s idle, 120s auto-bg, 30min ceiling', () => {
  // Idle must stay above auto-background so a quiet command always becomes a
  // job (whose real exit the loop waits for) instead of being killed mid-run.
  assert.equal(COMMAND_IDLE_TIMEOUT_MS, 300_000);
  assert.equal(COMMAND_AUTO_BACKGROUND_MS, 120_000);
  assert.equal(JOB_CEILING_MS, 30 * 60_000);
  assert.equal(JOB_BUFFER_BYTES, 200 * 1024);
  assert.ok(JOB_READ_DEFAULT_CHARS > 0);
});

test('killProcessTree tries Windows taskkill and POSIX fallbacks and reports failure accurately', async () => {
  const execCalls = [];
  const winKillTree = new Function(
    'process', 'treeKill', 'execFile', 'console',
    `${extractFunction('killProcessTree')}\nreturn killProcessTree;`
  )(
    { platform: 'win32', kill: () => {} },
    (_pid, _sig, cb) => cb(new Error('tree-kill failed')),
    (file, args, _opts, cb) => { execCalls.push([file, ...args]); cb(null); },
    { error: () => {} }
  );
  assert.equal(await winKillTree({ pid: 999, exitCode: null, signalCode: null, kill: () => false }), true);
  assert.deepEqual(execCalls, [['taskkill', '/F', '/T', '/PID', '999']]);

  const errors = [];
  const winFailTree = new Function(
    'process', 'treeKill', 'execFile', 'console',
    `${extractFunction('killProcessTree')}\nreturn killProcessTree;`
  )(
    { platform: 'win32', kill: () => {} },
    (_pid, _sig, cb) => cb(new Error('tree-kill failed')),
    (_file, _args, _opts, cb) => cb(new Error('access denied')),
    { error: (...args) => errors.push(args) }
  );
  assert.equal(await winFailTree({ pid: 999, exitCode: null, signalCode: null, kill: () => false }), false);
  assert.equal(errors.length, 1);

  const posixKillTree = new Function(
    'process', 'treeKill', 'execFile', 'console',
    `${extractFunction('killProcessTree')}\nreturn killProcessTree;`
  )(
    { platform: 'linux', kill: (pid) => { if (pid < 0) throw new Error('no group'); } },
    (_pid, _sig, cb) => cb(new Error('tree-kill failed')),
    () => {},
    { error: () => {} }
  );
  assert.equal(await posixKillTree({ pid: 888, exitCode: null, signalCode: null, kill: () => false }), true);
});

test('failed killProcessTree keeps job running without setting killedReason or abandoning watchdog', async () => {
  let killCalls = 0;
  const harness = buildExecutor({
    killProcessTree: async () => { killCalls += 1; return false; }
  });
  const pending = harness.executeCommand('node long.js', 'C:\\proj', { workspaceId: 'w1' });
  const job = harness.registry.get('J1');
  harness.timers.advance(COMMAND_AUTO_BACKGROUND_MS);
  const bgResult = await pending;
  assert.equal(bgResult.backgrounded, true);
  harness.timers.advance(JOB_CEILING_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killCalls, 1);
  assert.equal(job.status, 'running');
  assert.equal(job.killedReason, null);
  harness.spawns[0].child.emitClose(0);
  assert.equal(job.status, 'exited');
  assert.equal(job.exitCode, 0);
});

test('blob: window openings enforce sandbox, contextIsolation, and nodeIntegration false', () => {
  assert.match(mainSource, /url\.startsWith\('blob:'\)[\s\S]{0,260}sandbox:\s*true[\s\S]{0,160}contextIsolation:\s*true[\s\S]{0,160}nodeIntegration:\s*false/);
});