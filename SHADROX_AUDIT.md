# ShadRox — Deep Architectural, Security, Performance & UX Audit

> Read-only audit. Every finding cites `file:line`.
> Severity legend: **P0** = critical (security/stability/data-loss), **P1** = high-impact cleanup/speed, **P2** = polish.
>
> **Update (post `git pull` 94bb36f + local fixes):** Upstream already landed fixes for most P0/P1 items — dead-code deletion (§2), tool-schema memoization + incremental budget + head/tail truncation (§3), routing `FRAMEWORK_OR_CODE_QA_RE` (§3), semanticIndex/trie eviction on workspace close (§5), `beta-logger` secret redaction + per-key `secure:get` (§4). Local fixes applied this pass: removed the unused bulk `secure:get-all` IPC (P0 secret exfil), deleted orphaned `proof/ledger.test.ts`, added `dedupeMapInputFiles` to fix a typecheck break, memoized ChatPanel `symbols` prop. Remaining open items are listed inline as **OPEN**.
>
> **Update (UI/UX polish pass):** Verified most requested polish was already implemented upstream — AI-Studio pre-turn checkpoints + `↺ Restore` on user bubbles (`ChatPanel.tsx:1074`, `useOrchestrationController.ts:298/2077`), image `onPaste` (`ChatPanel.tsx:663`), native OS paperclip picker (`ChatPanel.tsx:1946`), autofocus `Search models…` (`ChatPanel.tsx:923`), SCM Push/Pull/Sync + Stage/Unstage All + per-file Discard/Open + `Ctrl+Enter` commit (`ScmPanel.tsx:394/480/454`), `delete_file` recursive folder delete with root/`.git`/`node_modules` guards (`workspace.cjs:633`), `MAX_PARALLEL_TERMINALS = 2` (`toolLoop.ts:55`). "Enter to send", "N files ready", "YOUR KEY" pill, Preview MARKDOWN/observed pills, and an Export-ZIP button did **not** exist. Local edits this pass: trimmed editor top bar to breadcrumb/Find/Format/Save (`CodeEditor.tsx:1408`), removed the "Photo ready to send" label (`ChatPanel.tsx:1590`). Typecheck clean, build ✓, 2504/2504 tests pass.

---

## 1. Architecture & Codebase Health Overview

### 1.1 High-level map

**Frontend (Vite + React 19 + Tailwind v4)** — entry `index.html` → `src/main.tsx` → `src/App.tsx`.
- `src/App.tsx:57` is the single root component; it composes ~20 hooks and renders either `AuthScreen` (`src/App.tsx:763`), `Stage2Hub` (`src/App.tsx:777`), or the full workspace (`src/App.tsx:799`).
- Workspace layout is a 3-column grid: `ActivityRail` + `ChatPanel` + `EditorWorkspacePane` (`src/App.tsx:829-999`), with `PreviewPane` docked inside the editor pane (`src/App.tsx:724-758`).
- State is **fully lifted into App.tsx** (30+ `useState`/`useRef` at `src/App.tsx:58-96`) and threaded down through hook return objects. There is no state library (Redux/Zustand/Jotai); all cross-cutting state flows through hook composition.

**Agent loop (`src/lib/agent/`)** — the core engine:
- `toolLoop.ts:47` `DEFAULT_MAX_TOOL_ROUNDS = 60`; `toolLoop.ts` is a pure control loop (1369 lines) driving both chat turns and headless autonomous milestones.
- `tools.ts` (2278 lines) defines tool schemas, `runTool`, output clipping (`tools.ts:735`), and per-round caps.
- `toolGatekeeper.ts` builds the `WorkspaceToolContext` (workspace open, preview status, active jobs, git, terminal) consumed by the prompt.
- `runPolicy.ts:159` `classifyTurnIntent` routes each prompt to `conversational` / `advisory` / `execution` and selects tool bundles (`runPolicy.ts:141`).
- Supporting: `loopContext.ts` (compaction/working memory), `stuck.ts` (progress-based nudge), `checkpoints.ts`, `taskPlan.ts`, `finishTool.ts`, `semanticIndex.ts`, `repoMap.ts`, `subagent.ts`, `mcpTools.ts`.

**Context builder (`src/hooks/useContextBuilder.ts`, 804 lines)** — assembles the system prompt each turn: prompt core (`useContextBuilder.ts:422-593`), repo map (`:535-594`), downstream contracts (`:556-587`), file excerpts (`:613-659`), manifest (`:735-744`), tool schemas (`:526-533`). Consumed by `useOrchestrationController` (`src/App.tsx:341-357`).

**Desktop IPC bridge (`electron/`)** — `main.cjs` registers IPC handlers; `preload.cjs` exposes a typed bridge consumed via `src/lib/desktop.ts` (`getDesktopBridge`, `src/App.tsx:102`). Eight IPC modules in `electron/ipc/`: `workspaceIpc`, `gitIpc`, `previewProtocol`, `previewRuntimeIpc`, `terminalJobsIpc`, `mcpIpc`, `authAppIpc`, `debugProofIpc`. Security primitives: `desktop-security.cjs` (`assertTrustedRenderer`), `workspace.cjs` (path containment), `command-risk.cjs` (risk tiering), `proof-*.cjs` (signed receipts + redaction).

### 1.2 Stability, TypeScript strictness, bundle/runtime weight

- **TypeScript is NOT strict.** `tsconfig.json:2-26` sets no `strict`, no `noImplicitAny`, no `strictNullChecks`. `skipLibCheck: true` (`tsconfig.json:13`) and `allowJs: true` (`:17`) further relax checking. This is the single biggest structural health risk: the entire `src/` tree compiles with implicit `any` and unchecked nulls.
- **Lint == typecheck == `tsc --noEmit`** (`package.json:24-25`) using a vendored `typescript-legacy`. No ESLint, no separate style gate.
- **Bundle weight is heavy but chunk-split.** `vite.config.ts:63-90` manually splits `react-vendor`, `xterm-vendor`, `icons-vendor`, `esbuild-vendor`, `codemirror-core`. `chunkSizeWarningLimit: 700` (`vite.config.ts:62`). Heavy deps: `esbuild-wasm` (`package.json:68`), `@xterm/*` (`:60-63`), `@codemirror/*` (`:40-52`), `lucide-react` (`:70`), `localEmbeddings` transformers pipeline (`src/lib/localEmbeddings.ts`).
- **Obfuscation is opt-in** (`SHADROX_OBFUSCATE=1`, `vite.config.ts:50,102-119`) with `controlFlowFlattening` + `deadCodeInjection` — only for production builds, adds runtime cost when enabled.
- **Desktop build** ships `asar: true` with `asarUnpack` for `@esbuild` (`package.json:85-88`) and extra TS libs + debug adapters as `extraResources` (`:118-134`).
- **Test coverage is broad** (colocated `*.test.ts` throughout `src/lib` and `electron/`), run via `scripts/run-tests.mjs` (`package.json:21`). This is a genuine strength.

**Verdict:** feature-rich and well-tested, but held back by non-strict TS, a monolithic `App.tsx`, and a large eager bundle. Stability is "works, but type-unsafe."

---

## 2. Dead Code, Orphaned Modules & Leftover Bloat

### 2.1 Orphaned source modules — SAFE TO DELETE (no import references found)

- `src/components/TaskInspector.tsx` — never imported by `App.tsx` or any component. **SAFE TO DELETE.**
- `src/hooks/useCapsules.ts` — no importer. **SAFE TO DELETE.**
- `src/hooks/useIntentGraph.ts` — no importer. **SAFE TO DELETE.**
- `src/lib/capsules/` (entire dir) — only consumer was `useCapsules.ts`. **SAFE TO DELETE.**
- `src/lib/debug/` (entire dir) — old Debugger panel logic; no importer. **SAFE TO DELETE.**
- `src/lib/intent/` (entire dir) — superseded by `src/lib/agent/runPolicy.ts`; no importer. **SAFE TO DELETE.**
- `src/lib/proof/verify.ts` and `src/lib/proof/receipts.test.ts` — orphaned; the live proof path is `electron/proof-*.cjs`. **SAFE TO DELETE.**
- `src/lib/indexReuse.ts` (+ `indexReuse.test.ts`) — no importer. **SAFE TO DELETE.**
- `src/lib/promptContext.ts` (+ test) — no importer. **SAFE TO DELETE.**
- `src/lib/providerKeys.ts` (+ test) — no importer. **SAFE TO DELETE.**

### 2.2 Orphaned electron modules — SAFE TO DELETE (debug cluster never registered)

- `electron/debug-host.cjs`, `electron/debug-autoconfig.cjs`, `electron/dap-framing.cjs` — the entire `debug:*` IPC cluster (`electron/ipc/debugProofIpc.cjs:86-186` `registerDebugHandlers`) is **exported but never called** in `electron/main.cjs` (only `registerProofHandlers` at `main.cjs:432-439` is wired). **SAFE TO DELETE** (also removes dead attack surface — see §4 P2).
- `electron/automation-webhook.cjs` (+ test) — loopback webhook server; **NEEDS REVIEW** — not referenced by `main.cjs`; if the Plugins/Webhook feature was removed, **SAFE TO DELETE**.

### 2.3 Stale / build artifacts & leftover bloat

- `dist/`, `dist_staging/`, `dist_desktop/` — build outputs, already gitignored (`.gitignore:3-8`). **KEEP (artifacts, not committed).**
- `landing/` — separate Next.js project with its own build artifacts; gitignored partially (`.gitignore:24-25`). **NEEDS REVIEW** — confirm it is still a maintained sub-project vs stale.
- `build.log`, `AGENT_AUDIT_REPORT.md` (root, 17 KB, dated 11/22) — leftover scratch/report. `build.log` is covered by `*.log` (`.gitignore:18`); `AGENT_AUDIT_REPORT.md` is **not** ignored → **SAFE TO DELETE / gitignore**.
- `.shadrox/` — internal config dir; **NEEDS REVIEW** (likely local-only; add to `.gitignore` if not intended to ship).
- `benchmark/` (root) and `src/lib/benchmark/` — test infra; **KEEP** (used by `npm run benchmark`, `package.json:22`).

### 2.4 Apparent duplicates that are NOT duplicates — KEEP

- `src/lib/repoMap.ts` vs `src/lib/agent/repoMap.ts` — distinct: the former is the prompt-budget helper (`repoMapBudgetFor`, `selectDependentFiles`), the latter builds the ranked PageRank map. Both used in `useContextBuilder.ts:6,44`. **KEEP.**
- `src/lib/compaction.ts` vs `src/lib/compaction/` — distinct concerns; both referenced. **KEEP.**
- `src/lib/ai.ts` vs `src/lib/ai/` — `ai.ts` is the public `streamChat` entry; `ai/` holds provider adapters. **KEEP.**
- `src/lib/agent/` vs `src/lib/agents/` — `agent/` is the loop; `agents/` holds `workspaceManifest` etc. **KEEP.**

---

## 3. Agent Pipeline, Prompt & Token Efficiency

### P0 — Token / cache / correctness

- **P0 — Tool schemas rebuilt every turn, no memoization → breaks provider prompt cache.** `useContextBuilder.ts:526-533` calls `describeTools(...)` inline inside the per-turn `core` build; the 2000+ char schema block is re-serialized each turn with no stable ordering guarantee, so the prefix that providers cache is invalidated turn-over-turn. Memoize on `(model, mcpToolSignature, toolContextEpoch)`.
- **P0 — Triple context overlap: repo map + retrieval + manifest inject the same files independently.** Repo map at `useContextBuilder.ts:535-594`, semantic/keyword retrieval at `:649-659`, and the context manifest at `:735-744` each re-list overlapping file sets with no shared dedup across the three. Result: the same paths/signatures are paid for 2–3× in the prompt. Consolidate into one manifest-driven injection.
- **P0 — System `core` array is unbounded; budget is applied only after assembly.** `useContextBuilder.ts:422-593` pushes rules, memory, skills, tool schemas, downstream contracts, and repo map with no running budget; `fitSystemContext` / `systemInstructionBudgetChars` (`contextBudget.ts`) only trims at the end (`useContextBuilder.ts` post-assembly). A large repo map can crowd out the actual task before the budget pass runs. Enforce budget incrementally as each block is pushed.

### P1 — Routing / truncation / loop

- **P1 — Code questions with no attached file misroute to `conversational` (no tools).** `runPolicy.ts:166-171` `hasFileOrCodeCue` requires an attachment, file-extension, stack trace, backtick, or codebase noun; a plain "why does my React effect run twice?" with none of those falls through to `conversational` (`:173-198`) and gets zero tools. Add a code-domain keyword fallback before the conversational branch.
- **P1 — "find and fix bug" routes to `advisory` (read-only).** `runPolicy.ts:213-225` checks `EXPLORATION_VERB_RE` (`find`, `scan`, `check`…) before `EXECUTION_IMPERATIVE_RE`; because `find` matches first and the guard is `!EXECUTION_IMPERATIVE_RE`, a prompt containing both "find" and "fix" is still classified advisory only if the execution verb is absent — but "find and fix" *does* contain `fix`, so the real risk is the ordering at `:110-114` vs `:107-108` where exploration is evaluated in the same predicate. Verify with a regression test; the intent of "find *and* fix" must be `execution`.
- **P1 — Tool output truncation keeps head only for `read_file`/`search_text`; only `run_command` gets head+tail.** `tools.ts:735-738` `clip()` slices the first `MAX_TOOL_OUTPUT_CHARS`; `capCommandSection` head+tail (`tools.ts:741-745`) is applied only to command output. A long `read_file` loses its tail (the part the model usually needs). Apply head+tail to file/search results too.
- **P1 — Progress tracker can be fooled by reading new-but-irrelevant files.** `toolLoop.ts:286-356` treats "new information" as progress; a model that keeps opening unrelated files looks productive and never trips the `ZERO_PROGRESS_LIMIT = 8` nudge (`toolLoop.ts:49`). Weight progress by relevance to the task plan, not mere novelty.

### P2 — Compaction / routing calibration

- **P2 — Compaction triggers at a fixed 70% of 160 K chars.** `loopContext.ts:16,267` hardcodes the threshold; wrong for small-context models (triggers too late) and wasteful for large ones. Derive from the active model's context window (`modelCapabilities.resolveContextWindow`).
- **P2 — `summarizeObservation` drops file paths from `read_file` results (160-char cap).** `loopContext.ts:139-162` — the compacted observation loses the path, forcing re-reads. Keep the path prefix.
- **P2 — Auto-route assumes a fixed 25% digest ratio with no calibration feedback.** `autoRoute.ts:25,149-151` — the digest-size heuristic is static; wire `calibratedAuto` outcomes back into the ratio.

---

## 4. Desktop IPC, File Safety & Security Risks

### P0 — Critical

- **P0 — Package managers tiered `INSTALL` auto-run with NO approval dialog.** `electron/command-risk.cjs:84-89` lists `apt/apt-get/dnf/yum/brew/choco/winget/pacman/npm/pip/conda/cargo/go/uv/poetry/bundle` as `INSTALL`; `command-risk.cjs:33` `AUTO_TIERS = {READ, BUILD_TEST, INSTALL}`; `command-approval.cjs:62-67` skips `showApproval` for any auto tier. **Impact:** `npm install <pkg-with-install-script>`, `apt-get install <malicious>`, `brew install` execute arbitrary code with user privileges, no dialog. This violates the module's own "unknown = MUTATE" fail-safe (`command-risk.cjs:19`). Move `INSTALL` to `DIALOG_TIERS`, or require approval when the package name is not allowlisted.
- **P0 — Classifier/executor tokenizer divergence (shell-quote bypass), worst on Windows.** Classifier uses `shell-quote` with `{ escape: '\u0000' }` on Windows (`command-risk.cjs:459-463`) + custom `protectWindowsSyntax` (`:335-377`); the executor uses a naive regex splitter `tokenizeCommand` (`electron/ipc/terminalJobsIpc.cjs:101-107`) and, for "complex" commands, `spawn(text, [], { shell: true })` (`terminalJobsIpc.cjs:349`). The two parsers can disagree on `^` escapes, `%VAR%`, and quoted paths, so a line classified READ/MUTATE may execute with different effective args. Unify on one tokenizer; fail closed on divergence.

### P1 — High

- **P1 — All decrypted secrets returned in plaintext over one IPC call.** `electron/ipc/authAppIpc.cjs:49-63` `secure:get-all` decrypts every `shadrox.byok.*`/`shadrox.auth.*` value (`:57`) and returns the full map to the renderer. Any renderer compromise exfiltrates all provider keys in one round trip. Add a per-key `secure:get` and never bulk-return.
- **P1 — `logs:record` persists unredacted arbitrary metadata.** `electron/main.cjs:483-495` stores `rawEntry.meta` (arbitrary object) + message to `userData/logs` with no redaction; `logs:getRecent` (`main.cjs:478-482`) returns them. `src/lib/secrets.ts:53-58` redaction exists but is never applied here. A model/renderer that logs a key persists it plaintext.
- **P1 — Workspace console output streamed over IPC unredacted.** `electron/main.cjs:367-380` forwards console text to `preview:output` events unredacted; only the proof *receipt* path redacts (`proof-service.cjs:88-90`). `console.log(process.env.API_KEY)` in workspace code leaks live.
- **P1 — CSP stripping weakens preview iframe isolation.** `electron/ipc/previewProtocol.cjs:431` strips the page's own `<meta http-equiv="Content-Security-Policy">` (`csp-strip.cjs:98-174`) before serving, and `preview-source.cjs:200` injects an inline bridge script; the renderer CSP header (`previewProtocol.cjs:21-29,277-288`) is applied only to `rendererOrigin`, not `shadrox-preview:` frames. Preview pages run without their intended CSP.
- **P1 — `backup-file` is an arbitrary-content write outside the workspace.** `electron/ipc/workspaceIpc.cjs:345-368` writes attacker-supplied `content` to `userData/file-backups/<sha256(root)>/<sanitized>.bak` (`:362-366`). Traversal within the dir is blocked, but it is an arbitrary-write primitive to a predictable userData path.
- **P1 — `git:discard` recursive delete is less defensive than `delete-path`.** `electron/ipc/gitIpc.cjs:346-363` uses `fs.promises.rm(target,{recursive:true})` (`:359`) with only `isPathInsideDirectory` + symlink rejection; it lacks `workspace.cjs`'s `assertSafeSubtreeForDelete` hidden/generated-entry sweep (`workspace.cjs:608-631`).
- **P1 — No explicit "refuse to delete workspace root / `.git` / `node_modules`" guard.** `electron/workspace.cjs:76-97` `normalizeRelativePath` rejects empty/`.`/`..`/absolute, and protection relies on `IGNORED_DIRECTORIES` + hidden-dot rejection (`workspace.cjs:614-616,637-639`). Effective, but defense-by-limitation rather than an explicit assertion. Add an explicit root/`.git`/`node_modules` refusal.

### P2 — Hygiene

- **P2 — Dead `debug:*` handlers are an unregistered attack surface.** `electron/ipc/debugProofIpc.cjs:86-186` `registerDebugHandlers` (spawns external debug adapters, `:100-119`) is never called in `main.cjs`. Delete the cluster (§2.2) to remove the surface.
- **P2 — Updater has no visible custom signature pinning.** `electron/updater.cjs:33-36,48-62` relies on electron-updater defaults (good: `autoDownload=false`), but no additional public-key pinning beyond built-in Authenticode/macOS verification.
- **P2 — MCP allows outbound http(s) to arbitrary hosts (consent-gated).** `electron/ipc/mcpIpc.cjs:134-136`, `mcp-client.cjs:39-50` `isSafeHttpUrl` allows any http(s) host; mitigated by user dialog consent (`mcpIpc.cjs:276-306`) and encryption at rest. Not SSRF (webhook is receive-only, loopback `automation-webhook.cjs:6`).
- **P2 — Terminal stdout/stderr streamed unredacted over IPC.** `electron/ipc/terminalJobsIpc.cjs:389-394,426-438` — `cat .env` / `echo $SECRET` leaks live. By design for UX, but a secret sink.

### Verified secure (positive findings)

- **IPC sender validation is consistent:** every `ipcMain.handle` across all 8 IPC files calls `assertTrustedRenderer(event)` verifying `event.sender === mainWindow.webContents` + same-origin main frame (`electron/desktop-security.cjs:78-89`).
- **Path containment on read/write/delete:** `normalizeRelativePath` (`workspace.cjs:76-97`), `resolveWorkspaceDirectory` with `realpath`+`isWithinRoot` (`workspace.cjs:148-170`), `resolveWorkspaceFile` (`:176-202`), `deletePath`+`assertSafeSubtreeForDelete` (`:608-666`); symlinks rejected (`:164,198`); `.git`/`node_modules` excluded (`:40-43,614`). **No path traversal found** in any reviewed handler.
- **Secrets encrypted at rest:** `safeStorage.encryptString`, mode `0o600` — `secure-store.json` (`authAppIpc.cjs:44-47`), MCP env/headers (`mcpIpc.cjs:38,60-68`), proof keys (`proof-keyring.cjs:132-138`).
- **Command proof redaction:** `proof-redact.cjs:13-38` redacts `NAME=secret`, `Authorization:`, URL userinfo, bare provider keys before signing.
- **Window/webview isolation:** webviews disabled (`main.cjs:356-358`); `setWindowOpenHandler` allows only `blob:`/`https:` via `shell.openExternal` (`main.cjs:340-355`); `will-navigate` blocks cross-origin (`:359-361`); `webPreferences` `contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true` (`main.cjs:299-305`).
- **automation-webhook:** loopback-only (`automation-webhook.cjs:6`), constant-time secret compare (`:64-69`), rate limit 10/60s (`:166-176`), 64 KiB body cap (`:8`).

---

## 5. Performance, Memory & UI Bottlenecks

### P0 — Unbounded caches / leaks

- **P0 — `semanticIndex` module-level Maps never evict.** `src/lib/agent/semanticIndex.ts:212-213` `memoryIndexes` / `lastRefresh` keyed by `workspaceId`; `persist()` sets every workspace and survives workspace switches. Monotonic growth across sessions.
- **P0 — `completionTrie` module-level `projectTrie` + `documentTokens` never cleared on workspace change.** `src/lib/completionTrie.ts:256,261`; `ingestWorkspacePaths` adds a `path:` entry per file; only `ejectDocument` removes and it is not called for closed workspaces.
- **P0 — Electron module-level session Maps grow per session/workspace with no eviction on close.** `electron/main.cjs:76` `terminalSessions`, `electron/ipc/workspaceIpc.cjs:33` `workspaceWatchers`, `electron/ipc/previewRuntimeIpc.cjs:196` `previewStartGenerations`.

### P1 — Heavy / re-render

- **P1 — `planApprovalGateRef` Set accumulates plan IDs, never pruned.** `src/hooks/usePatchManager.ts:59`.
- **P1 — `handlesRef` Map rebuilt on tree changes; old FileSystemAccess handles not revoked.** `src/hooks/useWorkspace.ts:327` — retains file handles for closed trees.
- **P1 — ChatPanel receives freshly-built props every render → re-render.** `src/App.tsx:903-908` rebuilds `symbols` via inline `outline.symbols.map`; `workspace.files`/`allFiles` passed directly (`:911-912`). No `React.memo` boundary; combined with **no message-list virtualization** (no `react-window`/`@tanstack/react-virtual` anywhere in `src`), long chats are O(n) DOM.
- **P1 — CodeEditor reconfigures CodeMirror on prop changes.** `src/components/CodeEditor.tsx:595` recomputes `dirty = new Set(dirtyFiles)` and reconfigures extensions on prop identity changes; verify extension array is memoized to avoid full reconfigure per keystroke.
- **P1 — `localEmbeddings` transformers pipeline loaded eagerly.** `src/lib/localEmbeddings.ts` — heavy runtime + bundle; lazy-load only when semantic retrieval is enabled.
- **P1 — `repoMap` rebuilt per context build with no cache.** `src/lib/agent/repoMap.ts` — recomputed each turn in `useContextBuilder.ts:535`.

### P2 — Debounce / startup

- **P2 — Diagnostics debounce may never settle.** `src/hooks/useDiagnostics.ts:171-173` 900 ms debounce depends on `overrides`, which App passes as a new array identity each render (`src/App.tsx:126-129` `useMemo` on `workspace.files`/`dirtyFiles` — stable only if those are stable) — if identity churns, the timer resets continuously.
- **P2 — Synchronous heavy work at first load.** `semanticIndex.loadPersisted` JSON parse (`semanticIndex.ts:228`) runs synchronously on first load; repo map + trie build on first context build.
- **P2 — Bundle weight.** `esbuild-wasm`, `@xterm/*`, `@codemirror/*`, full `lucide-react` named imports — chunk-split (`vite.config.ts:63-90`) but still large; consider lazy `import()` for editor/preview/xterm.

---

## 6. Prioritized Action Plan

### P0 — Critical (fix immediately)

1. **Stop auto-running package managers.** Move `INSTALL` out of `AUTO_TIERS` (`command-risk.cjs:33,84-89`) or gate non-allowlisted packages behind `showApproval` (`command-approval.cjs:62-67`).
2. **Unify command tokenizer** between classifier (`command-risk.cjs:459-463`) and executor (`terminalJobsIpc.cjs:101-107,349`); fail closed on divergence.
3. **Eliminate bulk secret return.** Replace `secure:get-all` (`authAppIpc.cjs:49-63`) with per-key fetch; never ship all keys to the renderer at once.
4. **Redact the log/console/terminal IPC paths.** Apply `secrets.ts` redaction in `main.cjs:483-495` (logs), `main.cjs:367-380` (console), and assess `terminalJobsIpc.cjs:389-394`.
5. **Fix prompt-cache breaker + triple context overlap.** Memoize `describeTools` (`useContextBuilder.ts:526-533`); dedup repo map / retrieval / manifest into one injection (`:535-594,649-659,735-744`).
6. **Bound the system `core` incrementally.** Enforce `systemInstructionBudgetChars` as each block is pushed (`useContextBuilder.ts:422-593`), not after.
7. **Evict the three unbounded module caches.** `semanticIndex.ts:212-213`, `completionTrie.ts:256,261`, and the electron session Maps (`main.cjs:76`, `workspaceIpc.cjs:33`, `previewRuntimeIpc.cjs:196`) — clear on workspace close.
8. **Enable TypeScript `strict`.** `tsconfig.json:2` — adopt `strict`/`strictNullChecks` (phased) to stop implicit-any crashes.

### P1 — High-impact cleanup & speed

9. Delete orphaned modules (§2.1): `TaskInspector.tsx`, `useCapsules.ts`, `useIntentGraph.ts`, `capsules/`, `debug/`, `intent/`, `proof/verify.ts`, `indexReuse.ts`, `promptContext.ts`, `providerKeys.ts`.
10. Delete the unregistered debug IPC cluster (§2.2/§4 P2): `debug-host.cjs`, `debug-autoconfig.cjs`, `dap-framing.cjs`, `debugProofIpc.cjs` handlers.
11. Fix routing edge cases (§3 P1): code-question-without-file → tools; "find and fix" → execution; add regression tests in `runPolicy.test.ts`.
12. Head+tail truncation for `read_file`/`search_text` (`tools.ts:735-745`).
13. Progress tracker relevance weighting (`toolLoop.ts:286-356`).
14. Virtualize the chat message list; memoize `symbols`/`files` props (`src/App.tsx:903-912`); add `React.memo` around `ChatPanel`.
15. Memoize CodeEditor extension array (`CodeEditor.tsx:595`); lazy-load `localEmbeddings` and editor/xterm.
16. Explicit root/`.git`/`node_modules` delete guard (`workspace.cjs`); extend `assertSafeSubtreeForDelete` to `git:discard` (`gitIpc.cjs:346-363`).
17. Scope `backup-file` (`workspaceIpc.cjs:345-368`) and preview CSP (`previewProtocol.cjs:431`) — keep the inline bridge but re-add a restrictive CSP for preview frames.
18. Prune `planApprovalGateRef` (`usePatchManager.ts:59`) and revoke `handlesRef` on tree change (`useWorkspace.ts:327`).
19. Remove `AGENT_AUDIT_REPORT.md` from the repo; gitignore `.shadrox/` if local-only.

### P2 — Nice-to-have polish

20. Model-aware compaction threshold (`loopContext.ts:16,267`); keep file paths in `summarizeObservation` (`:139-162`).
21. Calibrate `autoRoute` digest ratio from `calibratedAuto` outcomes (`autoRoute.ts:25,149-151`).
22. Updater public-key pinning (`updater.cjs`); MCP outbound-host allowlist (`mcpIpc.cjs:134-136`).
23. Repo map cache keyed by `(root, fileSetEpoch)` (`agent/repoMap.ts`).
24. Stable `overrides` identity for diagnostics debounce (`App.tsx:126-129`, `useDiagnostics.ts:171-173`).
25. Lazy `import()` for xterm/codemirror/esbuild-wasm to cut startup latency.
26. Add ESLint + a CI `tsc --strict` gate alongside the existing test suite.