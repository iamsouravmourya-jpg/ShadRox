// Autonomous 5-level stress harness for ShadRox.
// Launches the packaged exe offscreen, opens a sandbox workspace, drives the
// chat UI through 5 prompts, and audits the beta log for tool coverage.
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXE = path.resolve('dist_desktop/win-unpacked/ShadRox.exe');
const SANDBOX = process.env.SHADROX_SANDBOX || path.join(os.tmpdir(), 'shadrox-e2e-sandbox');
const LOG = path.join(process.env.APPDATA || '', 'ShadRox', 'logs', 'shadrox-beta.log');
const LEVEL_TIMEOUT = Number(process.env.LEVEL_TIMEOUT_MS || 10 * 60 * 1000);
const ONLY_LEVEL = process.env.QA_LEVEL ? Number(process.env.QA_LEVEL) : 0;

const LEVELS = process.env.QA_PROMPT
  ? [{ id: 0, prompt: process.env.QA_PROMPT }]
  : [
  {
    id: 1,
    prompt: 'Explore this workspace without modifying files. Use outline and semantic_search to map the main entry points and auth/payment modules, look up official Node.js fs/promises docs via web_search or fetch_url, check TypeScript diagnostics with problems, and save an architectural summary into memory_note (then verify with memory_read). Do not create or edit any files.',
  },
  {
    id: 2,
    prompt: 'Create a checkpoint labeled l2-base, then create src/utils/healthPing.ts with write_file exporting a healthPing function, update it via edit_file, apply a multi-hunk apply_patch, inspect diff_review, run list_checkpoints, restore back to l2-base with restore, then delete_file any leftover temp file if one exists. Confirm each step worked.',
  },
  {
    id: 3,
    prompt: 'Run git_state, then run_command "npm run typecheck" (or "npx tsc --noEmit" if that script is missing). Start the workspace preview with preview_control, inspect it with preview_inspect, check terminal_state, then stop background jobs with job_control. Report what each tool returned.',
  },
  {
    id: 4,
    prompt: 'Create tmp-debug-probe.mjs that calculates a 3-item invoice total with tax inside a loop. Set a breakpoint inside the loop with debug_set_breakpoint, launch the Node debugger, verify paused state with debugger_state, inspect debug_get_call_stack and debug_inspect_variables, evaluate items.length * 2 with debug_evaluate_expression, step with debug_step_execution, resume, and finally delete tmp-debug-probe.mjs.',
  },
  {
    id: 5,
    prompt: 'Decompose and execute a multi-file repair: update_tasks first, then read each broken file, fix all type errors with edit_file or apply_patch, check problems until 0 errors, run verify, save learnings with memory_note, and conclude with finish. If no broken files exist, create three small broken TS files under src/broken/, fix them, verify, then clean them up.',
  },
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(os.tmpdir(), 'shadrox-qa.log'), line + '\n');
}

async function tuckWindow(electronApp) {
  try {
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && win.isVisible()) win.minimize();
      }
    });
  } catch (error) {
    log(`tuckWindow failed: ${error.message}`);
  }
}

async function waitForAgentIdle(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // Agent turn is busy while streaming spinners / "thinking" indicators exist.
  // Fall back to a quiet-period heuristic on the transcript area.
  let quietSince = null;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(() => {
      const spinners = document.querySelectorAll('.animate-spin, [class*="spinner"], [class*="thinking"], [class*="streaming"]');
      const stopBtn = [...document.querySelectorAll('button')].find((b) => /stop|cancel/i.test(b.getAttribute('aria-label') || b.textContent || ''));
      return spinners.length > 0 || Boolean(stopBtn);
    }).catch(() => false);
    if (!busy) {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince > 15000) return true;
    } else {
      quietSince = null;
    }
    await page.waitForTimeout(3000);
  }
  return false;
}

function toolNamesSince(offset) {
  try {
    const content = fs.readFileSync(LOG, 'utf8');
    const slice = content.slice(offset);
    const names = new Set();
    for (const match of slice.matchAll(/"tool"\s*:\s*"([a-z_]+)"/g)) names.add(match[1]);
    for (const match of slice.matchAll(/tool_call_started[^}]*"tool"\s*:\s*"([a-z_]+)"/g)) names.add(match[1]);
    return { names: [...names], tail: slice.slice(-4000) };
  } catch {
    return { names: [], tail: '' };
  }
}

async function runLevel(page, electronApp, level) {
  log(`=== LEVEL ${level.id} ===`);
  const before = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;

  // Focus the composer and submit the prompt.
  const textarea = page.locator('textarea[placeholder*="Ask ShadRox"], textarea').last();
  await textarea.waitFor({ state: 'visible', timeout: 30000 });
  await textarea.click();
  await textarea.fill(level.prompt);
  await page.keyboard.press('Enter');
  log(`prompt submitted (${level.prompt.slice(0, 60)}…)`);

  const finished = await waitForAgentIdle(page, LEVEL_TIMEOUT);
  log(`level ${level.id} agent ${finished ? 'finished' : 'TIMED OUT'}`);

  // Capture the assistant's last visible reply + tool activity cards.
  const capture = await page.evaluate(() => {
    const all = [...document.querySelectorAll('div,section,article')];
    const toolNames = new Set();
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (t.length > 4000) continue;
      for (const m of t.matchAll(/\b(list_directory|read_file|find_files|search_text|write_file|edit_file|apply_patch|verify|checkpoint|list_checkpoints|restore|delete_file|problems|git_state|run_command|job_control|preview_control|preview_inspect|terminal_state|terminal_answer|debugger_state|debug_set_breakpoint|debug_get_call_stack|debug_inspect_variables|debug_evaluate_expression|debug_step_execution|outline|update_tasks|finish|memory_read|memory_note|semantic_search|find_references|go_to_definition|rename_symbol|diff_review|ask_user|spawn_subagent|web_search|fetch_url|mcp_[a-z_]+)\b/g)) {
        toolNames.add(m[1]);
      }
    }
    // Last sizeable text block in the chat scroll area = assistant reply.
    const candidates = all.map((el) => (el.textContent || '').trim()).filter((t) => t.length > 30 && t.length < 6000);
    return { tools: [...toolNames], reply: candidates.slice(-2).join('\n---\n').slice(0, 1200) };
  }).catch(() => ({ tools: [], reply: '' }));
  log(`level ${level.id} reply sample: ${capture.reply.slice(0, 250).replace(/\n/g, ' ')}`);

  // Give the log a moment to flush, then audit beta log for errors.
  await page.waitForTimeout(3000);
  const { tail } = toolNamesSince(before);
  const turnErrors = (tail.match(/"event"\s*:\s*"turn_error"/g) || []).length;
  log(`level ${level.id} tools seen: ${capture.tools.join(', ') || '(none)'}`);
  log(`level ${level.id} beta-log turn_errors: ${turnErrors}`);
  if (/SHADROX_UNTRUSTED_DATA_BEGIN/.test(tail)) log(`level ${level.id} LEAKED untrusted-data delimiter!`);
  return { level: level.id, finished, tools: capture.tools, errors: turnErrors };
}

async function main() {
  log('QA harness starting');
  if (!fs.existsSync(EXE)) throw new Error(`exe not found: ${EXE}`);
  if (!fs.existsSync(SANDBOX)) throw new Error(`sandbox not found: ${SANDBOX}`);

  const env = { ...process.env, ELECTRON_NO_ATTACH_CONSOLE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronApp = await electron.launch({
    executablePath: EXE,
    env,
  });
  const page = await electronApp.firstWindow();
  await page.waitForTimeout(3000);
  await tuckWindow(electronApp);
  log('app launched (minimized)');

  // Wait for the UI to settle (auth screen or workspace).
  await page.waitForTimeout(8000);
  await tuckWindow(electronApp);

  // Open the sandbox workspace through the desktop bridge (no native dialog).
  const opened = await page.evaluate(async (sandbox) => {
    const bridge = window.shadroxDesktop;
    if (!bridge) return 'no-bridge';
    if (typeof bridge.reopenWorkspace === 'function') {
      const ws = await bridge.reopenWorkspace({ kind: 'folder', path: sandbox });
      return ws ? 'reopened' : 'reopen-null';
    }
    return 'no-reopen';
  }, SANDBOX);
  log(`workspace open attempt: ${opened}`);
  await page.waitForTimeout(5000);
  await tuckWindow(electronApp);

  // If reopen did not land, try the second-instance CLI path.
  if (opened !== 'reopened') {
    log('trying second-instance folder arg');
    spawn(EXE, [SANDBOX], { detached: true, stdio: 'ignore' }).unref();
    await page.waitForTimeout(8000);
  }

  const results = [];
  for (const level of LEVELS) {
    if (ONLY_LEVEL && level.id !== ONLY_LEVEL) continue;
    try {
      results.push(await runLevel(page, electronApp, level));
    } catch (error) {
      log(`level ${level.id} harness error: ${error.message}`);
      results.push({ level: level.id, finished: false, tools: [], errors: -1, harnessError: error.message });
    }
    await tuckWindow(electronApp);
  }

  log('=== SUMMARY ===');
  for (const r of results) {
    log(`L${r.level}: finished=${r.finished} tools=[${r.tools.join(',')}] errors=${r.errors}${r.harnessError ? ' HARNESS:' + r.harnessError : ''}`);
  }
  fs.writeFileSync(path.join(os.tmpdir(), 'shadrox-qa-results.json'), JSON.stringify(results, null, 2));

  await electronApp.close();
  log('done');
}

main().catch((error) => {
  log(`FATAL: ${error.stack || error.message}`);
  process.exit(1);
});
