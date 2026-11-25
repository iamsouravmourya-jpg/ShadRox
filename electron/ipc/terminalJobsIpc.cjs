'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const treeKill = require('tree-kill');
const { runWithCommandApproval } = require('../command-approval.cjs');
const { classifyCommand, READINESS_LOG_PATTERN, extractReadyUrl } = require('../command-risk.cjs');
const { sanitizeRiskNotice } = require('../command-risk-notice.cjs');
const { findPlantedShim, WINDOWS_CMD_SHIMS } = require('../verify-allowlist.cjs');
const { resolveTerminalPlan, systemEnvironment, clampTerminalSize, normalizeTerminalSessionKey, isSafeExternalUrl } = require('../terminal-modes.cjs');
const { applyShellIntegration } = require('../shell-integration.cjs');
const { unwrapErrorMessage } = require('../error-utils.cjs');
const { acquireInstallLock, isPackageInstallCommand } = require('../install-lock.cjs');

let pty = null;
try { pty = require('node-pty'); } catch { /* PTY support may be unavailable in an unbuilt development install. */ }

const TERMINAL_OUTPUT_COALESCE_MS = 8;
const TERMINAL_OUTPUT_FLUSH_BYTES = 256 * 1024;
const TERMINAL_OUTPUT_PAUSE_BYTES = 64 * 1024;

const COMMAND_IDLE_TIMEOUT_MS = 300_000;
const COMMAND_AUTO_BACKGROUND_MS = 120_000;
const JOB_CEILING_MS = 30 * 60_000;
const JOB_BUFFER_BYTES = 200 * 1024;
const JOB_TAIL_CHARS = 4_000;
const JOB_READ_DEFAULT_CHARS = 8_192;
const FOREGROUND_OUTPUT_CAP = 2 * 1024 * 1024;
const OUTPUT_FLUSH_MS = 250;
const MAX_FINISHED_JOBS = 20;

let runtimeBridge = {
  getMainWindow: () => null,
  recordCommandProof: async () => {}
};

function recordCommandProof(workspaceId, command, run) {
  return runtimeBridge.recordCommandProof(workspaceId, command, run);
}

function terminalDescriptor(sessionId, sessionInfo, workspace) {
  return {
    sessionId,
    mode: sessionInfo.mode,
    label: sessionInfo.label,
    title: path.basename(workspace.root),
    cwd: workspace.root
  };
}

function createTerminalOutputForwarder(send, options = {}) {
  const coalesceMs = options.coalesceMs ?? TERMINAL_OUTPUT_COALESCE_MS;
  const flushBytes = options.flushBytes ?? TERMINAL_OUTPUT_FLUSH_BYTES;
  const pauseBytes = options.pauseBytes ?? TERMINAL_OUTPUT_PAUSE_BYTES;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  let pending = '';
  let timer = null;
  let paused = false;
  let disposed = false;

  const resumePty = () => {
    if (!paused) return;
    paused = false;
    try { options.resume?.(); } catch { /* pty already gone */ }
  };

  const flush = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    resumePty();
    if (!pending) return;
    const data = pending;
    pending = '';
    try { send(data); } catch { /* window gone */ }
  };

  return {
    push(data) {
      if (disposed || typeof data !== 'string' || data.length === 0) return;
      pending += data;
      if (timer === null) {
        const leading = pending;
        pending = '';
        try { send(leading); } catch { /* window gone */ }
        timer = setTimer(flush, coalesceMs);
        return;
      }
      if (pending.length >= flushBytes) { flush(); return; }
      if (!paused && pending.length >= pauseBytes) {
        paused = true;
        try { options.pause?.(); } catch { /* flow control unsupported on this pty */ }
      }
    },
    flush,
    dispose() { flush(); disposed = true; },
    pendingBytes() { return pending.length; }
  };
}

function tokenizeCommand(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function quoteCmdToken(token) {
  return /\s/.test(token) ? `"${token.replace(/\\+$/, (run) => run + run)}"` : token;
}

function resolveWindowsExecutable(name, cwd, env) {
  const pathValue = env.PATH || env.Path || process.env.PATH || process.env.Path || '';
  let cwdKey;
  try { cwdKey = path.resolve(cwd).toLowerCase(); } catch { cwdKey = null; }
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    let dirKey;
    try { dirKey = path.resolve(dir).toLowerCase(); } catch { continue; }
    if (cwdKey && dirKey === cwdKey) continue;
    for (const suffix of ['.cmd', '.exe', '.bat', '.com']) {
      const candidate = path.join(dir, name + suffix);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

function stripAnsi(text) {
  return String(text ?? '').replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g, '');
}

function createOutputRing(limit) {
  let buffer = '';
  let total = 0;
  return {
    append(chunk) {
      const text = String(chunk ?? '');
      if (!text) return;
      buffer += text;
      total += text.length;
      if (buffer.length > limit) buffer = buffer.slice(buffer.length - limit);
    },
    get length() { return total; },
    get start() { return total - buffer.length; },
    text() { return buffer; },
    tail(count) { return buffer.slice(Math.max(0, buffer.length - count)); },
    slice(from, to) {
      const base = total - buffer.length;
      const start = Math.max(base, Number.isFinite(from) ? from : base);
      const end = Math.min(total, Number.isFinite(to) ? to : total);
      if (end <= start) return '';
      return buffer.slice(start - base, end - base);
    }
  };
}

function createJobRegistry() {
  const jobs = new Map();
  let counter = 0;
  return {
    create(fields) {
      counter += 1;
      const job = {
        id: `J${counter}`,
        status: 'running',
        exitCode: null,
        timedOut: false,
        backgrounded: false,
        ready: false,
        readyUrl: null,
        startedAt: Date.now(),
        endedAt: null,
        killedReason: null,
        child: null,
        output: createOutputRing(JOB_BUFFER_BYTES),
        ...fields
      };
      jobs.set(job.id, job);
      return job;
    },
    get(id) { return jobs.get(id) || null; },
    list(workspaceId) {
      return [...jobs.values()].filter((job) => !workspaceId || job.workspaceId === workspaceId);
    },
    prune() {
      const finished = [...jobs.values()].filter((job) => job.status !== 'running');
      const excess = finished.length - MAX_FINISHED_JOBS;
      if (excess <= 0) return;
      finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
      for (const job of finished.slice(0, excess)) jobs.delete(job.id);
    }
  };
}

const commandJobs = createJobRegistry();

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const fallbackTerminate = (primaryError) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true }, (tkError) => {
          if (!tkError) { done(true); return; }
          let directKilled = false;
          try { directKilled = Boolean(child.kill('SIGKILL')); } catch { /* already gone */ }
          if (!directKilled) {
            console.error('[jobs] killProcessTree failed on Windows', {
              pid: child.pid,
              primaryError: unwrapErrorMessage(primaryError),
              taskkillError: unwrapErrorMessage(tkError)
            });
          }
          done(directKilled);
        });
        return;
      }
      let killed = false;
      try {
        process.kill(-child.pid, 'SIGKILL');
        killed = true;
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
          killed = true;
        } catch {
          try { killed = Boolean(child.kill('SIGKILL')); } catch { /* already gone */ }
        }
      }
      if (!killed) {
        console.error('[jobs] killProcessTree failed on POSIX', {
          pid: child.pid,
          primaryError: unwrapErrorMessage(primaryError)
        });
      }
      done(killed);
    };

    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); done(true); return; } catch { /* fall through */ }
    }
    try {
      treeKill(child.pid, 'SIGKILL', (error) => {
        if (!error) { done(true); return; }
        fallbackTerminate(error);
      });
    } catch (error) {
      fallbackTerminate(error);
    }
  });
}

function checkReadyUrl(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve(false); return; }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    let socket;
    try { socket = net.connect({ host: parsed.hostname || '127.0.0.1', port }); } catch { resolve(false); return; }
    const finish = (ok) => { socket.removeAllListeners(); socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function emitJobEvent(payload) {
  try {
    const channel = payload && payload.type === 'output' ? 'terminal:job-output' : 'terminal:job';
    runtimeBridge.getMainWindow()?.webContents.send(channel, payload);
  } catch { /* window gone */ }
}

function emitJobOutput(payload) {
  try { runtimeBridge.getMainWindow()?.webContents.send('terminal:job-output', payload); } catch { /* window gone */ }
}

function executeCommand(command, cwd, meta = {}) {
  const text = typeof command === 'string' ? command : '';
  if (!text.trim()) {
    return Promise.resolve({ stdout: '', stderr: 'Command is empty.', exitCode: 1, timedOut: false });
  }
  if (!isPackageInstallCommand(text)) {
    return executeCommandNow(text, cwd, meta, null);
  }
  return acquireInstallLock(cwd).then((releaseLock) => executeCommandNow(text, cwd, meta, releaseLock));
}

function executeCommandNow(text, cwd, meta = {}, releaseLock = null) {
  return new Promise((resolve) => {
    const releaseOnce = () => {
      if (typeof releaseLock === 'function') {
        const fn = releaseLock;
        releaseLock = null;
        fn();
      }
    };
    const risk = meta.risk || classifyCommand(text, { cwd, root: cwd });
    const workspaceId = typeof meta.workspaceId === 'string' ? meta.workspaceId : null;

    if (process.platform === 'win32') {
      for (const segment of risk.segments) {
        const argv = Array.isArray(segment.argv) ? segment.argv.filter((arg) => typeof arg === 'string') : [];
        if (argv.length === 0) continue;
        const planted = findPlantedShim(argv, cwd, (candidate) => {
          try { return fs.existsSync(candidate); } catch { return false; }
        }, process.platform);
        if (planted) {
          releaseOnce();
          resolve({ stdout: '', stderr: `Refusing to run "${argv[0]}": a file with that name exists in the project folder.`, exitCode: 1, timedOut: false, tier: risk.tier });
          return;
        }
      }
    }

    const env = resolveTerminalPlan({ mode: 'agent' }).env;
    const spawnOptions = { cwd, env, windowsHide: true, detached: process.platform !== 'win32' };
    let child;
    try {
      const simple = !risk.shellSyntax && risk.segments.length === 1 && !risk.parseError;
      if (simple) {
        const argv = tokenizeCommand(text);
        if (argv.length === 0) {
          releaseOnce();
          resolve({ stdout: '', stderr: 'Command is empty.', exitCode: 1, timedOut: false });
          return;
        }
        if (process.platform !== 'win32') {
          child = spawn(argv[0], argv.slice(1), { ...spawnOptions, shell: false });
        } else {
          const base = argv[0];
          const isShim = WINDOWS_CMD_SHIMS.has(base.toLowerCase()) || /\.(cmd|bat)$/i.test(base);
          if (isShim) {
            const resolved = resolveWindowsExecutable(base.replace(/\.(cmd|bat)$/i, ''), cwd, env);
            if (!resolved) {
              releaseOnce();
              resolve({ stdout: '', stderr: `Command not found on PATH: ${base}`, exitCode: 1, timedOut: false, tier: risk.tier });
              return;
            }
            const line = [resolved, ...argv.slice(1)].map(quoteCmdToken).join(' ');
            child = spawn(line, [], { ...spawnOptions, shell: true });
          } else {
            const hasPathShape = /^[a-z]:[\\/]/i.test(base) || base.includes('/') || base.includes('\\');
            const resolved = hasPathShape ? null : resolveWindowsExecutable(base, cwd, env);
            if (resolved) {
              child = spawn(resolved, argv.slice(1), { ...spawnOptions, shell: false });
            } else if (hasPathShape) {
              child = spawn(base, argv.slice(1), { ...spawnOptions, shell: false });
            } else {
              const line = argv.map(quoteCmdToken).join(' ');
              child = spawn(line, [], { ...spawnOptions, shell: true });
            }
          }
        }
      } else {
        child = spawn(text, [], { ...spawnOptions, shell: true });
      }
    } catch (error) {
      releaseOnce();
      resolve({ stdout: '', stderr: `Could not start command: ${unwrapErrorMessage(error)}`, exitCode: 1, timedOut: false, tier: risk.tier });
      return;
    }

    const job = commandJobs.create({
      command: text,
      cwd,
      workspaceId,
      tier: risk.tier,
      devServer: Boolean(risk.devServer),
      autoApproved: Boolean(meta.autoApproved)
    });
    job.child = child;
    const ring = job.output;
    let settled = false;
    let foregroundStdout = '';
    let foregroundStderr = '';
    let pendingEvent = '';
    let probing = false;
    let flushTimer = null;
    let idleTimer = null;
    let autoBgTimer = null;
    let killTimer = null;
    const ceilingTimer = setTimeout(() => requestKill('ceiling'), JOB_CEILING_MS);

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const appendCapped = (current, chunk) => {
      const next = current + chunk;
      return next.length > FOREGROUND_OUTPUT_CAP ? next.slice(next.length - FOREGROUND_OUTPUT_CAP) : next;
    };

    const flushOutput = () => {
      flushTimer = null;
      if (!pendingEvent) return;
      const chunk = pendingEvent;
      pendingEvent = '';
      emitJobOutput({ type: 'output', jobId: job.id, workspaceId, chunk: stripAnsi(chunk) });
    };

    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (job.backgrounded || job.devServer || job.ready) return;
      idleTimer = setTimeout(() => requestKill('idle'), COMMAND_IDLE_TIMEOUT_MS);
    };

    const probeReadiness = () => {
      if (!job.devServer || job.ready || probing || job.status !== 'running') return;
      const recent = stripAnsi(ring.tail(4096));
      if (!READINESS_LOG_PATTERN.test(recent)) return;
      const url = extractReadyUrl(recent);
      if (!url) {
        job.ready = true;
        resetIdle();
        emitJobEvent({ type: 'ready', jobId: job.id, workspaceId, url: null });
        return;
      }
      probing = true;
      checkReadyUrl(url).then((ok) => {
        probing = false;
        if (ok && job.status === 'running' && !job.ready) {
          job.ready = true;
          job.readyUrl = url;
          resetIdle();
          emitJobEvent({ type: 'ready', jobId: job.id, workspaceId, url });
        }
      }).catch(() => { probing = false; });
    };

    const onData = (stream) => (data) => {
      const chunk = data.toString();
      ring.append(chunk);
      if (!job.backgrounded) {
        if (stream === 'stdout') foregroundStdout = appendCapped(foregroundStdout, chunk);
        else foregroundStderr = appendCapped(foregroundStderr, chunk);
      }
      pendingEvent += chunk;
      if (pendingEvent.length > JOB_BUFFER_BYTES) pendingEvent = pendingEvent.slice(pendingEvent.length - JOB_BUFFER_BYTES);
      if (!flushTimer) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
      resetIdle();
      probeReadiness();
    };

    const background = (reason) => {
      if (settled || job.backgrounded) return;
      job.backgrounded = true;
      if (autoBgTimer) { clearTimeout(autoBgTimer); autoBgTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      emitJobEvent({ type: 'backgrounded', jobId: job.id, workspaceId, command: text, tier: job.tier, reason });
      settle({
        stdout: stripAnsi(ring.tail(JOB_TAIL_CHARS)),
        stderr: '',
        exitCode: null,
        timedOut: false,
        backgrounded: true,
        jobId: job.id,
        tier: job.tier,
        message: `still running, job id ${job.id}; use job_control`
      });
    };

    const requestKill = (reason) => {
      if (job.status !== 'running' || job.killedReason) return;
      const prevReason = job.killedReason;
      job.killedReason = reason;
      Promise.resolve(killProcessTree(child)).then((killed) => {
        if (!killed) {
          if (job.status === 'running') {
            job.killedReason = prevReason;
            console.error('[jobs] killProcessTree returned false; keeping job active', { jobId: job.id, reason, pid: child?.pid });
            if (reason === 'idle') resetIdle();
          }
          return;
        }
        if (job.status === 'running') {
          killTimer = setTimeout(() => {
            if (job.status === 'running') finalize(1, reason !== 'user', `\n[killed by ${reason} limit; process tree did not report exit]`);
          }, 5000);
        }
      }).catch((error) => {
        if (job.status === 'running') {
          job.killedReason = prevReason;
          console.error('[jobs] killProcessTree threw unexpectedly', { jobId: job.id, reason, error });
          if (reason === 'idle') resetIdle();
        }
      });
    };

    let observedExitCode = null;
    let observedSignal = null;
    let exitDrainTimer = null;

    const clearTimers = () => {
      clearTimeout(ceilingTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (autoBgTimer) clearTimeout(autoBgTimer);
      if (killTimer) clearTimeout(killTimer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      if (flushTimer) { clearTimeout(flushTimer); flushOutput(); }
    };

    const finalize = (exitCode, timedOut, note) => {
      if (job.status !== 'running') return;
      releaseOnce();
      job.status = job.killedReason === 'user' ? 'killed' : timedOut ? 'timed_out' : 'exited';
      job.exitCode = exitCode;
      job.timedOut = timedOut;
      job.endedAt = Date.now();
      clearTimers();
      emitJobEvent({ type: 'exit', jobId: job.id, workspaceId, exitCode, timedOut, status: job.status, durationMs: job.endedAt - job.startedAt });
      if (!settled) {
        settle({ stdout: stripAnsi(foregroundStdout), stderr: stripAnsi(foregroundStderr) + note, exitCode, timedOut, tier: job.tier });
      } else if (job.backgrounded && workspaceId) {
        recordCommandProof(workspaceId, text, { stdout: stripAnsi(ring.text()), stderr: note, exitCode, timedOut, tier: job.tier, jobId: job.id, backgrounded: true });
      }
      commandJobs.prune();
    };

    const resolveExitResult = (closeCode) => {
      const timedOut = job.killedReason === 'idle' || job.killedReason === 'ceiling';
      const note = job.killedReason === 'idle'
        ? `\n[killed after ${COMMAND_IDLE_TIMEOUT_MS / 1000}s with no output]`
        : job.killedReason === 'ceiling'
          ? `\n[killed at the ${JOB_CEILING_MS / 60000}-minute job ceiling]`
          : job.killedReason === 'user' ? '\n[killed by job_control]' : '';
      const rawCode = typeof closeCode === 'number'
        ? closeCode
        : (typeof child.exitCode === 'number' ? child.exitCode : observedExitCode);
      // Windows cmd.exe / shell shims occasionally report `null` on close after
      // a clean exit; only treat null as failure when signaled or explicitly killed.
      const finalCode = typeof rawCode === 'number'
        ? rawCode
        : (observedSignal || job.killedReason ? 1 : 0);
      return { finalCode, timedOut, note };
    };

    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.once('exit', (code, signal) => {
      observedExitCode = typeof code === 'number' ? code : observedExitCode;
      observedSignal = signal || observedSignal;
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      exitDrainTimer = setTimeout(() => {
        if (job.status === 'running') {
          const { finalCode, timedOut, note } = resolveExitResult(null);
          finalize(finalCode, timedOut, note);
        }
      }, 250);
      exitDrainTimer.unref?.();
    });
    child.once('close', (code) => {
      const { finalCode, timedOut, note } = resolveExitResult(code);
      finalize(finalCode, timedOut, note);
    });
    child.once('error', (error) => {
      const message = error && error.code === 'ENOENT'
        ? `Command not found: ${text.split(/\s+/)[0]}`
        : `Could not run command: ${unwrapErrorMessage(error)}`;
      finalize(1, false, message);
    });

    emitJobEvent({ type: 'started', jobId: job.id, workspaceId, command: text, cwd, tier: job.tier, devServer: job.devServer, autoApproved: job.autoApproved });
    resetIdle();
    if (job.devServer) background('dev-server');
    else autoBgTimer = setTimeout(() => background('foreground-wait'), COMMAND_AUTO_BACKGROUND_MS);
  });
}

function registerTerminalAndJobHandlers({
  dialog,
  shell,
  handleMachineSensitive,
  assertTrustedRenderer,
  workspaceAccess,
  terminalSessions,
  getMainWindow,
  recordCommandProof: customRecorder
}) {
  runtimeBridge = {
    getMainWindow,
    recordCommandProof: customRecorder || (async () => {})
  };
  const mainWindow = {
    get webContents() {
      return getMainWindow()?.webContents;
    }
  };
  const maxTerminalSessionsPerWorkspace = 12;

  handleMachineSensitive('terminal:create', async (event, workspaceId, cols = 100, rows = 30, mode = 'system', sessionKey) => {
    assertTrustedRenderer(event);
    if (!pty) throw new Error('Interactive terminal support is unavailable. Reinstall the desktop dependencies and restart ShadRox.');
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace) throw new Error('The terminal needs an opened workspace.');
    const requestedMode = mode === 'agent' ? 'agent' : 'system';

    const requestedKey = normalizeTerminalSessionKey(sessionKey);
    if (requestedKey) {
      const owned = terminalSessions.get(requestedKey);
      if (owned) {
        if (owned.workspaceId !== workspaceId) throw new Error('That terminal session belongs to another workspace.');
        if (owned.mode !== requestedMode) throw new Error('That terminal session already runs in another mode.');
        return terminalDescriptor(requestedKey, owned, workspace);
      }
    } else {
      const existing = [...terminalSessions].find(([, info]) => info.workspaceId === workspaceId && info.mode === requestedMode);
      if (existing) return terminalDescriptor(existing[0], existing[1], workspace);
    }

    const ownedCount = [...terminalSessions.values()].filter((info) => info.workspaceId === workspaceId).length;
    if (ownedCount >= maxTerminalSessionsPerWorkspace) {
      throw new Error(`A workspace can hold ${maxTerminalSessionsPerWorkspace} terminal sessions. Close a tab first.`);
    }

    const plan = resolveTerminalPlan({ env: process.env, mode: requestedMode });
    const sessionId = requestedKey ?? randomUUID();
    const size = clampTerminalSize(cols, rows);
    const terminalEnv = requestedMode === 'agent' ? plan.env : systemEnvironment(plan.env);
    const integrated = applyShellIntegration({ ...plan, env: terminalEnv });
    const terminal = pty.spawn(integrated.shellPath, integrated.shellArgs, {
      name: 'xterm-256color', cols: size.cols, rows: size.rows,
      cwd: workspace.root, env: { ...integrated.env, TERM: 'xterm-256color' }, useConpty: process.platform === 'win32',
      windowsHide: true
    });
    const sessionInfo = { workspaceId, mode: plan.mode, label: plan.label, launchCwd: workspace.root, terminal };
    const forwarder = createTerminalOutputForwarder(
      (data) => mainWindow?.webContents.send('terminal:output', { workspaceId, sessionId, type: 'data', data }),
      { pause: () => terminal.pause(), resume: () => terminal.resume() }
    );
    sessionInfo.forwarder = forwarder;
    terminalSessions.set(sessionId, sessionInfo);
    terminal.onData((data) => forwarder.push(data));
    terminal.onExit(({ exitCode }) => {
      forwarder.dispose();
      terminalSessions.delete(sessionId);
      mainWindow?.webContents.send('terminal:output', { workspaceId, sessionId, type: 'exit', exitCode });
    });
    return terminalDescriptor(sessionId, sessionInfo, workspace);
  });

  handleMachineSensitive('terminal:write', async (event, workspaceId, sessionId, data) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId || typeof data !== 'string' || data.length > 64_000) throw new Error('Invalid terminal session or input.');
    sessionInfo.terminal.write(data);
  });

  handleMachineSensitive('terminal:resize', async (event, workspaceId, sessionId, cols, rows) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId) throw new Error('Invalid terminal session.');
    const size = clampTerminalSize(cols, rows);
    sessionInfo.terminal.resize(size.cols, size.rows);
  });

  handleMachineSensitive('terminal:close', async (event, workspaceId, sessionId) => {
    assertTrustedRenderer(event);
    const sessionInfo = terminalSessions.get(sessionId);
    if (!sessionInfo || sessionInfo.workspaceId !== workspaceId) return;
    terminalSessions.delete(sessionId);
    sessionInfo.forwarder?.dispose();
    sessionInfo.terminal.kill();
  });

  handleMachineSensitive('terminal:list-sessions', async (event, workspaceId) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    const sessions = [];
    for (const [sessionId, sessionInfo] of terminalSessions) {
      if (sessionInfo.workspaceId !== workspaceId) continue;
      sessions.push(
        workspace
          ? terminalDescriptor(sessionId, sessionInfo, workspace)
          : { sessionId, mode: sessionInfo.mode, label: sessionInfo.label }
      );
    }
    return sessions;
  });

  handleMachineSensitive('terminal:open-link', async (event, url) => {
    assertTrustedRenderer(event);
    if (!isSafeExternalUrl(url)) throw new Error('Only an http or https link can be opened externally.');
    await shell.openExternal(url);
    return true;
  });

  handleMachineSensitive('terminal:run-command', async (event, workspaceId, command, riskNotice) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Terminal commands are available only for an opened folder workspace.');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > 5000) {
      throw new Error('Enter a command between 1 and 5000 characters.');
    }

    const started = Date.now();
    const approval = await runWithCommandApproval({
      workspaceId,
      command,
      workspace,
      riskNotice: sanitizeRiskNotice(riskNotice),
      showApproval: async ({ command: approvedCommand, cwd, riskNotice: notice, risk }) => {
        const dangerous = Boolean(risk && risk.tier === 'DANGEROUS');
        const segmentLines = risk && Array.isArray(risk.segments) && risk.segments.length > 0
          ? risk.segments
            .map((segment) => `[${segment.tier}] ${segment.argv.join(' ')}${segment.reason ? ` — ${segment.reason}` : ''}`)
            .join('\n')
          : '';
        const outOfRoot = risk && Array.isArray(risk.outOfRootPaths) && risk.outOfRootPaths.length > 0
          ? `\n\nPaths outside the workspace:\n${risk.outOfRootPaths.join('\n')}`
          : '';
        const dangerWarning = dangerous
          ? `DANGEROUS COMMAND — this can destroy files, expose credentials, or take over the machine. It is never auto-approved.\n${(risk.dangerousReasons || []).join('\n')}\n\n`
          : '';
        const choice = await dialog.showMessageBox(getMainWindow(), {
          type: dangerous ? 'error' : 'warning',
          buttons: ['Block command', dangerous ? 'Run anyway' : 'Run once'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: dangerous ? 'Dangerous command — approval required' : 'Approve command execution',
          message: dangerous
            ? 'This command was classified DANGEROUS. Run it only if you fully trust it.'
            : 'An agent or workspace action is requesting a shell command.',
          detail:
            `${dangerWarning}` +
            `${notice ? `${notice}\n\n` : ''}` +
            `Review the exact command and working directory. Commands can read, modify, or execute files in this workspace.\n\n${approvedCommand}\n\nWorking directory:\n${cwd}` +
            `${segmentLines ? `\n\nCommand segments:\n${segmentLines}` : ''}` +
            outOfRoot
        });
        return choice.response === 1;
      },
      getWorkspace: (id) => workspaceAccess.getWorkspace(id),
      runCommand: executeCommand,
      allowVerifyAllowlist: false
    });
    const run = approval.approved
      ? approval.result
      : { stdout: '', stderr: approval.reason, exitCode: 1, timedOut: false, deniedReason: approval.reason, tier: approval.tier };
    mainWindow?.webContents.send('terminal:run', {
      workspaceId,
      command,
      ...run,
      exitCode: run.exitCode,
      durationMs: Date.now() - started
    });
    await recordCommandProof(workspaceId, command, run);
    return run;
  });

  handleMachineSensitive('job:control', async (event, workspaceId, request) => {
    assertTrustedRenderer(event);
    const workspace = workspaceAccess.getWorkspace(workspaceId);
    if (!workspace || workspace.mode !== 'folder') {
      throw new Error('Job control is available only for an opened folder workspace.');
    }
    const payload = request && typeof request === 'object' ? request : {};
    const action = typeof payload.action === 'string' ? payload.action : null;

    const summarize = (job) => ({
      jobId: job.id,
      command: job.command,
      status: job.status,
      tier: job.tier,
      exitCode: job.exitCode,
      timedOut: job.timedOut,
      backgrounded: job.backgrounded,
      ready: job.ready,
      readyUrl: job.readyUrl,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      outputChars: job.output.length
    });

    if (action === 'list') {
      return { ok: true, jobs: commandJobs.list(workspaceId).map(summarize) };
    }

    const jobId = typeof payload.jobId === 'string' ? payload.jobId : null;
    const job = jobId ? commandJobs.get(jobId) : null;
    if (!job || job.workspaceId !== workspaceId) {
      return { ok: false, error: `Unknown job id ${jobId ?? '(missing)'} for this workspace. Use job_control with action "list" to see jobs.` };
    }

    if (action === 'status') {
      return { ok: true, ...summarize(job) };
    }

    if (action === 'read_output') {
      const range = payload.range && typeof payload.range === 'object' ? payload.range : {};
      const chars = Number.isFinite(payload.chars)
        ? Math.min(JOB_BUFFER_BYTES, Math.max(1, Math.floor(payload.chars)))
        : JOB_READ_DEFAULT_CHARS;
      const total = job.output.length;
      const start = Number.isFinite(range.start) ? Math.max(0, range.start) : Math.max(job.output.start, total - chars);
      const end = Math.max(start, Number.isFinite(range.end) ? Math.min(total, range.end) : total);
      return {
        ok: true,
        jobId: job.id,
        status: job.status,
        exitCode: job.exitCode,
        timedOut: job.timedOut,
        ready: job.ready,
        readyUrl: job.readyUrl,
        start,
        end,
        totalChars: total,
        text: stripAnsi(job.output.slice(start, end))
      };
    }

    if (action === 'stop' || action === 'kill') {
      if (job.status !== 'running') {
        return { ok: true, jobId: job.id, killed: false, status: job.status, message: `Job already ${job.status}.` };
      }
      const prevReason = job.killedReason;
      job.killedReason = 'user';
      const killed = await killProcessTree(job.child);
      if (!killed && job.status === 'running') {
        job.killedReason = prevReason;
        console.error('[jobs] job:control failed to terminate process tree', { jobId: job.id, action, pid: job.child?.pid });
        return {
          ok: false,
          jobId: job.id,
          killed: false,
          status: job.status,
          error: `Could not terminate process tree for job ${job.id}.`
        };
      }
      return { ok: true, jobId: job.id, killed: true, status: job.status };
    }

    return { ok: false, error: `Unknown job_control action "${action ?? ''}". Use "list", "read_output", "status" or "stop".` };
  });
}

module.exports = {
  commandJobs,
  killProcessTree,
  executeCommand,
  registerTerminalAndJobHandlers
};
