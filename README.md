<div align="center">

<img src="assets/icon.png" alt="ShadRox" width="120" />

# ShadRox

### Your project, code, AI, and preview — in one workspace.

A native desktop AI engineering workspace for building local projects with a real code editor, bounded AI agent loops, live preview, and an integrated terminal.

[![Version](https://img.shields.io/badge/version-0.0.4-violet?style=flat-square)](https://github.com/iamsouravmourya-jpg/ShadRox/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0d0f13?style=flat-square)](https://github.com/iamsouravmourya-jpg/ShadRox/releases)
[![License](https://img.shields.io/badge/license-Proprietary-orange?style=flat-square)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[Download for Windows](https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.0.4-Setup.exe) · [All Releases](https://github.com/iamsouravmourya-jpg/ShadRox/releases) · [Report an Issue](https://github.com/iamsouravmourya-jpg/ShadRox/issues)

</div>

---

> **ShadRox is early-stage beta software (v0.0.4).** It is not a mature replacement for a general-purpose IDE. Agent output and model-generated edits can be incorrect — inspect diffs and keep backups or use Git for important work.

## What is ShadRox?

ShadRox brings everything around the code into one Electron desktop app so you can stay in flow: open a local project folder, write code in a full-featured editor, ask an AI model for help, review proposed changes before applying them, preview your web app, and run commands in a terminal — all without leaving the workspace.

Your project stays **local on your disk**. There is no ShadRox cloud project sync. When you ask the AI for help, only the prompt and the project context you choose to include are sent to the provider you configured. Keys are encrypted on your device and never sent to ShadRox servers.

## Features

| | Feature | What it does |
|---|---|---|
| 📁 | **Project Explorer** | Open a folder or selected files, browse the tree, and create, rename, or delete files and folders. |
| ✏️ | **Code Editor** | A CodeMirror 6 editor with split editor groups, pinned and reorderable tabs, quick open, outline, inline AI completions, and save controls. |
| 🔍 | **TypeScript Language Server** | Diagnostics, go-to-definition, find references, rename, and workspace symbol search where supported. |
| 💬 | **AI Chat** | Ask Gemini, Groq, or a custom OpenAI-compatible endpoint questions or request code changes. Review diffs, including individual hunks, before applying. Queue up to five follow-up messages while a reply or run is active. |
| 🤖 | **Bounded Agent Loop** | Multi-round reasoning with native provider tool calls where supported and the ShadRox text protocol as fallback. Read-only workspace tools include directory listing, file reads, search, diagnostics, Git state, and file outlines. Maintains a task plan and finishes turns explicitly. |
| 🚀 | **Autonomous Runs** | Escalate multi-step requests to a DAG-planned autonomous engine: architect → code → verify → repair → commit, with transactional rollback and a vision critic. |
| 👥 | **Agent Teams** | A coordinator splits a goal into tasks and assigns each to a specialist — Frontend, Backend, Tests, or Reviewer — with file ownership boundaries so they don't clobber each other. |
| 🔌 | **MCP Servers** | Connect user-configured Model Context Protocol servers. External tool calls require your approval. |
| 👁️ | **Live Preview** | Serve static sites and launch detected Node-based web projects in an in-app preview. Click-to-source for ShadRox-served pages. |
| 📟 | **Integrated Terminal** | An interactive shell rooted in your workspace, with multiple sessions and resizable split panes. |
| 🔀 | **Source Control** | Inspect staged and unstaged Git changes, preview diffs, stage or unstage files, commit, and switch local branches. |
| 🔎 | **Workspace Search & Replace** | Search disk files and open buffers, review a bounded preview, then replace all matching results. |
| ⏮️ | **Checkpoint & Restore** | Restore earlier assistant checkpoints and scrub through a timeline of changes. |
| 📝 | **Project Rules & Skills** | Conventions via `SHADROX.md`, `AGENTS.md`, `.cursorrules`, nested `AGENTS.md`, or `.shadrox/rules/*.md`. Reusable skills under `.shadrox/skills/`. |
| 🔗 | **GitHub Integration** | Create repositories, push code, and validate tokens without leaving the app. |
| 🔧 | **Plugins & Automations** | Declarative plugins with hook engines, plus scheduled and webhook-triggered automations. |
| 🔄 | **Auto-Updates** | The app checks for newer releases on startup and installs them on the next restart. |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                     │
│  main.cjs · preload.cjs · workspace.cjs · desktop-security.cjs   │
│  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ TS Service│  │ Preview RT │  │ Terminal │  │ MCP Client    │   │
│  │ (LSP)     │  │ (node-pty) │  │ (xterm)  │  │ (approval-gated)│  │
│  └──────────┘  └────────────┘  └──────────┘  └───────────────┘   │
│  ┌──────────┐  ┌────────────┐  ┌──────────────────────────────┐  │
│  │ Updater   │  │ Git Ops    │  │ Automation Webhook           │  │
│  │(auto-update)│ │(create/push)│  │ (scheduler + HTTP triggers)  │  │
│  └──────────┘  └────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
              ▲ IPC (context-isolated, preload bridge) ▼
┌─────────────────────────────────────────────────────────────────┐
│                     React 19 Renderer (Vite)                     │
│  ┌───────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ ┌─────────┐  │
│  │ File Tree  │ │ CodeEdit │ │ ChatPanel│ │ Preview│ │ Terminal│  │
│  │ Outline    │ │ (CM6)    │ │ Agent    │ │ Pane   │ │ Panel   │  │
│  │ QuickOpen  │ │ FIM      │ │ Timeline │ │ Click→ │ │ xterm   │  │
│  │ References │ │ Diag.    │ │ Settings │ │ source │ │         │  │
│  └───────────┘ └──────────┘ └─────────┘ └────────┘ └─────────┘  │
└─────────────────────────────────────────────────────────────────┘
              ▲ Express dev server (server.ts) ▼
┌─────────────────────────────────────────────────────────────────┐
│                            API Layer                              │
│  /ai/chat · /ai/commit-message · /ai/fim · /byok/validate        │
│  /github/create-repo · /github/push · /prompt/refine             │
│  Gemini · Groq · OpenAI-compatible · BYOK · Budget/SpendGuard      │
└─────────────────────────────────────────────────────────────────┘
```

## How a request travels

```
 ┌──────────────┐      prompt + context      ┌──────────────────┐
 │  Your computer │  ───────────────────────▶  │  AI Provider      │
 │                 │                            │  (Gemini / Groq /  │
 │  • Local files  │  ◀───────────────────────  │   compatible)     │
 │  • BYOK key     │      response (stream)      └──────────────────┘
 │    (encrypted)  │
 │  • Project rules│   Supabase (auth only):
 │  • Skills       │   email, name, avatar,
 │  • Repo map     │   app version, platform
 └──────────────┘
```

Project files are edited locally on your disk. Only the prompt and the context you include go to the provider. Your provider key stays encrypted on your device.

## AI Agent: What It Does and Does Not Do

The agent is more than a one-shot text patch parser. It can request bounded rounds of workspace tools, receive their results, and continue reasoning.

**Built-in workspace tools (read-only):**
- Directory listing
- File reads
- Filename and text search
- Diagnostics
- Git state
- File outlines

The model can also update its task plan and finish a turn explicitly. A turn is limited to **five tool rounds** by default, with up to six calls in a round.

**File changes** are proposed through ShadRox's patch format and sent through a patch/review/apply pipeline — they are never arbitrary model-issued filesystem writes. Changes that are unsafe to apply automatically (edits to files the turn did not read, destructive rewrites) are held for review rather than silently written.

> Providers with native function calling use it for tool requests; ShadRox normalizes those calls into its bounded tool contract. A ShadRox-formatted text protocol is the fallback for providers that do not support native tools. The loop is an early implementation and can make mistakes.

### Autonomous Engine

Multi-step requests can escalate from chat to a fully autonomous run:

```
Goal → Architect (DAG plan) → Coder (patches) → Inspector (feedback)
     → Critic (review) → Repair Loop → Verify → Commit
                          ↑                    │
                          └── retry (≤ maxAttempts) ──┘
                          rollback on failure (TransactionManager)
```

The engine uses a **task DAG** for milestone planning, a **transaction manager** for snapshot/rollback, and a **vision critic** for verification. Each milestone gets up to a configurable number of repair attempts before rollback.

### Agent Teams

For goals that span multiple concerns, a **Coordinator** splits the work and assigns each task to a specialist:

| Role | Owns | Does not touch |
|---|---|---|
| **Coordinator** | Planning and assignment | Never edits files |
| **Frontend** | Components, styling, client state, rendering | Server code, data access, tests |
| **Backend** | APIs, data access, services, build config | UI code, tests |
| **Tests** | Test files and fixtures | Product code (won't weaken tests to pass) |
| **Reviewer** | Reads results, reports problems | Changes nothing |

Teams share the same bounded tool loop and guarded patch path. Each agent's brief includes file ownership boundaries so they stay out of each other's way.

## AI Providers & Project Context

**Supported providers:**
- Google Gemini
- Groq
- Custom OpenAI-compatible endpoints (including Ollama, LM Studio, and compatible gateways)

The beta runs on **Bring Your Own Key (BYOK)**. Add a provider key in Settings; model availability and charges depend on that provider.

**Project context** is assembled locally for each request and can include:
- Selected files
- Search results
- A compact repository map
- Project rules
- Recent conversation (compacted without another model call when long)

> Only the prompt and context selected for a request are sent to its configured AI provider. Do not send private code to a provider unless its data-handling terms are acceptable to you.

**Project convention files:**

| File | Scope |
|---|---|
| `SHADROX.md` | Root project rules |
| `AGENTS.md` | Root or nested per-directory rules |
| `QODER.md` | Root project rules |
| `.cursorrules` | Root project rules |
| `.shadrox/rules/*.md` | Structured rule files |
| `.shadrox/skills/` | Reusable skills |

## Preview & Terminal

**Preview** supports:
- ✅ Static sites (served by ShadRox)
- ✅ Vite projects
- ✅ Next.js
- ✅ Node-based web projects (detected scripts)
- ❌ Python, Go, PHP, Java, .NET backends

Opening a project workspace automatically starts its detected preview script and may install missing dependencies. Check the detected project and run script before opening an untrusted workspace. Click-to-source works for static pages served through ShadRox, not external dev servers.

The **integrated terminal** is an interactive shell rooted in the workspace with your computer's environment. Assistant-initiated commands use a separate approval-gated path with a credential-scrubbed environment — they do not get an interactive session.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 44 |
| Renderer | React 19 |
| Build tool | Vite 8 |
| Language | TypeScript 7 |
| Styling | Tailwind CSS 4 |
| Code editor | CodeMirror 6 |
| Terminal | xterm.js + node-pty |
| Dev server | Express 4 |
| Auth | Supabase (Google sign-in) |
| Icons | Lucide React |
| Packaging | electron-builder |
| Updates | electron-updater |

## Requirements

- **Node.js** 22.12 or newer
- **npm**
- **Windows** or **macOS** for desktop packaging
- A **Supabase project** with Google sign-in configured (to build from source)
- A **Gemini**, **Groq**, or compatible endpoint API key to use AI features

Some native dependencies may require platform build tools. Project previews may also need the package manager and toolchain used by the project.

## Quick Start

### Run from source

```sh
# Install dependencies
npm install

# Copy environment config and add Supabase credentials
cp .env.example .env
#   Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env
#   Never put a Supabase service_role key in the desktop app

# Run the desktop app (dev server + Electron)
npm run dev:desktop

# Or run only the local dev server + browser UI
npm run dev
```

### Landing page (separate app)

The landing page lives in `landing/` and uses pnpm:

```sh
corepack pnpm --dir landing install --frozen-lockfile
npm run dev:landing
```

## Development Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local Express/Vite development server. |
| `npm run dev:desktop` | Start the dev server and Electron app together. |
| `npm run build` | Build the renderer into `dist/`. |
| `npm run typecheck` | Type-check the TypeScript project. |
| `npm test` | Run the full Node test suite. |
| `npm run build:desktop` | Stage and package the desktop application. |
| `npm run dist:win` | Build a Windows NSIS installer (no publish). |
| `npm run dist:mac` | Build a macOS DMG. |
| `npm run release:win` | Build and publish a Windows release (requires `GH_TOKEN`). |

## Project Structure

```
shadrox/
├── electron/           # Main process: IPC, preview runtime, terminal, security, MCP, updater
├── src/
│   ├── components/      # React UI: editor, chat, preview, terminal, settings, explorer
│   ├── hooks/           # React hooks
│   └── lib/
│       ├── agent/       # Bounded tool loop, tool protocol, MCP tools, task plans
│       ├── agents/      # Team runs, roles, ownership, turn runner, coordinator
│       ├── autonomy/     # Autonomous engine: DAG, run-loop, confinement, budget
│       ├── automations/ # Schedulers, webhooks, declarative automations
│       ├── editor/      # Search/replace, hunks, semantic tokens, references
│       ├── plugins/     # Plugin manifest, loader, hook engine
│       ├── preview/     # Click-to-source, console capture, source mapping
│       └── terminal/    # Terminal sessions, ring buffer, dock height
├── autonomous/          # Standalone autonomous engine (DAG planner, patch coder, critic)
├── api/
│   ├── ai/             # Chat, FIM, commit message, budget, spend guard, upstream
│   ├── byok/           # BYOK key validation
│   ├── github/         # Repo creation, push, token validation
│   └── prompt/         # Prompt refinement
├── supabase/           # Auth schema (profiles table, triggers)
├── landing/            # Next.js marketing site
├── scripts/            # Desktop packaging and icon generation
├── assets/             # App icon
└── server.ts           # Express dev server entry point
```

## Testing

ShadRox has an extensive test suite covering the agent loop, autonomy engine, agent teams, plugins, automations, editor operations, preview, terminal, and security:

```sh
npm test
```

Tests run through Node's built-in test runner with `tsx` for TypeScript support. Builds and tests do not replace a clean-machine installer smoke test — verify installation, sign-in, preview, terminal, AI provider access, update behavior, and file changes before distributing a release.

## Local Data & Account

The desktop app works against files on your computer. ShadRox does not provide project synchronization or store your project files in a cloud workspace.

| What | Where | Notes |
|---|---|---|
| Project files | Your disk | Edited locally, never synced to ShadRox cloud |
| AI provider key | OS-backed encrypted storage | Never sent to ShadRox servers |
| Account identity | Supabase | Email, name, avatar, app version, platform only |
| AI prompts | Sent to your configured provider | Only the prompt + context you choose |

Google sign-in through Supabase is required to enter the app. Supabase stores the account identity and profile fields; it does not receive project files or AI prompts as part of sign-in. In the desktop app, provider credentials are stored using Electron's OS-backed encrypted storage where available.

## Beta Limitations

- This is **beta software.** Agent output and model-generated edits can be incorrect; inspect diffs and retain backups.
- Provider-native tool calls are used where supported, with ShadRox's text protocol as a fallback. Built-in workspace tools are read-only; edits use the patch pipeline.
- Run/team review-held patches are not the same as a fully featured per-hunk accept/reject review experience.
- Preview support is **project-dependent**; not every language, framework, or server configuration can be run in the preview pane.
- Google sign-in and Supabase configuration are required for the desktop app. BYOK keys and access to models are the user's responsibility.
- The shared ShadRox key, paid entitlements, and payment processing are **not enabled** as a public service in this beta.
- Windows builds are **unsigned**; Windows may show a SmartScreen warning.

## FAQ

<details>
<summary><b>Can I download ShadRox now?</b></summary>

Yes. The Download for Windows button installs the latest beta on Windows 10 or 11, 64-bit. You do not need an account, form, or approval to download the installer. Windows may show a SmartScreen warning because the build is not code-signed yet — choose "More" and then "Run anyway."
</details>

<details>
<summary><b>Do I need a ShadRox account?</b></summary>

Yes. On first launch the app asks you to continue with Google. It opens your browser, you pick a Google account, and the app receives a session in return. ShadRox stores only your account row: email, name, avatar URL, app version, and platform. There is no password to create and no subscription.
</details>

<details>
<summary><b>How do updates work?</b></summary>

The app checks for a newer release when it starts and downloads it in the background. The update installs when you restart or quit the app, so testers never have to re-download the installer.
</details>

<details>
<summary><b>Does ShadRox store my project in the cloud?</b></summary>

No. The desktop workspace opens and edits project files on your computer. There is no ShadRox cloud project sync. When you ask the AI for help, the prompt and the project context you include are sent to the Gemini or Groq provider you selected.
</details>

<details>
<summary><b>Where is my AI provider key stored?</b></summary>

Your Gemini or Groq key is saved only on your device in an encrypted local store, and requests go from your machine to the provider. ShadRox servers never receive your provider key. Your provider may charge for usage.
</details>

<details>
<summary><b>Which AI providers are supported?</b></summary>

The current app supports Gemini and Groq with your own key, plus custom OpenAI-compatible endpoints (including Ollama and LM Studio). Model availability and limits depend on your provider account.
</details>

<details>
<summary><b>Can I preview any project?</b></summary>

Static sites and supported Node-based web projects are the current focus. Other backend runtimes (Python, Go, PHP, Java, .NET) are not supported yet, and some sites may block embedded previews.
</details>

## Acknowledgements

ShadRox is built on excellent open-source projects including [Electron](https://www.electronjs.org/), [React](https://react.dev/), [CodeMirror](https://codemirror.net/), [xterm.js](https://xtermjs.org/), [Vite](https://vitejs.dev/), [Tailwind CSS](https://tailwindcss.com/), and [Supabase](https://supabase.com/). Third-party dependencies remain subject to their own licenses.

## License

ShadRox is proprietary software. Copyright (c) 2026 Sourav Maurya. All rights reserved. See [LICENSE](./LICENSE) for the full terms. The source code is published for viewing and reference only — access does not grant any license, right of use, or ownership interest.

---

<div align="center">

Built with care by [Sourav Maurya](https://github.com/iamsouravmourya-jpg)

[Download](https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-v0.0.4-Setup.exe) · [Releases](https://github.com/iamsouravmourya-jpg/ShadRox/releases) · [Issues](https://github.com/iamsouravmourya-jpg/ShadRox/issues)

</div>
