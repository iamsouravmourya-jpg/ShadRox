# ShadRox

ShadRox is a desktop coding workspace for opening a local project, browsing and editing its files, asking an AI provider for help, running a local preview, and using a terminal in the project folder.

The application is built with React, TypeScript, Vite, and Electron. Project files are opened from the user's computer and the desktop app writes accepted edits back to that folder. AI chat is optional and requires a Gemini or Groq provider key, or a shared key configured by the ShadRox operator.

> **Project status:** ShadRox is an early beta/development project. The local development app and core workflows have been exercised, but a distributable installer has not yet been verified end-to-end for release. There is no ShadRox account system, Supabase integration, or billing enforcement today. Do not treat the plan labels in the UI as active subscriptions.

## Beta landing page

The ShadRox-branded beta landing page lives in `landing/` as a separate Next.js app; it is not the desktop workspace. Its original shield-and-S mark matches the ShadRox app branding. From the repository root, install its locked dependencies once and run the preview with:

```sh
corepack pnpm --dir landing install --frozen-lockfile
npm run dev:landing
```

The landing page opens at `http://localhost:3001`; the existing desktop-app development server continues to use port `3000`. The Windows download button is intentionally disabled and labeled as coming soon until an installer is ready. The beta request button opens an email draft; there is no hosted waitlist yet.

Vercel deploys the static export from `landing/out` using the root `vercel.json`, while keeping the existing `api/` functions available. Keep the Vercel project connected to this repository's `main` branch and use the repository root as its Root Directory; the deployment config selects the landing build instead of the desktop Vite app.

## What it can do

- Open a folder or selected files from the desktop app.
- Browse folder contents on demand and load text files when selected. The desktop workspace applies size, generated-file, binary-file, path traversal, and symbolic-link safeguards.
- Edit source in a CodeMirror-based editor and save changes to the local project. AI-proposed changes can be reviewed and applied through the chat workflow; checkpoint/history features are also available in the app.
- Accept multi-file edits as SEARCH/REPLACE patches: each block is matched independently, applied right-to-left, and a block that does not match fails alone instead of blocking the rest of the reply.
- Use inline AI in the editor: ghost-text completion at the caret (Tab to accept, Escape to dismiss) and a Ctrl+K quick edit that rewrites the selection, or the line under a bare caret.
- Resume an interrupted reply. A dropped stream keeps the partial text, and continuing re-sends it as context so the model picks up where it stopped instead of starting over.
- Generate a commit message from the workspace's git status, diff, and recent subjects through a read-only git bridge; outside a git folder it falls back to the editor's unsaved-file list.
- Chat using Gemini or Groq through the app's local API handlers, with your own key (BYOK, free tier) or ShadRox's shared key (paid tiers). The app supports a Code mode, a read-only Plan mode, and a Complex mode. Model availability depends on the provider and key. Each request is trimmed to the selected model's context window, in the renderer and again at the server route that spends the key.
- Preview static sites and supported Node-based web projects inside the desktop app.
- Open an interactive terminal in the workspace and view terminal output.
- Connect GitHub actions from Settings using a GitHub token, including validation, repository creation, and pushing a project, where configured.

## Plans and BYOK

ShadRox is free-first by design. The goal is a zero-cost acquisition surface that competes with other AI coding tools on the free tier.

- **Free (BYOK) — unlimited, ₹0.** Bring your own Gemini or Groq key. There is no message cap on the free tier. The user pays their AI provider directly for tokens, and ShadRox's marginal cost is ₹0, so an unlimited free tier costs ShadRox nothing. This is the acquisition surface: a genuinely useful, no-cap free tier that metered tools cannot match.
- **Pro (₹499/mo, 250 msgs) and Adv (₹1,099/mo, 500 msgs).** These tiers use ShadRox's shared provider key, so the subscriber never manages an API key, never sees a per-token bill, and gets fast/premium models at a flat, GST-inclusive price. The upgrade levers are convenience (no key management), premium model access, and flat predictable cost — not artificial scarcity on the free tier.
- **Enterprise (custom).** Higher quotas, SSO, audit log, secrets vault — listed in the UI but not yet implemented.

The Pro/Adv/Enterprise message caps are currently client-side only (tracked in `localStorage`) and are not yet enforced against the API. Server-side entitlement enforcement (Supabase session + per-user usage meter) is the gating work before the shared key is turned on for real testers; the free BYOK tier needs none of it because it carries no ShadRox cost.

## Local project and AI data

ShadRox is designed around a local desktop workspace: opening, browsing, editing, and saving project files happens on the user's computer. The desktop app runs a local Express process for the UI and API routes; this local process is not a ShadRox-hosted account backend.

When the user sends a chat or prompt-refinement request, the prompt and the project context selected for that request are sent to the chosen Gemini or Groq provider via the app's API route. A provider API key is required for BYOK use. In the desktop app, keys entered in the Settings UI are mirrored into an OS-encrypted store (Electron `safeStorage`, so DPAPI on Windows) that survives a cache clear or reinstall; the renderer's working copy still lives in `localStorage`, which is where browser mode keeps them too. ShadRox's own server never stores a user key — BYOK requests pass the key straight through to the provider for that one call. A ShadRox shared provider key can optionally be supplied through environment variables by an operator. Requests using that key are still sent to the selected AI provider.

GitHub operations send the token and requested repository data to GitHub through the app's API handlers. Review provider and GitHub terms before sending private code or credentials. ShadRox currently has no sign-in, cloud project sync, or centralized user account service.

## Preview support

The preview pane supports these local workflows:

| Project | How preview works |
| --- | --- |
| Static site with `index.html` | Served from the opened workspace through ShadRox's internal `shadrox-preview://` protocol. |
| Static site nested in a workspace | If no runnable Node project is selected, discovered folders with `index.html` can be offered as preview roots. |
| Node-based web project | ShadRox discovers a `package.json` with a `dev`, `start`, `preview`, or `serve` script, asks the user to approve running it (and dependency installation when needed), then probes a loopback HTTP/HTTPS endpoint for readiness. |
| Multiple runnable subprojects | The user can choose which detected project folder to run. |

The preview runtime supports common package managers (npm, pnpm, Yarn, and Bun) when available. It scans nested project directories with safety limits, skips generated/vendor folders, and stops managed preview processes when the preview/workspace is closed. HTTPS readiness probing accepts self-signed certificates for local readiness checks; that does not make arbitrary remote certificates trusted.

Preview is not a universal runtime. Python, Go, PHP, Java, .NET, and other backend projects do not have dedicated runtime adapters. A site's own Content Security Policy or `X-Frame-Options` may prevent iframe rendering. Browser capabilities are sandboxed, and app-level certificate handling is restricted to local loopback preview hosts.

## Terminal and command execution

The desktop terminal uses `node-pty` to create an interactive shell rooted in the opened project. Closing the workspace tears down its terminal sessions. The terminal is a real shell with the current user's operating-system permissions: commands typed there can modify files or run programs. Review commands and project scripts before running them.

Preview scripts and dependency installation are separate managed actions that require an approval step in the UI. The app also exposes a one-shot command API with confirmation. Approval for one preview action does not mean arbitrary terminal commands are harmless.

## Architecture

| Area | Location | Responsibility |
| --- | --- | --- |
| React UI | `src/` | Hub, chat, editor, preview, settings, and terminal interface. |
| Renderer helpers | `src/lib/`, `src/hooks/` | AI requests, provider metadata, context budgeting, the SEARCH/REPLACE patch engine, editor completion/quick-edit extensions, workspace state, persistence, retrieval, and preview/UI logic. |
| Electron main process | `electron/main.cjs` | Native dialogs, IPC handlers, local preview protocol, managed preview and PTY lifecycle, and desktop security settings. |
| Preload bridge | `electron/preload.cjs` | Narrow, named renderer-to-main API exposed with `contextBridge`; raw Node and Electron APIs are not exposed to the renderer. |
| Workspace layer | `electron/workspace.cjs` | Lazy directory listing, read-on-click, scoped file access, and guarded local writes. |
| Local API server | `server.ts`, `api/` | Express routes used for AI, key validation, prompt refinement, GitHub actions, and local frontend serving. |
| Desktop packaging | `scripts/package-desktop.js`, `package.json` | Builds the web renderer, creates a production staging directory, installs runtime dependencies, and invokes Electron Builder. |

The renderer is configured without Node integration and runs with context isolation and sandboxing. Its desktop capabilities are deliberately routed through the preload bridge and main-process IPC.

## Requirements

- Node.js compatible with the installed Vite/Electron toolchain (Node 22.12+ is recommended; the project has also been developed with a newer Node release).
- npm. Optional project previews may additionally need pnpm, Yarn, or Bun to match the opened project.
- Windows or macOS for the configured desktop packaging targets. The development UI can also run in a browser.
- A Gemini or Groq API key to use AI chat with BYOK. Without a valid provider key or an operator-configured shared key, AI requests are unavailable.

Native dependencies such as `node-pty` may need platform build tools during installation. Windows native builds generally need Python, Visual Studio C++ Build Tools, and a Windows SDK. macOS native builds require the Apple command-line build tools. Package downloads require network access.

## Get started

From the repository root:

```sh
npm install
npm run dev:desktop
```

This starts the local API/Vite server and opens the Electron app. To run only the browser development server:

```sh
npm run dev
```

Copy `.env.example` to `.env` only if you are developing with optional operator-configured shared provider keys or need to change the local server port. Users can instead add their own provider key in the app. Keep `.env` private and never commit real API keys.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Express/Vite development server. |
| `npm run dev:desktop` | Start the server and Electron desktop shell together. |
| `npm run build` | Build the renderer into `dist/`; this does not create an installer. |
| `npm run typecheck` | Run TypeScript type checking. |
| `npm test` | Run the Node test suite: workspace, preview and preview-runtime modules, SSE decoding, context budgeting, the patch engine, stream resume, FIM postprocessing, quick edit, commit context, and the provider adapters. |
| `npm run build:desktop` | Build and package the desktop app through the staging script. |
| `npm run dist:win` | Request a Windows NSIS installer. |
| `npm run dist:mac` | Request a macOS DMG. |

Installer generation is currently experimental and must be validated on the target OS before distributing it. A renderer build or passing unit tests alone does not prove that the packaged app installs, launches, updates, or works on a clean beta tester machine. The packaging script uses `dist_staging/` and writes artifacts to `dist_desktop/`; do not assume an old artifact reflects the latest source.

## Configuration

`.env.example` documents optional server-side shared provider keys and `PORT`. Supported provider IDs are `gemini` and `groq`. For BYOK, users enter their own key in Settings. The app's available-model list is based on the provider response plus the local model catalog; actual model access and cost are controlled by the provider account.

The API routes currently mounted by the local server include:

- `GET /api/health`
- `POST /api/byok/validate`
- `POST /api/ai/chat`
- `POST /api/ai/fim`
- `POST /api/ai/commit-message`
- `POST /api/prompt/refine`
- `POST /api/github/validate`
- `POST /api/github/create-repo`
- `POST /api/github/push`

Shared keys are optional. Their use is not a user authentication system, and this codebase does not currently enforce account entitlements or billing for the UI's plan labels.

## Current limitations and beta checklist

- No ShadRox sign-in, Supabase, cloud sync, subscription billing, or entitlement enforcement. The Free tier is unlimited BYOK; the Pro/Adv/Enterprise message caps are client-side only and not enforced against the API.
- Provider keys still live in `localStorage` for the renderer's working copy; the OS-encrypted desktop store is a mirror, so browser mode has no hardware-backed protection.
- AI features need internet access and send the request context to the chosen external provider.
- Preview support is limited to static sites and detected Node scripts; embedded-app restrictions can still prevent rendering.
- Interactive terminal commands run with the operating-system user's permissions.
- Desktop installer packaging and clean-machine installation have not yet been confirmed as release-ready.
- Before inviting external testers, build installers on each target OS, test install/launch/uninstall on a clean machine, confirm terminal and preview permissions, check provider-key handling, and provide a channel for bug reports.

## License

This repository is source-visible under the proprietary terms in [`LICENSE`](LICENSE). Viewing the source does not grant permission to copy, modify, distribute, or use it to create derivative products. Third-party packages retain their own licenses.
