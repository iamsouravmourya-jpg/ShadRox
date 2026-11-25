<div align="center">

<img src="assets/icon.png" alt="ShadRox" width="96" />

# ShadRox

**Your project, code, AI, and preview — in one Windows workspace.**

[![Version](https://img.shields.io/badge/version-0.1.4-7c3aed?style=flat-square)](https://www.shadrox.cyou/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0f111c?style=flat-square)](https://www.shadrox.cyou/download)
[![License](https://img.shields.io/badge/license-Proprietary%20%C2%B7%20All%20Rights%20Reserved-3b82f6?style=flat-square)](./LICENSE)

[Download for Windows](https://www.shadrox.cyou/download) · [All releases](https://www.shadrox.cyou/releases) · [Support](https://www.shadrox.cyou/faq#support)

</div>

ShadRox is a native Electron desktop IDE that brings a CodeMirror 6 editor, BYOK AI chat and autonomous engineering agent, live project preview, Git source control, and an integrated terminal into one window. Open a local folder, edit files, ask your own AI provider for help, preview the running app, and commit — without leaving the workspace. Project files stay on your disk; only the prompt and selected context are sent to the provider you configure. ShadRox is free, bring-your-own-key only, and has no billing.

> **Beta software (v0.1.4).** Model output and generated edits can be incorrect. Review changes, keep backups or use Git, and never approve shell commands you do not understand. See [Beta terms](#beta-terms).

---

## Contents

- [Workspace Architecture & Execution Flow](#workspace-architecture--execution-flow)
- [Core Capabilities](#core-capabilities)
- [Quick Start](#quick-start)
- [35 Native Agent Tools](#35-native-agent-tools)
- [Command Approval: Risk Tiers](#command-approval-risk-tiers)
- [AI Chat, Providers & Key Storage](#ai-chat-providers--key-storage)
- [Privacy & Data Boundary](#privacy--data-boundary)
- [Live Preview & Integrated Terminal](#live-preview--integrated-terminal)
- [Tech Stack & Development](#tech-stack--development)
- [Production Build Protection](#production-build-protection)
- [Proof Ledger & Agent Benchmark](#proof-ledger--agent-benchmark)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Installation, Beta Terms, Privacy, Security & License](#installation)

---

## Workspace Architecture & Execution Flow

### ShadRox IDE Workspace Map

```text
+---------------------------------------------------------------------------------------------------+
| [<-] ShadRox  workspace (N files)  v0.1.4        [o Auto-save] [>_ Terminal] [Theme] [Bug] [Gear] |
+----+-------------------+---------------------------------------+----------------------------------+
|    | EXPLORER       +  | page.tsx  layout.tsx  globals.css     | [Sparkles] Model Selector  [BYOK]|
| [] | [Search files...] | src / app / page.tsx                  +----------------------------------+
|    | > src             |---------------------------------------|                                  |
| Q  |   > components    |  1  export default function Home() {  |  You · 10:42   [✓ Accept] [✗ Skip] |
|    |   > lib           |  2    return <main>...</main>;        |  Build the feature end-to-end    |
| Y  |   .env (masked)   |  3  }                                 |                                  |
|    |   package.json    +---------------------------------------+  ShadRox · Thinking & Progress   |
| |> |                   | Ready · N lines · UTF-8 · TypeScript  |  |- [Scout 1] Reading API...     |
|    +-------------------+---------------------------------------+  |- [Scout 2] Reading UI...      |
|                        | TERMINAL [Shell 1] [+]   Clear  Reset |  `- Verified: 0 type errors      |
|                        | $ npm test                            +----------------------------------+
| (U)|                   | 2537 passed (0 failed)                | [@] [Clip] [Img] [Wand]  [Send]  |
+----+-------------------+---------------------------------------+----------------------------------+
  ^          ^                              ^                                     ^
  |          |                              |                                     |
Rail:   Sidebar:                       Main Stage:                           Unified AI Panel:
Code    Explorer / Quick Search /      CodeMirror 6 Split Tabs, Ctrl+K,      Searchable Models, Accept/Reject
Preview Git SCM (Push/Pull/Sync/       Live Preview Pane, or Multi-Tab       Bar with Auto-Save, File &
Search  Stage/Discard/AI Commit)       xterm.js + node-pty Dock              Image Paste / Attachments
Git
Account
```

### Autonomous Agent & Security Execution Pipeline

```text
  User Prompt (Text, @Mentions, External Files, Pasted Snippets, Image)
         |
         v
  [Intent Router: classifyTurnIntent]
         |
         +--> Pure Conversational ("hi", thanks, Q&A) ---> Lightweight Context (<250 tok), 0 Tools
         |
         +--> Advisory / Review ("explain", "audit") ----> Read-Only Policy, Code Intel & Search
         |
         +--> Code / Execution Task ---------------------> Unified Autonomous Agent (60 Rounds Max)
                                                                  |
         +--------------------------------------------------------+
         |
         v
  [toolLoop: Up to 16 Parallel Calls/Round]
   |- Read-Only Parallel Scouts: spawn_subagent (max 2 concurrent) -> compact summary returned
   |- Resilient Editing: strips accidental "N| " line prefixes; 2-fail -> unlocks clean write_file
   |- Output Guardrails: 24k char balanced head+tail clip, .env* secret masking, 90-msg trim
   '- On-Demand Tool Bundles: unlock_tools activates preview, git, checkpoints, delete, web, etc.
         |
         v
  [Electron Main-Process Safety & Audit Boundary]
   |- Verified Atomic Writes: path-traversal/symlink block, Windows reserved device guard (CON/NUL)
   |- Risk-Tiered Shell: READ / BUILD_TEST / INSTALL auto-run (up to 2 parallel terminals)
   |                     MUTATE / NETWORK -> consent dialog | DANGEROUS -> red warning dialog
   '- Signed Audit Trail: Ed25519 command proof ledger (proof-ledgers/) + local flight recorder
```

---

## Core Capabilities

- **Unified Autonomous Agent (Zero Mode-Switching Friction)** — No manual `Ask / Plan / Agent` switcher in chat. `classifyTurnIntent` automatically scales each turn: pure greetings run on a `<250`-token conversational path with zero tool schemas, read-only questions run in safe inspection mode, and build/fix requests enter the 60-round bounded agent loop.
- **Parallel Read-Only Scout Swarm** — Complex codebase exploration delegates read-only searches via `spawn_subagent` (capped at `2` concurrent scouts) so main conversation context stays compact.
- **Accept/Reject Bar with Auto-Save** — Every file change the agent proposes appears in a hoverable Accept/Reject bar (Cursor-style). Toggle **Auto-Save ON** to apply instantly to disk, or **OFF** to review each diff before it lands. The bar only shows when there are pending changes and Auto-Save is OFF.
- **CodeMirror 6 + TypeScript 5.9 + Auto-Save** — Split editor groups, pinned/reorderable tabs, color-coded Explorer tree, go-to-definition (`F12`), find references (`Shift+F12`), rename (`F2`), quick fixes (`Ctrl+.`), inline AI diff edits (`Ctrl+K`), ghost-text FIM completions, and a persistent top-bar **Auto-Save** toggle (1.2s debounce).
- **Full Git Source Control (`ScmPanel`)** — Stage/unstage individual files, **Stage All**, **Unstage All**, **Discard** unstaged changes cleanly, generate AI commit messages, commit, switch local branches, resolve merge conflicts, and run **Push**, **Pull**, or **Sync** against upstream remotes alongside GitHub repository creation/push.
- **2-Terminal Parallel Command Execution & Live Preview** — Agents can run up to `2` safe commands concurrently across managed terminal/job sessions while keeping interactive user shells isolated. Embedded Preview detects static, Vite, Next.js, Nuxt, Astro, SvelteKit, Remix, and Python/Go/PHP/Java/.NET apps, tagging runtime errors with their active route pathname (e.g., `[Route: /dashboard]`).
- **Focused Composer & Searchable Models** — Filter configured models instantly (`Search models...`), pin files/symbols with `@`, invoke workspace skills with `/`, paste images (`Ctrl+V`) or external files (`Paperclip`, up to 512 KB text / 10 MB image), auto-collapse `4000+`-char pastes into `.txt` chips, refine drafts (`Wand2`), and queue up to 5 follow-up messages mid-run.

---

## Quick Start

1. **Download** `ShadRox-v0.1.4-Setup.exe` (Windows 10/11, 64-bit) from [shadrox.cyou/download](https://www.shadrox.cyou/download). Because beta builds are unsigned, verify the download URL if Windows SmartScreen warns, then choose **More info → Run anyway**.
2. **Sign in** with Google (required; you must accept the Beta Terms and Privacy Policy first).
3. **Add your API key** in **Settings → Models & Keys** (Gemini, Groq, or a custom OpenAI-compatible URL/local server such as Ollama or LM Studio).
4. **Open a project folder** from the Workspace Hub and start editing, running previews, and shipping changes.

---

## 35 Native Agent Tools

Base core tools load immediately for execution turns; specialized bundles unlock dynamically via `unlock_tools` so context overhead stays minimal on simple turns. Custom **MCP tools** configured in **Settings → MCP Tools** join the catalog dynamically after server consent.

| Tool | Bundle | Purpose |
|---|---|---|
| `list_directory` | Core (FS) | List folder entries with sizes (depth <= 3, respects `.gitignore`) |
| `read_file` | Core (FS) | Read files in 400-line recommended chunks (`start_line`/`end_line`; `.env*` secrets masked) |
| `find_files` | Core (FS) | Fast path substring search across workspace files |
| `search_text` | Core (FS) | Content search with automatic paraphrase-tolerant token ranking fallback |
| `edit_file` | Core (FS) | Replace an exact unique snippet; strips accidental `N\| ` line prefixes; 2-fail unlocks `write_file` |
| `write_file` | Core (FS) | Create new files or rewrite existing files (guarded against accidental large erasures) |
| `verify` | Core (Quality) | Run detected project checks (`typecheck`/`build`/`test`) and return structured diagnostics |
| `problems` | Core (Diagnostics) | Inspect compiler diagnostics project-wide or for touched files |
| `outline` | Core (Code) | List classes, functions, and symbol line numbers in a file |
| `update_tasks` | Core (Workflow) | Track structured multi-step turn tasks (`pending`, `doing`, `done`, `blocked`) |
| `finish` | Core (Workflow) | Complete the turn with summary, touched files, and verification status |
| `unlock_tools` | Core (Meta) | Dynamically unlock specialized tool categories on demand |
| `run_command` | Core (Exec) | Run shell commands in workspace root under risk-tier rules; `>30s` becomes a background job |
| `apply_patch` | `apply_patch` | Atomically apply multi-file `{path, old, new}` hunks with rollback on error |
| `job_control` | `jobs` | List background jobs, inspect rolling 200 KB logs, or stop a process tree |
| `terminal_state` | `terminal` | Inspect active shell cwd, exit code, silence timer, and waiting-for-input state |
| `terminal_answer` | `terminal` | Send an approved single-line reply to an interactive prompt waiting for input |
| `preview_control` | `preview` | `start`, `stop`, or `restart` the embedded preview and read route-tagged logs |
| `git_state` | `git` | Inspect working-tree `git status` plus staged/unstaged diffs |
| `checkpoint` | `checkpoints` | Save a named workspace snapshot and Git baseline |
| `list_checkpoints` | `checkpoints` | List saved workspace checkpoints, newest first |
| `restore` | `checkpoints` | Roll back workspace files to a saved checkpoint (user confirmation required) |
| `delete_file` | `delete` | Delete a file or folder recursively (`confirm: true` + native dialog + read-back verify) |
| `memory_read` | `memory` | Read persisted project notes and architectural decisions from `.shadrox/memory.json` |

---

## Command Approval: Risk Tiers

`run_command` parses command chains, pipes, redirects, and substitutions via `shell-quote` + Windows shell normalization. **The highest-risk segment sets the tier for the entire command.**

| Tier | Execution Behavior | Examples |
|---|---|---|
| `READ` | Auto-runs | `ls`, `cat`, `git status`, `git diff`, `git log`, `tsc --noEmit`, `rg foo` |
| `BUILD_TEST` | Auto-runs | `npm test`, `npm run build`, `pytest`, `jest`, `cargo check`, `go test`, `eslint .` |
| `INSTALL` | Auto-runs | `npm install`, `pip install`, `pnpm add`, `winget install`, `go get` |
| `MUTATE` | Native approval dialog | `git commit`, `mkdir`, `sed -i`, `node script.js`, `eslint --fix`, file redirects, unknown binaries |
| `NETWORK` | Native approval dialog | `curl`, `wget`, `git push`, `git clone`, `ssh`, `npm publish` |
| `DANGEROUS` | **Always** red warning dialog | `rm -rf` at/outside root, writes outside root, `sudo`/`runas`, `curl \| sh`, `-EncodedCommand`, `format`/`diskpart`/`mkfs`, `shutdown`, `Invoke-Expression`, fork-bomb functions |

**Fail-safe protections:** Unrecognized commands fail closed to `MUTATE`. Windows current-directory binary shadowing (`.cmd`/`.bat` shims in workspace root overriding `PATH` executables) is blocked before spawn, and sibling `.env` credential variables are stripped from shell environments. Background non-server jobs terminate after **120 seconds of output silence**, ready dev servers stay exempt up to the **30-minute hard ceiling**, and each job buffers **200 KB** of searchable output.

---

## AI Chat, Providers & Key Storage

| Provider | Configuration (`Settings → Models & Keys`) | Secret Storage |
|---|---|---|
| **Google Gemini** | Gemini API key | Desktop: OS `safeStorage` (DPAPI on Windows) + session memory |
| **Groq** | Groq API key | Desktop: OS `safeStorage` (DPAPI on Windows) + session memory |
| **Custom OpenAI-Compatible** | Base URL (e.g. Ollama, LM Studio, OpenRouter) + API key | Desktop: OS `safeStorage` (plaintext mirrors purged on startup) |

> **Browser dev mode (`npm run dev`) note:** When running purely in a browser without the Electron main-process bridge, provider keys sit in `localStorage` and pass to your local Express API (`server.ts`). Do not run browser dev mode on a shared machine.

---

## Privacy & Data Boundary

| Data Type | Destination | Notes |
|---|---|---|
| Project files & `.env*` secrets | Nowhere (stays on local disk) | No ShadRox cloud sync; `.env*` secret values are masked (`<set>`/`<empty>`) before context assembly |
| Prompt + selected context | Your configured AI provider only | Compact repo map, explicitly read/`@`-attached files, rules (`SHADROX.md`, `AGENTS.md`, `.cursorrules`), trimmed to <= 90 messages |
| Provider API key | Direct to your configured provider | Encrypted on desktop via OS `safeStorage`; never sent to ShadRox |
| Account profile | Supabase (Auth only) | Email, name, avatar, version, platform — zero code or prompts |
| Feedback submission | Maintainer's private Google Sheet | Triggered only when clicking **Send** in the Feedback drawer (`kind`, `message`, server timestamp) |

---

## Live Preview & Integrated Terminal

- **Live Preview (`PreviewPane`)** — Supports static HTML sites (with click-to-source), Node web frameworks (Vite, Next.js, Nuxt, Astro, Angular, SvelteKit, Remix, webpack, Parcel), and installed Python, Go, PHP, Java, and .NET runtimes. Occupies conflicting ports safely by relocating upward rather than killing foreign processes, and attaches active URL pathnames (e.g., `[Route: /settings]`) to runtime errors.
- **Integrated Terminal (`TerminalPanel`)** — Multi-tab & split-pane `xterm.js` + `node-pty` shells rooted in the workspace with OSC 133/633 cwd, exit-code, and configurable hung-silence indicators (PowerShell/bash). Up to `2` agent-managed terminal/background commands can run in parallel without hijacking your active typing tab.

---

## Tech Stack & Development

| Layer | Technology |
|---|---|
| Desktop Shell | Electron 44 (`electron/main.cjs` + context-isolated `preload.cjs`) |
| UI Renderer | React 19, Vite 8, Tailwind CSS 4 |
| Languages & Diagnostics | TypeScript 5.9 (`typescript-legacy` compiler worker & semantic layer) |
| Editor | CodeMirror 6 (split groups, inline Ctrl+K diff, FIM ghost text, lint gutter) |
| Terminal | `xterm.js` 5.5 + `node-pty` 1.1 |
| Local Server | Express 4 (`server.ts` + `api/ai`, `api/byok`, `api/github`, `api/prompt`) |
| Auth | Supabase (Google OAuth) |
| Packaging & Updates | `electron-builder` (Windows NSIS / macOS DMG) & `electron-updater` |

### Requirements & Local Commands

Requires **Node.js 22.12+**, npm, and Supabase env keys in `.env` (copy `.env.example`: set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; never embed `service_role` keys).

| Command | Action |
|---|---|
| `npm run dev:desktop` | Launch Express + Vite dev middleware + Electron window |
| `npm run dev` | Run browser UI + local Express backend on port `3000` |
| `npm test` | Run all `*.test.*` suites across `src/`, `electron/`, and `api/` (`node:test` + `tsx`) |
| `npm run typecheck` | Run full workspace TypeScript check (`typescript-legacy/bin/tsc --noEmit`) |
| `npm run build` | Build production renderer bundle into `dist/` |
| `npm run benchmark` | Run the model-free end-to-end agent grading benchmark (`--case id`, `--json`) |
| `npm run verify:proofs` | Verify Ed25519-signed command proof ledgers offline |
| `npm run build:desktop` | Stage hardened desktop build (`vite-plugin-javascript-obfuscator` + Bytenode `.jsc`) |
| `npm run dist:win` / `npm run dist:mac` | Package Windows NSIS installer or macOS DMG in `dist_desktop/` |
| `npm run dev:landing` | Run the separate Next.js site in `landing/` |

```text
electron/    Main process: IPC, consent, command risk tiers, preview runtime, terminal PTY, MCP, proofs
src/         React UI (components/, hooks/) and core engines (lib/agent/, lib/editor/, lib/history, etc.)
api/         Local Express endpoints: ai/, byok/, github/, prompt/
benchmark/   Model-free fixture cases for offline agent pipeline verification
scripts/     Packaging (Bytenode/obfuscation), test runner, benchmark runner, proof verifier
server.ts    Express server entry point (port 3000, CSRF loopback/origin checks)
```

---

## Production Build Protection

`npm run build:desktop` and `npm run dist:win` set `NODE_ENV=production` and automatically run the distribution hardening pipeline:

1. **Renderer obfuscation** via `vite-plugin-javascript-obfuscator` (control-flow flattening, dead-code injection, hex identifiers, RC4 string encoding; self-defending disabled for Electron compatibility).
2. **V8 bytecode compilation** via **Bytenode** (`.jsc`) for Electron main-process modules and the local API backend, removing staging `.js`/`.cjs` sources before building the ASAR (the sandboxed `preload.cjs` stays source as required by Electron).
3. **Development mode** (`npm run dev`, `npm run dev:desktop`) bypasses obfuscation and bytecode compilation for fast debugging.

---

## Proof Ledger & Agent Benchmark

- **Ed25519 Proof Ledger (`electron/proof-service.cjs`):** Every assistant command appends a signed entry (`proof-ledgers/` in Electron user-data) containing the credential-redacted command, command/output SHA hashes, and exit code — never raw output. Signing keys reside in OS encrypted storage (`proof-keys/`). Run `npm run verify:proofs` to detect tampering or torn chains offline.
- **Model-Free Benchmark (`npm run benchmark`):** Evaluates end-to-end parse, verify, atomic apply, and Git checks against pinned cases under `benchmark/cases/<id>/` without calling an LLM. Baseline fixtures must fail before patch replay so hollow passes are rejected.

---

## Troubleshooting

### Windows SmartScreen Warning
Because `ShadRox-v0.1.4-Setup.exe` is unsigned during beta, SmartScreen may prompt **"Windows protected your PC"**. Verify you downloaded directly from [shadrox.cyou/download](https://www.shadrox.cyou/download), then click **More info → Run anyway**.

### Preview Port Conflicts or Stale Servers
- Occupied ports are **never** resolved by killing foreign processes; Vite-style servers increment upward to the next free port automatically.
- Stale-process cleanup targets only PIDs tracked against the current workspace root (`preview-orphans.json`) or stale `.next/dev/lock` files from dead PIDs.
- White or stuck preview? Click restart in the Preview pane or ask the agent to run `preview_control restart`.

### `pnpm` / `bun` / `yarn` Detection
Preview dependency resolution checks `packageManager` -> lockfiles -> existing `node_modules/.pnpm` or `.bun` store -> `npm` fallback (`--no-package-lock --legacy-peer-deps`).

### OneDrive, File Locks & External Changes
Saves write to a temporary file, hard-link/rename (or copy+unlink across OneDrive/FAT32 volumes), and verify bytes back. If a file changed externally since it was read, ShadRox refuses the silent overwrite — reload the file first.

### Where Logs Live

| Record | Location |
|---|---|
| Flight recorder traces | Renderer local storage (`shadrox.flight.*`, scrubbed, bounded to 4,000 events / 24 runs) |
| Signed command ledgers | `%APPDATA%/ShadRox/proof-ledgers/` (keys in `proof-keys/`) |
| Workspace consent, orphans & MCP | `%APPDATA%/ShadRox/`: `workspace-consent.json`, `preview-orphans.json`, `mcp-servers.json`, `secure-store.json` |
| Dev diagnostics | Terminal running `npm run dev:desktop` or `Ctrl+Shift+L` (Beta Debug Logs modal) |

---

## FAQ

- **Does ShadRox cost anything?** No. ShadRox is free and BYOK-only; your provider bills your own API key directly.
- **Does ShadRox upload my code to a cloud workspace?** No. Files open and save strictly on your local disk.
- **Can the agent delete files or run dangerous commands silently?** No. `delete_file` and `DANGEROUS` commands always prompt via native confirmation dialogs; `read_file` masks `.env*` secrets.
- **How do I undo agent edits quickly?** Use the **Accept/Reject bar** above any prompt in chat — click ✗ Skip to discard a change, or toggle **Auto-Save OFF** to review every diff before it hits disk. Git discard/restore in the Source Control panel also works.
- **Can I send follow-up prompts while the agent is still working?** Yes — up to 5 messages queue cleanly with the active model/workspace state.
- **Who builds ShadRox?** Founder and developer **Sourav Maurya** ([shadrox.cyou](https://www.shadrox.cyou)).

---

## Installation

1. Download `ShadRox-v0.1.4-Setup.exe` from [shadrox.cyou/download](https://www.shadrox.cyou/download).
2. If SmartScreen warns on the unsigned beta installer, verify the URL and choose **More info → Run anyway**.
3. Sign in with Google, open a folder, and save your Gemini, Groq, or OpenAI-compatible key in **Settings → Models & Keys**.

## Beta Terms

ShadRox (`v0.1.4`) is beta software provided as-is without warranty of correctness, availability, or fitness for safety-critical work. Keep backups or source control active and review model edits and approved commands before relying on them. You retain **100% ownership** of your project files and code.

## Privacy

Project files and encrypted provider keys reside on your device. Auth via Supabase records minimum beta profile metadata (`email`, `name`, `avatar`, version, platform). Only prompts and selected request context leave your machine toward the AI provider you configured.

## Security

Report suspected vulnerabilities privately to **`iamsouravmourya@gmail.com`** or via [shadrox.cyou/about](https://www.shadrox.cyou/about) with reproduction steps and affected version. Never attach API keys or private project repositories, and avoid public disclosure until a fix is released.

## License & Intellectual Property

Proprietary software — **All Rights Reserved** (see [LICENSE](./LICENSE)). Copyright (c) 2026 **ShadRox**, founded and owned by **Sourav Maurya**. Unauthorized redistribution, reverse engineering, or commercial hosting without written permission is prohibited; bundled open-source dependencies retain their respective licenses.

<div align="center">

Built by **[Sourav Maurya](https://www.shadrox.cyou/about)** · [Website](https://www.shadrox.cyou) · [Releases](https://www.shadrox.cyou/releases) · [LinkedIn](https://www.linkedin.com/in/sourav-maurya-45b272377)

</div>
