# ShadRox — AI Workflow (ASCII Deep Dive)

> Ye file ShadRox ke andar ek prompt submit karne se lekar streamed AI response + tool
> execution + persistence tak ka **pura end-to-end flow** ASCII me dikhata hai.
> Har phase ke saath real file paths, function names aur line numbers diye gaye hain.

Legend:
```
  -->   data / control flow
  <--   streamed / response flow
  [ ]   tool ya event
  { }   state / store
  ( )   decision
  |     boundary (process / transport)
```

================================================================================
 0. BIG PICTURE — ek prompt ka poora safar (10,000 ft view)
================================================================================

  USER
   |  type prompt + Enter
   v
┌──────────────────────────── RENDERER (React) ────────────────────────────┐
│ ChatPanel.tsx  -->  useOrchestrationController.handleChatSend()          │
│        |                    |                                            │
│        |                    +--> useContextBuilder.ts  (context assemble)  │
│        |                    +--> detectIntentToolBundles()  (unlock plan) │
│        |                    +--> streamChat()  (src/lib/ai.ts)            │
│        v                                                                 │
│   POST /api/ai/chat  (HTTP + SSE)                                        │
└────────────────────────────────|─────────────────────────────────────────┘
                                 |  (same machine: Express in Electron main)
                                 v
┌──────────────────────────── MAIN PROCESS (Node/Express) ─────────────────┐
│ server.ts  -->  api/ai/chat.ts                                           │
│     |  parseProviderId()  resolveKeyAccess() (BYOK)  budget check        │
│     |  nativeToolDefinitions()                                           │
│     v                                                                    │
│   ADAPTERS[provider].stream()   (_gemini | _openai | _compatible)        │
│     |  HTTPS  -->  LLM PROVIDER (Gemini / Groq / OpenAI-compatible)      │
│     <--  SSE deltas (text / reasoning / tool_calls)                      │
│     |  emit()  -->  sseSend(res, {type,...})                             │
└────────────────────────────────|─────────────────────────────────────────┘
                                 |  SSE  (text/event-stream)
                                 v
┌──────────────────────────── RENDERER (React) ────────────────────────────┐
│ streamChat() parses events: delta / reasoning / tool_calls / done /error │
│     |  text -> chat bubble (live)                                        │
│     |  tool_calls -> runToolRounds()  (src/lib/agent/toolLoop.ts)        │
│     |        |  runTool()  (src/lib/agent/tools.ts)                      │
│     |        |     +--> Electron IPC bridge (electron/preload.cjs)       │
│     |        |            terminal | preview | git | mcp | fs | jobs     │
│     |        +--> results -> model (next round)                          │
│     v                                                                    │
│   finish tool -> final answer + activity + staged changes                │
└────────────────────────────────|─────────────────────────────────────────┘
                                 v
                          { chatHistory (localStorage)
                            proof ledger (JSONL, signed)
                            secure store (BYOK keys) }

================================================================================
 1. PHASE 1 — PROMPT ENTRY (Frontend UI)
================================================================================

  src/components/ChatPanel.tsx
    |
    |  user types in chat input, Enter / Send
    v
  src/App.tsx:889   handleChatSend(prompt)   (from useOrchestrationController)
    |
    v
  src/hooks/useOrchestrationController.ts :: handleChatSend()
    |
    +-- validate: empty prompt? workspace open?
    +-- resolve provider/model  (src/lib/providers.ts : ProviderId + ModelTier)
    +-- build context           (useContextBuilder.ts)
    +-- detect tool intent      (detectIntentToolBundles)
    |
    +--> (A) chat turn      -> streamChat()            src/lib/ai.ts
    +--> (B) autonomous turn -> runAutonomousTurn() -> runAgentTurn()
                                                        src/lib/agents/turnRunner.ts

  Supporting UI:
    src/components/chat/ChatEmptyState.tsx
    src/components/chat/chatUx.ts
    src/components/chat/PendingChangesBar.tsx      (Auto-Save OFF)
    src/components/chat/AssistantActivityView.tsx  (tool/subagent activity)

================================================================================
 2. PHASE 2 — CONTEXT ASSEMBLY
================================================================================

  src/hooks/useContextBuilder.ts
    |
    +-- projectBrain            (repo knowledge base facts)
    +-- projectMemory           (cross-session persistent memory)
    +-- mcpTools                (connected MCP server tool defs)
    +-- repoMap                 (file tree overview)
    +-- conversationalContext   (prior turns in this workspace)
    +-- contextDedup            (remove duplicate context items)
    +-- targetLock              (TRI-LAYER TARGET LOCK, src/lib/agents/targetLock.ts)
    |     symbol  = pinnedSymbols (LSP)   dom = active file   style = query .class
    |     resolveTargetLock() -> confidence 0..1 + FNV content-hash staleness
    |     corroborated lock (>=0.70, pinned line/@symbol/2-layer) -> "TARGET LOCK" core line
    |
    v
  serialized to  ChatTurn[]   (system + user + assistant messages)
    |
    v
  request body  ChatRequestBody  { messages, provider, model, tools, temperature }

================================================================================
 3. PHASE 3 — CLIENT STREAM REQUEST  (src/lib/ai.ts + src/lib/sse.ts)
================================================================================

  src/lib/ai.ts :: streamChat(body, { onDelta, onToolCalls, onDone, signal })
    |
    |  fetch('/api/ai/chat', { method:'POST', body: JSON, signal })
    v
  src/lib/sse.ts :: createSseDecoder()   (shared client+server SSE parser)
    |
    |  reads  "data: {...}"  lines, parses event.type
    v
  event router (src/lib/ai.ts:610-665)
    |
    +-- 'delta'     -> append text to assistant bubble      (live typing)
    +-- 'reasoning' -> show thinking / reasoning panel
    +-- 'tool_calls'-> hand to tool loop (Phase 6)
    +-- 'done'      -> finalize message + token usage
    +-- 'error'     -> surface error, allow retry (REFINE_MODES)

  Transport note:
    Frontend -> Backend : HTTP POST + SSE   (no websocket for chat)
    Frontend -> Desktop : Electron IPC      (terminal/preview/git/mcp/fs)

================================================================================
 4. PHASE 4 — SERVER CHAT ENDPOINT  (api/ai/chat.ts)
================================================================================

  Express route  POST /api/ai/chat
    |
    |  startedAt = performance.now()
    v
  1) parseProviderId(providerId)        api/ai/_access.ts
        "gemini:models/gemini-2.5-pro" -> { provider:'gemini', model:'...' }
        "groq:llama-3.3-70b"           -> { provider:'groq',   model:'...' }
        "custom:https://..."           -> { provider:'custom', model:'...' }
    |
  2) resolveKeyAccess()  (BYOK)         api/ai/_access.ts
        key from Electron secureStore  OR  request header
    |
  3) budget check  (token / TPM limits)
    |
  4) toolDefinitions = nativeToolDefinitions(...)   api/ai/_toolCalls.ts
        (max 64 defs, 24KB total; validates + normalizes)
    |
  5) shapedMessages = shapeStablePrefix()/systemInstruction()  (_gemini.ts)
    |
    v
  adapter = ADAPTERS[provider]          api/ai/_access.ts
    |
    +-- gemini  -> streamGemini()          api/ai/_gemini.ts
    +-- groq    -> streamGroq()            api/ai/_openai.ts
    +-- custom  -> streamCustomEndpoint()  api/ai/_compatible.ts
    |
    v
  adapter.stream(req, { delta, reasoning, toolCalls })
    |
    |  HTTPS  -->  UPSTREAM LLM PROVIDER
    <--  streamed chunks
    |
    |  forward('delta', text)      -> emit({ type:'delta', text })
    |  forward('reasoning', text)  -> emit({ type:'reasoning', text })
    |  toolCalls(calls)            -> emit({ type:'tool_calls', calls })
    |  on finish                   -> emit({ type:'done', tokens, usageSource,
    | ..................................................................... servedModel, attempts })
    |  on failure                  -> emit({ type:'error', ... })
    |
    v
  sseSend(res, event)  -->  text/event-stream  -->  client

================================================================================
 5. PHASE 5 — PROVIDER ADAPTERS & UPSTREAM  (api/ai/*)
================================================================================

  api/ai/_access.ts
    |-- ADAPTERS                { gemini, groq, custom }
    |-- parseProviderId(id)     split "provider:model"
    `-- resolveKeyAccess()      BYOK key from secure store / header

  api/ai/_openai.ts   (Groq / OpenAI-compatible)
    |-- streamGroq()
    |-- fetchUpstream()                 retry on 429/5xx
    `-- OpenAiToolCallCollector         reassembles fragmented delta.tool_calls

  api/ai/_gemini.ts
    |-- streamGemini()
    |-- cacheShaped()                   prefix caching
    |-- shapeStablePrefix()             stable cacheable prefix
    `-- systemInstruction()             Gemini system instruction

  api/ai/_compatible.ts
    `-- streamCustomEndpoint()          user-configured OpenAI-compatible URL

  api/ai/_endpoint.ts
    |-- runsOnTheUsersMachine()         local vs remote
    `-- resolveCustomEndpoint()         DNS-rebinding / SSRF protection

  api/ai/_upstream.ts
    |-- AttemptCounter
    |-- MAX_LOGICAL_CALL_ATTEMPTS = 6
    `-- fetchUpstream()                 retryable: 429,500,502,503,504

  api/ai/_toolCalls.ts
    |-- OpenAiToolCallCollector         (lines 10-53)
    |-- rejectsNativeTools()            "tools not supported"
    |-- rejectsToolCall()               "tool call validation failed"
    |-- sanitizeGeminiSchema()          strip unsupported keys
    |-- geminiFunctionParameters()
    `-- nativeToolDefinitions()         (lines 134-158)

================================================================================
 6. PHASE 6 — THE TOOL LOOP  (src/lib/agent/toolLoop.ts)   *** CORE ***
================================================================================

  runToolRounds(input: ToolLoopInput)
    |
    |  loop (round = 1,2,3,... until finish / cap / stop):
    |
    v
  +-----------------------------------------------------------------------+
  |  stream()  --> one model turn (text + optional ```shadrox:tools block)  |
  +-----------------------------------------------------------------------+
    |
    |  parse ```shadrox:tools   fenced JSON array:
    |     ```shadrox:tools
    |     [ {"name":"read_file","args":{"path":"src/App.tsx"}},
    |       {"name":"write_file","args":{...}} ]
    |     ```
    |
    v
  (calls found?)
    | yes                                   | no
    v                                       v
  execute in parallel                 treat text as reply
  (MAX_CALLS_PER_ROUND = 16)          (or wait for finish)
    |  runTool() each
    v
  results wrapped as UNTRUSTED:
     [[SHADROX_UNTRUSTED_DATA_BEGIN]]
       ...tool outputs (fs, terminal, git, mcp)...
     [[SHADROX_UNTRUSTED_DATA_END]]
    |
    v
  append tool results as next user/assistant turn  --> loop again
    |
    +-- if call.name == 'finish'  -> end turn (summary, verified, files_changed)
    +-- if round cap reached      -> force finish
    +-- if stop signal            -> abort

  Finish gate (BRUTAL HONESTY, toolLoop.ts controlOutcome + finishGate):
    verified = docsOnly ? false
             : mutated  ? (satisfyingVerification(turn)?.ok ?? false)   <-- FAIL/NOT_RUN clamp
             :            (details.verified ?? true)
    A mutated turn can NEVER report verified when the post-change check FAILed or
    did NOT run; the model's own verified:true does not override the real check.
    verify tool (tools.ts) attaches gateReport = evaluateVerificationGates()
    (src/lib/behavior/verificationGates.ts, Gates 0-6 PASS/FAIL/NOT_RUN/SKIPPED_BY_POLICY).

  Transient provider fallback (controller streamOnce + modelRouter.ts):
    buildFallbackLadder()/nextFallback() -> same-provider (user key) cheap scout,
    bounded to 1; only on rate-limit/5xx/timeout/stream errors.

  Loop state tracked:
    changedPaths[]   createdPaths[]
    activity: ToolActivity[]      (input/output/ok/refused/proof)
    failureProof: FailureReceipt  (REDACTED via redactSecrets before persist)
    stopReason: complete|finish|step_cap|stuck|provider_error|aborted|no_workspace

  Parallel scout subagents:
    MAX_CONCURRENT_SUBAGENTS caps parallel read-only scouts

================================================================================
 7. PHASE 7 — TOOL DISPATCH  (src/lib/agent/tools.ts :: runTool)
================================================================================

  runTool(workspaceId, call, options)   (lines ~1248-2370)  switch(call.name):

  READ
    list_directory    (1264)  depth<=3, .gitignore, <=400 entries/60 dirs
    read_file         (1306)  line ranges, masks .env*, <=400 lines
    find_files        (1346)  path substring, <=80 results
    search_text       (1360)  content search + partialWordSearch() (1133)
    outline           (2329)  symbols + line numbers

  WRITE
    write_file        (1402)  create/overwrite, read-before-write, backup,
    edit_file         (1402)  exact snippet; locateUniqueMatch() (909) 5 passes:
                             exact | CRLF | trimmed | indent | whitespace
    apply_patch       (1710)  atomic multi-file (<=50 hunks); stage+commit

  EXECUTE
    run_command       (2033)  shell via desktop bridge, risk-tiered,
                             background after 30s, failure receipts
    verify            (1888)  typecheck/build/test; modified vs pre-existing
    preview_control   (2175)  start/stop/restart/status live preview
    terminal_answer   (2319)  input to interactive terminal (approval)
    job_control       (2108)  list/read_output/status/stop background jobs

  CONTROL (handled by loop, not disk)
    update_tasks               task plan
    finish                     end turn
    unlock_tools      (1203)   unlock tool bundle categories

  MEMORY / CODE-INTEL / WEB / INTERACTION
    memory_read / memory_note
    find_references / go_to_definition / rename_symbol
    get_dependents            (OryTree cached import graph -> downstream blast radius)
    semantic_search
    web_search / fetch_url
    preview_inspect
    ask_user                   prompt user mid-turn
    spawn_subagent             read-only scout
    diff_review

  Tool schemas: NATIVE_TOOL_SCHEMAS (342-562)
  Effect class: classifyToolEffect (635) -> read|write|execute|control|external
                (MCP/unknown fail closed to 'external')

================================================================================
 8. PHASE 8 — DESKTOP BRIDGE (Electron IPC)  (electron/preload.cjs + main.cjs)
================================================================================

  tools.ts runTool()
    |  window.shadroxDesktop.<channel>(...)
    v
  electron/preload.cjs  contextBridge.exposeInMainWorld('shadroxDesktop')
    |  ipcRenderer.invoke(...)
    v
  electron/main.cjs  registers handlers:
    |-- workspaceIpc.cjs     open-folder, read-file, list-directory,
    |                        save-files, backup-file, search-content
    |-- terminalJobsIpc.cjs  terminal:create (node-pty, max 12/ws),
    |                        terminal:write, terminal:run-command (approval),
    |                        job:control (auto-background after 30s)
    |-- previewRuntimeIpc.cjs preview:start/stop/status, preview-inspect:run
    |-- gitIpc.cjs           git:read/commit/push/pull/discard
    |-- mcpIpc.cjs           mcp:list-servers/save/connect/list-tools/
    |                        call-tool (consent + per-call approval, <=20 srv)
    |-- authAppIpc.cjs       auth:start-loopback
    `-- debugProofIpc.cjs    proof:append-receipt/milestone, proof:verify

  Secure store:  secure:get/set/delete  (safeStorage.encryptString/decryptString)
                 -> BYOK API keys + MCP secrets

================================================================================
 9. PHASE 9 — SUBAGENTS & HEADLESS TURN  (subagent.ts + turnRunner.ts)
================================================================================

  src/lib/agent/subagent.ts
    |-- spawn_subagent   read-only scout (can read, cannot write)
    `-- ask_user         ASK_USER_EVENT (mid-turn user prompt)

  src/lib/agents/turnRunner.ts :: runAgentTurn(input)   (331-534)  [autonomous]
    1) buildMessages()            system context + instruction
    2) runToolRounds()            the tool loop (injected from App.tsx)
    3) extractPatches()           parse path= edit blocks
    4) confinePatches()           keep paths in-scope (scopedExpectedFiles)
    5) read-before-write verify   full read required for write
    6) partitionPatches()         auto (write now) vs review (hold)
    7) writePatches()             atomic verified apply
    8) return AgentTurnOutcome    reply, applied, pendingReview, activity

    helpers: readCoverageFromActivity (224), filesReadFromActivity (237),
             executedToolCallCount (283), sanitizeUserFacingReply (259),
             turnReviewLine (541)

================================================================================
10. PHASE 10 — STREAMING BACK & RENDER
================================================================================

  api/ai/chat.ts  emit(event) --> sseSend(res,event)
    |
    v  SSE:  data: {"type":"delta","text":"..."}
             data: {"type":"reasoning","text":"..."}
             data: {"type":"tool_calls","calls":[...]}
             data: {"type":"done","tokens":...,"usageSource":"..."}
             data: {"type":"error", ...}
    |
    v
  src/lib/ai.ts streamChat  (event router 610-665)
    |-- delta     -> append to assistant bubble (live)
    |-- reasoning -> reasoning panel
    |-- tool_calls-> runToolRounds() -> runTool() -> IPC -> results -> model
    |-- done      -> finalize + usage
    `-- error     -> show + retry (REFINE_MODES)

  Render:
    src/components/ChatPanel.tsx
    src/components/chat/AssistantActivityView.tsx   (tool calls/results inline)
    src/components/chat/PendingChangesBar.tsx        (staged, Auto-Save OFF)

================================================================================
11. PHASE 11 — WRITE MODES (Auto-Save ON vs OFF)
================================================================================

  isAutoSaveEnabled(workspaceId)
    |
    +-- ON  : saveFiles() -> version-pinned atomic save; bridge reads back
    |          (tools.ts 1560-1568, 1837-1853)
    |          apply_patch -> stageFiles() + commitTransaction()
    |
    `-- OFF : stagePendingChange() -> pending review; user clicks Accept
              (tools.ts 1570-1580, 1854-1866)

================================================================================
12. PHASE 12 — PERSISTENCE
================================================================================

  Chat history   src/lib/chatHistory.ts
    { HISTORY_KEY }  per-workspace transcript in localStorage (size-capped)

  Proof ledger   electron/proof-store.cjs
    userData/<sha256(workspaceId)>/ledger.jsonl
    appendLine() (max 32 MiB, 256 KiB/line), readLedger(), readKeys/writeKeys
    signing keys OS-encrypted via safeStorage; receipts replay after restart
    createFailureReceipt() REDACTS every text field (redactSecrets) before persist
    turn failures -> buildTurnFailureReceipt() (category from failureTaxonomy.ts)
    -> globalProofLedger.recordFailureReceipt() (durable signed chain)

  Secure store   IPC secure:get/set/delete
    BYOK keys + MCP secrets via safeStorage

================================================================================
13. ARCHITECTURE BOUNDARIES (cheat sheet)
================================================================================

  Frontend -> Backend   HTTP POST + SSE     src/lib/ai.ts, src/lib/sse.ts,
                                            api/ai/chat.ts
  Backend  -> LLM       HTTP SSE            api/ai/_openai.ts, _gemini.ts,
                                            _compatible.ts
  Frontend -> Desktop   Electron IPC        electron/preload.cjs, main.cjs,
                                            electron/ipc/*.cjs
  Model    -> Tools     ```shadrox:tools   src/lib/agent/tools.ts, toolLoop.ts
  Tools    -> Model     [[SHADROX_UNTRUSTED_DATA_BEGIN/END]]  tools.ts:657
  Persistence           localStorage + JSONL ledger + safeStorage

================================================================================
14. NOTES (extra / important things — last me, jaisa bola tha)
================================================================================

  1) Chat SSE events sirf 5 hain: delta, reasoning, tool_calls, done, error.
     Koi websocket nahi — sab SSE over HTTP.

  2) Model tool calls native function-calling se aate hain (tool_calls event)
     YA phir text ke andar ```shadrox:tools fenced JSON block se. Dono support.

  3) Tool outputs ko model ko wapas bhejte waqt UNTRUSTED fences me wrap kiya
     jaata hai ([[SHADROX_UNTRUSTED_DATA_BEGIN]] ... [[END]]) — prompt-injection
     se bachne ke liye. Ye data kabhi "instruction" ki tarah treat nahi hoti.

  4) Har command risk-tiered hai; approval dialog terminal:run-command pe aata
     hai. MCP tool calls pe bhi per-call approval + server consent.

  5) BYOK: API keys plain me nahi — Electron safeStorage (OS keychain) me
     encrypt hoke rehti hain; server secureStore se resolve karta hai.

  6) Custom endpoint pe DNS-rebinding / SSRF protection lagta hai
     (api/ai/_endpoint.ts) — local vs remote detect hota hai.

  7) Retry: upstream 429/5xx pe automatic retry, MAX_LOGICAL_CALL_ATTEMPTS = 6.

  8) Tool loop parallel: ek round me max 16 calls; parallel scouts capped
     (MAX_CONCURRENT_SUBAGENTS), scouts read-only hote hain.

  9) Auto-Save OFF ho to changes stage hote hain (PendingChangesBar) — user
     Accept kare tabhi disk pe likhte hain. ON ho to atomic version-pinned save.

 10) Autonomous (headless) turns chat se alag hote hain: runAgentTurn()
     (turnRunner.ts) — patches ko scope me confine karke auto vs review me
     partition karta hai, phir atomic write.

 11) "finish" tool hi turn ko normally end karta hai (summary + verified +
     files_changed). Round cap ya stop signal pe bhi end ho sakta hai.

  12) File:line references is repo ke current state pe based hain; code badle
      to line numbers shift ho sakte hain (function names stable rahenge).

================================================================================
 15. VERIFIED CODE TRUTH — status tables (audit 2026-11-28)
================================================================================
  Legend:  EXISTS = present & wired   PARTIAL = core only, host-wiring pending
           VERIFIED = audited end-to-end this pass (typecheck+2594 tests+build green)

  PIPELINE PHASE                          STATUS     KEY FILES / SYMBOLS
  --------------------------------------  ---------  --------------------------------
  Entry & Routing (ChatPanel->controller) VERIFIED   useOrchestrationController.ts
    AbortSignal cleanup (abortRef null)   VERIFIED   every exit path (356/556/592/1007/2617)
    Transient fallback ladder             VERIFIED   modelRouter.ts buildFallbackLadder/nextFallback
    Failure receipt persistence           VERIFIED   repairProof.ts buildTurnFailureReceipt
  Context & Target Lock                   VERIFIED   useContextBuilder.ts + agents/targetLock.ts
    Staleness hash demotion (case-insens) VERIFIED   targetLock.ts normalizePath/toLowerCase
    Multi-candidate ambiguity             VERIFIED   resolveTargetLock (sort conf, then path)
    Expanded vibe nouns (dashboard/...)   VERIFIED   targetLock.ts VIBE_WORDS + tie-abstain (+tests)
    Secret exclusion (path:line only)     VERIFIED   TARGET LOCK line prints no content
    Token budget bound (1 short line)     VERIFIED   core.push before coreChars compute
  Tool Loop & Brutal Honesty Gate         VERIFIED   toolLoop.ts + tools.ts + verificationGates.ts
    finish clamp on FAIL/NOT_RUN          VERIFIED   controlOutcome verified=...satisfying.ok
    Gates 0-6 states                      VERIFIED   behavior/verificationGates.ts
    Baseline diagnostics diff             VERIFIED   newErrorsVsBaseline (touched-scoped)
    Duplicate-error termination           VERIFIED   stuck.ts failureTracker (3-strike) + ZERO_PROGRESS_LIMIT=8
  Persistence & Security                  VERIFIED   proofLedger + secrets.ts
    Proof ledger redaction (0 secrets)    VERIFIED   createFailureReceipt redactSecrets (FIXED)
    IPC boundary (contextBridge)          VERIFIED   electron/preload.cjs fixed API allow-list
  Failure Black Box taxonomy              VERIFIED   observability/failureTaxonomy.ts (F01-F12 -> 6 categories)
  BYOK capability registry                VERIFIED   modelCapabilities.ts (reused, no duplicate)
  Prefix-cache hit measurement            VERIFIED   taskUsage.ts cacheHitRate + ChatPanel metrics
  Local index freshness                   VERIFIED   semanticIndex.ts invalidateSemanticIndexPaths
  N4 Instant Tweak (one-shot)             VERIFIED   agents/instantTweak.ts + controller tweak path
  Tool pruning (lean profile)             VERIFIED   tools.ts describeTools(profile) + useContextBuilder
  Mobile overflow probe (responsive)      VERIFIED   agents/mobileOverflow.ts + preview-inspect.cjs 'mobile'
    Geometry read (no nav/mutate)         VERIFIED   buildMobileScript (scrollWidth vs innerWidth)
    TRUE 375x812 emulation + restore      VERIFIED   buildResize/Restore/Reflow + finally (preview-inspect.cjs)
    Gate 5 behavior wiring                VERIFIED   tools.ts verify -> gateChecks.behavior (allOk=false on fail)
    Pure verdict + formatter              VERIFIED   evaluateMobileOverflow/formatMobileOverflow (+tests)
  Interactive/persistence verify rule     VERIFIED   promptDiscipline.ts (click-to-open / reload-before-finish)
  Secret-display refusal rule             VERIFIED   promptDiscipline.ts (no raw env/keys UI; Configured/Missing)

  AUDIT FIXES (real bugs, this pass):
    1. targetLock normalizePath now lowercases -> staleness no longer fails open on
       a case-different path key (was: currentHashes lowercased, lookup not).
    2. createFailureReceipt redacts errorMessage/stackTrace/consoleErrors/diffSummary
       via redactSecrets -> a key echoed in a failed command never reaches the ledger.
    3. TARGET LOCK is announced only when corroborated (pinned line / @symbol /
       2-layer agreement) -> a lone vague active-file hint no longer misdirects.
    4. Transient-error ladder widened (controller isTransientStreamError): 5xx/ETIMEDOUT/
       ENOTFOUND/EAI_AGAIN/ECONNREFUSED/cert -> a 500 from an overloaded upstream now
       advances the fallback instead of stopping it.
    5. Instant-tweak loop only advances its one fallback on a TRANSIENT error (was:
       any error) -> a bad key / missing model no longer burns the cheap->answer retry.
    6. Abort honored at the top of the answer while-loop -> a stop mid-stream no longer
       waits for the next round boundary.
    7. Verification gate: an all-SKIPPED_BY_POLICY report is NOT_RUN, not PASS
       (verificationGates.ts) -> "unproven" is never reported as "proven".
    8. secrets.ts redacts inline connection-string creds (postgres://user:pass@host)
       -> a DB URL echoed in a log no longer leaks the password (bare URLs untouched).
    9. Mobile probe now emulates a TRUE 375x812 viewport: the handler resizes the
       preview iframe element in the top doc (buildResizePreviewScript), waits a
       paint (buildReflowScript), measures, and ALWAYS restores the original inline
       style in finally -> a wide desktop pane can no longer pass a broken 375px
       layout; a pane that cannot be resized fails honestly (no false "ok").
   10. promptDiscipline rule: closed overlays need a click-to-open before the mobile
       probe, and persistence needs a preview_control reload + DOM assertion before
       finish -> static geometry no longer stands in for interactive/reload proof.

  ASCII — responsive gate + fallback ladder (this pass):
    verify tool (tools.ts ~L2026)
      |-- run manifest scripts + diagnostics  -> errors/failedTests
      |-- best-effort previewInspect{mobile}  -> [resize 375x812 -> reflow -> measure -> restore]
      |        ok=false -> allOk=false ; gateChecks.behavior={ran,ok,detail}
      v
    evaluateVerificationGates -> verdict  (FAIL > NOT_RUN > PASS>all-skipped=NOT_RUN)
      |
    finish (toolLoop.ts controlOutcome L397)
      verified = docsOnly?false : mutated?(satisfying.ok) : (details.verified??true)

    streamOnce (controller ~L730)        instant-tweak (~L948)
      while(true){                        while(candidate){
        if aborted break;                   stream(cheap); if aborted break;
        stream(answerModel);                if !transient(err) break;  <-- FIX #5
        if !transient(err) break;           candidate=nextFallback(...);}
        candidate=nextFallback(...);}       (transient = isTransientStreamError, FIX #4)

 ================================================================================
 16. ORYTREE — unified RepoMap + Feature-Grouped Architecture Tree  (repoMap.ts)
 ================================================================================
   buildRepoMap (aider PageRank map) answers "which defs matter most".
   buildOryTree adds the refactor half: which PRODUCT DOMAIN a file is in, and
   its blast radius. Same aider graph + incremental cache (no duplicate graph):

     buildOryTree(root, {files|listFiles+readFile})
       |-- collectMapInputs()            (shared with buildRepoMap)
       |-- extractFileTagsCached()       per-file content-hash cache (FNV-1a)
       |     unchanged file -> cached tags (===) ; changed -> fresh key
       |     => 1,500-file rebuild re-folds refs, never re-tokenizes (O(n^2) fix)
       |-- buildTagGraph() + rankTags()  (PageRank reused, not reimplemented)
       |-- classifyOryDomain(path, symbols, importDomains)
       |     LANDING | AUTH | DASHBOARD | BILLING | SETTINGS | API | SHARED
       |     path/symbol keywords; SHARED inherits a one-hop import domain
       v
     OryTree { domains[], graph(cached), nodeRank, refCounts }
       |
       v  renderOryTree(tree, tokenBudget)   chars/4 budget, tail domains dropped
     [API / BACKEND] (2 files · refs 3)
       src/api/
         client.ts [refs: 2] {apiClient}      <-- blast-radius badge + top exports
         index.ts  [refs: 1] {createClient}

   get_dependents tool (codeIntel.ts, READ effect, code_intel bundle):
     handleGetDependents -> enumerateWorkspaceFiles (semanticIndex, reused)
       -> loadFiles (bounded) -> buildOryTree('' ,{files})
       -> dependentsFromGraph(graph, targets)  (edges src references dst)
     => exact downstream importers + weight + symbols BEFORE a shared refactor.

   LIVE WIRING (useContextBuilder.ts): the per-turn context map now calls
     buildOryTree(folder.path, {files, signaturesByFile, openTabs, ...})
       -> renderOryTree(tree, repoMapBudgetFor(contextWindow))
     as the PRIMARY map (header: "ORE TREE — feature-grouped architecture
     tree ... ref-count badge ... top exported symbols"). The aider
     buildRepoMap stays only as a defensive fallback when the tree renders
     empty. setSentRepoMap / repoMapForManifest carry the rendered tree.
     classifyOryDomain normalizes `\` -> `/` so Windows paths classify right.

   semantic_search speed (semanticIndex.ts):
     bm25Stats(index) cached per index.updatedAt (WeakMap) -> precomputed
     tokenized entries + document-frequency table + avgLength; a query no
     longer re-walks every chunk. MAX_BM25_ENTRIES byte cap; invalidation bumps
     updatedAt so the table rebuilds only on real change.

   STATUS (this pass, typecheck + 2618 tests + vite build green):
     Incremental FileTags hash cache         VERIFIED   repoMap.ts extractFileTagsCached
     OryTree domain grouping + badges        VERIFIED   repoMap.ts buildOryTree/renderOryTree
     Live OryTree wiring (not legacy map)    VERIFIED   useContextBuilder.ts buildOryTree+renderOryTree
     classifyOryDomain backslash/edge cases   VERIFIED   repoMap.ts (+tests)
     Blast-radius refs + dependents          VERIFIED   dependentsFromGraph (+tests)
     BM25 precomputed DF table + byte cap    VERIFIED   semanticIndex.ts bm25Stats
     get_dependents tool (read-only)         VERIFIED   codeIntel.ts + tools.ts dispatch

  ── End of file ──