# ShadRox BIG-TASK & Elite Architecture Implementation Plan

A comprehensive engineering plan to elevate ShadRox into a dependable, elite local-first desktop AI engineering workspace by hardening security gates, integrating structured shell state, shipping the Self-Healing Proof signature feature, and wiring verifiable ledgers.

### User Review & Critical Decisions

> [!IMPORTANT]
> The following critical architectural decisions have been confirmed and will govern the implementation:
>
> - **Confirmed Decision 1 (3D Signature Feature)**: Prioritize **Self-Healing Proof** as the flagship deliverable. Any failing test, preview assertion, or verification command captures runtime context (stack, console error logs, diff, and environment) into a verifiable receipt and generates a scoped repair proposal against the workspace.
> - **Confirmed Decision 2 (Command Security Gate)**: Enforce a strict **default-deny allowlist per binary** for `verifyCommand` (`npm test`, `pytest`, `tsc`, `git diff` with vetted argv arrays executed via `execFile`). Every command outside this strict allowlist requires an explicit, native human approval dialog before execution.
> - **Confirmed Decision 3 (Terminal Integration Architecture)**: Implement **Real-time OSC escape sequences** (OSC 133 / OSC 633) for terminal shell integration, streaming command start/stop markers, current working directory (cwd), and exit codes directly into a structured terminal state engine queryable by the agent.
> - **Confirmed Decision 4 (Phase 4 Release & Packaging)**: No packaging (`npm run dist:win`), release publishing, or git commits/pushes will take place without your explicit written approval.

---

### 1. Overview & Core Concept

- **What It Does**: Hardens ShadRox against command injection and arbitrary execution risks while providing the agent with real-time, tamper-resistant terminal feedback and an autonomous, verified Self-Healing Proof workflow.
- **Target Audience / Persona**: Professional developers and engineering teams using desktop AI agents who demand total local privacy (BYOK), verified proof receipts over claims, and zero unexpected shell execution.
- **Key Value**: Replaces unmonitored command execution and hallucinated "task done" assertions with cryptographically grounded execution receipts, real terminal process telemetry, and reproducible repair loops.

---

### 2. User Experience & Visual Design

- **Key User Flows**:
  1. *Security Approval Flow*: When an agent or plugin proposes an unrecognized shell command, an Electron native modal displays the exact binary, working directory, and sanitized argv arguments. The user can inspect, approve once, or block. Verified safe test binaries execute without nagging.
  2. *Interactive Shell Integration*: In the terminal pane, commands display inline execution badges: status icons indicating running, successful exit (`0`), or nonzero failure, alongside real-time working directory breadcrumbs.
  3. *Self-Healing Proof Review*: When a build or test fails, a "Review Self-Healing Proof" card appears in the chat and preview surfaces showing the failure receipt (failed line, exit code, diff, and error stack). Clicking "Generate Repair" creates an atomic patch for review.

- **Visual Identity & Theme (Adhering to Frontend Constitution)**:
  - *Theme*: Deep Obsidian Slate (`#0B0F17`) background, neutral structural surfaces (`#151C28`), and subtle 1px hairline dividers (`rgba(255, 255, 255, 0.08)`).
  - *Typography*: Monospace tabular figures (`JetBrains Mono`, `tabular-nums`) for timestamps, exit codes, test tallies, and git hashes. Clear sans-serif (`Plus Jakarta Sans`) for natural title-case labels.
  - *Zero-Pill Discipline*: Unboxed metadata separated by typographic dots (`·`) and slashes (`/`), without pill badges or code-comment prefixes (`//`).
  - *Single-Elevation Depth*: Flat surfaces with clean hairline borders; no nested cards within cards or decorative gradient borders.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: verifyCommand Strict Binary Allowlist vs. Blanket Approval**:
  - *Chosen Approach*: Only specific testing binaries (`npm test`, `pytest`, `tsc`, `git diff`) with strict argv parsing are permitted for silent milestone verification; all others route to `runWithCommandApproval`.
  - *Why*: Eliminates the "silent command execution" vulnerability while allowing autonomous tests and milestone checks to verify agent progress without spamming confirmation dialogs on every test cycle.
  - *Alternatives Considered*: Banning all silent execution would break automated test-driven agent autonomy; blanket execution without allowlists allows arbitrary shell injection.

- **Decision 2: OSC Escape Sequences for Terminal State vs. Buffer Scraping**:
  - *Chosen Approach*: Embed OSC 133/633 marker sequences in the shell initialization scripts (PowerShell & Bash) to emit structured boundaries directly from the shell.
  - *Why*: Visual terminal buffer scraping is brittle, prone to ANSI corruption, and cannot distinguish command output from prompt redisplays. OSC markers provide unambiguous start, end, cwd, and exit code signals.

- **Decision 3: Flagship Selection — Self-Healing Proof**:
  - *Chosen Approach*: Anchor on Self-Healing Proof over full Time-Travel Workspace for this push.
  - *Why*: Reuses ShadRox's existing machine-delta, preview assertion, and checkpoint rails to deliver a high-signal, production-complete capability without ballooning credit or complexity costs.

---

### 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SHADROX DESKTOP WORKSPACE                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ Security Gate    │      │ Shell State API  │      │ Self-Healing     │
│ (Phase 2.3a)     │      │ (Phase 3A)       │      │ Proof (Phase 3D) │
├──────────────────┤      ├──────────────────┤      ├──────────────────┤
│ • execFile Argv  │      │ • OSC 133/633    │      │ • Failure Receipt│
│ • Allowlist:     │      │   Markers        │      │   (Stack + Diff) │
│   - npm test     │      │ • Real-time CWD  │      │ • Preview Assert │
│   - pytest       │      │ • Exit Code Bus  │      │ • Atomic Repair  │
│   - tsc          │      │ • Hung Detection │      │   Proposals      │
│   - git diff     │      │ • Agent Query API│      │ • Verified Undo  │
│ • Dialog for     │      │                  │      │   Checkpoints    │
│   All Others     │      │                  │      │                  │
└────────┬─────────┘      └────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   ▼
         ┌───────────────────────────────────────────────────┐
         │ Core Ledgers & Context Engine (Phase 3C & Wiring) │
         ├───────────────────────────────────────────────────┤
         │ • Proof Ledger & Spend Ledger                     │
         │ • Model Metadata DB & Context Budget Normalizer   │
         │ • Provider Prompt Caching (Stable Prefix)         │
         │ • Observation Boundary Trust Markers              │
         └───────────────────────────────────────────────────┘
```

- **Data Models & State Entities**:
  1. `ExecutionReceipt`: `{ id: string, timestamp: number, command?: string, exitCode?: number, diagnostics: DiagnosticLine[], diff?: string, verified: boolean }`
  2. `TerminalProcessState`: `{ sessionId: string, activeCommand: string | null, cwd: string, lastExitCode: number | null, isSilent: boolean, lastOutputAt: number }`
  3. `ProofLedger`: Session-persisted records correlating agent milestone claims with verifiable machine executions.

---

### 5. Implementation Roadmap & Milestones (Completed & Verified)

1. [x] **Phase 2.3a — Command Gate & Security Hardening**:
   - Implemented `parseVerifyArgv()` and `isAllowedVerifyCommand()` in `electron/command-approval.cjs`.
   - Strict default-deny policy enforcing only safe `execFile` argv execution (`npm test`, `pytest`, `tsc`, `git diff`).
   - Rejection of all shell metacharacters (`[&|;><`$()\\\n\r]`) and unapproved binaries with native approval fallback.
   - 9 unit tests in `electron/command-approval.test.cjs` passing cleanly.

2. [x] **Phase 3A — Terminal Shell Integration**:
   - Built `ShellIntegrationParser` in `src/lib/terminal/shellIntegration.ts` handling OSC 133 / OSC 633 / OSC 7 sequences.
   - Tracks prompt start/end, command execution boundaries, exit codes, and live cwd updates without xterm pollution.
   - Built multi-session manager `terminalStateManager` in `src/lib/terminal/state.ts` providing structured state queries.
   - Wired live PTY stream parsing and status chips into `src/components/TerminalPanel.tsx`.
   - 5 unit tests in `src/lib/terminal/state.test.ts` passing cleanly.

3. [x] **Phase 3D — Self-Healing Proof Engine**:
   - Built DOM and console assertions in `src/lib/previewAssertions.ts` with 5 unit tests.
   - Built `src/lib/repairProof.ts` with `createFailureReceipt()`, `buildRepairBrief()` (with untrusted data delimiters), `proposeRepair()`, and `verifyHealing()`.
   - Added interactive `SelfHealingProofCard` in `src/components/ChatPanel.tsx` rendering proof status, failure context, and repair diffs.
   - 5 unit tests in `src/lib/repairProof.test.ts` passing cleanly.

4. [x] **Phase 3C — Ledger Wiring & Context Optimization**:
   - Built `ProofLedger`, `SpendLedger` (with prompt caching tokens and cost savings computation), and `resolveModelMetadata` in `src/lib/proofLedger.ts`, `src/lib/spendLedger.ts`, and `src/lib/modelMetadata.ts`.
   - Integrated `cachedTokens` extraction into `api/ai/_types.ts` for OpenAI `prompt_tokens_details.cached_tokens` and Gemini `cachedContentTokenCount`.
   - 11 unit tests across `src/lib/ledgers.test.ts` and `api/ai/usage.test.ts` passing cleanly.

5. [x] **Phase 4 Verification & Guardrails**:
   - All 45 unit tests passing (`node --import tsx --test ...`).
   - `npm run typecheck` passes with zero type errors.
   - `compile_applet` and `lint_applet` succeed without warnings or errors.
   - Installer builds (`npm run dist:win` / `package-desktop.js`) strictly held pending explicit user instruction.

