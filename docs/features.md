# Features

What ShadRox v0.1.4 actually does today, area by area. Beta areas are marked; review what they produce. The agent's tool surface and safety model have their own page: [agent-tools.md](./agent-tools.md).

## Editor

- CodeMirror 6 editing with split editor groups and pinned, reorderable tabs.
- Quick open, file outline, and a command palette that fuzzy-finds files, workspace symbols, and commands.
- Select code and press **Ctrl+K** for an inline AI edit on just that selection; accept ghost-text completions powered by server-side fill-in-the-middle (FIM).
- TypeScript diagnostics, go-to-definition, find references, rename, quick fixes, semantic highlighting, and workspace symbol search where supported. Diagnostics come from a bundled TypeScript 5.9 language service so the editor matches what ships inside the app (the renderer itself is built with TypeScript 7).
- One-click **Source/Preview** toggle for Markdown files (`.md`, `.markdown`).
- Workspace search and replace across files on disk and open buffers, with a reviewable result list.

## AI chat

- Providers: Google Gemini, Groq, and custom OpenAI-compatible endpoints (including local gateways such as Ollama and LM Studio). Bring your own key — see [byok.md](./byok.md).
- Three access modes in the Run settings menu: **Ask** and **Plan** are read-only (the assistant may read files but never edit or run anything); **Agent** may edit files and run commands under the approval model in [agent-tools.md](./agent-tools.md).
- Context you choose: attach workspace files, one external photo (thumbnail above the composer with a remove control), or use `@` mentions for files and symbols. Every request also carries a compact repository map.
- A clipboard paste of 4,000+ characters or 60+ lines becomes a named `pasted-<time>.txt` attachment; the chat bubble stays short while the full text reaches the model. Shorter pastes insert normally.
- Queue up to 5 follow-up messages while a turn is running; they send after the current turn finishes, with the workspace/key/model identity frozen at the time you queued them.
- Replies render as cards with headings, tables, quotes, and copyable code blocks; the composer carries the ShadRox mark. Proposed file changes are inspectable diffs; unsafe changes are held for review rather than silently written.
- Prompt fitting uses per-model context-window and output limits, keeps every history message under the server's per-message size limit, and shapes stable prefixes for providers that support prompt caching.
- A reply cut off at the provider's output limit is marked incomplete and resumable, never presented as finished; a cut-off edit block gets one bounded repair attempt.
- Microphone, prompt auto-refine, Semantic, and Auto composer toggles are intentionally out of the beta UI.

## Multi-step runs and agent teams (beta)

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
- Port conflicts and stale servers are handled without touching foreign processes; see [troubleshooting.md](./troubleshooting.md). The agent can stop/start/restart the pane with `preview_control`.
- Preview bundles never embed vault secrets.

## Terminal

- Interactive shell rooted in the workspace (xterm.js + node-pty), with multiple sessions and split panes. Credential-shaped environment variables are stripped before the shell starts.
- PowerShell and bash load a small ShadRox script (OSC 133/633 markers) reporting cwd, command text, and exit code; the panel shows them and notices a command that has gone silent (default hung threshold 20s, configurable). Command Prompt and plain `/bin/sh` are not wrapped.
- Assistant commands run on a separate non-interactive path and are echoed into the terminal dock; they never type into your shell. The agent reads the summary with `terminal_state` and can answer a waiting prompt only through the approval-gated `terminal_answer`.

## Git and checkpoints

- Inspect staged and unstaged changes, preview file diffs, stage/unstage, commit with AI-generated messages, switch local branches, see ahead/behind counts against the upstream, and detect and resolve merge conflicts.
- GitHub integration: validate a token in the app and push commits from the workspace; a repository-creation endpoint ships with the API layer.
- **Checkpoints** capture workspace files and the local Git position; restore earlier content from the timeline when an experiment goes sideways. Installed packages, running terminals, and remote effects are not undone. The Machine Delta core in the main process provides bounded snapshot/inspect/restore primitives; foreign Git locks are never removed.

## MCP servers

Connect user-configured Model Context Protocol servers in Settings. Starting a server or listing/calling its tools requires consent for the complete server configuration. MCP tools join the agent's tool list on the text protocol; in Ask/Plan modes they are refused like any other external effect. Treat MCP servers as untrusted until approved.

## Rules and skills

Project conventions load from `SHADROX.md`, `AGENTS.md` (root or nested per-directory), `QODER.md`, `.cursorrules`, and `.shadrox/rules/*.md`; reusable skills live under `.shadrox/skills/`. Rules and skills are treated as untrusted reference data, and read-only rule docs cannot be overwritten by the agent.

## Debugger (DAP)

Add a `shadrox.debug.json` at the workspace root with one or more `node` launch configurations, then start it from the Debug panel: breakpoints in the editor gutter, call stack, scopes and variables, hover evaluation while paused, and pause/continue/step. Programs and working directories outside the workspace are refused. Bundled adapters may start directly; external adapters require native approval and a scrubbed environment, and run as bounded argv processes, never through a shell. Heap profiling is not included. The agent can read a paused session with `debugger_state` (read-only).

## Plugins and automations (beta)

Declarative workspace plugins extend the app; automations fire on a schedule or from a webhook. Agent edits to plugin and automation manifests are blocked.

## Task Inspector

One dock for the local-first engineering records that accompany an AI task:

- **Behavior Studio** — records preview bridge events (source-mapped clicks, runtime errors) into a bounded interaction history and generates an editable acceptance contract: target source location, observed failure, expected behavior, reproduction steps. Running the contract captures evidence per phase (screenshot digest plus DOM/console assertions) for `baseline` and `postPatch`.
- **Living Intent Graph** — indexes symbols and dependency edges from loaded source; user-approved decisions are stored locally, re-hashed (SHA-256) against current files, and marked `stale` when their governing content changes. Budgeted intent context is injected into AI tasks.
- **Outcome-Calibrated Auto** — a bounded local ledger of route, model, verification, repair, token, and latency outcomes. Ranking uses a pass rate shrunk toward the pool's prior and only reorders a route after five verified runs; unproven models keep the neutral fallback order. Every choice carries a human-readable reason, and a model can be pinned per task type (`bugfix`, `refactor`, `feature`, `test`, `chat`).
- **Capsules** — context capsule capture with redaction and sandboxing; capsule and intent data support offline JSON export/import (imports are validated before storage).

These records stay local to the workspace/browser profile.

## Workspace basics

- **New project** asks for a name and location, creates an empty folder, and opens it — no starter files, and a non-empty target folder is refused rather than overwritten.
- **Recent workspaces** reopen saved folders/file sets with persisted native consent, a visible loading state, and a ready-file count. Reopening requires a path the main process already accepted; an unknown path asks again.
- **Themes** — one light/dark toggle; until you choose, the app follows your OS preference, then remembers your choice.
- **Feedback drawer** — the top-bar Feedback button offers exactly two report types, Bug and Feature request, and sends only the message you typed (see [byok.md](./byok.md#feedback)).
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

Architecture in one paragraph: the Electron main process (`electron/main.cjs` and friends) owns workspace consent, command risk classification and approval, the preview runtime, terminals, Git, MCP, the proof ledger, and the updater. The React renderer talks to it over a context-isolated preload bridge, with a renderer CSP applied only to the app origin (the preview iframe is allowed its own loopback dev-server origins). A local Express API layer (`api/`) handles provider calls (`/ai/chat`, `/ai/fim`, `/ai/commit-message`), BYOK validation, and GitHub operations. Prompts go from your machine to your configured provider; Supabase receives only account profile fields.

ShadRox is proprietary software owned by ShadRox and founder Sourav Maurya, built on third-party libraries including Electron, React, CodeMirror, xterm.js, Vite, Tailwind CSS, and Supabase; third-party dependencies remain subject to their own licenses.

<details>
<summary>Repository layout</summary>

```
electron/    Main process: IPC, consent, command approval, preview, terminal, MCP, proof store, updater
src/         React UI (components/, hooks/) and lib/ (agent loop, patch engine, autonomy, agents,
             terminal, preview, proof, intent, behavior, calibratedAuto, capsules, plugins, ...)
api/         Local API routes: ai/, byok/, github/, prompt/
benchmark/   Model-free agent benchmark cases (see benchmark/README.md)
supabase/    Auth schema (profiles table, triggers)
landing/     Next.js marketing site (separate app, pnpm)
scripts/     Packaging, test and benchmark runners, feedback Apps Script
server.ts    Express dev server entry point
```

</details>

## Building from source

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
| `npm run benchmark` | Grade the model-free agent benchmark (see [agent-tools.md](./agent-tools.md#agent-benchmark)) |
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

## Keep reading

- [Features](./features.md) · [BYOK & keys](./byok.md) · [Agent tools](./agent-tools.md) · [Troubleshooting](./troubleshooting.md) · [FAQ](./faq.md)
- [README](../README.md) · [Website](https://www.shadrox.cyou) · [Releases](https://www.shadrox.cyou/releases) · [Contributors](https://www.shadrox.cyou/contributors)
