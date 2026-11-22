# ShadRox IDE — AI Pipeline, Token Efficiency & Reliability Audit Report

## 1. Executive Summary & Token Leak Analysis
ShadRox’s AI orchestration already includes foundational safeguards (heuristic loop guards, patch verification, BYOK credential redaction, and basic token budgets), but **critical disconnects between the UI, client retry layer, server adapters, and filesystem tools** cause massive token waste, premature stream completion, and unsafe file or command mutations.

### Top Sources of Token Waste & Free-Tier Exhaustion
1. **Dual Tool Protocol Bloat:** The system sends native JSON tool schemas while simultaneously teaching the full text-based tool protocol in the system prompt, doubling recurring input token overhead on every turn.
2. **Broken Native Tool History Round-Tripping:** Incoming native tool calls lose their `call_id` and provider continuation metadata (such as Gemini thought signatures), converting into flat user and assistant text blocks. Smaller or free models get confused and waste turns re-reading files.
3. **Unenforced 48,000-Character Tool Output Budget:** `toolProtocol.ts` checks raw character length instead of JSON-escaped length. Quote-heavy code or logs can balloon past 80,000 characters after JSON escaping without triggering truncation.
4. **Full-File Disk Reads & Unbounded Context:** Reading a line range still loads up to 2 MiB from disk, and `loopContext.ts` leaves assistant messages and the last 4 tool observations unbounded without a hard provider-aware token ceiling.
5. **Multiplying Retry Loops:** Up to 6 server retries multiplied by 4 client retries results in up to 24 upstream requests per failed turn, while discarding `Retry-After` headers and burning free-tier RPM/TPM limits.
6. **Whole-File FIM Validation Rejections:** The editor sends up to 30,000+ characters for autocomplete (FIM), causing server validation failures before truncation even runs.

---

## 2. Critical Loopholes & Infinite Loop / Safety Risks

### P1 — High-Severity Safety & Data Loss Defects
* **Command Approval Bypass (`READ` Auto-Run):** `fd --exec`, GNU `sed` execute/write flags, `awk system()`, and mutating `git symbolic-ref` commands are misclassified as read-only and auto-execute without user confirmation.
* **Non-Atomic File Saves & Overwrite Races:** `saveFiles` checks `expectedVersion` before async temp-file creation, allowing concurrent edits to be overwritten. Hard-link fallback on `EEXIST` can overwrite newly created files even when `expectedVersion: null`.
* **Broken Transaction Rollback:** Failed read-back after disk replacement excludes the modified file from `saved`, so rollback skips it while still reporting `rolledBack: true`. Rollback also ignores `expectedVersion`, overwriting newer external changes.
* **Destructive Whitespace-Tolerant Patching:** `patchEngine.ts` expands partial-line whitespace matches to entire lines, silently deleting surrounding code on the same line while reporting success.
* **False Successful Completion on Upstream EOF:** Gemini, OpenAI, and Compatible adapters treat any non-empty stream EOF as `done` even without a valid `finish_reason`, causing half-written files or truncated tool calls to appear successful.
* **Broken Autonomy Resume Reconciliation:** Resuming after a rollback keeps previously passed milestones marked `done` even though their workspace changes were reverted, resets active-time and attempt limits, and can mark plans `done` while unresolved tasks remain.

### P2 — Reliability, Loop & Quota Defects
* **Main-Process Regex Hang (ReDoS):** Synchronous regex search over long lines has no timeout or complexity guard and can freeze the entire Electron app.
* **Stale Symbol Rename Offsets:** `rename_symbol` computes compiler spans and re-reads files separately without verifying expected symbol text, corrupting shifted files.
* **False Process Termination:** Failed `killProcessTree` calls still mark `killedReason = 'user'`, leaving zombie background jobs running and disabling the timeout ceiling.
* **Groq & Provider TPM Clamping Mismatch:** Quota-error shrinking leaves `max_tokens` unchanged (for example, 8,192) and ignores tool schemas, guaranteeing repeated 429 failures on free-tier keys.
* **Broken Prompt Refinement Argument Order:** Custom prompt refinement swaps `rawPrompt` and `instruction`, turning user prompt text into the system prompt.
* **Mismatched FIM Cache Keys:** FIM caches only 1,200 prefix and 400 suffix characters and omits programming language, serving wrong-language completions.
* **Hosted SSRF & Custom Endpoint Gaps:** Custom endpoint validation checks hostnames rather than resolved DNS/redirect targets, omits IPv4-mapped IPv6 hex checks, silently drops `imageData` on custom vision calls, and hardcodes `max_tokens` without fallback dialects.
* **Incomplete Spend & Usage Telemetry:** Fallback estimates count only generated text/arguments while ignoring input tokens, schemas, and aborted/errored turns.

---

## 3. Exact File-by-File Action Plan (No Code)

### A. Token Efficiency, Context & History Management
* **`src/lib/agent/tools.ts` (lines 426–432, 499–538)**
  * **Issue:** Injects full text-based tool instructions even when native JSON tool calling is active.
  * **Fix:** Separate native tool mode from text-fallback mode; omit text protocol instructions completely when native tools are enabled.
* **`src/lib/agent/toolProtocol.ts` (lines 165–189)**
  * **Issue:** Enforces the 48,000-character budget on unescaped text rather than serialized JSON size, and enforces a 1,000-char floor that breaks small budgets.
  * **Fix:** Measure serialized JSON character/byte length inside the truncation loop and scale minimum observation floors proportionally to the total budget.
* **`src/lib/agent/loopContext.ts` (lines 16–21, 77–91)**
  * **Issue:** Compaction skips long prose-only histories and leaves assistant messages plus the 4 most recent tool observations uncapped.
  * **Fix:** Enforce a hard provider-aware token ceiling across all message roles, truncate oversized recent observations, and trigger compaction on total token count rather than message count alone.
* **`src/App.tsx` (lines 4026–4045) & `src/lib/agent/toolLoop.ts` (lines 1017–1037)**
  * **Issue:** Drops native `call_id`s and flattens tool calls and results into generic user/assistant text messages.
  * **Fix:** Preserve native tool call IDs, structured tool-result roles, and provider-specific continuation metadata (such as thought signatures) across turns.
* **`api/ai/_gemini.ts` (lines 185–198), `api/ai/_types.ts` (lines 3–54), `api/_validate.ts` (lines 113–165)**
  * **Issue:** Request schema rejects native tool-result roles and discards Gemini function-call metadata.
  * **Fix:** Extend shared message types and validators to support native tool-call and tool-result pairs along with opaque provider metadata.

### B. Provider Adapters, Streaming & Free-Tier Quota Handling
* **`api/ai/_gemini.ts` (lines 216–260), `api/ai/_openai.ts` (lines 310–385), `api/ai/_compatible.ts` (lines 245–318), `api/ai/chat.ts` (lines 238–263)**
  * **Issue:** Stream EOF without a valid `finish_reason` is emitted as a successful `done` event.
  * **Fix:** Require an explicit provider terminal finish reason before emitting `done`; classify premature EOF as an incomplete or retryable stream error.
* **`src/lib/quickEdit.ts` (lines 114–147)**
  * **Issue:** Ignores `onDone` incomplete flags and applies truncated completions.
  * **Fix:** Reject replacements when `onDone` reports truncation or missing terminal confirmation.
* **`api/ai/_upstream.ts` (lines 5–38, 73–136), `api/ai/chat.ts` (lines 182, 264–269), `src/lib/ai.ts` (lines 340–389, 506–524, 645–697, 730–740, 801–842), `src/lib/ai/backoff.ts` (lines 54–60, 138–143)**
  * **Issue:** Independent server (6x) and client (4x) retry loops multiply requests, strip HTTP status codes and `Retry-After` delays, and lack active-request deadlines or reader cleanup.
  * **Fix:** Use a unified turn-wide provider-hit and deadline budget; forward structured error envelopes preserving HTTP status, zero-quota flags, and exact `Retry-After` delays; cancel and release stream readers in `finally` blocks.
* **`api/ai/_openai.ts` (lines 26–35, 109–140, 192–245)**
  * **Issue:** TPM quota clamping leaves `max_tokens` too high, ignores tool schema tokens, and slices system prompts blindly.
  * **Fix:** Anchor TPM regex strictly, deduct tool schema and output token ceilings from the available quota budget, and prune history rather than slicing system instructions.
* **`api/ai/_budget.ts` (lines 64–89), `api/byok/validate.ts` (lines 63–69, 101–107), `src/lib/modelCapabilities.ts` (lines 109–147, 191–205), `src/lib/providers.ts` (lines 130–139, 199–212)**
  * **Issue:** Ignores discovered context windows from model validation, leaves capability flags unset, and marks unknown Gemini Flash models as free.
  * **Fix:** Pass discovered model context limits into server budgeting, populate tool/cache capability flags, and fail-closed on unknown model tiers.
* **`api/prompt/refine.ts` (lines 31–32, 65–115, 170–204), `api/ai/_compatible.ts` (lines 327–363), `src/lib/ai.ts` (lines 900–947)**
  * **Issue:** Custom refinement swaps `rawPrompt` and `instruction` arguments, lacks output caps and abort signals, and ignores selected models.
  * **Fix:** Fix parameter order, enforce strict `max_tokens` and `AbortSignal` timeouts, and route refinement through the unified metered completion service.
* **`src/lib/ghostText.ts` (lines 158–178), `src/lib/fimClient.ts` (lines 74–81, 193–228), `api/ai/fim.ts` (lines 48–55, 80), `src/lib/fim.ts` (lines 7–9, 24–36)**
  * **Issue:** Client sends full-file prefix/suffix exceeding the 20K server limit, while cache keys omit language and full prompt context.
  * **Fix:** Slice prefix/suffix on the client before dispatch and key the FIM cache on the full normalized prompt plus language ID.
* **`api/ai/_compatible.ts` (lines 43–60, 111–128, 154–194, 302–308), `api/ai/_endpoint.ts` (lines 54–71, 109–131), `api/byok/validate.ts` (lines 118–124), `api/ai/commit-message.ts` (lines 98–119)**
  * **Issue:** Custom endpoints silently drop images, fail on non-`max_tokens` parameters, validate hostnames instead of resolved IPs/redirects, and omit input/aborted token usage.
  * **Fix:** Serialize vision payloads properly, add parameter dialect fallback, validate resolved DNS and redirect targets, and record complete input/output usage across all routes.

### C. File System, Patching & Command Execution Safety
* **`electron/command-risk.cjs` (lines 773–788, 1079–1104, 1281–1316), `electron/command-approval.cjs` (lines 45–89), `electron/main.cjs` (lines 1153–1219)**
  * **Issue:** `fd --exec`, `sed` write/execute commands, `awk system()`, and `git symbolic-ref` bypass approval as `READ`.
  * **Fix:** Inspect command flags and subcommands for execution or write side-effects and downgrade them from `READ` to `MUTATE` or `EXECUTE` requiring approval.
* **`electron/workspace.cjs` (lines 894–925, 990–1014) & `src/lib/agent/tools.ts` (lines 945–991, 1240–1247)**
  * **Issue:** Non-atomic version checks, `EEXIST` overwrite fallback on new files, incomplete rollback tracking, and unread-file auto-reread overwrites.
  * **Fix:** Enforce atomic compare-and-swap writes, fail new-file creation on `EEXIST`, record pre-write snapshots for every touched file, track `rollbackErrors` before setting `rolledBack`, and require explicit model observation before edits.
* **`src/lib/patchEngine.ts` (lines 307–339, 365–422)**
  * **Issue:** Whitespace-stripped fallback expands partial-line matches to full lines, deleting unrelated code on the same line.
  * **Fix:** Restrict whitespace-tolerant matching to full-line boundaries only; reject partial-line matches instead of expanding replacement spans.
* **`electron/workspace.cjs` (lines 687–737)**
  * **Issue:** Unbounded synchronous regex execution can freeze the Electron main process.
  * **Fix:** Validate regex complexity, cap per-line length scanned, or offload regex search to a worker thread with a strict timeout.
* **`src/lib/agent/codeIntel.ts` (lines 267–317) & `src/lib/editor/edits.ts` (lines 12–22, 40–64)**
  * **Issue:** `rename_symbol` applies stale compiler offsets to re-read files without checking expected symbol text.
  * **Fix:** Capture file version before compiler lookup, verify exact symbol text at target spans, and abort if the version changed.
* **`electron/main.cjs` (lines 1082–1103, 1337–1344, 3000–3006) & `src/lib/agent/tools.ts` (lines 1527–1530)**
  * **Issue:** Failed `killProcessTree` still sets `killedReason = 'user'`, falsely reporting termination and disabling timeout kills.
  * **Fix:** Only set `killedReason` and return `killed: true` after confirming process-tree termination or exit.
* **`src/lib/agent/mcpTools.ts` (lines 158–184, 315–364) & `electron/mcp-client.cjs` (lines 317–341)**
  * **Issue:** Turn cancellation and timeouts do not cancel in-flight MCP requests, and MCP schemas truncate nested properties and enums beyond 6 fields.
  * **Fix:** Forward `AbortSignal` cancellation to MCP stdio/HTTP calls and expose full or on-demand schema inspection for complex MCP tools.

### D. Autonomy Loop, Turn Runner & UI State Integrity
* **`src/lib/autonomy/run-loop.ts` (lines 85–143, 164–187, 351–388), `src/lib/autonomy/runStore.ts` (lines 30–44), `src/hooks/useAutonomyRun.ts` (lines 168–177)**
  * **Issue:** Resume after rollback keeps rolled-back milestones marked `done`, resets time and attempt counters, and ignores unresolved pending tasks.
  * **Fix:** Bind task receipts to workspace checkpoint IDs, invalidate reverted milestones on rollback, persist cumulative active time and attempts, and block `done` while any task is non-terminal.
* **`src/lib/agents/turnRunner.ts` (lines 306–320, 324–428, 461–487)**
  * **Issue:** Intermediate reply patches are dropped during tool loops and `wroteNothing: true` is returned even when tools modified files.
  * **Fix:** Track all tool and reply mutations in a single turn mutation journal and derive `wroteNothing` and `changedFiles` strictly from that journal.
* **`src/hooks/useAutonomyRun.ts` (lines 92–153), `src/hooks/useTeamRun.ts` (lines 39–42, 75–107), `src/lib/agents/team-run.ts` (lines 344–355)**
  * **Issue:** Switching workspaces leaks active autonomy controllers across roots, and team pause UI promises a resume action that does not exist.
  * **Fix:** Bind controllers to an immutable workspace root ID and abort on workspace switch; implement team resume or remove the misleading prompt.

---

## 4. Recommended Execution Order (Fix Without Breaking)

### Phase 1 — Stop Token Bleed (Immediate Free-Tier Relief)
1. **`src/lib/agent/tools.ts`:** Remove duplicate text tool protocol instructions when native JSON tools are active.
2. **`src/lib/agent/toolProtocol.ts` & `src/lib/agent/loopContext.ts`:** Enforce the 48,000-char limit on JSON-serialized output and set a hard provider-aware token ceiling across all history and recent observations.
3. **`src/lib/ghostText.ts` & `src/lib/fimClient.ts`:** Slice prefix/suffix on the client before sending FIM requests and include language ID in the cache key.
4. **`api/prompt/refine.ts`:** Fix the swapped `rawPrompt` / `instruction` argument order and enforce output token limits.

### Phase 2 — Fix Stream Reliability & Retry Multiplication
1. **`api/ai/_gemini.ts`, `api/ai/_openai.ts`, `api/ai/_compatible.ts`, `api/ai/chat.ts`:** Reject premature EOF without a valid `finish_reason` instead of emitting `done`.
2. **`api/ai/_upstream.ts`, `src/lib/ai.ts`, `api/ai/_openai.ts`:** Unify retry budgets across server and client, preserve HTTP status and `Retry-After` headers, and fix Groq TPM clamping.
3. **`src/App.tsx`, `src/lib/agent/toolLoop.ts`, `api/ai/_types.ts`, `api/_validate.ts`:** Preserve native `call_id` and structured tool-result round-tripping across turns.

### Phase 3 — Lock Down File & Command Safety
1. **`src/lib/patchEngine.ts`:** Prevent whitespace-tolerant fallback from expanding partial-line matches and deleting surrounding code.
2. **`electron/command-risk.cjs`:** Block `READ` auto-execution on mutating flags (`fd --exec`, `sed` write/exec, `awk system()`, `git symbolic-ref`).
3. **`electron/workspace.cjs`:** Enforce atomic compare-and-swap saves, prevent `EEXIST` overwrites on new files, fix `rolledBack` error tracking, and bound or offload regex search.

### Phase 4 — Harden Autonomy & Team Run State
1. **`src/lib/autonomy/run-loop.ts` & `runStore.ts`:** Bind task receipts to checkpoint generations, invalidate rolled-back milestones on resume, and persist cumulative time/attempt budgets.
2. **`src/lib/agents/turnRunner.ts`:** Use a unified mutation journal for tool edits and reply patches.
3. **`src/hooks/useAutonomyRun.ts` & `src/hooks/useTeamRun.ts`:** Stop active controllers on workspace switch and fix team run resume handling.
