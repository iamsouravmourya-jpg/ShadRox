<div align="center">

<img src="assets/icon.png" alt="ShadRox" width="96" />

# ShadRox

**Your project, code, AI, and preview — in one Windows workspace.**

[![Version](https://img.shields.io/badge/version-0.1.4-violet?style=flat-square)](https://www.shadrox.cyou/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0d0f13?style=flat-square)](https://www.shadrox.cyou/download)
[![License](https://img.shields.io/badge/license-Proprietary%20%C2%B7%20All%20Rights%20Reserved-blue?style=flat-square)](./LICENSE)

[Download for Windows](https://www.shadrox.cyou/download) · [All releases](https://www.shadrox.cyou/releases) · [Support](https://www.shadrox.cyou/faq#support)

</div>

ShadRox is a native Electron desktop app that puts a code editor, BYOK AI chat and agent, live project preview, Git tools, and an integrated terminal in one window. Open a local folder, edit files, ask your own AI provider for help, run the project, and commit — without leaving the workspace. Project files stay on your disk; only the prompt and context you choose are sent to the provider you configure. ShadRox is free, bring-your-own-key only, and has no billing.

> **Beta software (v0.1.4).** Agent output and model-generated edits can be incorrect. Review changes, keep backups or use Git, and do not approve commands you do not understand. See [Beta terms](#beta-terms).

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Editor](#editor)
- [AI chat & BYOK](#ai-chat--byok)
- [Agent tools & safety model](#agent-tools--safety-model)
- [Command approval: risk tiers](#command-approval-risk-tiers)
- [Multi-step runs & agent teams](#multi-step-runs--agent-teams)
- [Live preview](#live-preview)
- [Terminal](#terminal)
- [Git & checkpoints](#git--checkpoints)
- [MCP servers](#mcp-servers)
- [Rules and skills](#rules-and-skills)
- [Workspace basics](#workspace-basics)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Development & building from source](#development--building-from-source)
- [Production build protection](#production-build-protection)
- [Background jobs](#background-jobs)
- [The agent loop](#the-agent-loop)
- [`.env` files](#env-files)
- [Proof ledger](#proof-ledger)
- [Agent benchmark](#agent-benchmark)
- [Limits](#limits)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Installation](#installation)
- [Beta terms](#beta-terms)
- [Privacy](#privacy)
- [Security](#security)
- [License & Intellectual Property](#license--intellectual-property)
- [Keep reading](#keep-reading)

## Features

- **Editor** — CodeMirror 6, split groups, pinned tabs, breadcrumb navigation, quick open, outline, symbol references, Ctrl+K inline AI edit, ghost-text completions.
- **AI chat (BYOK)** — Gemini, Groq, or any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, Anthropic proxies) with your own key; unified autonomous agent, `@` mentions, image pasting/attachments, message queue.
- **Agent with guardrails** — 60-round bounded agent loop with risk-tiered command approval (safe commands auto-run, risky ones ask, dangerous ones always ask in red), background jobs, contract-aware TypeScript repairs, verified file writes, and multi-file atomic patches.
- **Dynamic Tool Bundles** — Base workspace tools plus on-demand category unlocking (`preview`, `git`, `checkpoints`, `delete`, `web`, `memory`, `code_intel`, `review`, `jobs`, `terminal`, `interaction`, `apply_patch`, `mcp`).
- **Resilience & Anti-Stall** — Auto-recovery from edit failures (after 2 failed edits, switches to clean rewrite), identical-call capping, progress-based stuck detection, and head+tail output clipping.
- **Live preview** — static sites, Node web frameworks, and detected Python/Go/PHP/Java/.NET backends, with DOM inspection and bounded health checks.
- **Terminal** — interactive shell rooted in the workspace (xterm.js + node-pty); PowerShell and bash report cwd and exit codes.
- **Git & checkpoints** — diffs, staging, AI commit messages, branches, conflict resolution, GitHub push, and rewindable workspace checkpoints with baseline Git comparison.
- **Multi-step runs & agent teams (beta)** — larger goals escalate from chat to a plan-edit-verify run or a coordinator-led agent team with explicit target-file checks.
- **Extensible** — MCP servers, project rules (`SHADROX.md`, `.cursorrules`, `AGENTS.md`) and skills.

## Quick start

1. **Download** the installer from [shadrox.cyou/download](https://www.shadrox.cyou/download) (`ShadRox-v0.1.4-Setup.exe`, Windows 10/11, 64-bit). The build is unsigned — if SmartScreen warns, verify the download source, then choose **More info → Run anyway**.
2. **Install and sign in** with Google (required; you must accept the Terms and Privacy Policy first).
3. **Add your own API key** in **Settings → Models & Keys** — Gemini, Groq, or a custom OpenAI-compatible endpoint.
4. **Open a folder** and start editing, asking, running, and committing.

## Editor

- CodeMirror 6 editing with split editor groups and pinned, reorderable tabs.
- **Persistent Auto-Save** — toggle auto-save on/off in the top bar; your preference is persisted across restarts and debounces disk saves safely (1.2s after typing).
- Quick open, file outline, and a command palette that fuzzy-finds files, workspace symbols, and commands.
- Select code and press **Ctrl+K** for an inline AI edit on just that selection; accept ghost-text completions powered by server-side fill-in-the-middle (FIM).
- **Multi-Language Intelligence** — dynamic syntax highlighters for TypeScript, JavaScript, Python, HTML, CSS, JSON, Markdown, and shell. Deep diagnostics, go-to-definition, find references, rename, and quick fixes powered by a bundled TypeScript 5.9 worker for web projects, plus automated `verify` test/build detection for Python (`pytest`), Rust (`cargo check`), and Go (`go vet`).
- One-click **Source/Preview** toggle for Markdown files (`.md`, `.markdown`).
- Workspace search and replace across files on disk and open buffers, with a reviewable result list.

## AI chat & BYOK

ShadRox is free and BYOK-only. There is no ShadRox plan, checkout, shared key, or meter: your own provider key carries every AI request and your provider bills you directly. Legacy paid-plan and shared-key values from older builds are deleted at startup, not interpreted.

### Supported providers

| Provider | What you need |
|---|---|
| Google Gemini | A Gemini API key |
| Groq | A Groq API key |
| Custom OpenAI-compatible endpoint | A base URL plus a key — works with compatible gateways and local servers such as Ollama and LM Studio |

- Add and validate keys in **Settings → Models & Keys**. Validation lists the models the provider reports; for an endpoint that does not list `/models`, you can type model ids manually.
- The custom endpoint's base URL is not a credential and is stored in plain settings; the key itself goes through the secret path below.
- Model availability, limits, and charges depend entirely on your provider. Labels like "free on your key" or "paid on your key" describe what **your provider** charges that key, not a ShadRox tier.
- Where the UI says "credits" (run budgets, automation caps), it means ShadRox's internal unit of work — roughly one edit-sized turn — never money. It exists only to stop a runaway run.

### Where keys are stored

- **Desktop app (installed build):** keys live in the OS-backed encrypted store (Electron `safeStorage`, e.g. DPAPI on Windows) plus session memory. They are never written to `localStorage`, and older plaintext mirrors are purged. The key is used by the local API process to call the provider you chose; it is not sent to ShadRox.
- **Browser dev build (`npm run dev`):** there is no OS-store bridge, so the key sits in that browser's `localStorage` in plain text and is posted to the local `/api/byok/validate` and `/api/ai` routes on your own machine. Do not run the browser build on a shared machine or with a key you would not accept seeing in that browser's profile.
- You can forget a key per provider in Settings. If OS encryption is unavailable, secret storage is refused rather than silently downgraded.

### What leaves your machine

| Data | Destination | Notes |
|---|---|---|
| Project files | Nowhere | Opened and edited on your disk; no ShadRox cloud project sync |
| AI prompt + selected context | Your configured provider only | Selected files, search results, a compact repo map, project rules, recent conversation (compacted locally when long) |
| Provider key | Your provider (from your machine) | Encrypted at rest on desktop; never sent to ShadRox |
| Account profile | Supabase (auth only) | Email, name, avatar, app version, platform. No project files or prompts |
| Feedback message | The owner's private Google Sheet | Only when you press Send feedback; see below |

Only the prompt and the context included with that request go to the provider. Do not send private code to a provider unless its data-handling terms are acceptable to you. API error text is redacted for GitHub- and AWS-shaped tokens before it is shown or stored, and terminal environments drop credential-shaped variables.

### Account

Google sign-in through Supabase is required to enter the desktop app; there is no password to create. **Continue with Google** stays disabled until you tick that you agree to the Terms of Service and Privacy Policy. Supabase stores the minimum profile fields listed above — nothing about your projects.

### Feedback

The top-bar Feedback button opens a drawer with exactly two report types: **Bug** and **Feature request**. The app POSTs a small JSON body (`{ kind, message }`) straight to a Google Apps Script web app owned by the maintainer, which appends one row to a private Google Sheet:

| Column | Contents |
|---|---|
| Date | Stamped server-side by Apps Script (`yyyy-MM-dd HH:mm:ss`, sheet time zone) |
| Bug | The message, when the report type is Bug |
| Feature | The message, when the report type is Feature request |

Nothing else is collected: no email or account row, no app version, no platform or user agent, no code, file names, or diagnostics. There is no ShadRox feedback server, no Supabase table, and no analytics in this path. The endpoint is write-only (opening it in a browser prints `Not found`), validates the payload, enforces a per-hour write quota, and caps message length.

## Agent tools & safety model

The agent is a bounded tool loop, not a one-shot patch parser: it requests workspace tools, receives their real results, and continues reasoning. Providers with native function calling use it; a ShadRox text protocol (```shadrox:tools blocks) is the fallback. Every tool result is wrapped as untrusted data (`[[SHADROX_UNTRUSTED_DATA_BEGIN]]` … `END`) — instructions found inside results are ignored.

### Access modes

The composer's Run settings menu is the capability boundary:

| Mode | Reads | Writes / commands / MCP |
|---|---|---|
| Ask | yes | refused |
| Plan | yes | refused (edits staged for review only) |
| Agent | yes | allowed, under the guards below |

Any tool that is not a known native read/write/execute/control tool — every MCP tool and any unknown name — fails closed to `external` and is denied in Ask/Plan. A refusal is shown in the trace with its reason; it is not a silent no-op.

### Tool surface

ShadRox equips the agent with native workspace tools split into base tools (always available in Agent mode) and specialized bundles that unlock on demand via `unlock_tools`:

| Tool | Category | What it does |
|---|---|---|
| `list_directory` | Base (FS) | List entries with sizes (max depth 3; respects `.gitignore`) |
| `read_file` | Base (FS) | Read file contents (with `start_line`/`end_line` slicing; `.env` secrets masked) |
| `find_files` | Base (FS) | Fast substring match across workspace file paths |
| `search_text` | Base (FS) | Search file contents with tokenized paraphrase-tolerant fallback |
| `write_file` | Base (FS) | Create a new file or rewrite an existing file (unlocked automatically if edits fail) |
| `edit_file` | Base (FS) | Replace an exact, unique snippet in an existing file |
| `apply_patch` | Base / Patch | Atomically apply multi-file hunks (`{path, old, new}`) with rollback on error |
| `verify` | Base / Quality | Run detected project checks (`typecheck`/`build`/`test`) and return structured error diagnostics |
| `problems` | Base / Diagnostics | Real compiler diagnostics (project-wide or for specific/changed files) |
| `outline` | Base / Code | List symbols, classes, functions, and line numbers in a file |
| `update_tasks` | Base / Workflow | Set or update the turn's multi-step task plan (`pending`, `doing`, `done`, `blocked`) with evidence |
| `finish` | Base / Workflow | End the turn with a summary, changed files list, verification status, and testing instructions |
| `unlock_tools` | Base / Meta | Unlock specialized tool categories dynamically for subsequent rounds |
| `run_command` | Base / Exec | Execute shell commands in the workspace root; risk-tiered approval (READ/BUILD/INSTALL auto-run; MUTATE/NETWORK/DANGEROUS require approval) |
| `job_control` | Jobs Bundle | List, inspect status, read buffered output tail, or stop background jobs |
| `terminal_state` | Terminal Bundle | Read live interactive terminal: cwd, active command, exit code, silence duration, waiting-for-input status |
| `terminal_answer` | Terminal Bundle | Send a single line to an interactive prompt waiting for input (requires explicit user confirmation dialog) |
| `preview_control` | Preview Bundle | Control embedded preview: `start`, `stop`, `restart`, or inspect server logs/health status |
| `git_state` | Git Bundle | Show working-tree git status and unstaged/staged diffs |
| `checkpoint` | Checkpoints Bundle | Save a named snapshot of workspace files and git baseline |
| `list_checkpoints`| Checkpoints Bundle | List saved workspace checkpoints, newest first |
| `restore` | Checkpoints Bundle | Rollback workspace to a previous checkpoint (requires user approval dialog) |
| `delete_file` | Delete Bundle | Delete a file or recursively delete a directory (requires `confirm: true` and native confirmation dialog) |
| `read_memory` | Memory Bundle | Read long-term project memory and architecture decisions from `.shadrox/memory.json` |
| `note_memory` | Memory Bundle | Persist architectural decisions, project conventions, and key notes to memory |
| `find_references` | Code Intel Bundle | Find all reference usages of a symbol across the project |
| `go_to_definition`| Code Intel Bundle | Locate definition and declaration sites for a symbol |
| `rename_symbol` | Code Intel Bundle | Project-wide symbol rename analysis and changes |
| `semantic_search` | Search Bundle | Vector embedding search over codebase files using local transformers |
| `web_search` | Web Bundle | Query documentation or search the web for solutions |
| `fetch_url` | Web Bundle | Fetch and parse clean markdown/text content from external documentation URLs |
| `preview_inspect`| Web Bundle | Inspect live preview DOM elements, console logs, and runtime errors |
| `ask_user` | Interaction Bundle | Pause the agent turn to ask the user a clarifying question |
| `spawn_subagent` | Interaction Bundle | Delegate a focused sub-task to an isolated subagent |
| `diff_review` | Review Bundle | Inspect full diff before landing changes to prevent unintended regressions |

User-configured MCP (Model Context Protocol) tools dynamically join the agent tool catalog and share the turn budget. Output is capped at 24,000 characters per result with balanced head+tail retention.

### File writes are verified, not arbitrary

`write_file` and `edit_file` save to disk immediately during the turn, through the same verified save path as the reviewed patch pipeline:

1. Pre-apply change-set verification — nothing reaches disk that the verifier refused or could not check.
2. A rewrite-risk guard refuses a `write_file` that would erase most of an existing file (use `edit_file` instead). `edit_file` requires the original snippet to match exactly one place.
3. A version-pinned atomic save: the bridge refuses paths outside the workspace, symlinks, read-only rule docs, and files that changed on disk since the read; then it reads the saved bytes back to confirm.
4. Plugin and automation manifests are protected paths — agent edits to them are blocked.

Reply edit blocks (`path=` fences) are applied by the host between rounds through the same pipeline. The patch parser keeps nested code fences inside an edited Markdown file from splitting the edit block, preserves the file's Windows CRLF line endings, refuses an unterminated whole-file rewrite rather than partially writing it, and tolerates a blank context line in a multi-file diff. Deletes are the one tool with no in-chat undo: a person must click, and a read-back that cannot prove absence is reported as *unverified*, never as success.

### Command approval: risk tiers

`run_command` lines are parsed with a real shell tokenizer (shell-quote plus a Windows adaptation layer) into segments — chains, pipes, redirects, substitutions — and each segment is classified. **The worst segment decides the tier.** Compound commands like `npm i && npm test` are allowed.

| Tier | Behavior | Examples |
|---|---|---|
| READ | auto-runs | `ls`, `cat`, `git status`, `git diff`, `git log`, `tsc --noEmit`, `rg foo` |
| BUILD_TEST | auto-runs | `npm test`, `npm run build`, `pytest`, `jest`, `cargo build`, `go test`, `eslint .` |
| INSTALL | auto-runs | `npm install`, `pip install`, `pnpm add`, `winget install`, `go get` |
| MUTATE | native approval dialog | `git commit`, `mkdir`, `sed -i`, `node script.js`, `eslint --fix`, redirects into workspace files |
| NETWORK | native approval dialog | `curl`, `wget`, `git push`, `git clone`, `ssh`, `npm publish` |
| DANGEROUS | **always** the dialog, with a red warning; never pre-approved by any scope | `rm -rf` at/outside the workspace root, writes outside the root, `sudo`/`runas`, `curl … \| sh`, encoded PowerShell (`-EncodedCommand`), `format`/`diskpart`/`mkfs`, `shutdown`, `Invoke-Expression`, shell function definitions (fork-bomb shape) |

Fail-safe rules:

- An **unrecognized command is MUTATE** — an unknown binary never auto-runs.
- Writes, deletes, or moves aimed **outside the workspace root** escalate to DANGEROUS; a recursive forced delete at the root itself (or a root-covering glob like `*`) is DANGEROUS.
- A model field (`confirm: true`, "the user said so") is never authorization. The workspace is re-checked between approval and execution.
- On Windows, a binary-shaped file planted in the project root that would shadow a PATH tool (CreateProcess searches cwd first) is refused outright; `.cmd`/`.bat` shims are resolved to trusted absolute executables and quoted safely.
- Approval is not a sandbox: an approved command can still change the machine. Approve only what you understand.

Auto-run commands stay visible in the terminal dock with their real output and exit code. A non-zero exit produces a **failure receipt** on the chat message (with the turn's undo checkpoint id) and a repair brief for the model; ShadRox never applies a repair patch by itself. A successful re-run of the same command after a proposed repair is shown as a verified heal.

### Background jobs and `job_control`

Timeouts are about **silence**, not wall-clock duration:

- A command still running after **30 seconds** of foreground waiting becomes a background job: `run_command` returns `exit null`, a job id (`J1`, `J2`, …), and the output tail. That is not a failure and earns no repair receipt.
- **Dev servers background immediately** (`npm run dev`, `vite`, `uvicorn`, `next dev`, …) and report readiness from their logs — a ready URL is probed before it is trusted. A ready server logs once and then serves quietly: silence is health, not a hang.
- A **silent non-server job is killed after 120 seconds** of no output (any stdout/stderr resets the timer). Dev servers and jobs proven ready are exempt from the idle kill.
- **Every job has a 30-minute absolute ceiling**, output or not.
- Each job keeps a rolling **200 KB** output buffer with stable absolute offsets. `job_control read_output` returns the last 8,192 chars by default (up to 204,800, or an explicit character range). `stop` terminates the whole process tree. Up to 20 finished jobs stay readable; closing a workspace cleans up its jobs.

The model is told explicitly: a backgrounded command has NOT finished — read its output and exit status before drawing conclusions, and never restart a healthy server just because its logs went silent.

### The loop: 60 rounds, progress-based stuck detection

- A turn gets **60 tool rounds** by default, each holding up to **16 calls** that run in parallel. Calls beyond the cap are reported and stay runnable next round.
- At **80% of the budget** (round 48) the model gets one soft wrap-up note. At the cap, one final stream is forced ("answer now with what you have"); the stop carries a resumable state summary so a Continue button can pick up later.
- **Stuck detection is progress-based, not repetition-based.** Real progress signals: a new file read, a file content-hash change, a diagnostics count decrease, a command exit-code change, a mutation landing, a task marked done — plus any result that says something new. **8 consecutive steps** with zero progress and zero new information earn one nudge, then a forced final answer. Repeating a call is not a crime; seeing nothing new is.
- **Duplicate calls are never refused.** A succeeded call repeated in the same turn is served from a result cache prefixed `[unchanged since step N]`. Cache entries are invalidated by real workspace mutations (a mutation epoch) and content hashes — a verified delete, an approved command, a landed write, or an MCP write makes earlier reads runnable again. Failed or refused calls are never cached, so they stay retryable.
- An exploration-style ask ("explain this project", "scan…") answered without a single workspace read gets one nudge to inspect first.
- Every boundary (model request, tool call, command decision, verification, stop) lands in a local, scrubbed **flight recorder** — see [Troubleshooting](#troubleshooting).

### Paraphrase-tolerant search

Users paraphrase and typo when quoting text from their app, so a full-phrase miss is never proof the text is absent:

- The model is instructed to search **1–3 distinctive words** (a noun, a year, an identifier), never a whole quoted sentence.
- If a multi-word plain-text `search_text` query finds nothing, the tool automatically retries with the query's distinctive tokens (up to 6; numbers first, then longest words; stop words dropped) and returns **partial matches ranked by how many query words each file contains** — best files first, with matching lines.
- The result tells the model to read the top-ranked file before claiming anything is missing. Regex queries do not get the fallback.

Example: searching `"Copyright 2024 Acme Inc all rights reserved"` and missing falls back to tokens like `2024`, `acme`, `copyright`, `reserved`, and surfaces the footer file that contains most of them.

### `.env` files: readable, secrets masked

`read_file` on any `.env*` file returns the content with secret-shaped values replaced: keys matching `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PASS`, `PRIVATE`, `CREDENTIAL`, `SIGNATURE`, `DATABASE_URL`, `_DSN`, or `AUTH` show as `<set>` or `<empty>` — presence, never the secret. Non-secret lines pass through unchanged, so configuration can still be diagnosed. Secret values never enter the model context or the transcript.

### `preview_control`

The embedded preview pane is managed separately from raw processes:

- `start` runs the project's dev/static server and points the pane at its URL. A one-time install/run consent dialog may appear; if the tool returns `approval-required`, the user must approve — the agent is told not to retry blindly. With multiple detected projects, it asks which to run.
- `stop` halts the preview; `restart` stops then starts so the pane re-points after a crash or port change.
- Use it when the preview is white or stale instead of killing servers by hand. `run_command`/`job_control` manage processes; `preview_control` manages the pane.

### Proof ledger

Every assistant command appends a line to a local **Ed25519-signed ledger** under the app's user-data folder: the redacted command, hashes of the command and its output, and the exit code — never the output text. Credential-shaped parts (tokens, passwords, `Authorization` headers, credentials in URLs) are replaced before signing. Ledger keys live in the OS encrypted store; an edited, reordered, or torn ledger is detected on read. `npm run verify:proofs` re-checks every ledger offline and exits non-zero on any failure. This is not remote attestation and does not protect a machine an attacker already controls.

Settings also reports the token usage the provider returns for each turn (including cache hits where reported). ShadRox bills nothing and keeps no meter.

### Agent benchmark

`npm run benchmark` grades the agent end-to-end **without calling any model**. Each case in `benchmark/cases/<case-id>/` pins a fixture, a prompt, the expected reply, and the commands that must pass afterwards; the reply is replayed through the same parse → verify → atomic-apply → Git rail the product uses.

```sh
npm run benchmark                              # grade every case
npm run benchmark -- --case id                 # grade one case
npm run benchmark -- --case id --reply reply.md  # grade a reply an agent really produced
npm run benchmark -- --json                    # machine-readable output
```

The suite refuses a hollow pass: each case must fail its baseline and assert at least one real check, so an edit that never applied or a command that tests nothing shows up as a failure. Cases cover `bugfix`, `refactor`, `feature`, and `test`.

### Limits to keep in mind

The loop is an early implementation and can make mistakes. Reads and inspections are unguarded; edits go through the verified pipeline; commands follow the tier table. Agent loops, autonomous runs, teams, plugins, and automations are evolving — verify important work yourself and keep backups or Git.

## The 3 Pillars of ShadRox

ShadRox is built from scratch to reject the generic "wrapper" paradigm. It introduces a distinct, human-centric, verified engineering personality:

### 1. Human Engineering Partner Persona (Not a Bot, a Senior 10x Lead)
- **Engineer-to-Engineer Communication:** ShadRox does not recite robotic boilerplate or generic disclaimers. It acts like a sharp, calm, dependable senior software engineer sitting right next to you.
- **Zero Sugar-Coating & Brutal Honesty:** Never flatters, sugar-coats, or pretends something works when it doesn't. ShadRox tells the raw technical truth about compiler errors, failed assertions, security edge-cases, and performance trade-offs.
- **No Claims Without Proof:** The agent never claims code was written, a bug was fixed, or a test passed unless verified by real tool execution on disk this turn. If something was not run or checked, it explicitly states: `Not checked: <what>`.
- **Proactive Ownership:** When tasked with a bug or feature, it explains what it is inspecting, executes targeted changes, runs real compiler/runtime checks, and reports verified results with concrete how-to-test instructions.

### 2. Autonomous Engineering Squad (Ultra-Token-Efficient Multi-Agent Collaboration)
Instead of a single monolithic agent hallucinating across dozens of files, ShadRox coordinates a specialist squad:
- **Coordinator (Tech Lead):** Deconstructs goals into an execution task DAG without touching code directly.
- **Builders (Frontend & Backend Specialists):** Work strictly within their designated file-ownership domains.
- **Tests & Reviewer (QA / Quality Gate):** Audits code diffs, asserts compiler diagnostics, and verifies tests without weakening assertions.
- **Ultra-Token-Efficient Micro-Envelopes:** Agents do not burn tokens on long conversational banter. They communicate over a shared memory blackboard using compact micro-envelopes and pass **diff-only slices (not entire file dumps)**, saving up to 80% token expenditure.

### 3. The Verification & Proof Engine (Quality Over Hallucination)
- **Zero-Guesswork Completion:** A task is never marked finished on mere generation. ShadRox validates that compiler errors are zero (`problems`/`verify`), checks live preview HTTP health, and attaches an Ed25519-signed proof receipt to the audit ledger.

---

## Multi-step runs & agent teams (beta)

Chat is the front door. A deterministic router (no extra model call) decides whether a message stays a normal chat turn or escalates, and the chat card shows the reason — an escalation is never silent. Questions, short prompts, read-only requests, and Plan mode always stay on the chat path.

- **Autonomous runs** — a multi-step change with real files to touch is planned as a task DAG of milestones. Each milestone applies changes through the same guarded patch pipeline and verifies with diagnostics plus an optional approval-gated command. A milestone that passed without touching a file is annotated as having touched nothing. Failed milestones get a repair brief and bounded attempts; a run that still fails after writing files rolls the workspace back to its checkpoint. Runs are durable (journal + run store survive restarts), can be paused, cancelled, and resumed, and enforce time/tool/spend budgets.
- **Agent teams** — a goal spanning several areas (or explicitly asking for a team) is split by a coordinator across specialists:

  | Role | Owns | Does not touch |
  |---|---|---|
  | Coordinator | Planning and assignment | Never edits files |
  | Frontend | Components, styling, client state | Server code, data access, tests |
  | Backend | APIs, data access, services, build config | UI code, tests |
  | Tests | Test files and fixtures | Product code (won't weaken tests to pass) |
  | Reviewer | Reads results, reports problems | Changes nothing |

  Teams share the solo run's single write-and-verify path and checkpoint; each brief carries file-ownership boundaries. A team plans once: Pause halts at the next task boundary and leaves an honest `paused` state, but continuing means starting the goal again.

There is no model-triggered background `run_plan` tool in this release; escalation happens at send time from your prompt.

## Live preview

- Supported: static sites (served by ShadRox); Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, Remix, webpack, and Parcel projects; other Node web projects with detected scripts; Python, Go, PHP, Java, and .NET backends with detected entry points (the runtime must be installed on your machine).
- Opening a workspace auto-starts the detected preview script and may install missing dependencies behind a one-time install/run consent dialog. Check the detected project and run script before opening an untrusted workspace.
- Click-to-source works for static pages served through ShadRox, not external dev servers.
- **Check** inspects bounded frame structure and recent console errors and reports `ok`, `warn`, `fatal`, or `observed`. `observed` means the check could not prove the page — deliberately not a claim that it looks correct.
- Port conflicts and stale servers are handled without touching foreign processes; see [Troubleshooting](#troubleshooting). The agent can stop/start/restart the pane with `preview_control`.
- Preview bundles never embed vault secrets.

## Terminal

- Interactive shell rooted in the workspace (xterm.js + node-pty), with multiple sessions and split panes. Credential-shaped environment variables are stripped before the shell starts.
- PowerShell and bash load a small ShadRox script (OSC 133/633 markers) reporting cwd, command text, and exit code; the panel shows them and notices a command that has gone silent (default hung threshold 20s, configurable). Command Prompt and plain `/bin/sh` are not wrapped.
- Assistant commands run on a separate non-interactive path and are echoed into the terminal dock; they never type into your shell. The agent reads the summary with `terminal_state` and can answer a waiting prompt only through the approval-gated `terminal_answer`.

## Git & checkpoints

- Inspect staged and unstaged changes, preview file diffs, stage/unstage, commit with AI-generated messages, switch local branches, see ahead/behind counts against the upstream, and detect and resolve merge conflicts.
- GitHub integration: validate a token in the app and push commits from the workspace; a repository-creation endpoint ships with the API layer.
- **Checkpoints** capture workspace files and the local Git position; restore earlier content from the timeline when an experiment goes sideways. Installed packages, running terminals, and remote effects are not undone. The Machine Delta core in the main process provides bounded snapshot/inspect/restore primitives; foreign Git locks are never removed.

## MCP servers

Connect user-configured Model Context Protocol servers in Settings. Starting a server or listing/calling its tools requires consent for the complete server configuration. MCP tools join the agent's tool list on the text protocol; in Ask/Plan modes they are refused like any other external effect. Treat MCP servers as untrusted until approved.

## Rules and skills

Project conventions load from `SHADROX.md`, `AGENTS.md` (root or nested per-directory), `QODER.md`, `.cursorrules`, and `.shadrox/rules/*.md`; reusable skills live under `.shadrox/skills/`. Rules and skills are treated as untrusted reference data, and read-only rule docs cannot be overwritten by the agent.

## Workspace basics

- **New project** asks for a name and location, creates an empty folder, and opens it — no starter files, and a non-empty target folder is refused rather than overwritten.
- **Recent workspaces** reopen saved folders/file sets with persisted native consent, a visible loading state, and a ready-file count. Reopening requires a path the main process already accepted; an unknown path asks again.
- **Themes** — one light/dark toggle; until you choose, the app follows your OS preference, then remembers your choice.
- **Feedback drawer** — the top-bar Feedback button offers exactly two report types, Bug and Feature request, and sends only the message you typed (see [AI chat & BYOK](#ai-chat--byok)).
- **Update checks** — the app checks for a newer release 15 seconds after start and every 6 hours, and shows a badge when one exists. Downloading and installing stays manual from [shadrox.cyou/download](https://www.shadrox.cyou/download).

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 44 |
| Renderer | React 19 + Vite 8 |
| Language | TypeScript 7 (build); bundled TypeScript 5.9 language service |
| Styling | Tailwind CSS 4 |
| Editor | CodeMirror 6 |
| Terminal | xterm.js + node-pty |
| Local server | Express 4 (`server.ts`) |
| Auth | Supabase (Google sign-in) |
| Packaging | electron-builder (NSIS on Windows, DMG on macOS) |
| Updates | electron-updater (check + badge only) |

## Architecture

The Electron main process (`electron/main.cjs` and friends) owns workspace consent, command risk classification and approval, the preview runtime, terminals, Git, MCP, the proof ledger, and the updater. The React renderer talks to it over a context-isolated preload bridge, with a renderer CSP applied only to the app origin (the preview iframe is allowed its own loopback dev-server origins). A local Express API layer (`api/`) handles provider calls (`/ai/chat`, `/ai/fim`, `/ai/commit-message`), BYOK validation, and GitHub operations. Prompts go from your machine to your configured provider; Supabase receives only account profile fields.

ShadRox is proprietary software owned by ShadRox and founder Sourav Maurya, built on third-party libraries including Electron, React, CodeMirror, xterm.js, Vite, Tailwind CSS, and Supabase; third-party dependencies remain subject to their own licenses.

### Repository layout

```
electron/    Main process: IPC, consent, command approval, preview, terminal, MCP, proof store, updater
src/         React UI (components/, hooks/) and lib/ (agent loop, patch engine, autonomy, agents,
              terminal, preview, proof, behavior, calibratedAuto, plugins, ...)
api/         Local API routes: ai/, byok/, github/, prompt/
benchmark/   Model-free agent benchmark cases
supabase/    Auth schema (profiles table, triggers)
landing/     Next.js marketing site (separate app, pnpm)
scripts/     Packaging, test and benchmark runners, feedback Apps Script
server.ts    Express dev server entry point
```

## Development & building from source

Requirements: Node.js 22.12+, npm, Windows or macOS for desktop packaging, a Supabase project with Google sign-in configured, and a Gemini/Groq/compatible API key for AI features. Some native dependencies need platform build tools; project previews need the project's own package manager and toolchain.

```sh
npm install
cp .env.example .env   # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
                        # never put a Supabase service_role key in the desktop app
npm run dev:desktop    # dev server + Electron
npm run dev            # browser UI only (dev server + Vite middleware)
```

| Command | Purpose |
|---|---|
| `npm test` | Auto-discovers and runs every `*.test.*` under `src/`, `electron/`, `api/` (Node test runner + tsx) |
| `npm run typecheck` | Type-check with the bundled TypeScript 5.9 service |
| `npm run benchmark` | Grade the model-free agent benchmark |
| `npm run verify:proofs` | Re-verify every signed proof ledger offline; non-zero exit on any failure |
| `npm run build` | Build the renderer into `dist/` |
| `npm run build:desktop` / `npm run dist:win` | Stage/package the desktop app; Windows NSIS installer (no publish) |
| `npm run dist:mac` | macOS DMG |
| `npm run release:win` | Build and publish a Windows release (requires `GH_TOKEN`) |
| `npm start` / `npm run preview` | Alias of `dev` / serve the built `dist/` |

Landing page (separate app, pnpm):

```sh
corepack pnpm --dir landing install --frozen-lockfile
npm run dev:landing
```

Tests include integration runs that drive the real tool loop and patch pipeline against real temporary-directory workspaces. Builds and tests do not replace a clean-machine installer smoke test: verify installation, sign-in, preview, terminal, provider access, update behavior, and file changes before distributing a release.

### Production build protection

`npm run build:desktop` and `npm run dist:win` set `NODE_ENV=production` and run the hardening pipeline automatically:

1. The renderer bundle is obfuscated (control-flow flattening, dead-code injection, hexadecimal identifiers, RC4 string-array encoding). Self-defending mode stays disabled for Electron compatibility.
2. The Electron main process and local API backend are compiled to V8 bytecode (`.jsc`) with Bytenode; their source files are removed from staging before the ASAR is built. The sandboxed preload bridge ships as source because Electron disallows Node bytecode loaders in sandboxed preloads.
3. Development (`npm run dev`, `npm run dev:desktop`) skips all of this and stays readable.

Obfuscation and bytecode raise the cost of static inspection but cannot make a distributed app impossible to reverse-engineer; keep signing keys, provider secrets, and other confidential material out of the client.

## Background jobs

Timeouts are about **silence**, not wall-clock duration:

- A command still running after **30 seconds** of foreground waiting becomes a background job: `run_command` returns `exit null`, a job id (`J1`, `J2`, …), and the output tail. That is not a failure and earns no repair receipt.
- **Dev servers background immediately** (`npm run dev`, `vite`, `uvicorn`, `next dev`, …) and report readiness from their logs — a ready URL is probed before it is trusted. A ready server logs once and then serves quietly: silence is health, not a hang.
- A **silent non-server job is killed after 120 seconds** of no output (any stdout/stderr resets the timer). Dev servers and jobs proven ready are exempt from the idle kill.
- **Every job has a 30-minute absolute ceiling**, output or not.
- Each job keeps a rolling **200 KB** output buffer with stable absolute offsets. `job_control read_output` returns the last 8,192 chars by default (up to 204,800, or an explicit character range). `stop` terminates the whole process tree. Up to 20 finished jobs stay readable; closing a workspace cleans up its jobs.

The model is told explicitly: a backgrounded command has NOT finished — read its output and exit status before drawing conclusions, and never restart a healthy server just because its logs went silent.

## The agent loop: 60 rounds, progress-based stuck detection & self-healing

- A turn gets **60 tool rounds** by default, each holding up to **16 calls** that run in parallel. Calls beyond the cap are reported and stay runnable next round.
- At **80% of the budget** (round 48) the model gets one soft wrap-up note. At the cap, one final stream is forced ("answer now with what you have"); the stop carries a resumable state summary so a Continue button can pick up later.
- **Auto-Recovery on Edit Failures:** If `edit_file` or `apply_patch` fails 2 consecutive times on the same target file (due to snippet drift, unexpected whitespace, or stale buffers), ShadRox automatically unlocks clean overwrite mode via `write_file` for that specific file during the turn.
- **Identical Call Loop Capping:** Calling the exact same tool with identical arguments repeatedly is capped at 2 attempts. On the second failure, the loop returns an actionable recovery hint ("Stop retrying identical arguments — re-read the exact start_line/end_line range with read_file...").
- **Stuck detection is progress-based, not repetition-based.** Real progress signals: a new file read, a file content-hash change, a diagnostics count decrease, a command exit-code change, a mutation landing, a task marked done — plus any result that says something new. **8 consecutive steps** with zero progress and zero new information earn one nudge, then a forced final answer. Repeating a call is not a crime; seeing nothing new is.
- **Duplicate calls are never refused.** A succeeded call repeated in the same turn is served from a result cache prefixed `[unchanged since step N]`. Cache entries are invalidated by real workspace mutations (a mutation epoch) and content hashes — a verified delete, an approved command, a landed write, or an MCP write makes earlier reads runnable again. Failed or refused calls are never cached, so they stay retryable.
- An exploration-style ask ("explain this project", "scan…") answered without a single workspace read gets one nudge to inspect first.
- Every boundary (model request, tool call, command decision, verification, stop) lands in a local, scrubbed **flight recorder** — see [Troubleshooting](#troubleshooting).

## `.env` files

`read_file` on any `.env*` file returns the content with secret-shaped values replaced: keys matching `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PASS`, `PRIVATE`, `CREDENTIAL`, `SIGNATURE`, `DATABASE_URL`, `_DSN`, or `AUTH` show as `<set>` or `<empty>` — presence, never the secret. Non-secret lines pass through unchanged, so configuration can still be diagnosed. Secret values never enter the model context or the transcript.

## Proof ledger

Every assistant command appends a line to a local **Ed25519-signed ledger** under the app's user-data folder: the redacted command, hashes of the command and its output, and the exit code — never the output text. Credential-shaped parts (tokens, passwords, `Authorization` headers, credentials in URLs) are replaced before signing. Ledger keys live in the OS encrypted store; an edited, reordered, or torn ledger is detected on read. `npm run verify:proofs` re-checks every ledger offline and exits non-zero on any failure. This is not remote attestation and does not protect a machine an attacker already controls.

Settings also reports the token usage the provider returns for each turn (including cache hits where reported). ShadRox bills nothing and keeps no meter.

## Agent benchmark

`npm run benchmark` grades the agent end-to-end **without calling any model**. Each case in `benchmark/cases/<case-id>/` pins a fixture, a prompt, the expected reply, and the commands that must pass afterwards; the reply is replayed through the same parse → verify → atomic-apply → Git rail the product uses.

```sh
npm run benchmark                              # grade every case
npm run benchmark -- --case id                 # grade one case
npm run benchmark -- --case id --reply reply.md  # grade a reply an agent really produced
npm run benchmark -- --json                    # machine-readable output
```

The suite refuses a hollow pass: each case must fail its baseline and assert at least one real check, so an edit that never applied or a command that tests nothing shows up as a failure. Cases cover `bugfix`, `refactor`, `feature`, and `test`.

## Limits

The loop is an early implementation and can make mistakes. Reads and inspections are unguarded; edits go through the verified pipeline; commands follow the tier table. Agent loops, autonomous runs, teams, plugins, and automations are evolving — verify important work yourself and keep backups or Git.

## Troubleshooting

### SmartScreen warns about the installer

The Windows installer is **not code-signed**, so SmartScreen may show "Windows protected your PC". This is expected for the beta.

1. Verify the download came from [shadrox.cyou/download](https://www.shadrox.cyou/download) (the direct asset is `ShadRox-v0.1.4-Setup.exe`).
2. Choose **More info → Run anyway**.

Do not run installers from mirrors or re-uploads you cannot verify.

### Preview: port conflicts and stale servers

ShadRox **never kills a foreign process** to free a port:

- If the project's pinned port is occupied by another process (even one that answers nothing), the preview **relocates to a free port** — for Vite-style servers it walks upward port by port. The foreign listener survives.
- A URL the dev server prints itself outranks the pre-startup port scan, and the printed host is kept as-is (rewriting `localhost` to `127.0.0.1` can break Next.js HMR).
- Stale-server cleanup only kills process trees **recorded against the same project root** (kept in `preview-orphans.json` in the app's user-data folder). Another workspace's live preview, or any unrelated server, is foreign too: relocate, never kill.
- Next.js records its dev server in `.next/dev/lock`. If the recorded PID is still alive and the URL matches, ShadRox reuses it; if the PID is gone (e.g. after a force-kill), the stale lock is removed so a fresh server can start.

**White or stale preview pane?** Use the preview pane's restart control, or ask the agent to run `preview_control restart` — it re-points the pane at the live URL after a crash or port change. A dev server that logs once and then goes quiet is healthy; silence is not a hang (see [Background jobs](#background-jobs)).

### pnpm / bun / yarn projects

The preview runtime picks the package manager in this order:

1. The `packageManager` field in `package.json`, if that manager is installed.
2. The lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`/`bun.lock`), if its manager is installed.
3. **The `node_modules` layout on disk** — a `node_modules/.pnpm` store means pnpm built it; `node_modules/.bun` means bun. The store wins over a foreign lockfile, because a lockfile only records what the project was *once* installed with.
4. npm as the fallback.

If the lockfile's manager is not installed, ShadRox installs with npm using `--no-package-lock --legacy-peer-deps` (so it does not rewrite the dependency tree or write a competing lockfile) and shows a notice: install that manager for an exact reproduction. If you see `'bun.cmd' is not recognized` or peer-dependency failures, install the manager the project actually uses, or delete `node_modules` and let ShadRox reinstall with a consistent one.

### OneDrive, file locks, and "changed on disk" errors

Saves are atomic and verified: ShadRox writes a temp file, then hard-links or renames it over the target, and reads the bytes back to confirm.

- **OneDrive/FAT32/network volumes refuse hard links** — ShadRox falls back to rename (and to copy+unlink across volumes), so saves still work there.
- If a file **changed on disk since it was read** (OneDrive sync, another editor, a Git operation), the save is refused with "This file changed on disk. Reload it before saving to avoid overwriting external changes." Reload the file and re-apply; ShadRox will not silently clobber the external change.
- If saves fail with permission/lock errors while OneDrive is actively syncing, pause syncing (or move the project out of the synced folder) and retry. Keep important work in Git regardless — checkpoints and the agent's undo do not replace backups.

### A command was killed or "timed out"

- A non-server command that produces **no output for 120 seconds** is killed (any output resets the timer). Long silent builds should print progress, or run them in the interactive terminal instead.
- **Every background job has a 30-minute ceiling**, output or not; the output says so when it fires.
- Dev servers and jobs proven ready are exempt from the idle kill — only the ceiling bounds them.
- A command still running after 30 seconds is not a failure: it became a background job. Read its real result with `job_control` before concluding anything.

### The agent refuses to edit or run

- **Ask and Plan modes are read-only.** Switch the Run settings menu to **Agent** to allow writes, commands, and MCP tools.
- A delete needs your click in a native dialog; a cancelled delete is final for that call — the agent is told not to retry or pick another file.
- A command in the MUTATE/NETWORK/DANGEROUS tiers needs your approval; DANGEROUS always asks, in red, and can never be pre-approved.
- "Not written — …" means pre-apply verification refused the change; the file on disk is untouched.

### Where logs live

| Record | Location | Notes |
|---|---|---|
| Flight recorder (agent turn traces) | App local storage, keys `shadrox.flight.*` | Local-only JSONL: every model request, tool call, command decision, verification, and stop, scrubbed of credential-shaped text. Bounded: 4,000 events/run, 24 runs, 400 KB/run. Default on; toggle in Settings. Fail-open — logging never breaks a turn |
| Command proof ledgers | User-data folder, `proof-ledgers/` (keys in `proof-keys/`) | Signed, redacted command + hashes + exit code; never output text. Verify offline with `npm run verify:proofs` |
| Machine receipts / consent / preview orphans / MCP config | User-data folder: `machine-receipts/`, `workspace-consent.json`, `preview-orphans.json`, `mcp-servers.json`, `secure-store.json`, `runtime.json` | Main-process state |
| Next.js dev server logs | Project's `.next/dev/logs/` | Written by Next.js itself |
| Dev console | Terminal running `npm run dev:desktop` | Main-process `console` output and renderer devtools |

The user-data folder is Electron's per-app directory — on Windows under `%APPDATA%`, named after the app (`ShadRox` for the installed app). Nothing in these records is sent anywhere.

### Updates

The app checks for a newer release 15 seconds after start and every 6 hours, and shows a badge when one exists. It does **not** download or install updates by itself — download the new installer from [shadrox.cyou/download](https://www.shadrox.cyou/download) and run it.

### Sign-in and source builds

- Google sign-in is required; the Continue button stays disabled until you accept the Terms and Privacy Policy.
- Running from source needs a Supabase project configured in `.env` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). See [Development & building from source](#development--building-from-source).
- In the browser dev build your provider key sits in `localStorage` in plain text — see [AI chat & BYOK](#ai-chat--byok).

Still stuck? Use the in-app **Feedback** button or visit <https://www.shadrox.cyou/faq#support>. For suspected vulnerabilities, use private reporting per [Security](#security) — never disclose them publicly.

## FAQ

### Can I download ShadRox now?

Yes. The latest beta installer (v0.1.4) is for Windows 10 or 11, 64-bit: download `ShadRox-v0.1.4-Setup.exe` from [shadrox.cyou/download](https://www.shadrox.cyou/download). The build is unsigned, so SmartScreen may warn — verify the download source before choosing **More info → Run anyway**. See [Troubleshooting](#troubleshooting).

### Do I need an account?

Yes. Google sign-in through Supabase is required to enter the desktop app; there is no password to create. Account profile fields are email, name, avatar, app version, and platform — nothing about your projects. You must accept the Terms and Privacy Policy before the sign-in button enables.

### Does ShadRox store my project in the cloud?

No. Project files are opened and edited on your computer. There is no ShadRox cloud project sync.

### What is sent when I use AI?

Only the prompt and the project context included with that request (selected files, search results, a compact repo map, project rules, recent conversation) go to the AI provider configured for it. Providers process that data under their own data-handling terms. Your key travels from your machine to your provider, never to ShadRox. Details: [AI chat & BYOK](#ai-chat--byok).

### Which AI providers are supported?

Google Gemini, Groq, and custom OpenAI-compatible endpoints, including compatible local gateways such as Ollama and LM Studio. Model availability and charges depend on your provider.

### Where is my AI key stored?

In the desktop app, keys live in OS-backed encrypted storage (Settings → Models & Keys) and are never written to plain local storage. In the browser dev build (`npm run dev`) there is no OS-store bridge, so the key sits in that browser's `localStorage` in plain text — do not use the browser build on a shared machine. See [AI chat & BYOK](#ai-chat--byok).

### Can the agent make changes on its own?

Not silently, and not without tiers. Inspection tools are read-only. In Agent mode, shell commands are parsed and risk-classified: reads, builds/tests, and installs (including `npm test`, `pytest`, `tsc --noEmit`, `npm install`, Git status/diff) **run automatically** and stay visible in the terminal dock; file-modifying and network commands open a native approval dialog; dangerous commands (deletes outside the workspace, `sudo`, download-piped-to-shell, disk tooling) **always** ask, with a red warning, and can never be pre-approved. File edits go through a verified save pipeline with a rewrite guard; deleting a path needs an explicit confirm plus your click and a follow-up read that proves it is gone. Ask and Plan modes never mutate anything. Agent workflows are beta — inspect results and keep backups. Full model: [Agent tools & safety model](#agent-tools--safety-model).

### How do updates work?

The app checks for a newer release about 15 seconds after start and every 6 hours after that, and shows a badge when one is ready. Nothing is downloaded or installed automatically — you download the installer from the release page and run it when you choose.

### Does ShadRox cost anything?

No. ShadRox is free and bring-your-own-key only. There is no plan to buy, no checkout, and no charge from ShadRox; your own provider key carries every request and your provider bills you directly. "Credits" in run budgets are an internal unit of work, never money.

### Can I preview any project?

ShadRox supports Markdown, static sites, detected Node web projects (Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, Remix, webpack, Parcel, and other detected scripts), and detected Python, Go, PHP, Java, and .NET backends. The project's runtime must be installed on your machine, and not every configuration is supported. Some external sites block embedded previews. Port conflicts are handled by relocating, never by killing foreign processes — see [Troubleshooting](#troubleshooting).

### Can I preview a README or Markdown file?

Yes. Select any `.md` or `.markdown` file and use the **Preview** button beside its name; switch back to **Source** to edit.

### Can I send a follow-up message while the AI is working?

Yes. Up to 5 follow-up messages are held in a queue and sent after the current turn finishes, rather than interrupting it. Each queued message keeps the workspace, key, and model you queued it with.

### Who is behind ShadRox?

ShadRox is proprietary software founded and owned by Sourav Maurya, a 19-year-old full-stack developer and AI engineer based in Delhi, India. There is no outside company behind it — the app, the website ([shadrox.cyou](https://www.shadrox.cyou)), and all releases are built and maintained by its founder.

### Where does feedback go?

The Feedback button in the app sends only the message you type — tagged as Bug or Feature request — plus a server-side date, into the maker's private Google Sheet (columns: date, bug, feature). Nothing else is attached: no email, account details, app version, platform, code, file names, or diagnostics, and no ShadRox server sits in this path. Setup and limits: [AI chat & BYOK](#ai-chat--byok).

## Installation

1. Download the Windows installer from [shadrox.cyou/download](https://www.shadrox.cyou/download).
2. If Windows SmartScreen warns, verify the download URL before choosing **More info -> Run anyway**. This beta installer is not code-signed.
3. Open ShadRox and sign in with Google.
4. Open a project folder, then add your own Gemini, Groq, or compatible endpoint key in **Settings -> Models & Keys**.
5. Keep important work in Git or a backup. Review patches before applying them.

ShadRox is free and runs on bring-your-own-key. Add your own Gemini, Groq or OpenAI-compatible provider key in Settings; your provider bills you directly and ShadRox takes no payment.

For feedback, post in the private beta WhatsApp group with the steps you took, what you expected, what happened, and the diagnostics copied from the app.

## Beta terms

ShadRox is an experimental beta. Use it only with backups or source control and review all generated edits and commands before relying on them.

The software is provided for testing and feedback, without a promise of availability, correctness, security, or fitness for a particular purpose. You are responsible for your files, provider accounts, API keys, and any commands you approve. Do not use the beta for safety-critical or regulated work.

You may stop using the beta at any time. Report defects and data-deletion requests in the private beta WhatsApp group. ShadRox is free and runs on bring-your-own-key: there is no plan to buy and no charge from ShadRox — your own provider key carries every request and your provider bills you directly.

### Intellectual Property

Copyright (c) 2026 ShadRox — founded and owned by Sourav Maurya. All rights reserved. ShadRox, its source code, architecture, branding, and compiled installers are proprietary intellectual property owned exclusively by ShadRox and Sourav Maurya (see [LICENSE](./LICENSE)). You retain 100% ownership and all rights to your own project files and code.

## Privacy

ShadRox stores your local project files and provider keys on your device. Provider keys use the operating system's encrypted storage where available.

When you ask an AI provider for help, ShadRox sends the prompt and the project context you select to that provider. ShadRox account authentication stores the minimum profile information required for the beta, such as email, name, avatar, app version, and platform. ShadRox does not sync your project folder to a cloud workspace.

For deletion or privacy questions, contact the beta coordinator in the private WhatsApp group. Do not include API keys or project contents in the request.

## Security

Please report suspected vulnerabilities privately by contacting the founder directly at `iamsouravmourya@gmail.com` or via [shadrox.cyou/about](https://www.shadrox.cyou/about). Include a reproduction, the affected version, and the impact. Do not send credentials or private project files, and do not disclose an unpatched vulnerability publicly before a fix is shipped.

This beta runs local commands and previews in the folder you open. Use trusted folders, keep backups, and do not approve commands you do not understand.

## License & Intellectual Property

ShadRox is proprietary software ([All Rights Reserved](./LICENSE)). Copyright (c) 2026 ShadRox — founded and owned by **Sourav Maurya**. Unauthorized copying, redistribution, modification, or commercial exploitation of ShadRox without written permission from the founder is prohibited. No warranty; third-party open-source dependencies retain their own licenses.

Founded & built by [Sourav Maurya](https://www.shadrox.cyou/about). [Website](https://www.shadrox.cyou) · [LinkedIn](https://www.linkedin.com/in/sourav-maurya-45b272377)

## Keep reading

- [Website](https://www.shadrox.cyou) · [Releases](https://www.shadrox.cyou/releases) · [Contributors](https://www.shadrox.cyou/contributors) · [About](https://www.shadrox.cyou/about)
