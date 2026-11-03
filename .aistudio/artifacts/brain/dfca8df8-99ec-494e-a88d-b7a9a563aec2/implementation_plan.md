# ShadRox Advanced IDE & Agent Autonomy Upgrade Plan

## 1. Codebase Audit & Critical Gap Analysis

A thorough audit of the ShadRox codebase reveals a strong desktop foundation (Electron desktop bridge, atomic file saves with AST pre-apply verification, token budgeting, and sandboxed live preview). However, to rival frontier IDEs like Cursor, Trae, Devin, and VS Code, the following gaps must be resolved:

| Subsystem | Current State | Critical Gap & Weakness | Target Architecture |
| :--- | :--- | :--- | :--- |
| **Agent Autonomy** | Single-turn tool loop & partial team coordinator | Team tasks require manual foreground focus; lacks full background worker mode with auto-generated comprehensive summary report | **Background Autonomous Team Runner**: multi-agent delegation (Coordinator, Frontend, Backend, Tests, Reviewer) running in background with progress telemetry and structured milestone summary report |
| **Model Routing & Reasoning** | Basic model router with fixed roles | Heavy reasoning models (Gemini 2.5/3 Flash Thinking, DeepSeek R1) dump thoughts into raw text or basic details; lacks automatic complexity routing | **Intelligent Complexity Auto-Router & Live Thought Trace**: Automatically routes simple edits/retrieval to rapid models and architectural refactors to frontier thinking models, with real-time collapsible thought traces |
| **Terminal UX** | Single xterm dock with narrow IPC | Lacks quick session tab switcher, split pane shortcuts, search highlight jump, and clear state persistence | **Advanced Terminal Dock**: Tabbed sessions, horizontal/vertical split management, search bar with match counter, and resilient shell output streaming |
| **Source Control (SCM)** | Basic list of changed files with staged toggle | No inline visual hunk staging (staging individual diff hunks before committing), no branch creation/switching UI | **Granular Git Hunk Staging**: Visual hunk diff with per-hunk "Stage Hunk" / "Unstage Hunk" controls, branch manager, and clean commit flow |
| **Editor Superpowers** | Standard CodeMirror 6 text editor | Missing symbol breadcrumbs at top of active editor, diagnostic squiggles for lint/type errors, and ghost-text AI completion | **Pro CodeMirror Enhancements**: Active file symbol path breadcrumbs, LSP diagnostic gutter & underline squiggles, and quick-fix actions |

---

## 2. Architecture & Design Principles

1. **Zero-Pill Discipline & Dense Developer Aesthetics**:
   - Dark slate palette (`#090a0d`, `#111318`, hairline `#ffffff0e` borders) with crisp typography (`JetBrains Mono`, `Inter`).
   - Clean tabular and drawer layouts without decorative bubble pills.
2. **Safe Bounded Execution**:
   - All filesystem writes remain confined to the active workspace with AST pre-apply syntax verification.
   - Per-command shell confirmations with timeout and output truncation bounds.
   - Non-destructive atomic file rollback checkpoints before any multi-agent sequence.
3. **Background Autonomy Authoritative State**:
   - The autonomous agent team operates asynchronously with credit/task guards (`MAX_TASKS = 8`, `BUDGET_CAP`).
   - Generates a finalized structured Markdown summary report documenting all modified files, passing tests, and open issues.

---

## 3. Step-by-Step Implementation Phases

### Phase 1: Background Autonomous Agent Team & Summary Report
- **Goal**: Allow users to dispatch full tasks (e.g. "Migrate auth to JWT and add unit tests") to an autonomous background team.
- **Components & Files**:
  - `src/lib/agents/team-run.ts` & `src/lib/autonomy/background.ts`: Connect team runner to persistent run store with background execution state.
  - `src/components/ChatPanel.tsx` & `src/components/AgentTeamCard.tsx`: Build a dedicated Agent Team view showing current specialist active (`Coordinator`, `Frontend`, `Backend`, `Tests`, `Reviewer`), real-time step progress, and a prominent final **Executive Summary Report** drawer with diff stats.
  - `src/App.tsx`: Provide "Run with Agent Team" toggle/action in prompt box with background persistence.

### Phase 2: Live Reasoning Thought Trace & Multi-Model Complexity Router
- **Goal**: Automatically pick optimal models based on prompt complexity and stream reasoning thoughts in a dedicated thinking trace.
- **Components & Files**:
  - `src/lib/autoRoute.ts` & `src/lib/modelRouter.ts`: Implement task complexity classifier that inspects prompt length, multi-file attachments, and intent keywords (`refactor`, `architect`, `debug`, `team`).
  - `src/components/ChatPanel.tsx`: Enhance reasoning block with streaming collapsible thought trace, live token counter, and reasoning duration badge.

### Phase 3: Advanced Terminal Dock & Multi-Tab/Split Management
- **Goal**: Turn the terminal into a pro developer console with multi-session tabs and split panes.
- **Components & Files**:
  - `src/components/TerminalPanel.tsx` & `src/lib/terminal/panes.ts`: Add session tab bar with active status chips, split horizontal/vertical actions (`Ctrl+\`), and quick-kill.
  - Terminal search drawer with `SearchAddon` match count (`X of Y`) and next/previous navigation.

### Phase 4: SCM Granular Hunk Staging & Branch Operations
- **Goal**: Enable Git hunk-level staging directly inside ShadRox SCM panel.
- **Components & Files**:
  - `src/components/ScmPanel.tsx`: Add expandable file diff viewer with hunk-level `Stage Hunk` / `Unstage Hunk` buttons using `src/lib/editor/hunks.ts`.
  - Add branch switcher dropdown with local branches and branch creation modal.

### Phase 5: CodeMirror 6 Editor Superpowers
- **Goal**: Add IDE-grade breadcrumbs, diagnostic squiggles, and quick-fix code actions.
- **Components & Files**:
  - `src/components/EditorView.tsx` / `src/components/CodeEditor.tsx`: Add sticky header breadcrumb (`folder > subfolder > File.tsx > Class > function`) using outline symbols.
  - Diagnostics extension: render error squiggles and hover tooltips for compiler diagnostics with "Ask AI to Fix" action.

---

## 4. Verification & Testing Plan

1. **Agent Autonomy Tests**:
   - `node --import tsx --test src/lib/agents/team-run.test.ts src/lib/autonomy/run-loop.test.ts`
   - Test background persistence and summary report generation on task completion.
2. **Terminal & SCM Tests**:
   - `node --import tsx --test src/lib/terminal/panes.test.ts electron/terminal-modes.test.cjs electron/git-scm.test.cjs`
   - Test terminal split layout computation and Git hunk staging logic.
3. **TypeScript & Build Verification**:
   - `npm run typecheck` (`tsc --noEmit`)
   - `compile_applet` (Vite build bundle integrity)
