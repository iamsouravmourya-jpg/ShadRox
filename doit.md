# ShadRox — Low-Credit Execution Playbook

- Purpose: preserve the completed Phase 1 findings and execute the remaining work in small, verified sessions.
- Source: the existing Phase 1 report and reference investigation; no new scan was performed to write this file.
- Scope of this writing session: this document only; no product changes, tests, builds, commits, or pushes.
- Snapshot: HEAD `d49310e`, version `0.0.6`; these are historical verified values, not a fresh status check.
- Credit context: user reports approximately 550 of 2,000 credits consumed; this document was requested within a further 450-credit target. Actual metering is unavailable.
- Verification notation below separates direct reads, delegated research, remembered paths, and proposed files.
- Execution: resume only the task the user authorizes; never treat a status question as permission to start another phase.

## 1. Phase 1 report

### Verified baseline

| Check | Phase 1 result |
|---|---|
| HEAD / package version | `d49310e` / `0.0.6` [V] |
| Full test suite | 1,066 passed; 0 failed; 0 skipped; exit 0 [V] |
| Typecheck | Exit 0 [V] |
| Tracked / staged changes | None at the final Phase 1 check [V] |
| Changes / commits / builds / pushes | None during Phase 1; the subsequently started redaction edit was reverted and tracked cleanliness checked [V] |

### Architecture map

| Area | Implementation and integration |
|---|---|
| Desktop boundary | [V] `electron/main.cjs:567` invokes trusted-renderer checks; [V] `electron/preload.cjs:9` exposes named, frozen bridge methods rather than arbitrary IPC invocation. |
| Application hub | [V] `src/App.tsx:2894` starts chat orchestration; context, tools, disk edits, preview and orchestration connect here. Do not broadly refactor this file. |
| AI transport | [U] `src/lib/ai.ts`, symbol `streamChat`: provider request/stream normalization. [V] `src/App.tsx:3001` applies request fitting before transport. |
| Agent execution | [U] `src/lib/agent/toolLoop.ts`, symbol `runToolRounds`: bounded rounds. [V] `src/lib/agent/tools.ts:410` implements the live command tool. |
| Disk edits | [V] `src/App.tsx:2496` and `src/App.tsx:2539` connect atomic application and verification. [U] `src/lib/patchEngine.ts` and `src/lib/patch/clinePatchApply.ts` handle patch grammar. |
| Autonomy / teams | [U] `src/lib/autonomy/run-loop.ts` and `src/lib/agents/team-run.ts` implement task execution/integration. [V] `src/App.tsx:3602` provides the shared execution host. |
| Plugins / automations | [V] `src/App.tsx:656` loads plugins; `src/App.tsx:672` reads consent by ID; `src/App.tsx:701` loads automations after workspace consent. |
| Editor / intelligence | [U] `electron/ts-service.cjs` provides language-service functions; [U] `src/lib/completionTrie.ts` boosts ghost completions. Exact ghost-text module path requires a localized check. |
| Terminal | [V] `electron/terminal-modes.cjs:79` selects shells/environments; [V] `electron/main.cjs:686` runs bounded one-shot shell commands. PTYs are separate from that one-shot path. |
| Preview | [U] `electron/preview-runtime.cjs` contains port relocation, orphan recovery and stale-lock handling; [U] `electron/preview-source.cjs` implements a restricted source bridge. |
| Landing | [V] `landing/app/page.tsx:1` renders an iframe to the static HTML landing page, not the old Next component composition. [V] `landing/app/layout.tsx:1` supplies metadata and JSON-LD. |
| Packaging | [V] `scripts/package-desktop.js:13` accepts `SHADROX_OUTPUT_DIR`; its default remains inside the project and must be overridden for installer builds. |

### DONE-list reconciliation

- Present with production integration found: command guard, chat shell access, reply surface, preview port relocation and self-healing.
- Present with production integration found: fuzzy search, mentions, ranked repository context, Cline-grammar patches, retry/backoff and conversation compaction.
- Present with production integration found: Trie-assisted ghost completion, bounded tool discipline, team integration turn and disk-write verification.
- Core only: [U] `src/lib/debug/debugSession.ts` and related framing implement DAP rails; no usable debugger UI or production debugger consumer was found.
- Ranked repository context is not a full AST dependency graph; do not describe it as one.
- The completion Trie is custom; the reference investigation found no Aider Trie implementation to copy.
- Compaction exists, but the local OpenHands snapshot does not contain the Python backend condenser implementation.
- Local FIM memoization is not provider prompt caching. Source presence and passing tests are not fresh interactive feature verification.

### Security findings

1. [V] `api/_http.ts:87` lacks the requested standalone GitHub/AWS redaction shapes. This proves a coverage gap, not a reproduced live credential leak.
2. [V] `electron/main.cjs:1494` reopens renderer-supplied folder AND file paths without remembered main-process consent. Filesystem existence is not permission.
3. [V] `src/lib/agent/tools.ts:410` accepts model-controlled confirmation; [V] `src/App.tsx:3631` prompts only for blacklist hits; [V] `electron/main.cjs:1877` has no independent human approval dialog.
4. [V] `src/App.tsx:672` enables plugins by consented ID, not a hash of approved manifest contents. Re-consent and writable-configuration restrictions remain work.
5. [V] `src/lib/agent/toolProtocol.ts:116` serializes results into fences. Formatting alone is not an untrusted-instruction boundary; all observation paths need consistent treatment.
6. [V] `electron/terminal-modes.cjs:97` and `electron/terminal-modes.cjs:107` give the live system shell the full environment. The exported scrub helper does not prove integration; user-system-shell inheritance is an intentional product distinction, not automatically a bug.

### Reference inventory

| Repository | Research result / permitted use |
|---|---|
| Aider [R] | Apache-2.0; useful retry/cache-placement logic. Repository map source is Python; no Trie source was found. |
| Cline [R] | Apache-2.0; useful protected-history trimming, tool-pair integrity and model-schema/catalog normalization. |
| Void [R] | Apache-2.0 project with upstream Microsoft MIT files; terminal/debug candidates retain MIT provenance. Check each copied file. |
| OpenHands [R] | This snapshot is MIT and frontend-oriented; useful redaction rules, not the absent backend condenser. |
| Zed [R] | Mixed-license tree, primarily GPL; user prohibits copying from the entire checkout regardless of a particular file's license. |

### Conventions and Phase 3 seams

- Electron uses CommonJS; the frontend uses TypeScript/React. Prefer pure helpers, boundary validation, structured errors and localized changes.
- [V] `package.json:21` explicitly lists test files. [V] `package.json:23` uses the legacy TypeScript compiler alias. [V] `tsconfig.json` excludes landing from root typechecking.
- Phase 3A: extend the existing terminal resolver, PTY lifecycle and renderer terminal model; do not substitute a second command runner.
- Phase 3B: connect DAP to real editor/panel consumers; extend the restricted preview bridge for assertions rather than treating screenshots as DOM checks.
- Phase 3C: extend current context fitting, ranked map, request shaping, metadata and secret-scrub boundaries; preserve zero-tab disk context.
- Phase 3D: existing checkpoints, verification, terminal and preview events support a bounded Self-Healing Proof feature; competitor uniqueness is unverified.
- Verification scope: architecture/integration inspection plus automated baseline. No fresh manual desktop battery, landing browser test or installer verification occurred in Phase 1.

## 2. Honesty markers and source ledger

- [V] verified: directly read or observed earlier in this conversation; line numbers refer to that snapshot, not a fresh read during document creation.
- [U] unverified — re-check before editing: remembered/search-derived path or claim without a retained direct read; no invented line numbers are supplied.
- [R] unverified — re-check before copying: exact candidate/range supplied by the completed reference researcher, not independently opened by the main agent.
- [N] unverified — proposed new file: an implementation suggestion, not a claim that the file already exists.
- All verification expires when the relevant file changes. In a later implementation session, inspect only the selected task's files and current diff; do not repeat the full audit.
- Commands below are future instructions, not commands run while writing this file. Their path status inherits the task's Files/Test markers.

| ID | Reference candidate / retained research range | License / use |
|---|---|---|
| R01 | [R] `reference/void-main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1:6-155` | Microsoft MIT; prompt/cwd/command markers; success may be Boolean rather than a numeric process exit. |
| R02 | [R] `reference/void-main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh:217-232` and `:370-511` | Microsoft MIT; preserve prompt/DEBUG behavior and Git Bash path conversion. |
| R03 | [R] `reference/void-main/src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts:363-369` and `:475-545` | Microsoft MIT; nonce validation and command tracking; substantial workbench dependencies. |
| R04 | [R] `reference/void-main/src/vs/workbench/contrib/debug/common/debugProtocol.d.ts:1980-2096` and `:2153-2265` | MIT candidate; confirm exact path/header before using DAP contracts. |
| R05 | [R] `reference/void-main/src/vs/workbench/contrib/debug/common/debugModel.ts:37-180`, `:424-508`, `:564-670`, `:821-1052` | Microsoft MIT; variables, scopes, stack paging and verified breakpoints. |
| R06 | [R] `reference/aider-main/aider/exceptions.py:13-113` | Apache-2.0; provider/API error classification, NOT a ready-made shell failure classifier. |
| R07 | [R] `reference/aider-main/aider/coders/chat_chunks.py:16-64` | Apache-2.0; stable-prefix cache placement. |
| R08 | [R] `reference/aider-main/aider/coders/base_coder.py:1333-1392` and `:1449-1487` | Apache-2.0; capability gates, cache warming/retry; warming spends extra requests. |
| R09 | [R] `reference/cline-main/sdk/packages/core/src/extensions/context/summarize-conversation.ts:24-26` and `:99-173` | Apache-2.0; protected history and invalid-summary rejection. |
| R10 | [R] `reference/cline-main/sdk/packages/core/src/extensions/context/budget-projection/project.ts:25-42` and `:592-656` | Apache-2.0; protected boundaries, tool pairs and budget failures. |
| R11 | [R] `reference/cline-main/sdk/packages/core/src/extensions/context/compaction-shared.ts:15-37` and `:65-106` | Apache-2.0; shared trimming invariants. |
| R12 | [R] `reference/cline-main/sdk/packages/shared/src/llms/model-info.ts:22-74` and `:256-282` | Apache-2.0; model schema; avoid importing its dependency stack unnecessarily. |
| R13 | [R] `reference/cline-main/sdk/packages/llms/src/catalog/catalog-live.ts:304-350` | Apache-2.0; catalog normalization. Missing prices becoming zero must not be interpreted as verified free pricing. |
| R14 | [R] `reference/OpenHands-main/src/utils/redact-mcp-secrets.ts:9-129` | MIT candidate; exact checkout capitalization/path must be checked; longest-first known-value and token-shape redaction, no AWS detector. |
| R15 | [R] `reference/OpenHands-main/src/utils/redact-custom-secrets.ts:1-32` | MIT candidate; exact checkout path must be checked; this masks CUSTOM_SECRETS blocks, not every secret source. |

- Attribution examples in cards are additions, not replacements for upstream copyright/license headers. Retain applicable LICENSE/NOTICE and modification notices; never invent copyright holders or years.
- Reference checkout prefixes retained from research may differ on disk. A missing candidate is a localized lookup/blocker, not permission to fabricate source code or provenance.

## 3. Task cards

- Preserve phase order: 2 → 3A → 3B → 3C → 3D → 4. Within a phase, cards are listed by effort; dependencies override that display order.
- S/M/L means relative task size, not a measured credit estimate. L tasks may require multiple authorized sessions; never promise they fit the remaining credits.
- Every product task requires its targeted checks, `npm run typecheck; echo $?`, and `npm test; echo $?`. Require exit 0, at least 1,066 tests, and no reduction from the newer passing baseline.
- Future commit authorization follows the user's selected task/contract. Review staged files and use a quoted HEREDOC message; never stage this playbook or unrelated work.
- Add each new test path once as a whitespace-separated argument to the existing test command. Do not duplicate existing entries or create meaningless tests for documentation-only work.

## T01 — Close API error-redaction coverage gaps
- Phase / why / risk level: 2 / prevent credential-shaped data appearing in upstream errors / medium.
- Files: [V] `api/_http.ts:87`, `package.json:21`; [N] `api/_http.test.ts`.
- Port source: none; small original patterns. No upstream attribution header is appropriate.
- Steps:
  1. Add standalone GitHub token-family matching, including classic and fine-grained formats, without removing existing provider patterns.
  2. Add bounded AWS access-key-ID matching for AKIA and ASIA shapes; do not guess a generic AWS secret matcher from arbitrary 40-character text.
  3. Add synthetic GitHub/AWS tests covering multiple tokens, surrounding punctuation and mixed messages; never use real credentials.
  4. Add regression cases for ordinary text, existing provider redaction, blank fallback, output truncation and repeated calls.
  5. Add an upstream-error payload case exercising the existing response sanitization path, not a separate unused helper.
  6. Append the test path to the package test command and review that the temporary reverted regex expansion has not been reintroduced accidentally.
- Test: [N] `api/_http.test.ts`; append exactly `api/_http.test.ts`.
- Verify: `node --import tsx --test api/_http.test.ts; echo $?`; then both shared gates above; all exit 0, full count ≥1,066.
- Definition of done: existing GitHub/provider error consumers automatically use the extended sanitizer; no raw synthetic token survives the tested payloads.
- Commit message: `fix(security): redact GitHub and AWS credentials from API errors`.
- Do-not-touch list: provider authentication, pricing, unrelated regex families, landing, release artifacts, private files.
- Credits: S.

## T02 — Bind workspace reopen to main-process consent
- Phase / why / risk level: 2 / prevent renderer-chosen paths gaining workspace access / high.
- Files: [V] `electron/main.cjs:1494`; [U] `electron/workspace.cjs`; [N] `electron/workspace-consent.cjs`, `electron/workspace-consent.test.cjs`; [V] `package.json:21`.
- Port source: none; original integration with the current workspace authorization boundary.
- Steps:
  1. Add a small main-owned registry of canonical folder roots and individually approved files, scoped to the intended session lifetime.
  2. Populate it only after successful native selection or explicitly trusted, validated startup opening; never from renderer assertions or recent-entry metadata alone.
  3. Gate folder reopen on matching consent; for an unknown root, request native selection/confirmation and mount only what the user actually approves.
  4. Gate file reopen separately; approval of one file must not silently approve its parent folder or additional renderer-supplied files.
  5. Move preview shutdown/workspace mutation after successful consent and validation; preserve the current workspace on cancellation or failure.
  6. Test cancellation, changed selection, sibling paths, canonical aliases, symlink escape and expired consent; register the tests.
- Test: [N] `electron/workspace-consent.test.cjs`; append exactly `electron/workspace-consent.test.cjs`; retain existing workspace/security tests.
- Verify: `node --test electron/workspace-consent.test.cjs electron/workspace.test.cjs electron/desktop-security.test.cjs; echo $?`; shared gates exit 0.
- Definition of done: BOTH reopen branches enforce main-owned consent and existing per-operation containment checks still apply.
- Commit message: `fix(security): require main-owned consent when reopening workspaces`.
- Do-not-touch list: unrelated file formats, user recent-project data, preview foreign processes, broad App refactors.
- Credits: M.

## T03 — Make agent command approval an actual human decision
- Phase / why / risk level: 2 / remove model-controlled and blacklist-only command authorization / high.
- Files: [V] `electron/main.cjs:686`, `electron/main.cjs:1877`, `src/lib/agent/tools.ts:410`, `src/App.tsx:3631`; [N] `electron/command-approval.cjs`, `electron/command-approval.test.cjs`; [V] `package.json:21`.
- Port source: none; reuse the current native dialog and command execution infrastructure.
- Steps:
  1. Add main-process approval bound to the exact command, canonical cwd and workspace identity; a renderer Boolean must never count as consent.
  2. Show the command and cwd before launching; on cancel, return a structured denial without invoking the process runner.
  3. Make the native one-shot execution handler enforce approval for every model/plugin/automation-issued command by default.
  4. Remove model confirmation as an authorization shortcut and avoid duplicate blacklist dialogs in renderer callers; retain useful risk explanations.
  5. Route autonomy verification through the same denied-until-approved boundary; do not silently trust npm, pytest or tsc because of their binary names.
  6. Test model flags, caller variations, cancellation, workspace changes while a dialog is open and real approve-once behavior; register the tests.
- Test: [N] `electron/command-approval.test.cjs`; append exactly `electron/command-approval.test.cjs`; extend existing command-tool/autonomy tests where applicable.
- Verify: `node --test electron/command-approval.test.cjs; node --import tsx --test src/lib/agent/toolLoop.test.ts src/lib/commandGuard.test.ts src/lib/autonomy/ports.test.ts; echo $?`; shared gates exit 0; exercise the native dialog manually.
- Definition of done: unapproved agent commands cannot reach the native runner; direct human typing in their own terminal remains a separate user-controlled path.
- Commit message: `fix(security): require human approval for agent command execution`.
- Do-not-touch list: system-terminal environment policy, user shell preferences, silent executable allowlists, remote services.
- Credits: L.

## T04 — Preserve data boundaries and bind configuration consent to content
- Phase / why / risk level: 2 / contain injected instructions and unauthorized execution configuration changes / high.
- Files: [V] `src/lib/agent/toolProtocol.ts:116`, `src/lib/agent/tools.ts`, `src/App.tsx:656`, `src/App.tsx:701`; [U] `src/lib/workspaceConsent.ts`, `src/lib/plugins/manifest.ts`, `electron/workspace.cjs`; [N] `src/lib/agent/dataTrust.test.ts`; [V] `package.json:21`.
- Port source: none required; reuse existing MCP untrusted-data conventions only after checking their actual implementation locally.
- Steps:
  1. Add a shared, bounded observation representation preserving source and tool-call identity while explicitly treating workspace content as data, not instructions.
  2. Wire file excerpts, tool output, git data and restored/compacted observations into that representation without breaking native tool-result pairing.
  3. Deny agent API writes/deletes/renames into automation/plugin execution configuration, including directory-level and canonical-path equivalents; retain deliberate human settings edits.
  4. Bind plugin enablement to workspace, ID and main-approved manifest hash; editing content must invalidate prior consent rather than inherit it by ID.
  5. Apply the corresponding changed-definition consent rule to automations and ensure all resulting commands pass T03; do not claim this sandboxes approved shell commands.
  6. Add injection, truncation, native/text tool pairing, renamed-config, disabled-plugin, hash-change and rejected-action regressions; register the tests.
- Test: [N] `src/lib/agent/dataTrust.test.ts`; append exactly `src/lib/agent/dataTrust.test.ts`; extend existing plugin/automation/workspace tests.
- Verify: `node --import tsx --test src/lib/agent/dataTrust.test.ts src/lib/agent/toolProtocol.test.ts src/lib/plugins/plugins.test.ts src/lib/automations/automations.test.ts electron/workspace.test.cjs; echo $?`; shared gates exit 0.
- Definition of done: all identified observation producers are wired; changed executable configuration cannot silently reuse consent; prompt markers are not described as a sandbox.
- Commit message: `fix(security): bind execution configuration consent and isolate observation data`.
- Do-not-touch list: ordinary human editor saves, approved settings workflows, arbitrary provider role formats, unrelated workspace content.
- Credits: L.

## T05 — Classify failures before requesting a repair
- Phase / why / risk level: 3A / distinguish actionable failures from cancellation, denial and unavailable context / medium.
- Files: [V] `src/App.tsx:2394`, `src/App.tsx:3602`; [U] `src/lib/autoFix.ts`, `src/lib/autonomy/ports.ts`; [N] `src/lib/autoFixFailure.test.ts`; [V] `package.json:21`.
- Port source: R06 is API-error classification, not shell logic. If adapted, add `// Adapted from Aider, aider/exceptions.py (Apache-2.0).` and preserve notices; otherwise report original code honestly.
- Steps:
  1. Add a small typed failure classification for nonzero exit, denied execution, cancellation, timeout and missing diagnostics.
  2. Keep provider-transient retry classification separate from shell/test failures; do not copy Aider exception names into unrelated process logic.
  3. Connect the classifier to the existing repair entry point rather than exporting an unused classifier.
  4. Exclude denied and cancelled runs from automatic retry; retain bounded retry budgets for genuinely retryable transport failures.
  5. Include the actual exit/output evidence in repair requests, with T04 data boundaries and secret scrubbing.
  6. Test each classification plus retry exhaustion and the live caller's decision; register the tests.
- Test: [N] `src/lib/autoFixFailure.test.ts`; append exactly `src/lib/autoFixFailure.test.ts`.
- Verify: `node --import tsx --test src/lib/autoFixFailure.test.ts src/lib/autonomy/ports.test.ts; echo $?`; shared gates exit 0.
- Definition of done: actual failed runs follow the classification; refusal never becomes an invitation to bypass approval or retry indefinitely.
- Commit message: `feat: classify execution failures before offering repair`; use an explicit Aider attribution in the message if code is actually ported.
- Do-not-touch list: new automatic API spending, retry ceilings, user approvals, unrelated import-fix behavior.
- Credits: M.

## T06 — Add visible, approve-once input for interactive terminals
- Phase / why / risk level: 3A / let an agent answer non-secret CLI prompts without blind PTY writes / high; depends on T07.
- Files: [V] `electron/preload.cjs:50`, `electron/main.cjs`; [U] `src/lib/desktop.ts`, `src/components/TerminalPanel.tsx`; [N] `src/lib/terminal/approvedInput.test.ts`; [V] `package.json:21`.
- Port source: none; reuse T03 approval authority and T07 session identity, not a new unconstrained terminal-write tool.
- Steps:
  1. Add a distinct agent-input operation; do not expose the existing unrestricted human typing bridge as an agent tool.
  2. Bind approval to the selected live session, exact printable text and whether Enter will be appended.
  3. Show that text to the user and require approve-once; reject hidden control sequences and stale/closed sessions.
  4. Forward bytes only after the decision, without changing the human typing path or automatically retrying rejected input.
  5. Refuse secret/password entry through this feature; represent input denials and unsupported prompts explicitly.
  6. Test cancel, approve, session switch, close-during-dialog, newlines/control bytes and Enter behavior; register and manually exercise the feature.
- Test: [N] `src/lib/terminal/approvedInput.test.ts`; append exactly `src/lib/terminal/approvedInput.test.ts`.
- Verify: `node --import tsx --test src/lib/terminal/approvedInput.test.ts; echo $?`; shared gates exit 0; manual y/N approval and cancellation both required.
- Definition of done: a real interactive CLI receives exactly the displayed approved input; cancellation writes zero bytes.
- Commit message: `feat: gate agent terminal input on explicit user approval`.
- Do-not-touch list: password prompts, silent stdin injection, user keyboard events, automatic acceptance of install prompts.
- Credits: M.

## T07 — Connect shell integration to bounded terminal state
- Phase / why / risk level: 3A / expose trustworthy command lifecycle and cwd instead of parsing arbitrary visual output / high.
- Files: [V] `electron/terminal-modes.cjs:79`, `electron/main.cjs`, `electron/preload.cjs`; [U] `src/lib/terminal/`, `src/components/TerminalPanel.tsx`, `src/lib/desktop.ts`; [N] `src/lib/terminal/state.test.ts`; [V] `package.json:21`.
- Port source: R01–R03, Microsoft MIT; add `// Adapted from VS Code/void shell integration (MIT).` to adapted TypeScript and retain original script headers verbatim.
- Steps:
  1. Extract only required PowerShell/Bash prompt/cwd/start/end markers; omit optional environment-export blocks and preserve existing user prompt hooks.
  2. Add per-session marker validation and an incremental parser that survives split PTY chunks, terminal resets and malformed sequences.
  3. Maintain bounded command/output/cwd snapshots with session identity, timestamps and explicit unknown/incomplete states.
  4. Wire shell startup, PTY output and close events into that state, and expose a bounded read-only agent query through named IPC.
  5. Surface running/completed/silent-for-N-seconds status in the terminal; silence is not proof of a hang, and PowerShell Boolean success is not a fabricated numeric exit code.
  6. Register parser/state tests and exercise real Windows PowerShell plus supported Bash; unsupported shells must remain usable without invented integration data.
- Test: [N] `src/lib/terminal/state.test.ts`; append exactly `src/lib/terminal/state.test.ts`; retain `electron/terminal-modes.test.cjs`.
- Verify: `node --import tsx --test src/lib/terminal/state.test.ts electron/terminal-modes.test.cjs; echo $?`; shared gates exit 0; real PTY lifecycle checks required.
- Definition of done: terminal UI and agent query consume actual events; output is bounded/scrubbed and foreign process output cannot be treated as unquestioned authority.
- Commit message: `feat: terminal state ported from VS Code/void (MIT)`.
- Do-not-touch list: default system-shell environment, foreign processes, complete xterm workbench infrastructure, optional environment dumping.
- Credits: L.

## T08 — Show the actual preview reload state
- Phase / why / risk level: 3B / distinguish idle, reloading and failed preview states / low.
- Files: [U] `src/components/PreviewPane.tsx`, `src/lib/desktop.ts`, `src/hooks/usePreviewSync.ts`; [V] `src/App.tsx`; [N] `src/lib/previewStatus.test.ts`; [V] `package.json:21`.
- Port source: none; reuse existing preview/HMR events after checking their concrete fields, not an assumed Boolean.
- Steps:
  1. Identify the existing reload event and add only the missing typed status transition, if any.
  2. Derive the chip state from actual preview lifecycle events rather than a cosmetic timer.
  3. Render the chip beside the existing port status using current component styling.
  4. Clear stale reload state on workspace switch, preview stop or failed reload.
  5. Add state-transition tests covering rapid reloads, error and unsupported/static preview cases.
  6. Register tests and exercise a real file edit/HMR cycle in the running app.
- Test: [N] `src/lib/previewStatus.test.ts`; append exactly `src/lib/previewStatus.test.ts`.
- Verify: `node --import tsx --test src/lib/previewStatus.test.ts; echo $?`; shared gates exit 0; browser/desktop reload and error paths required.
- Definition of done: the chip reflects real lifecycle transitions and never reports successful HMR based only on elapsed time.
- Commit message: `feat: surface live preview reload status`.
- Do-not-touch list: port relocation, orphan ownership checks, landing design, new polling loops.
- Credits: S.

## T09 — Attach current diagnostics to a repair request
- Phase / why / risk level: 3B / replace guessed failure context with bounded runtime evidence / high; depends on T10 and T11.
- Files: [V] `src/App.tsx:2394`, `src/App.tsx:3602`; [U] `src/lib/autonomy/ports.ts`, `src/lib/debug/debugSession.ts`; [N] `src/lib/autonomy/repairContext.test.ts`; [V] `package.json:21`.
- Port source: none beyond T10's attributed DAP model; reuse its normalized snapshots rather than copying another stack model.
- Steps:
  1. Define a failure evidence envelope with command/run/session IDs, timestamps and explicit unavailable fields.
  2. Attach the matching terminal result and current preview assertions; reject unrelated or stale session data.
  3. Attach stack/scopes only when the debugger actually captured them for the relevant stopped session; a normal crashed process may have none.
  4. Redact secrets, bound variable depth/output and apply T04 data markers before adding the envelope to a repair prompt.
  5. Wire the envelope into the existing bounded repair loop and show the user what context will be sent.
  6. Register tests for stale snapshots, missing adapters, resumed execution, truncation, secrets and the actual repair caller.
- Test: [N] `src/lib/autonomy/repairContext.test.ts`; append exactly `src/lib/autonomy/repairContext.test.ts`.
- Verify: `node --import tsx --test src/lib/autonomy/repairContext.test.ts src/lib/autonomy/ports.test.ts; echo $?`; shared gates exit 0; a real failure must produce the expected repair context.
- Definition of done: repair requests contain correlated observed evidence, never fabricated local variables or stale stack frames.
- Commit message: `feat: attach bounded runtime evidence to repair requests`.
- Do-not-touch list: automatic debugger attachment to unrelated processes, unapproved provider requests, secret variable values, retry budgets.
- Credits: M.

## T10 — Wire a usable DAP debugger into the editor
- Phase / why / risk level: 3B / turn existing DAP rails into a complete debugger workflow / high.
- Files: [U] `src/lib/debug/debugSession.ts`, `src/lib/debug/abstractDebugAdapter.ts`, `src/components/CodeEditor.tsx`, `src/lib/desktop.ts`; [V] `src/App.tsx`, `electron/main.cjs`; [N] `src/components/DebugPanel.tsx`, `src/lib/debug/debugIntegration.test.ts`; [V] `package.json:21`.
- Port source: R04–R05, MIT after header verification; add `// Adapted from VS Code/void debugModel.ts (MIT).` while retaining original notices.
- Steps:
  1. Define and validate a small workspace launch configuration; show the adapter/target command and require approval before executing workspace-controlled code.
  2. Connect the existing session to an approved adapter process through the desktop bridge with the existing scrubbed debugger environment.
  3. Port only required breakpoint/stack/scope state and cancellation logic; invalidate DAP variable/frame handles whenever execution resumes.
  4. Wire breakpoint gutter markers and verified adapter responses into the editor rather than marking requested breakpoints as already bound.
  5. Add stack/scopes panels and safe hover from captured variables, plus continue/step/stop controls; do not evaluate arbitrary expressions merely on hover.
  6. Register adapter-protocol and consumer tests; manually launch one supported local adapter and exercise breakpoint, stepping, variables, stop and error paths.
- Test: [N] `src/lib/debug/debugIntegration.test.ts`; append exactly `src/lib/debug/debugIntegration.test.ts`; retain `src/lib/debug/debugFraming.test.ts`.
- Verify: `node --import tsx --test src/lib/debug/debugIntegration.test.ts src/lib/debug/debugFraming.test.ts; echo $?`; shared gates exit 0; real adapter/UI verification required.
- Definition of done: a user can launch, stop at a breakpoint, inspect current stack/scopes, step and terminate through the app.
- Commit message: `feat: debugger state ported from VS Code/void (MIT)`.
- Do-not-touch list: heap snapshots, automatic adapter installation, arbitrary process attachment, full Void UI, secret-bearing scope exports.
- Credits: L.

## T11 — Add structured preview assertions
- Phase / why / risk level: 3B / verify route/DOM/error evidence without requiring a vision model / high.
- Files: [U] `electron/preview-source.cjs`, `electron/preview-runtime.cjs`, `src/lib/previewSource.ts`, `src/components/PreviewPane.tsx`; [V] `electron/main.cjs`; [N] `src/lib/previewAssertions.test.ts`; [V] `package.json:21`.
- Port source: none required; extend the existing restricted preview bridge. Screenshot IPC is not a DOM assertion engine.
- Steps:
  1. Define a bounded assertion schema for route, selector presence, bounding boxes and fatal console errors; expected facts must be explicit, not guessed from arbitrary source.
  2. Implement collection inside the preview's own restricted context; validate session/frame/message identity and do not bypass cross-origin isolation from the parent renderer.
  3. Trigger collection on actual load/HMR completion with cancellation for stale navigations and bounded retry/timeouts.
  4. Render pass/fail/unavailable details in the preview pane, including the observation time and route being checked.
  5. Offer optional screenshots only for a verified vision-capable provider and approved request; structured assertions remain usable without images.
  6. Register origin, malformed payload, missing selector, zero-size element, stale navigation and console-error tests; exercise supported static and runtime previews.
- Test: [N] `src/lib/previewAssertions.test.ts`; append exactly `src/lib/previewAssertions.test.ts`; retain existing preview-source/runtime tests.
- Verify: `node --import tsx --test src/lib/previewAssertions.test.ts electron/preview-source.test.cjs electron/preview-runtime.test.cjs; echo $?`; shared gates exit 0; real preview checks required.
- Definition of done: the chip reports measured assertions from the active preview, and unsupported contexts are visibly unavailable rather than falsely green.
- Commit message: `feat: verify preview state with structured assertions`.
- Do-not-touch list: exposing Node/desktop APIs to preview content, foreign process termination, unconditional screenshot upload, insecure cross-origin access.
- Credits: L.

## T12 — Normalize model metadata into current budget decisions
- Phase / why / risk level: 3C / replace unsupported capability assumptions without changing product pricing / medium.
- Files: [U] `src/lib/modelRates.ts`, `src/lib/modelCapabilities.ts`, `src/lib/contextBudget.ts`; [N] `src/lib/modelMetadata.test.ts`; [V] `package.json:21`.
- Port source: R12–R13, Apache-2.0; add `// Adapted from Cline model metadata normalization (Apache-2.0).` and retain applicable notices.
- Steps:
  1. Extract the minimal metadata schema needed for context window, output limit, supported modalities and provider input/output/cache rates.
  2. Normalize known provider/model identifiers without silently treating unknown models or absent prices as free.
  3. Record source/provenance and an update timestamp; re-check vendor metadata during this future task rather than trusting an old catalog forever.
  4. Wire normalized capabilities into the existing context/output fitting functions, preserving explicit user overrides where supported.
  5. Keep provider cost metadata separate from user-owned subscription prices, credits, caps and margin decisions.
  6. Register fixtures for unknown IDs, missing prices, explicit zero prices, output caps and provider overrides; avoid a new schema dependency unless justified.
- Test: [N] `src/lib/modelMetadata.test.ts`; append exactly `src/lib/modelMetadata.test.ts`; retain existing rates/capabilities/context tests.
- Verify: `node --import tsx --test src/lib/modelMetadata.test.ts src/lib/modelRates.test.ts src/lib/contextBudget.test.ts; echo $?`; shared gates exit 0.
- Definition of done: production request fitting reads the normalized metadata and distinguishes unknown pricing from verified zero pricing.
- Commit message: `feat: model metadata normalization ported from Cline (Apache-2.0)`.
- Do-not-touch list: plan prices, credit conversion, shared-key spending policy, automatic paid catalog services.
- Credits: M.

## T13 — Scrub outbound context consistently
- Phase / why / risk level: 3C / prevent known credential values in model-visible observations / high.
- Files: [V] `src/App.tsx`, `api/_http.ts`; [U] `src/lib/ai.ts`, `src/lib/contextBudget.ts`, `src/lib/secureStore.ts`; [N] `src/lib/contextSecrets.test.ts`; [V] `package.json:21`.
- Port source: R14–R15, MIT after path/header verification; add `// Adapted from OpenHands redact-mcp-secrets.ts (MIT).` and preserve the upstream notice.
- Steps:
  1. Locate the existing prompt-scrub and secure-store boundaries without opening stored secrets; reuse known secret handles/values only inside protected runtime code.
  2. Adapt longest-first known-value replacement and supported token shapes without treating arbitrary short strings as secrets.
  3. Apply scrubbing before budgeting/serialization to file context, terminal/debug observations, git data and restored context.
  4. Keep provider authentication headers separate so scrubbing request context does not delete the active credential needed by the selected transport.
  5. Audit that only required provider credentials cross the intended API boundary; never print or serialize the full secret store for diagnosis.
  6. Register synthetic secret, overlapping value, URL/header, multiline, partial-token and cross-provider request-shape tests.
- Test: [N] `src/lib/contextSecrets.test.ts`; append exactly `src/lib/contextSecrets.test.ts`; retain existing AI/provider-key tests.
- Verify: `node --import tsx --test src/lib/contextSecrets.test.ts src/lib/providerKeys.test.ts src/lib/ai.test.ts; echo $?`; shared gates exit 0.
- Definition of done: all identified outbound context paths use the scrubber; documentation does not claim perfect detection of every possible unknown secret.
- Commit message: `feat: outbound context redaction ported from OpenHands (MIT)`.
- Do-not-touch list: credential storage contents, provider authentication behavior, user system-terminal environment, plaintext secret logs.
- Credits: M.

## T14 — Preserve protected turns during compaction
- Phase / why / risk level: 3C / trim context without losing the active task or breaking tool exchanges / medium.
- Files: [V] `src/App.tsx:2975`; [U] `src/lib/compaction.ts`, `src/lib/contextBudget.ts`; [N] `src/lib/contextCompactionPolicy.test.ts`; [V] `package.json:21`.
- Port source: R09–R11, Apache-2.0; add `// Adapted from Cline context compaction policy (Apache-2.0).` and preserve applicable notices.
- Steps:
  1. Document the current retained-turn policy inside tests rather than replacing it with an unrelated compaction engine.
  2. Add protection for the active user request, required system context and complete tool-call/result groups.
  3. Adapt Cline's trim ordering and invalid-summary rejection only where stronger than the current policy; record conflict decisions.
  4. Preserve T04 untrusted-data labels through summaries and keep zero-tab file inventory/context available.
  5. Return a clear budget failure when protected content cannot fit rather than emitting invalid provider messages or silently dropping the request.
  6. Register native/text tool-pair, tiny-window, huge-observation, failed-summary and repeated-compaction cases.
- Test: [N] `src/lib/contextCompactionPolicy.test.ts`; append exactly `src/lib/contextCompactionPolicy.test.ts`; retain existing compaction/context tests.
- Verify: `node --import tsx --test src/lib/contextCompactionPolicy.test.ts src/lib/compaction.test.ts src/lib/contextBudget.test.ts src/lib/promptContext.test.ts; echo $?`; shared gates exit 0.
- Definition of done: real chat request fitting preserves protected groups and handles irreducible context explicitly.
- Commit message: `feat: protected context trimming ported from Cline (Apache-2.0)`.
- Do-not-touch list: fabricated OpenHands backend ports, provider message ordering, silent extra summarization requests, zero-tab invariant.
- Credits: M.

## T15 — Add dependency-aware contract context
- Phase / why / risk level: 3C / supply relevant exported contracts instead of entire dependent files / high.
- Files: [V] `src/App.tsx:91`, `src/App.tsx:98`; [U] `src/lib/agent/repoMap.ts`, `src/lib/search/`, `electron/ts-service.cjs`, `src/lib/contextBudget.ts`; [N] `src/lib/search/dependencyContext.test.ts`; [V] `package.json:21`.
- Port source: no exact AST-graph port verified. Reuse the installed TypeScript parser/service; do not relabel the existing ranked map as AST infrastructure.
- Steps:
  1. Define graph edges explicitly: imports/dependencies versus reverse dependents; cap traversal and handle cycles.
  2. Extract supported TS/JS module/export/type contracts through existing compiler facilities, without installing another parser by default.
  3. Cache per-file extraction by content/version and invalidate it on edits, rename and workspace changes.
  4. Select bounded relevant contracts for an actual edit request, prioritizing useful import and impacted-dependent signatures.
  5. Merge the contracts into current retrieval/fitting while retaining path inventory and disk-read context when no tabs are open.
  6. Register cycles, re-exports, aliases, unresolved imports, stale cache, unsupported languages and token-budget tests.
- Test: [N] `src/lib/search/dependencyContext.test.ts`; append exactly `src/lib/search/dependencyContext.test.ts`.
- Verify: `node --import tsx --test src/lib/search/dependencyContext.test.ts src/lib/agent/repoMap.test.ts src/lib/promptContext.test.ts; echo $?`; shared gates exit 0.
- Definition of done: a real edit request receives bounded dependency contracts; unsupported languages are honestly excluded rather than called AST-supported.
- Commit message: `feat: add dependency-aware contracts to edit context`.
- Do-not-touch list: replacing all retrieval, whole-repository file dumps, zero-tab context, unapproved parser dependencies.
- Credits: L.

## T16 — Apply provider-specific prompt caching and measure it
- Phase / why / risk level: 3C / reduce repeated-input cost only where the chosen provider supports it / high.
- Files: [U] `src/lib/ai.ts`, `src/lib/modelCapabilities.ts`, `src/lib/modelRates.ts`, `api/ai/_gemini.ts`, `api/ai/_openai.ts`, `api/ai/_compatible.ts`; [N] `api/ai/promptCache.test.ts`; [V] `package.json:21`.
- Port source: R07–R08, Apache-2.0; add `// Adapted from Aider stable-prefix cache placement (Apache-2.0).`; provider wire formats require independent verification.
- Steps:
  1. Confirm current provider/model support during this future task and record whether caching is automatic, explicit-resource based or unsupported.
  2. Separate stable system/project prefixes from changing turns without moving secrets or untrusted data into a privileged role.
  3. Implement only the verified provider mechanism; never invent a generic Groq/OpenAI cache suffix or send Anthropic-shaped fields blindly.
  4. For explicit cached resources, obtain retention/cost approval and isolate ownership, invalidation and expiry by provider/key/workspace identity.
  5. Record actual input/cached-input/output usage and any storage/create fees; compare identical cold/warm requests with explicit paid-test approval.
  6. Register provider payload, unsupported model, expiry, key switch and stale-context tests; keep optional cache warming off unless separately approved.
- Test: [N] `api/ai/promptCache.test.ts`; append exactly `api/ai/promptCache.test.ts`; retain usage/provider transport tests.
- Verify: `node --import tsx --test api/ai/promptCache.test.ts api/ai/usage.test.ts src/lib/ai.test.ts; echo $?`; shared gates exit 0; live cost claims require measured approved requests.
- Definition of done: supported providers use valid caching and report observed savings/costs; unsupported providers behave normally without false cache-hit claims.
- Commit message: `feat: prompt cache placement ported from Aider (Apache-2.0)`.
- Do-not-touch list: silent warming, extra paid API calls, cross-workspace cache reuse, arbitrary provider fields, subscription pricing.
- Credits: L.

## T17 — Ship a complete bounded Self-Healing Proof workflow
- Phase / why / risk level: 3D / make one failure-to-reviewed-repair workflow independently useful / high.
- Files: [V] `src/App.tsx:2394`, `src/App.tsx:2504`; [U] `src/lib/autonomy/ports.ts`, `src/lib/history.ts`, `src/components/ChatPanel.tsx`; [N] `src/lib/repairProof.ts`, `src/lib/repairProof.test.ts`; [V] `package.json:21`.
- Port source: reuse already attributed diagnostics/checkpoint/patch integrations; no additional upstream implementation or uniqueness claim is verified.
- Steps:
  1. Add a bounded local failure receipt containing correlated diagnostics, command/preview status and relevant file-content identities.
  2. Show a Review repair action with exactly what context will be sent; do not make an API request merely because a command failed.
  3. On explicit acceptance, run the existing repair request and present the normal patch review rather than a second write mechanism.
  4. Apply through verified atomic writes/checkpoints and request approval for any verification command through T03.
  5. Attach real verification receipts to the result and invalidate proof when relevant files change; expose rollback using existing verified file restoration.
  6. Register failure→proposal→accept→verify, rejection, mismatch, stale proof, unavailable diagnostics and rollback cases; exercise the complete desktop flow.
- Test: [N] `src/lib/repairProof.test.ts`; append exactly `src/lib/repairProof.test.ts`; retain atomic/disk-write/repair-context tests.
- Verify: `node --import tsx --test src/lib/repairProof.test.ts src/lib/applyPipeline.e2e.test.ts src/lib/autonomy/repairContext.test.ts; echo $?`; shared gates exit 0; complete manual golden/cancel/failure paths required.
- Definition of done: one supported workflow captures an actual failure, proposes a reviewed patch, verifies it and shows current evidence; unverified is never labelled proven.
- Commit message: `feat: connect local repair proposals to verifiable execution receipts`.
- Do-not-touch list: automatic GitHub PRs, auto-commit/push, unrestricted background agents, whole-machine rewind, silent provider spending.
- Credits: L.

## T18 — Execute and record the manual integration battery
- Phase / why / risk level: 4 / distinguish passing helpers from working desktop behavior / medium.
- Files: [V] `PENDING.txt`; this playbook's Section 5; no product code change is planned.
- Port source: none; manual validation of the integrated application.
- Steps:
  1. Ask the user to approve a disposable test workspace and identify the exact app/build under test; do not reuse an old reported running session as proof.
  2. Record the baseline branch, current dirty files and checkpoint before any fixture edit.
  3. Execute every applicable click-through row in Section 5, including denial/cancellation and disk inspection.
  4. Record observed outcomes and exact failing steps; screenshots/logs must not expose credentials or unrelated private files.
  5. Fix discovered defects only as separately scoped tasks, then repeat affected scenarios and the full automated gates.
  6. Update the pending checklist with verified results and unresolved blockers; do not mark unrun scenarios passed.
- Test: new automated file N/A; allowlist entry N/A. Do not invent a passing unit test for a manual observation; all Section 5 scenarios are required.
- Verify: `npm run typecheck; echo $?` and `npm test; echo $?`; both exit 0 and count ≥1,066; manual rows must carry observed results.
- Definition of done: every required manual scenario has evidence or an explicit blocker; release remains blocked on unresolved critical failures.
- Commit message: `docs: record verified desktop integration battery results` only if the user wants the nonsensitive checklist committed; otherwise no commit.
- Do-not-touch list: original IGNOU CODER artifacts without approval, public uploads, private fixtures, pretending browser checks cover native dialogs.
- Credits: S.

## T19 — Polish the landing that visitors actually see
- Phase / why / risk level: 4 / align the live silver-shield presentation without damaging SEO / medium.
- Files: [V] `landing/app/page.tsx:1`, `landing/app/layout.tsx:1`; [U] `landing/public/landing-v3.html`, `landing/lib/download.ts`, `landing/package.json`; [N] `landing/landingContract.test.ts`; [V] `package.json:21`.
- Port source: none; change the rendered asset, not unused historical components.
- Steps:
  1. Resolve approved privacy/version/FAQ decisions before touching metadata; retain the server layout and production analytics.
  2. Identify the rendered CTA/workspace styles in the iframe asset and adjust only approved colors/details to the new logo.
  3. Keep existing canonical, entity, icon and social metadata intact; if FAQ schema is approved, derive it from matching visible FAQ content.
  4. Reconcile approved version/download metadata without assuming the current download helper already owns every reference.
  5. Add contract tests for the agreed metadata/download relationships and register the root test entry; do not present text assertions as visual verification.
  6. Run the landing dev server, test desktop/mobile and light/dark where supported, inspect console errors and verify download behavior before reporting completion.
- Test: [N] `landing/landingContract.test.ts`; append exactly `landing/landingContract.test.ts`; landing's own checks must also be identified from its package during implementation.
- Verify: `node --import tsx --test landing/landingContract.test.ts; echo $?` and `npm --prefix landing run build; echo $?`; shared gates exit 0; browser checks required.
- Definition of done: the rendered landing is polished, metadata remains accurate and browser/download paths work; no deployment occurs without permission.
- Commit message: `fix: align the rendered landing with verified release metadata`.
- Do-not-touch list: converting metadata layout into a client component, unrelated component rewrites, invented FAQ schema, external deployment without approval.
- Credits: M.

## T20 — Build, inspect and publish only the approved release
- Phase / why / risk level: 4 / deliver a verified installer without OneDrive failures or accidental publication / high.
- Files: [V] `package.json:4`, `scripts/package-desktop.js:13`; [U] lockfile/version metadata and generated artifacts; outside-project build paths in Section 5 are proposed, not verified.
- Port source: none; use the existing packaging pipeline.
- Steps:
  1. Obtain explicit build/version approval, reconcile the selected version across required files and confirm the approved output directory is outside OneDrive.
  2. Run final source verification and record actual exit codes/counts; review all changes and separate private notes/unrelated files from any release commit.
  3. Build with the output override in Section 5 and inspect real generated paths; do not infer success from a piped log or exit code alone.
  4. Inspect/extract the ASAR locally and verify packaged version plus changed runtime modules, exclusion of tests/secrets, and the corresponding installer payload.
  5. Install/run the approved artifact and repeat the critical desktop smoke checks; record exact artifact names, sizes and checksums.
  6. Only after separate written publication/push approval, publish the agreed assets using GitHub CLI and verify the public release; deleting an old asset needs its own confirmation.
- Test: new automated file N/A; allowlist entry N/A. Existing full suite, ASAR inspection and installed-app verification are the release gates.
- Verify: `npm run typecheck; echo $?`, `npm test; echo $?`, then the approved build/ASAR commands in Section 5; all required exits 0 and full count ≥1,066.
- Definition of done: source and installed artifact match, required assets are verified, and publication occurs only within the user's written scope.
- Commit message: `chore: prepare the approved ShadRox release` after source verification; never commit generated binaries/private playbooks by accident.
- Do-not-touch list: build output inside OneDrive, silent release:win publishing, old release assets, signing configuration, remote branches without approval.
- Credits: L.

## 4. Signature-feature choice and scope

| Seed | Existing foundation | Main missing work / decision |
|---|---|---|
| Time-Travel Workspace | Checkpoints, file history and rollback | Full terminal/process/git/environment rewind is not generally reversible; too large for this bounded delivery. |
| Watchful Pair | Editor context, local retrieval and ghost completions | Useful prediction before an ask needs a concrete local model/heuristic and latency/privacy validation; not automatically zero-cost intelligence. |
| Self-Healing Proof | Verified edits, checkpoints, failure loop, terminal/preview and planned DAP snapshots | Connect evidence to one reviewed repair workflow; fits the existing architecture best, though still a substantial integration task. |

- Recommendation: Self-Healing Proof only. Do not claim that no competitor ships a comparable feature without separate current research.
- Complete scope: one approved local workspace, bounded failure receipt, explicit request for repair, reviewed atomic patch, approved verification, current evidence and file rollback.
- Cut list: automatic GitHub PRs, whole-workspace timeline rewind, process-memory restore, passive speculative model calls, heap profiling, cross-project orchestration and unsupported adapter guarantees.
- Permission: present this scope for approval before it changes Phase 4 priorities. If budget cannot complete this scope, shrink the supported workflow before implementation rather than shipping unused rails.

## 5. Manual battery and release commands

### Click-through battery

- Setup: use an approved disposable workspace with no secrets. Record app version/commit, provider/model, terminal mode and preview type; never expose the credential itself.
| Scenario | Exact action sequence | Required observation |
|---|---|---|
| T2 FAQ build | Open the approved fixture folder → checkpoint → ask chat to add an FAQ data file, accordion and about-page section → review/accept patches → approve its build command. | All intended files exist on disk; FAQ renders/expands; build exit is real; no unapproved Built with ShadRox attribution. |
| Safe disk apply | Ask for a small anchored change → review → externally alter the anchor before acceptance → attempt apply. | Mismatch/ambiguity writes zero bytes; unaffected files remain identical. |
| Rollback | Apply one verified edit → request chat undo → inspect disk → make another edit → select checkpoint/timeline restore → inspect disk again. | Both restoration paths restore intended contents without silently overwriting unrelated external work. |
| Delete file | Create an approved disposable fixture file → ask chat to delete it → follow required review/approval → refresh explorer and inspect disk. | Only that file is removed; escape/config-protected paths are rejected. |
| Git commit gate | In the disposable repo, ask chat to commit → cancel command approval → inspect HEAD → repeat and explicitly approve. | Cancellation leaves HEAD unchanged; approval creates only the intended local commit; nothing pushes. |
| Hinglish reply | Request a detailed explanation of the FAQ changes, failures and next actions. | Readable rendered Markdown, no raw tool/results JSON, no secret output, and claims match observed file/command results. |
| Terminal integration | Open supported shell → run a passing command, failing command and long silent command → query terminal state → request y/N input, first cancel and then approve. | Correct session/cwd/lifecycle; unknown numeric exit stays unknown; cancellation writes no input; approved text matches exactly. |
| Debugger | Approve launch → set breakpoint → run → inspect stack/scopes → step → hover captured variable → continue → stop. | Bound breakpoint state is real; stale frame/variable handles disappear after resume; secrets are not exported in repair context. |
| Preview | Start supported project → edit for HMR → remove expected selector or introduce a controlled error → restore it → occupy a candidate port with another owned fixture. | Reload/assertion states track reality; error is visible; preview relocates without killing the other process. |
| Trust boundaries | Reopen an unapproved folder/file and cancel → attempt model-confirm-only command → change enabled plugin/automation manifest. | No mount/exec on cancellation; model Boolean grants nothing; changed definition requires fresh consent. |
| Context / BYOK | Close every tab → request a repository-aware change → switch approved provider/model → inspect scrubbed request metadata and unsupported-cache behavior. | Inventory plus bounded disk context remain; provider limits are respected; no secret/context or cache crosses the wrong identity. |
| Packaged smoke | Install the specifically approved artifact → launch → open fixture → edit/save → chat with configured provider → terminal → preview → checkpoint restore. | Installed behavior matches the verified source; developer-server success alone is insufficient. |

### Installer and ASAR checks

- Run only after T20 build approval. Confirm version first; `0.0.7` is a plan target, not a version already built or published.
- [N] The following output/extraction paths are proposed. Verify the parent directory and actual generated `win-unpacked` path before creating files or inspecting artifacts.
```bash
SHADROX_OUTPUT_DIR="C:/Users/sourav/shadrox-build" npm run dist:win; echo $?
```
- Run local ASAR tooling only if already installed; do not let a package runner download tools silently. The exact local binary location is [U].
```bash
./node_modules/.bin/asar list "C:/Users/sourav/shadrox-build/win-unpacked/resources/app.asar"; echo $?
./node_modules/.bin/asar extract "C:/Users/sourav/shadrox-build/win-unpacked/resources/app.asar" "C:/Users/sourav/shadrox-build/asar-check-approved-version"; echo $?
node -p "require('C:/Users/sourav/shadrox-build/asar-check-approved-version/package.json').version"; echo $?
```
- If paths/tooling differ, stop and perform a localized check; do not invent a successful artifact inspection or overwrite an earlier extraction directory.
- Inspect packaged changed Electron/API modules and frontend bundles against the selected source build; verify no private files/credentials were included without opening credential files in chat.
- Verify the actual installer payload and installed app, not only a leftover unpacked ASAR; correlate build time, version and checksums.
- Expected asset classes: Setup executable, NSIS payload archive and updater metadata. Exact names and whether each is produced are [U] until the build is inspected.
- Publication: use `gh` only after written go; inspect current release state, upload only approved assets, verify download/update metadata, and ask before deleting/replacing an old asset or pushing code.

## 6. Task dependency graph

```text
T01 -> T02 -> T03 -> T04 -> Phase 3A
T05 and T07 -> T06 -> Phase 3A complete
Phase 3A complete -> T08, T10, T11 -> T09 -> Phase 3B complete
Phase 3B complete -> T12, T13 -> T14 -> T15 -> T16 -> Phase 3C complete
T03 + T04 + T05 + T07 + T09 + T10 + T11 + T13 -> T17
Phase 3C complete + signature scope approval -> finish T17 -> Phase 4
T18 and approved T19 -> repeat affected T18 rows -> build approval -> T20
Verified installed artifact -> publication approval -> publish; push/deletion need scoped approval
```
- Cards are sorted by size within each phase, not an instruction to violate dependencies: implement terminal state T07 before input T06, and diagnostics T10/T11 before repair context T09.

## 7. Cheapest next task

- T01 is the smallest safe next task: two credential-family coverage additions plus focused tests, with no UI or Electron lifecycle change.
- Fresh-session brief: "Implement T01 only. Check the current diff, open only its named files, preserve unrelated work, use synthetic tokens, run targeted/full/typecheck gates, report proof and stop. Do not push."
- Commit only after verified success under the user's task authorization; if the tree has changed since this document, adapt locally rather than applying stale line numbers blindly.

## 8. Open decisions for the user

| Decision | Tradeoff / safe default |
|---|---|
| 70% shipped versus complete-or-nothing | Choose a smaller 100%-working scope. Do not interpret 70% as permission to ship dead features. |
| Folder-open-only versus command/stdin approvals | Keep normal file work smooth within granted scope; retain explicit authority for program execution/input. Confirm this exception instead of silently weakening security. |
| Binary allowlist versus real execution control | npm tests, pytest and tsc/config/plugins can run workspace code. `execFile` avoids shell parsing, not that code execution. Default-deny plus bound human approval protects consent; OS sandboxing would be separate work. |
| Provider prompt-cache support | Prefer automatic cache behavior where verified; explicit cached resources can retain context externally and add lifecycle/cost work. Unsupported providers remain uncached. |
| Cache warming | Extra requests may cost more than saved input on short sessions. Default off; require measured break-even and explicit approval before enabling. |
| Privacy wording | Correct "files never leave" to "no ShadRox project sync; selected context is sent to your provider" and disclose current auth/server dependencies; preserve truthful local-first positioning. |
| Built with ShadRox line | User chooses keep/revert; no automatic about-page branding. |
| IGNOU CODER cleanup | User identifies approved artifacts before deletion; prefer separate test fixtures. Existing work may belong to another session. |
| Ignoring generated directories | User decides whether to ignore [V] `shadrox-dist-060/` and `vibe_images/`; do not edit ignore rules or delete either implicitly. |
| Signature scope | Approve bounded Self-Healing Proof and its cuts before it displaces Phase 4. No promise of market uniqueness or full process rewind. |
| Provider costs versus business pricing | Update verified provider metadata only; prices, credit caps/conversion and margins remain user decisions. |
| New dependencies/adapters | Prefer existing facilities; justify any missing package or adapter, its license and size before installation/packaging. |
| Session budget / stopping point | Select one card at a time. Actual credit consumption is unavailable; stop at verified task boundaries, not after making half a large feature. |

## 9. Never do

- Never copy code from [R] `reference/zed-main`, including files that might individually have a permissive license; user prohibition covers the checkout.
- Never read credential files or print keys/tokens; use synthetic fixtures and runtime-only scrubbing. Do not persist private observations into this public repository.
- Never use git stash, restore, clean or checkout-discard commands; never overwrite another session's uncommitted work.
- Never stage this playbook, [V] `PLAN-BIGTASK.md`, private strategy notes, [V] `shadrox-dist-060/` or [V] `vibe_images/` as collateral changes.
- Never build installer output inside OneDrive, silently publish via the release script, force-push or delete old release assets without approval.
- Never equate an exported helper, source comment, passing unit test or old screenshot with a wired and manually verified feature.
- Never ship partial rails as completed features; never regress the zero-byte mismatch, zero-tab context or foreign-process preview invariants.
- Never inject unreviewed PTY input, treat a model Boolean as user consent, or auto-retry a rejected command.
- Never call data fences or a binary-name allowlist a sandbox; approved commands can still execute project-controlled code and change files.
- Never claim UI completion without using the running feature; root typecheck does not validate landing, and browser-only tests do not validate native dialogs.
- Never change business pricing/credit policy, install dependencies without justification, or invent a source license/header.
- Never report guessed credit usage, fabricated test counts, unsupported cache savings or unverified competitor claims as facts.

## 10. Plan drift log

| Statement or assumption | Correction / retained evidence |
|---|---|
| Wrong App hub path | [V] `PLAN-BIGTASK.md:32` names a components path; the directly read hub is [V] `src/App.tsx:1`. |
| Old landing component architecture | [V] `landing/app/page.tsx:1` renders only an iframe. Editing old components may have no visible effect. |
| Existing FAQ schema must remain 1:1 | [V] `PLAN-BIGTASK.md:98` assumes FAQ schema; the full direct read of [V] `landing/app/layout.tsx` found only Organization, Person, WebSite and SoftwareApplication. |
| Download helper is the sole version source | [V] `landing/app/layout.tsx:82` and `landing/app/layout.tsx:85` hardcode version/download metadata; the plan's single-source assumption is false today. |
| Root typecheck covers the landing | [V] `tsconfig.json` excludes landing; [V] `package.json:23` invokes the root compiler. Separate landing validation is required. |
| Files never cloud / zero server dependency | [V] `PLAN-BIGTASK.md:61` overclaims. [V] `src/App.tsx:3146` sends fitted context to transport; [U] `src/lib/ai.ts` and auth paths require localized confirmation before wording changes. |
| Unique advantage no competitor can offer | [V] `PLAN-BIGTASK.md:61` and `PLAN-BIGTASK.md:64` are aspirations, not verified comparative facts. No competitor research was performed for this document. |
| Permission only at folder open | [V] `PLAN-BIGTASK.md:20` conflicts with explicit approvals at `PLAN-BIGTASK.md:76`; preserve meaningful execution consent pending the user's decision. |
| 70% feature is sufficient | [V] `PLAN-BIGTASK.md:65` conflicts with `PLAN-BIGTASK.md:22`; scope reduction is acceptable, incomplete production integration is not. |
| npm/pytest/tsc allowlist means safe execution | [V] `PLAN-BIGTASK.md:45` proposes binary-based silent execution; these tools run workspace-controlled code. Argument APIs do not provide a sandbox. |
| Model confirmation equals human approval | [V] `src/lib/agent/tools.ts:410`, `src/App.tsx:3631` and `electron/main.cjs:1877` prove distinct and incomplete approval paths. |
| PAT leak already reproduced | [V] `PLAN-BIGTASK.md:42` overstates the evidence: [V] `api/_http.ts:87` proves missing shape coverage; no live credential leak was reproduced here. |
| System helper proves system-shell scrubbing | [V] `electron/terminal-modes.cjs:75` differs from live resolver behavior at `:97` and `:107`; system inheritance is intentionally separate from model-driven execution. |
| Aider Trie port | Reference research [R] found no Trie implementation; [U] `src/lib/completionTrie.ts` is custom. Do not claim copied LOC without provenance. |
| OpenHands backend condenser is locally available | [R] local snapshot is frontend-oriented; [R] `src/api/agent-server-adapter.ts:1328-1339` in that checkout contains configuration, not the backend condenser. Exact checkout prefix is unverified. |
| Ranked map already supplies AST graph edges | [V] `PLAN-BIGTASK.md:86` assumes more than the regex/signature-ranked implementation mapped in Phase 1; [U] `src/lib/agent/repoMap.ts` needs real parser-backed edges for T15. |
| Aider repomap TypeScript candidate | [R] source is `reference/aider-main/aider/repomap.py:89-101`, not a TypeScript file; referenced sampling is approximately 100 lines, not every hundredth line. |
| Void PHP helper / language protocol claim | [R] actual helper is under `reference/void-main/extensions/php-language-features/src/features/utils/async.ts`; the validator invokes php -l, not an LSP server. Range unverified. |
| Void tfIdf is learned user recency | [R] the researched tfIdf implementation is corpus similarity; exact path not retained, so no invented location or claim of user-learning is supplied. |
| One cache_control format fits every provider | [V] `PLAN-BIGTASK.md:87` requires provider-specific correction; R07 demonstrates placement discipline, not Gemini/Groq wire compatibility. |
| Old installer path/session still exists | [V] `PENDING.txt:6` and `PENDING.txt:14` describe a prior live session/artifact under a different Windows user path; neither was freshly verified in Phase 1. |
| Cleanup / branding already approved | [V] `PLAN-BIGTASK.md:99` and [V] `PENDING.txt:19` leave these decisions with the user. No approval follows merely from this playbook. |
| Phase 1 would cost about 150 credits | [V] `PLAN-BIGTASK.md:107` is a budget, not actual usage; user now reports about 550. Do not fill the ledger with invented metering. |
| Baseline guarantees current or installed state | The 1,066/0 baseline is a historical automated result at `d49310e`; later commits, UI behavior and packaged artifacts require their own scoped verification. |

- Scope limit: this is every contradiction retained from the completed orientation, not a new exhaustive audit of all documentation or a live environment check.
## 11. Competitive bar (PLAN-BIGTASK.md Phase 3 requirement)

- Status: compiled from general product knowledge in this session, NOT from current competitor research. Every external column is [U] unverified — re-check before editing before using any of it in marketing or in a "we beat X" claim.
- Rule: this table exists to pick targets, not to assert facts. A gap that is not owned by a task card below is out of scope, not "planned".

| Competitor | What they have | ShadRox today | Target card |
|---|---|---|---|
| Cursor | High-quality tab completion | Custom Trie ghost completion exists; quality unmeasured | already DONE; no card |
| Cursor | @-context UX | @mentions + retrieval exist; no dependency-contract context | T15 |
| Cursor | Agent fluency / multi-step edit | Bounded tool loop, patch grammar, disk-write proof | already DONE; hardening via T03, T04 |
| Cursor | Structured project understanding | Ranked map only, not a graph | T15 |
| Cursor | Provider freedom | BYOK across Gemini/Groq/OpenAI-compatible | our advantage; protect it, do not add lock-in in T12/T16 |
| VS Code | Debugger depth (breakpoints, stack, scopes, hover) | DAP core only, zero UI | T10, then T09 |
| VS Code | Terminal shell integration + command lifecycle | Plain PTY, no structured state | T07, T06 |
| VS Code | Extension ecosystem | Own plugin/automation engine, consent-bound | out of scope; T04 only fixes its consent boundary |
| Devin / Trae | Planning autonomy | Autonomy DAG, repair loop, team merge turn | already DONE; reliability is the gap |
| Devin / Trae | Self-verification of its own work | Verified writes + checkpoint evidence; no failure-to-proof loop | T05, T09, T17 |
| Devin / Trae | Cloud sandbox with isolated state | Real local machine state (files, terminal, preview, git) | T07 + T11 + T17 make that visibility usable |
| All of them | Server-side context store / telemetry | Selected context still leaves to the provider; ShadRox does not sync projects | T13 plus the §8 privacy-wording decision |

- Structural position to exploit, stated honestly: one process owns editor, terminal, preview, git and checkpoints, so cross-surface correlation is cheap here and awkward for a cloud agent. That is an architectural reason, not proof that no competitor ships it.
- Anti-target list (deliberately NOT chased this program): extension marketplace, remote development, language servers beyond TypeScript, heap profiling, database/tooling UI, multi-model auto-routing rework.

## 12. Credit ledger carried from the plan

| Phase | Cards | Plan budget | Size mix | Actual |
|---|---|---|---|---|
| 1 Orientation | none (delivered as §1) | 150 | — | user reports ~550; no meter available |
| 2 Security | T01–T04 | 200 | 1 S, 1 M, 2 L | blank |
| 3A Terminal | T05–T07 | part of 1,100 | 1 S, 2 M | blank |
| 3B Preview/debugger | T08–T11 | part of 1,100 | 1 S, 2 M, 1 L | blank |
| 3C Prompt/BYOK | T12–T16 | part of 1,100 | 4 M, 1 L | blank |
| 3D Signature | T17 | ≤250 inside 3 | 1 L | blank |
| 4 Release/battery | T18–T20 | 300 | 1 S, 1 M, 1 L | blank |
| Buffer | none | 250 | — | blank |

- Plan rule: if a phase passes 1.5x its budget, trim later phases and say so immediately; never fill a ledger with invented numbers.
- Stop rule that protects a low-credit session: one card per session, commit only at a verified boundary, and if credits run out mid-card, leave the tree compiling and record the exact next command in §13 rather than half-wiring a feature.
- 3A/3B/3C sizes above are the card mix; the plan's single 1,100 envelope still applies across all of Phase 3.

## 13. Per-phase report format (required by the plan)

Every phase report must contain, in this order:
1. Files changed + commit hashes.
2. Test count and the real exit codes from the shared gates; count must stay ≥1,066.
3. LOC **ported** vs **written** vs **rejected** — ported only when a specific upstream file and license back it; custom code must be reported as written, never as a port; rejected counts work deliberately not done to protect the budget.
4. Remaining TODOs with the reason for each (blocked, cut for scope, or deferred by decision).
5. Anything the report cannot honestly claim, listed as "not verified".

- Known ledger corrections so a future session does not report a false port: completionTrie is custom (no Aider source found), OpenHands backend condensers are absent locally, aider repo map is Python, and the DAP/UI work in T10 is an adaptation of MIT models rather than a drop-in copy.
- Documentation-only sessions, including the creation of this file, report LOC as `0 / this file only / 0` and product files changed as zero.

## 14. Coverage check — plan line by line

| PLAN-BIGTASK.md item | Where it lives in this file |
|---|---|
| Baseline, never-below-1066, per-phase gates | Header, §3 gates, §13 |
| Non-negotiable rules 1–8 (license, exit codes, git, secrets, build trap, product invariants, no new deps, complete-or-nothing) | §9, §8, §10, §5 |
| DONE list | §1 reconciliation |
| Phase 1 orientation goals 1–5 (read order, module map, style, manifests, report) | §1, §2, reference rows in §3 |
| Phase 2 items 1–3 including all three sub-bullets | T01, T02, T03, T04 |
| Phase 3A shell integration, terminal-state API, approve-once stdin, aider failure classification | T07, T07, T06, T05 |
| Phase 3B DAP siphon, void data layer, React debugger, repair context, visual assertions, HMR chip, heap deferred | T10, T10, T10, T09, T11, T08, §4 cut list |
| Phase 3C AST context graph, prompt caching, trim-order merge, model metadata DB, secret scrub | T15, T16, T14, T12, T13 |
| Phase 3D three seeds, recommend one, ship complete, user approval | §4, T17 |
| Competitive bar Cursor/VS Code/Devin/Trae + local advantage | §11, §10 drift rows |
| Phase 4 battery, installer, landing polish, user approvals | T18, T20, T19, §8 |
| Credit ledger table and 1.5x rule | §12 |
| Report format files/commits, tests, LOC ported-written-rejected, TODO reasons | §13 |
| PENDING.txt items T2 FAQ, rollback, delete-file, git commit, Hinglish report | §5 battery rows |
| PENDING.txt old installer path and prior live session | §10 drift row |
| "Built with ShadRox" / IGNOU cleanup / .gitignore asks | §8, never auto-approved |

- Deliberate deviations from the plan, each defended above: the plan's App path is wrong; the FAQ-schema "1:1 rule" protects a node that does not exist; argv allowlists are not sandboxes; model-set confirmation is not approval; provider cache formats are not portable; "files never leave the computer" and "zero server dependency" need rewording; 70%-ship loses to complete-or-nothing.

- Handoff ledger: 23 cards — 4 S, 9 M, 10 L (§3 covers T01–T20, §15 adds T21–T23). Four separate Phase 2 commits are T01–T04. Cheapest next task: T01; cheapest flagship task: T23 inside the T21 chain. Product files changed by creating and completing this document: zero.

## 15. Flagship features from competitor research (supersedes the §4 single recommendation)

Research basis: three web-research passes on 2026 competitor docs/privacy pages, GitHub issue trackers, Reddit/HN complaint threads and Windows API feasibility. External URLs were fetched by research agents this session and are [R] re-check-before-quoting; they are evidence, not verified code claims.

### 15.1 The market's proven, unresolved wounds

| Pain | Evidence that it is real and unsolved |
|---|---|
| Phantom completion — the agent claims work it never established | A 100+ session audit reports 30–40% of interaction time spent just verifying claims; named failure modes include blind file edits with no read-back ([anthropics/claude-code#32650](https://github.com/anthropics/claude-code/issues/32650)); "mental load of going back through every line" ([HN 47048461](https://news.ycombinator.com/item?id=47048461)) |
| Runtime blindness | Users copy-paste terminal output back into the agent ([cline#641](https://github.com/cline/cline/issues/641), 32 comments); output-capture regressions ([cline#3445](https://github.com/cline/cline/issues/3445), 103 comments); browser-replay MCPs built just to hand the model console/DOM state ([HN 46057973](https://news.ycombinator.com/item?id=46057973)) |
| Rewind is a lie | Cursor "Restore checkpoint doesn't revert terminal commands" ([r/cursor](https://www.reddit.com/r/cursor/comments/1mawncv/oh_god_it_happened_to_me_too/)); checkpoint button disappearing; Copilot has no per-message revert at all |
| Runaway, unobservable spend | "$2000 in less than a session" ([r/cursor](https://www.reddit.com/r/cursor/comments/1szupca/agent_got_stuck_in_a_loop_and_spent_over_2000_in/)); 13M tokens for a failed implementation; no aggregate cost view ([Roo#6822](https://github.com/RooCodeInc/Roo-Code/issues/6822)) |
| Structurally excluded developers | Companies banning AI tools; privacy mode still means code leaves the machine ([r/ChatGPTCoding](https://www.reddit.com/r/ChatGPTCoding/comments/1qi4sq0/my_company_banned_ai_tools_and_i_dont_know_what/)) |

### 15.2 Why the field cannot answer these (architectural, not roadmap)

- Cursor: "Custom API keys only work with chat models. Tab completion continues using Cursor's built-in models" — the fast loop is permanently server-side ([api-keys](https://cursor.com/docs/settings/api-keys)); Cloud Agents are the one feature requiring Cursor to store code ([privacy governance](https://cursor.com/docs/enterprise/privacy-and-data-governance)).
- Copilot cloud agent runs in an ephemeral firewalled environment on GitHub infra; VS Code BYOK covers chat/tools but not inline completions ([responsible use](https://docs.github.com/en/copilot/responsible-use/agents), [BYOK blog](https://code.visualstudio.com/blogs/2025-10-22/bring-your-own-key)).
- Devin/Jules/Replit: the session machine belongs to the vendor; Devin "Local Hands" only lets a cloud session drive your PC per approved call ([local-hands](https://docs.devin.ai/work-with-devin/local-hands)); Jules clones into a Google VM ([faq](https://jules.google.com/faq)).
- Gemini CLI / Trae free tiers: your data is the payment ([plans](https://geminicli.com/plans/)).
- Cursor audit logs exist but are enterprise-side, cloud-authored, and record admin events rather than agent actions ([compliance docs](https://cursor.com/docs/enterprise/compliance-and-monitoring)) — a vendor log cannot be adversarially verified offline.
- Windsurf retired as a brand into Devin Desktop; Roo Code's cloud shut down May 2026; Void is paused; Aider is stagnant. The local-first, full-loop seat is genuinely vacant, and the failures show why: they could not monetise an agent loop without a cloud.

### 15.3 Ideas explicitly rejected as moats

- Machine-wide cross-project agent memory: `agentmemory`, `claude-mem`, `codebase-memory-mcp` already ship it, and anything installable as an MCP server is copied in five minutes ([agent-memory.dev](https://agent-memory.dev/)).
- "What was I looking at" desktop capture + OCR + ASR: Screenpipe already ships it with a Claude Code integration ([docs](https://docs.screenpipe.com/claude-code)); screen capture of other apps also inherits Recall's exfiltration threat model ([doublepulsar](https://doublepulsar.com/recall-stealing-everything-youve-ever-typed-or-viewed-on-your-own-windows-pc-is-now-possible-da3e12e9465e)).
- Anything needing a kernel/minifilter driver, machine-wide ETW, raw USN/VSS without elevation, or low-level keyboard hooks: unsigned-driver SmartScreen death, admin prompts, AV heuristics and keylogger-adjacent brand risk. Not shippable by one person.

### T21 — Proof Ledger: the agent must evidence every claim

- Phase / why / risk level: new flagship (replaces the §4 pick) / attacks pain #1, the single largest measured cost of AI coding today / medium risk, highest differentiation.
- Files: [V] `src/App.tsx:2504` verified-write path, `src/App.tsx:2591` disk proof, `src/App.tsx:3602` command host; [U] `src/lib/history.ts` checkpoints, `src/lib/agent/toolProtocol.ts` results, `electron/git-scm.cjs`; [N] `src/lib/proof/ledger.ts`, `src/lib/proof/verify.ts`, `src/lib/proof/ledger.test.ts`; [V] `package.json:21`.
- Port source: none — original. Follow the in-toto/AWP receipt concept as a design reference, do not copy their code ([in-toto background](https://arxiv.org/html/2606.04193v1)).
- Steps:
  1. Define one append-only, Ed25519 hash-chained event record per agent action: timestamp, workspace, action type, before/after file SHA-256, command argv, cwd, exit code, stdout/stderr hash, port/DOM assertion result, model+provider identity, token counts and cost estimate.
  2. Write it where the truth already lives — inside the verified-atomic-apply, the command host and the preview/checkpoint paths — so a claim can only be recorded from an observed outcome, never from model narration.
  3. Record denials and cancellations as first-class events; an unapproved command must produce a receipt that says so.
  4. Add `shadrox verify`: recompute the chain and re-hash the current files on disk, then report which claims still hold and which the user or another tool has since invalidated.
  5. Render the ledger as the chat turn's status ("3 files changed, hash verified · npm test exit 0 · preview 200 at :5174"), plus an exportable transcript for a human reviewer.
  6. Fold cost into the same chain so runaway spend becomes auditable per turn — the missing aggregate view Roo/Cursor devs script themselves.
  7. Register ledger tests (chain tampering, hash mismatch, stale proof, cancelled action, truncation) and prove it on a real agent turn.
- Test: [N] `src/lib/proof/ledger.test.ts`; append exactly `src/lib/proof/ledger.test.ts`.
- Verify: `node --import tsx --test src/lib/proof/ledger.test.ts src/lib/applyPipeline.e2e.test.ts; echo $?`; shared gates exit 0, count ≥1,066; manual: one real turn, then hand-edit a file and confirm `verify` flags it.
- Definition of done: every agent claim in a real session has a machine-observed receipt, and offline verify runs against the live workspace. No claim is recorded from model output.
- Why nobody else can: a cloud agent verifies on its own word inside its own VM, and its vendor-authored logs cannot be checked offline on the user's files. Only the app that holds the disk, the PTY and the preview can produce adversarially checkable receipts.
- Commit message: `feat: machine-observed proof ledger for agent actions`.
- Do-not-touch list: treating model narration as evidence, uploading receipts anywhere, changing the zero-byte mismatch invariant.
- Credits: M.

### T22 — Machine Delta: rewind the machine, not just the files

- Phase / why / risk level: new flagship #2 / fixes the rewind everyone ships but nobody completes / high risk if restore is oversold, safe if scoped.
- Files: [V] `src/App.tsx:4524` restore path; [U] `src/lib/history.ts`, `src/lib/timeline.ts`, `electron/preview-runtime.cjs`, `electron/terminal-modes.cjs`; [N] `src/lib/machine/snapshot.ts`, `src/lib/machine/delta.ts`, `src/lib/machine/delta.test.ts`; [V] `package.json:21`.
- Port source: none — original observation logic; reuse existing preview/terminal/git state rather than a new watcher stack.
- Steps:
  1. At each agent turn, snapshot machine state by plain Node only: git HEAD/branch/dirty set, file hashes (existing checkpoints), workspace-relative env additions, active ports from the preview runtime, terminal cwd, dependency manifest hashes (`package.json`/`package-lock.json`/`requirements.txt`/`pyproject.toml`), tool versions via a bounded `--version` probe list the user approves.
  2. Produce a per-turn DIFF, not a full copy: "this turn changed 3 files, installed 2 packages, started a server on 5174, moved HEAD, wrote 1 PATH entry".
  3. Render it on the existing timeline scrubber as the machine-level layer above file-level restore.
  4. Revert ONLY what is honestly reversible: files, git position, preview/owned processes, dependency manifest + lockfile state, env/PATH entries ShadRox itself added. Show everything else as "observed but not revertable".
  5. Never touch Volume Shadow Copy, registry system hives, other users' state, or elevated restore; a bricked beta machine is a company-ending event for a solo dev.
  6. Register snapshot/delta/revert tests including a turn that installs a package and one that kills nothing foreign; then verify on a real machine with the user's own repo copy.
- Test: [N] `src/lib/machine/delta.test.ts`; append exactly `src/lib/machine/delta.test.ts`; retain `src/lib/timeline.test.ts`, `electron/preview-runtime.test.cjs`.
- Verify: `node --import tsx --test src/lib/machine/delta.test.ts src/lib/timeline.test.ts; echo $?`; shared gates exit 0; manual rewind of a turn that started a server and edited files.
- Definition of done: a user scrubs to any agent turn, reads the exact machine delta, and one click restores files+git+owned processes+dependency state, with the non-revertable remainder labelled.
- Why nobody else can: Devin/Jules/Replit/Cursor snapshots only the files inside the workspace they were handed; their session machine is their own image, so it can neither observe nor restore the user's real environment. Cursor's checkpoint is documented as not reverting terminal commands — the gap is theirs to explain.
- Commit message: `feat: machine-level delta and bounded rewind per agent turn`.
- Do-not-touch list: system restore/VSS/admin elevation, registry writes, killing processes ShadRox does not own, promising full-machine reversibility.
- Credits: L.

### T23 — Egress Ledger (cheap trust bolt-on to T21)

- Phase / why / risk level: flagship support / converts "local-first" from a slogan into a checkable claim / low effort, high marketing value.
- Files: [U] `api/ai/_gemini.ts`, `api/ai/_openai.ts`, `api/ai/_compatible.ts`, `src/lib/ai.ts`; [V] `api/_http.ts` redaction, `src/lib/providerKeys.ts`, `electron/preload.cjs`; [N] `src/lib/proof/egress.test.ts`.
- Port source: none.
- Steps: log every outbound request as one T21 ledger event class (destination host, method, body hash, byte count, which fields the scrubber removed, provider+model, cost); add an allowlist mode that hard-refuses anything non-localhost except the user's configured provider; show a per-day "what left this machine" view; ship a signed-offline-audit story so an NDA/banned-at-work developer can prove compliance to their employer.
- Test: [N] `src/lib/proof/egress.test.ts`; append exactly `src/lib/proof/egress.test.ts`; reuse `src/lib/providerKeys.test.ts` guards.
- Verify: `node --import tsx --test src/lib/proof/egress.test.ts src/lib/contextSecrets.test.ts; echo $?`; shared gates exit 0; manual: confirm the app with allowlist on cannot reach any non-provider host.
- Definition of done: one screen answers "what left my machine today" and one switch enforces it.
- Why nobody else can: their business is shipping your code to their servers; Cursor's own docs state prompts persist at the model vendor even under privacy mode. A local BYOK app is the only shape that can make this claim, and it is 3–5 days of plain Node.
- Honest limit: this is ShadRox's own word unless paired with reproducible/open-source verification — decide §8's open-source question before marketing it as a proof.
- Commit message: `feat: auditable egress ledger with provider allowlist`.
- Do-not-touch list: printing request bodies, storing provider keys in the ledger, silently blocking the user's own configured endpoints.
- Credits: S.

### 15.4 Why this trio is the unfair advantage

- One hash-chained local event stream powers all three: what the agent changed (T21), what it did to the machine (T22), what it sent out (T23). Cloud products can copy the UI but cannot generate the data.
- Order and cost: T01–T04 (security) still precede these because an ungated command host makes a proof ledger an attestation of unsupervised execution. Then T21 → T23 (cheap, visible, differentiating) → T22 (largest). T17 becomes the repair workflow that consumes T21's receipts instead of duplicating it; T09/T11 feed T21 as evidence producers.
- Positioning line, no invented uniqueness: "Every other agent asks you to trust it. ShadRox prints the receipt, the machine delta, and the exact bytes that left — all offline, on your key." Uniqueness claims stay unverified until a dedicated competitor sweep says otherwise.
- Recheck before quoting in landing copy: all competitor doc lines above are agent-fetched snapshots that change; T19a should re-verify any sentence we publish.

## 16. Industry-level gap, from the inside

Written after T22 shipped (`ef95128` + reaper-test race fix `12af6e6`). Every claim tagged: [code] = read in this repo at these lines today; [doc] = a repo document/spec; [web] = agent-fetched external material that must be re-verified before publishing (see §15 rule).

### 16.1 Correction to this document

- [code] §2 line 58 says the live system shell "gets the full environment" and calls that an intentional product distinction. That is wrong as shipped: `electron/main.cjs:1754` routes the system-mode terminal through `systemEnvironment(plan.env)`, and `electron/terminal-modes.cjs:75-77` defines `systemEnvironment` as `scrubEnvironment` — credential-pattern variables are stripped from BOTH terminal modes; only `agentEnvironment` vs `systemEnvironment` naming and shell selection differ (`terminal-modes.cjs:61-99`). The real distinction is shell choice (PowerShell vs ComSpec) and mode labelling, not env leakage. Update §2/§9 wording before re-auditing.

### 16.2 Industry gaps that T21–T23 do not yet cover → new cards

#### T24 — Turn budget: cap runaway spend before it happens

- [code] Gap: rates and the context-cost router exist and are tested, but nothing enforces a per-run or per-day ceiling in-app; the chat loop can only be stopped by hand. [web] "$2000 in less than a session" and the missing aggregate cost view (§15.1) are still unsolved industry-wide.
- Files: [U] `src/App.tsx` turn loop, `src/lib/usageCredits.ts`, `src/lib/contextCost` layer, [N] a budget gate module + test; [V] `package.json:21`.
- Steps: sum estimated cost from the SSE usage frames per turn and per session; hard-stop the agent loop at a user-set cap with a visible "budget exhausted" timeline entry; expose a per-day total in the same surface as T21's ledger.
- Done when: an autonomy run cannot exceed its declared budget without a user action. Commit: `feat: per-turn and per-day spend cap enforced in the agent loop`. Credits: S.

#### T25 — True offline seat for banned-at-work developers

- [code] Gap: BYOK + `/v1`-compatible base URL already points at any host, and the egress ledger design (T23) exists on paper; nothing is verified as "zero non-localhost bytes" in CI. [web] Companies banning AI tools and privacy-mode-still-exfiltrates (§15.1) remain the structurally excluded segment.
- Files: [U] `src/lib/providerKeys.ts` baseUrl handling, [N] an offline-profile test; reuse T23's allowlist. [doc] README/landing copy update.
- Steps: define an "Offline" provider profile (Ollama/LM Studio URL preset, telemetry/auth calls refused); add a CI test that boots the renderer path and asserts no non-localhost connect is attempted; document the exact NDA answer text.
- Done when: one switch makes the app provably LAN-only. Commit: `feat: verified offline provider profile`. Credits: S.

#### T26 — Delta export: hand the rewind story to another human

- [code] Gap: T22's machine report lives in renderer state only; `saveCheckpoint` metadata is local and transient. [doc] §15.2 notes vendor audit logs are cloud-authored and not adversarially checkable — our equivalent is checkable but currently unexportable.
- Files: [U] `src/lib/history.ts`, `electron/machine-delta.cjs` view(), [N] a JSON export + verifier test.
- Steps: serialize one turn's machine delta (paths, hash kinds, git refs, preview identities, omissions, partial flag) into a signed-hash JSON file; a second machine can re-verify file hashes against it. No content bytes in the export (same contract as the DTO).
- Done when: one turn's delta survives as one portable file a reviewer can check offline. Commit: `feat: exportable, offline-verifiable machine delta receipts`. Credits: M.

#### T27 — Close the runtime-blindness loop without copy-paste

- [code] Gap: the agent gets bounded one-shot output and can open a file-attached PTY view, but a live interactive terminal's new output is not fed back as bounded context; the user still pastes. [web] cline#641 / #3445 complaint threads (§15.1) are exactly this.
- Files: [U] `electron/main.cjs` terminal output fan-out, `src/hooks` context assembly, `src/lib/promptContext.ts`.
- Steps: per agent turn, auto-attach the last N KB of scrolled output from sessions the agent itself started (T22 already records owned terminal ids + launch cwd); label it as observed runtime output, never as user prose.
- Done when: an agent turn after a failing `npm test` in an agent-started terminal carries the failure text with zero user pasting. Commit: `feat: agent-owned terminal output flows back as bounded context`. Credits: M.

#### T28 — Quarterly competitor-doc sweep (keeps us honest)

- [doc] Gap: every §15.2/§15.3 sentence is a point-in-time agent fetch; landing copy (T19) publishes derived claims. [web] Nothing re-verifies them on a schedule.
- Steps: a checklist card that re-fetches the six cited vendor docs, diffs claims, and gates any marketing edit on a green sweep. No app code. Commit: `docs: competitor claim re-verification sweep`. Credits: S.

### 16.3 Five strengths, from the inside

- [code] One process holds disk, PTY, preview and git — capture points T22 exploited (`electron/machine-delta.cjs` reads only app-owned state, no new watcher stack).
- [code] Fail-closed discipline is already cultural: zero-byte-on-mismatch, fatal UTF-8 decode, foreign-lock preservation (all in `machine-delta.cjs`/`machine-git.cjs` and tested).
- [code] Honest-restore contract: `{ok, partial}` with labelled omissions — shipped in T22, rare in an industry that shows green checkmarks on best-effort reverts.
- [code] Plain Node, no native modules, no admin: everything in T22 runs under the user's own token with `git.exe` + `fs`; the beta machine cannot be bricked by elevation mistakes.
- [doc] The [V]/[U]/[N] ledger in this file makes drift visible inside the repo itself — most plans rot silently.

### 16.4 What we refuse, and why solo-dev is the reason

- [code] §9 bans stay: no VSS, registry hives, elevation, full-restore promises, killing foreign processes, new npm dependencies. T22 implements exactly the honest subset.
- Refusals with causes: kernel/minifilter or ETW monitoring (unsigned-driver death, §15.3), a cloud relay/telemetry fleet (business model contradicts local-first pitch), model hosting (capital), multi-user collab backend (ops surface we cannot staff), marketplace/plugin runtime (trust chain we cannot audit alone).
- [doc] These are not capability gaps; they are solo-dev blast-radius math written down.

### 16.5 Honest limit on the "why nobody else can" lines

- No technical impossibility has been proven for cloud agents: nothing in §15.2 shows Cursor/Devin/Copilot *cannot* build local receipts or bounded machine deltas — their constraint is product shape and business model (code must reach their servers to be the product), not physics or missing APIs. Any marketing sentence must phrase it that way. [web] This stays true until a vendor ships the counterexample.

### 16.6 Top three differentiation targets (order and why)

- 1. T21 proof ledger → T26 export: the verifiable-receipt story is the headline none of the cloud products can let become their core. [doc]
- 2. T22 machine delta (shipped) + T27 runtime feedback: "the agent that can actually undo, and can see what it ran" directly answers the two loudest complaint threads in §15.1. [code]
- 3. T25 offline seat + T23 egress ledger: the banned-at-work/NDA developer is a paying segment nobody else is allowed to serve. [web]
