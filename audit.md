# ShadRox — Full Codebase Audit

Date: 2026-11-21 · Scope: entire repository (Electron desktop IDE + local Express backend + agent/autonomy engine)

---

## 1. What ShadRox Is

ShadRox is a **local-first AI coding IDE**: an Electron desktop app (Windows/macOS via electron-builder NSIS/DMG) wrapping a Vite + React 19 + TypeScript frontend, an Express backend (`server.ts`, also deployed as Vercel serverless functions under `api/`), and a deeply engineered agent layer that can read, search, patch, run commands, debug (DAP), preview, and autonomously execute multi-milestone plans — all against the user's own opened workspace folder.

Stack: Electron 44 · React 19 · Vite 8 · TypeScript · Express · node-pty · chokidar · electron-updater · bytenode-compiled main/backend.

---

## 2. Architecture Map

```
┌─────────────────────────────────────────────────────────────┐
│ Renderer (React, sandboxed, contextIsolation ON)            │
│  App.tsx (6.9k lines — orchestrator)                        │
│  hooks/: useWorkspace, useDebug, useAutonomyRun, useTeamRun │
│  lib/agent/: toolLoop, tools (40 tools), toolProtocol       │
│  lib/autonomy/: run-loop, ports, events, dag, feedback      │
│  lib/patchEngine.ts + lib/patch/ (Cline-style S/R parser)   │
│  lib/ai.ts + api/ai/* (BYOK proxy to providers)             │
└──────────────┬──────────────────────────────────────────────┘
               │ contextBridge → preload.cjs (frozen API surface)
               │ ipcRenderer.invoke — every call assertTrustedRenderer'd
┌──────────────▼──────────────────────────────────────────────┐
│ Main process (electron/main.cjs, 3.8k lines)                │
│  workspace.cjs (file ops, versioned atomic saves)           │
│  command-risk.cjs / command-approval.cjs (tiered exec)      │
│  debug-host.cjs (DAP client → @vscode/js-debug adapter)     │
│  debug-autoconfig.cjs (zero-config inference)               │
│  preview-runtime / preview-assert / preview-inspect /       │
│    preview-source (iframe preview + click-to-source)        │
│  junk-scanner.cjs, proof-*.cjs (signed edit ledger),        │
│  machine-*.cjs (checkpoint/rollback receipts),              │
│  shell-integration, terminal-modes, mcp-client, updater     │
└──────────────┬──────────────────────────────────────────────┘
               │ startServer() on 127.0.0.1 (stable ports        │
               │ 43121-43123, fallback 0)                        │
┌──────────────▼──────────────────────────────────────────────┐
│ Express backend (server.ts → server.jsc in packaged app)    │
│  /api/ai/chat · /api/ai/fim · /api/ai/commit-message        │
│  /api/prompt/refine · /api/byok/validate                    │
│  /api/github/* (validate, create-repo, push)                │
│  Same handler files deploy to Vercel — no local/prod drift  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. End-to-End Flow: Prompt → Answer → Applied Change

### 3.1 Prompt ingestion
1. User types in `ChatPanel` → `App.tsx` builds a `ChatTurn[]` history (system + user + assistant + tool observations).
2. **Context assembly** (`autoContext`, `contextBudget`, `contextManifest`, `repoMap`, `projectBrain`, `completionTrie`): the app auto-attaches relevant files, repo map, diagnostics, open tabs, and memory notes — bounded by a token budget so prompts never explode.
3. **Mode selection** (`autoRoute`, `modelRouter`, `calibratedAuto`): task type (chat/code/plan/complex) picks a `RefineMode` (`src/lib/ai.ts` `REFINE_MODES`) — `plan` mode is contractually read-only (`writesFiles:false`).
4. **Provider call**: `src/lib/ai.ts` streams to the BYOK provider (OpenAI-compatible, Gemini, Groq, or user custom endpoint) **through the local backend** (`/api/ai/chat`), which holds the key server-side-ish and normalizes SSE, retries with backoff (`ai/backoff`, `ai/retryPolicy` — rate-limit aware, `stream_options`/`tools` rejection resends), and records usage (`taskUsage`, `flightRecorder`).

### 3.2 Tool loop (`src/lib/agent/toolLoop.ts`)
- The model may emit native function calls **or** fenced text blocks (```` ```shadrox:tools ````), parsed by `toolProtocol.ts` — up to `MAX_CALLS_PER_ROUND` calls per round, run in parallel.
- **40 built-in tools** (`tools.ts`): `list_directory`, `read_file`, `write_file`, `edit_file`, `apply_patch`, `find_files`, `search_text`, `problems`, `verify`, `checkpoint`/`list_checkpoints`/`restore`, `run_command`, `job_control`, `preview_control`, `preview_inspect`, `debugger_state`, `memory_*`, `find_references`/`go_to_definition`/`rename_symbol`/`semantic_search`, `web_search`/`fetch_url`, `ask_user`, `spawn_subagent`, `diff_review`, `finish`, plus external **MCP tools** (`mcp-client.cjs`, user-configured).
- **Discipline enforced in code, not prompt**: 60-round budget with soft wrap-up at 80%; stuck detection is *progress-based* (8 zero-progress steps → nudge → forceFinal); duplicate calls get a cached "[unchanged since step N]" result, never refused; every turn boundary lands in the `flightRecorder`.
- Every tool result is wrapped in `[[SHADROX_UNTRUSTED_DATA_BEGIN/END]]` markers — prompt-injection hygiene.
- Read-before-write tracking (`turnState`), auto-reads for small files, rewrite-risk guard on `write_file`, `isProtectedAgentWritePath` blocks plugin/automation manifests.

### 3.3 Writes & patches
- **`write_file`/`edit_file`**: verified save path — pre-apply verification (`change-verify.cjs`), version-pinned atomic write via `workspace.cjs`, read-back confirmation.
- **`apply_patch`**: `{path, old, new}` hunks applied in memory first — any mismatch aborts the whole patch (atomic); `locateUniqueMatch` + `closestRegionHint` give the model the nearest on-disk region on failure.
- **Reply edit blocks** (`path= … ``` fences): parsed by `patchEngine.ts` — a 4-level matcher (exact → trimmed-lines → whitespace-stripped → similarity ≥0.66 on ≥3-line blocks), EOL normalization, overlap refusal, ambiguous-match safety (self-replacement only).
- **Atomic apply rail** (`atomicApply.ts` + `applyPipeline.e2e.test.ts`): multi-file patches staged → verified → committed or rolled back; exercised end-to-end against the real `workspace.cjs` disk layer in tests.

### 3.4 Verification & finish
- `verify` tool detects project kind (package.json/lockfile, pytest, cargo, go) and runs real typecheck/build/test through the command runner; `finish` is **refused** after writes until verification ran.
- `problems` surfaces compiler diagnostics (ts-service.cjs worker).
- Checkpoints: automatic before first write; `restore` rolls back (user-approved).

### 3.5 Autonomous runs (`src/lib/autonomy/`)
- `askPlan` → model emits milestones → DAG validation (cycles, confinement to workspace paths, budget caps) → `run-loop.ts` executes each milestone via `runTurn` (same toolLoop, headless).
- **Per attempt**: turn → `verifyMilestone` (`ports.ts`) — type diagnostics scoped to expected+touched files, placeholder scanning, optional `verifyCommand` (allowlisted forms auto-run, others need approval) → verdict `passed`/`failed`/`unverified`.
- **Honesty invariants** (recently hardened): a zero-write turn cannot pass a milestone whose expected files are absent (`failed`) or unverifiable (`unverified`); verdict events carry attempt number + first diagnostic/note; `unverified` never counts as `passed`; failed runs roll back to the pre-run checkpoint.
- Team runs (`useTeamRun`, `src/lib/agents/`) parallelize milestones across role agents with an ownership/apply-policy layer.

### 3.6 Commands, terminal, preview, debug
- **`run_command`**: `command-risk.cjs` tiers every command READ < BUILD_TEST < INSTALL < MUTATE < NETWORK < DANGEROUS; compound commands take the worst segment; dialog-tier commands open a native approval dialog — renderer flags are never authorization; approval is invalidated if the workspace changes mid-dialog.
- **Terminal**: node-pty + shell-integration (OSC 633) → prompt/command lifecycle, hung detection, job control (J1… ids, output rings, 30-min ceilings).
- **Preview**: `preview-runtime.cjs` serves workspace apps (static + dev servers); `preview-source.cjs` injects a click-to-source bridge **and runtime error capture** (`window.onerror`/`unhandledrejection` → stack forwarded to the agent); `preview-assert.cjs`/`preview-inspect.cjs` give the agent DOM/console/assertion evidence.
- **Debugger**: `debug-host.cjs` speaks DAP to `@vscode/js-debug` (or configured adapter), validates `shadrox.debug.json`, and — new — **infers zero-config launch configs** (`debug-autoconfig.cjs`) for Node/Vite/Next/Python workspaces through the same `normalizeConfig` path, so `debug:start` resolves them identically.

### 3.7 Evidence & receipts
- `proof-chain.cjs`/`proof-store.cjs`/`proof-service.cjs`: signed hash-chained ledger of edits; receipts exportable and re-verifiable.
- `machine-git.cjs`/`machine-delta.cjs`/`machine-receipt.cjs`: checkpoint = Git HEAD/index + file snapshots; rewind restores baseline atomically, refuses on foreign locks/conflicts.
- `junk-scanner.cjs`: dependency-graph walk from entry points → unused files/dead folders → recycle-bin delete.

---

## 4. Security Posture (Good)

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; preload exposes a frozen, minimal bridge.
- Every privileged IPC handler calls `assertTrustedRenderer` (main frame + own origin only).
- Commands are classified main-side; approval cannot be bypassed by renderer-supplied flags; DANGEROUS always dialogs.
- Workspace confinement everywhere: paths normalized, `..`/absolute/drive-letter rejected, `isPathInsideDirectory` checks, protected manifest writes blocked.
- BYOK keys never shipped; custom endpoints gated by `SHADROX_LOCAL_BACKEND` (open-proxy protection on the Vercel deployment).
- Secret redaction in upstream errors (`proof-redact` patterns); environment scrubbing for spawned adapters (`scrubEnvironment`).
- Preview bridge is deliberately dumb: no preload access, no eval, baked-in file paths, postMessage-only.
- Unsigned-build warning is expected; no code-signing cert configured.

---

## 5. Strengths

1. **Verification honesty** — the autonomy engine distinguishes `passed`/`failed`/`unverified` and refuses to launder no-op turns into passes; a step nobody proved is never claimed as succeeded.
2. **Atomicity everywhere** — patches, multi-file applies, checkpoints, and rollbacks are all-or-nothing with receipts.
3. **Real-evidence agent loop** — diagnostics, command exit codes, preview console/DOM, DAP stack frames, and patch-failure regions all feed back into the next turn instead of letting the model guess.
4. **Prompt-injection hygiene** — untrusted-data markers, tool-result clipping, control-char stripping, bounded outputs everywhere.
5. **Test discipline** — 2,542 tests / 193 files / 44 suites, all passing; heavy use of real-disk e2e (`applyPipeline.e2e.test.ts`, `pipelineHarness`) rather than mocks; `tsc --noEmit` clean.
6. **Single-source contracts** — renderer and main share `.cjs` modules (dap-framing, debug-autoconfig, command-risk) so behavior can't drift between processes.
7. **BYOK + local backend** — no keys in the client bundle; same API handlers serve local dev and Vercel prod.

---

## 6. Weak Points & Risks

1. **`App.tsx` is a 6,919-line monolith** — the single biggest maintainability risk; orchestration, state, and UI concerns are concentrated in one component. Extraction into hooks/feature modules is overdue.
2. **`server.ts` binds `0.0.0.0` by default** (`host` option) — in dev (`npm run dev`) the API is reachable from the LAN, not just loopback. Packaged app uses loopback, but dev mode exposes BYOK-proxied endpoints to the network. Should default to `127.0.0.1`.
3. **Python debug inference is aspirational** — `debug-autoconfig.cjs` offers a `main.py` launch through the js-debug (JS-only) adapter; it will fail at runtime unless the workspace supplies a Python-capable `adapterCommand`. Better to gate on adapter capability or mark it clearly.
4. **Unsigned binaries** — Windows SmartScreen will warn on install; no cert chain configured.
5. **Vite chunk sizes** — `index-*.js` ≈ 2.3 MB (708 kB gzip), esbuild wasm asset ≈ 14 MB; cold start and memory footprint suffer. Dynamic-import boundaries exist but are flagged `INEFFECTIVE_DYNAMIC_IMPORT` (tools/toolLoop/history statically pulled anyway).
6. **OneDrive `EPERM` rename failures** during packaging — environmental, recovered by copy+delete, but slows builds and can corrupt `win-unpacked` if interrupted mid-fallback. `SHADROX_OUTPUT_DIR` escape hatch exists but isn't default.
7. **`import.meta` in CJS build** — `server.ts` compiled to CJS emits an empty `import.meta` warning; works today by accident of `__filename` fallback, fragile if bundling changes.
8. **Junk scanner is heuristic** — entry-point graph misses dynamic imports, reflection, and string-computed paths; "unused" files may be false positives (mitigated by recycle-bin delete + confirm dialog, but still).
9. **Auto-config inference edge cases** — `package.json "main"` pointing into `dist/` won't be found (walk skips `dist`), and Python/Next configs depend on `node_modules` binaries that may not be installed — failures surface as adapter errors rather than upfront messaging.
10. **Single-session debugger & preview ownership** — one debug session and bounded preview identities at a time; concurrent-workspace debugging is serialized by design (acceptable, but a ceiling).
11. **`diagnose_renderer.cjs` + logs** — leftover diagnostic scripts in repo root (untracked); should be removed or gitignored to avoid shipping in builds.
12. **Hook-order fragility (fixed once, pattern remains)** — `App.tsx` mixes ~50 hooks with early returns; the React #310 crash we fixed is the class of bug this file invites again. A lint rule or component split would prevent recurrence.

---

## 7. Known Fixed Issues (this cycle)

| Issue | Fix |
|---|---|
| White screen: `server.jsc` path + loopback flakiness | `shadrox-app://` protocol serves UI from ASAR; `/api/*` proxied to backend |
| React #310 crash (hooks after early return) | Auth early-return moved below all hooks in `App.tsx` |
| Milestone false-pass on no-op turn | `verifyMilestone` requires expected files on disk or downgrades verdict |
| Opaque duplicate failure trace | Verdict events carry attempt + first diagnostic/note |
| Blind component guessing on preview errors | Preview bridge captures `error`/`unhandledrejection` stacks |
| `apply_patch` unrecovered mismatch | `closestRegionHint` attaches nearest on-disk region to failures |
| Wrong `public/index.html` created | Entry-point precedence guard in `write_file`/`apply_patch` |
| `workspace:scan-junk` clone error | `cancel` function stripped before IPC return |
| Debug panel dead-end without config | Zero-config inference in `debug-host.cjs` |

---

## 8. Verdict

ShadRox is an unusually **evidence-driven** agent IDE: the recurring theme is "never claim what you can't prove" — enforced in the verifier, the patch engine, the command classifier, and the receipt ledger. The architecture is sound and security-conscious. The dominant risks are **concentration** (`App.tsx`, main.cjs) and **scale** (bundle size, unsigned binaries, OneDrive I/O), not correctness. Priority order for hardening: split `App.tsx`, loopback-bind the dev server, gate Python inference on adapter capability, and set up code signing.
