# ShadRox BIG-TASK PLAN — v0.0.7 push (model: Sonus 8x, budget: ~2000 credits)

You are hired for a multi-phase engineering task on ShadRox. This file is your strict, non-negotiable contract.
Baseline: HEAD d49310e — **1066/1066 tests pass, typecheck 0**. Never commit code that drops below this baseline.
At the end of every phase run: `npm run typecheck; echo $?` = 0 AND `npm test; echo $?` = 0.

---

## NON-NEGOTIABLE RULES (enforce for the entire session)

1. **Licensing:** `reference/` contains MIT/Apache-2.0 repos (void, cline, aider, OpenHands) — copying IS ALLOWED with attribution headers. **`reference/zed-main` is GPL — copying even a SINGLE LINE is strictly BANNED.** Reading its patterns is allowed; code is not.
2. **Piped exit codes lie:** `cmd | tail` hides the real exit code. Always use `command; echo $?`.
3. **Git discipline:** `git stash` / `git checkout --` / `git restore` / `git clean` are NEVER allowed. Commit after every verified port (message: "ported from X (license)"). `git push` only on explicit user command.
4. **Secrets:** Never print API keys/tokens in chat or reports. Never read the `.env` file.
5. **Build trap:** Set `SHADROX_OUTPUT_DIR` completely OUTSIDE OneDrive (e.g. `C:/Users/sourav/shadrox-build`) — OneDrive causes EBUSY crashes.
6. **Product invariants (violated = feature rejected):**
   - Anchor mismatch / ambiguous edit = ZERO bytes written (applyPipeline.e2e.test.ts guard).
   - Zero open tabs → model still gets path-inventory + disk-read files (promptContext invariant).
   - Preview never kills foreign processes — relocate the port instead.
   - Permission gate lives at folder-open only; no per-action nagging.
7. **No new npm dependencies** unless explicitly justified in the phase report.
8. **Complete-or-nothing:** a ported feature must be wired into a REAL call site with tests, or not shipped at all. No half-installed rails pretending to be features.

**DONE (do not repeat):** commandGuard, preview port-relocation, fuzzyScorer, @mentions, aider-PageRank repoMap, patchEngine+Cline-grammar, aider retry/backoff, OpenHands compaction, Trie ghost-completion, DAP core (protocol+adapter+session — no UI), agent tool-discipline loop, teams merge turn, disk-write e2e proofs, self-healing preview, chat shell access, reply-surface.

---

## PHASE 1 — CODEBASE ORIENTATION (~150 credits)

Goal: understand the complete ShadRox architecture, style, and conventions.
1. Read: `README.md`, `PENDING.txt`, `package.json`, this plan.
2. Read-only module map: `electron/*.cjs` (main, preload, workspace sandbox, git bridge, terminal-modes, preview-runtime), `src/lib/` (agent, agents, ai+ai/, autonomy, patch, search, debug, chat, terminal), `src/components/App.tsx` (5000+ line hub — learn its structure, do not refactor it), `landing/` (Next.js — SEO-critical zone).
3. Style notes: error-handling pattern, side-by-side `.test.ts` files (`node:test` + tsx), `assertTrustedRenderer` on every IPC handler.
4. Read `reference/manifests/*.md` (ranked port targets, difficulty, license).
5. Report: module map + which DONE-list items live where + Phase-3 target file inventory.

---

## PHASE 2 — SECURITY DEBT (~200 credits)

Live audit findings, fix before any feature work:
1. `api/_http.ts` (~87-100): add GitHub PAT (`ghp_`,`gho_`,`ghs_`,`github_pat_`) + AWS (`AKIA…`) regexes to `REDACT_PATTERNS` — `/api/github/*` leaks PATs via error text today. Targeted test.
2. `electron/main.cjs` `workspace:reopen` (~1493): renderer-supplied absolute path mounts with NO consent. Track consented roots in main (dialog-pick + validated argv); unknown root → `dialog.showOpenDialog` confirm before mounting.
3. Injection blast-radius (audit HIGH #1-#3):
   - Autonomy `verifyCommand` silent-exec → strict **default-deny allowlist per binary** (`npm test`, `pytest`, `tsc`, `git diff` via `execFile` argv; everything else gets the approval dialog).
   - Remove plugin/automation manifest paths (`.shadrox/automations.json`, `.shadrox/plugins/**`) from the agent-writable set; re-consent when an enabled plugin's manifest hash changes; route plugin/automation argv through the same approval gate.
   - Wrap ALL workspace-derived observations (file contents, tool output, git log/diff) in the untrusted-DATA marker — today only MCP results are wrapped.

Targeted tests + full suite after EACH fix; separate commits.

---

## PHASE 3 — ELITE ADVERSARIAL IDE ARCHITECTURE (Cursor/Devin-killer specs) (~1100 credits)

Port → adapt → wire into real call sites → test. Work order: **3A → 3B → 3C → 3D** (signature feature ko end ke pehle scope kar lena — credits kam bhi bache to 70%-ship rule poora karna hi hai; warna scope chhota kar dena, adhoora bada feature mat chhodo).

### COMPETITIVE BAR (har feature is benchmark ke against tikkaana chahiye)
- **Cursor**: tab-completion quality, @-context UX, agent fluency. Humare paas: Trie booster + @mentions + fuzzy search already; jo cheez Cursor me hai aur hum me nahi — woh target bano.
- **VS Code**: extension breadth, debugger depth, terminal integration. Humare paas: DAP rails + shell-integration (3A/3B).
- **Devin/Trae (agent products)**: planning autonomy, self-verification. Humare paas: autonomy DAG + repair loop + teams merge — inhe unke level ka reliable banao.
- **ShadRox ka structural advantage jo teeno nahi de sakte:** 100% local-first (BYOK, project files kabhi cloud nahi jaate), full desktop control (preview+terminal+editor+git ek hi process me), zero server dependency. Har design decision me ye advantage USE karo — jahan Cursor/Devin ko sandbox me naks karna padta hai, humara agent asli machine state dekh sakta hai.

### 3D. SIGNATURE FEATURE — INVENT ONE (mandatory deliverable, ~250 credits of Phase 3)
Design ONE flagship feature that no current IDE (Cursor/VS Code/Copilot/Devin/Trae/Windsurf) ships today, that ShadRox's local-first desktop position uniquely enables. Constraints:
- Must be BUILT-AT-LEAST-70% within this session's remaining credits — an impressive spec that ships 20% is a FAILURE; a modest idea that ships complete with tests is a pass.
- Must exploit what cloud IDEs cannot: total local visibility (live editor intent + terminal state + preview DOM + git history + file-watch timeline in ONE brain, on-device).
Seed ideas (pick one, improve one, or invent better — your call, justify in report):
1. **Time-Travel Workspace:** every AI turn + human edit + command + preview reload is one rewindable timeline event — scrub back with a slider and the ENTIRE workspace state (files, open tabs, terminal cwd, git position) rewinds live, then fork-forward from any point. (Checkpoint DNA already exists in ShadRox.)
2. **Watchful Pair:** agent passively observes cursor/selection/terminal churn locally, and pre-computes the likely next edit/context in idle CPU — ghost suggestion appears BEFORE you type the ask. Zero API calls until you accept.
3. **Self-Healing Proof:** any failing command/preview/test auto-captures the exact runtime context (stack + vars + logs + diff) and opens a repair PR against your own workspace — no copy-paste, no context loss.
Ship: spec paragraph → architecture → ports where needed → real call sites → tests → commit. User approval (report me ask) before Phase 4 polish ko affect kare.

### 3A. TERMINAL — Virtual Terminal State Interceptor (highest remaining gap)
- Port patterns from `reference/void-main/src/vs/workbench/contrib/terminal/common/scripts/` (shell integration sequences: command start/end markers, cwd reports, exit codes) into `electron/terminal-modes.cjs` + `src/lib/terminal/`.
- Expose a structured terminal-state API the agent can query: which command is running, real-time demarcated stdout, exit code, current cwd, hung-state detection (no output + no exit for N seconds).
- **Stdin management:** programmatic input injection into interactive CLI prompts (y/N answers, password-less prompts) — ONLY through the existing approval gate: the user sees the injected text before it lands in the PTY, same shape as `confirmAction` for commands. Never blind-inject.
- aider's command-failed → auto-fix classification heuristics into `autoFix.ts` (reference/aider-main/aider/ — exceptions/back-off sections).

### 3B. PREVIEW & DEBUGGER — Omni-Diagnostics + Visual Assertion
- **DAP state siphon:** connect existing `src/lib/debug/` rails — capture active stack frames + local variable scopes on failure. Port void's `contrib/debug` data layer (breakpoint/stackFrame/variable models — NOT its UI) and build the React layer: breakpoint markers in CodeEditor gutter, call-stack + variables panels, hover value. Scope: launch via a workspace debug-config; NO heap-snapshot profiling this wave (mark deferred — heavy, adapter-specific).
- **Auto-inject repair context:** when a run/verify fails, the repair brief prompt gets the failure's captured local-variable scope + stack appended (this is the Devin-killer move: model sees runtime truth, not guesses).
- **Visual sanity assertion loop:** on preview load/HMR, capture the DOM container state programmatically (structured check: element presence, bounding boxes, console errors — via the existing preview bridge/CDP), and assert against expected source-derived facts (route renders, no fatal console error, key selector exists). If the running model has vision capability, additionally compare a screenshot for layout sanity; if not, the structured assertion IS the gate — do not stall waiting on images. Show result as a preview-pane status chip.
- Preview pane polish: `:PORT` chip exists — add HMR/reload indicator chip (desktop.ts already flows `hmr`).

### 3C. PROMPT/CONTEXT & BYOK — the money layers
- **AST dependency context graph:** upgrade `src/lib/search/` + repoMap: when a file is queued for edit, append the type signatures / exported contract of its downstream dependents (graph-edges from the existing ranked-map data) instead of dumping whole files. Token-cheap, model-accurate.
- **Prompt caching:** port aider's `cache_control` placement discipline into ShadRox's request shaping where the provider supports it (Gemini cached content / Groq & OpenAI-compat cache suffix). This directly cuts user's per-turn cost — measure and report the before/after token math.
- **Budget trimming:** merge Cline's context-management trim ORDER (which turns drop first, tool-pair integrity) with our OpenHands compaction — keep whichever policy is stronger per case, report conflicts.
- **Model metadata DB:** port cline's `models.ts`/model-info tables (contextWindow, maxOutput, pricing per token) into `src/lib/modelRates.ts` / `modelCapabilities.ts` with Apache-2.0 attribution — replace guessed constants with real metadata; wire into contextBudget so per-provider caps drive compaction.
- **Secret scrub upgrade:** OpenHands secret-detection rules → extend prompt-scrub + `secureStore` coverage audit (never send secrets to providers inside file-context blocks).

---

## PHASE 4 — RELEASE & INTEGRATION BATTERY (~300 credits)

1. **BIG-TASK battery checklist** (author the steps; user runs the app side): T2 FAQ task via chat (data file + accordion + about page + build), rollback/checkpoint undo (chat "undo" + timeline restore), delete-file via chat, git commit via chat confirm-gate, deep Hinglish report.
2. **Installer:** on user's explicit GO only — `SHADROX_OUTPUT_DIR` outside OneDrive, `npm run dist:win`, asar-verify the artifact, prepare release payload (Setup.exe + nsis.7z + latest.yml), publish v0.0.6→v0.0.7 swap on GitHub Releases. Purane exe ka workflow: user confirms before deletion.
3. **Landing polish:** palette of beta-cta/workspace-mockup to match new silver-shield logo. NEVER touch JSON-LD / FAQ-schema 1:1 rule / `lib/download.ts` version single-sourcing.
4. **User approvals (ask, never assume):** "Built with ShadRox" about-page line keep/revert; IGNOU CODER test artifacts cleanup; add `shadrox-dist-060/` + `vibe_images/` to `.gitignore` (recommend YES).

---

## CREDIT LEDGER

| Phase | Budget | Actual |
|---|---|---|
| 1 Orientation | 150 | |
| 2 Security | 200 | |
| 3 Ports 3A→3D (3D signature ≤250) | 1100 | |
| 4 Release/battery | 300 | |
| Buffer | 250 | |

Any phase exceeds 1.5x budget → trim later phases and report immediately. Never end a turn with a broken working tree. Report format per phase: files+commits, test count (must be ≥1066), LOC ported vs written vs rejected, TODO-with-reason list.

---

### START EXECUTION: Phase 1 — Codebase Orientation
Acknowledge this contract, scan the workspace, compile the module map, analyze already-ported modules, output the Phase 1 report. Do not write code yet.
