# ShadRox

ShadRox is a desktop coding workspace for opening a local project, browsing and editing its files, asking an AI provider for help, running a local preview, and using a terminal in the project folder.

The application is built with React, TypeScript, Vite, and Electron. Project files are opened from the user's computer and the desktop app writes accepted edits back to that folder. AI chat is optional and requires a Gemini or Groq provider key that the user brings (BYOK). The shared operator key exists in the code but is switched off for the beta; see **Beta scope**.

> **Project status:** ShadRox is an early beta/development project. Every install starts with a Google sign-in; the account row (email, name, avatar URL, app version, platform) lives in Supabase. Versioning restarted at **0.0.1** and moves 0.0.2, 0.0.3, … from here. The Windows build is one unsigned NSIS installer, `ShadRox-Setup.exe`, and updates itself from GitHub Releases. There is no billing or paid-plan enforcement yet; the plan labels in the UI are not active subscriptions.

## Accounts and sign-in

Sign-in is compulsory: the installed app does not show the workspace until a session exists. The first screen is a single **Continue with Google** button. Pressing it starts the standard OAuth 2.0 PKCE flow for native apps (RFC 8252):

1. The renderer creates a PKCE verifier and an `state` value, then opens Supabase's `/auth/v1/authorize?provider=google` URL in the system browser through `shell.openExternal`.
2. Electron starts a one-shot HTTP listener on `http://127.0.0.1:51789/auth/callback` before the browser opens.
3. After Google sign-in, Supabase redirects to that loopback URL with `?code=…&state=…`. The main process checks the path and hands the query to the renderer, which verifies `state`, exchanges the code at `/auth/v1/token?grant_type=pkce`, and closes the listener.
4. The session (`shadrox.auth.session`) and the PKCE verifier are written to the OS-encrypted store (`safeStorage`/DPAPI on Windows), never to `localStorage`. Access tokens are refreshed before expiry; signing out revokes the refresh token and clears both keys.
5. A best-effort profile upsert writes the account row to `public.profiles` with the user's own access token, so RLS (`auth.uid() = id`) applies.

What is stored server-side: Supabase's `auth.users` row (email, provider identity) and one `public.profiles` row (email, full name, avatar URL, provider, app version, last platform). No project files, no prompts, and no Gemini/Groq key are sent to ShadRox. If Supabase env vars are missing at build time, the first screen says sign-in is not configured rather than opening the workspace.

### Supabase project setup

1. Create a Supabase project and copy the project URL and **anon** public key (Project Settings → API). Never put the `service_role` key in the desktop app or the landing page.
2. Authentication → Providers → Google: enable it and paste a Google Cloud OAuth client ID/secret. In Google Cloud Console create an OAuth client of type **Web application** with authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. The loopback URL (`http://127.0.0.1:51789/auth/callback`) belongs only in Supabase's redirect allow list, never in the Google console. While the Google consent screen is in **Testing**, add every tester's Google address as a test user (or publish the app); an address that is not listed cannot sign in.
3. Authentication → URL Configuration: set the Site URL to `https://shadrox.cyou`. Add `http://127.0.0.1:51789/auth/callback` to the redirect allow list. Both the exact port and path are required; the desktop listener is bound to that address. The Google client ID/secret go in the Supabase Google provider, not in Vercel.
4. Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor. It creates `public.profiles`, owner-only RLS policies, the `handle_new_user` trigger, and the `updated_at` trigger, and is safe to re-run.
5. Confirm a test Google sign-in fills `auth.users` and `public.profiles`.

## Beta landing page

The ShadRox-branded beta landing page lives in `landing/` as a separate Next.js app; it is not the desktop workspace. Its original shield-and-S mark matches the ShadRox app branding. From the repository root, install its locked dependencies once and run the preview with:

```sh
corepack pnpm --dir landing install --frozen-lockfile
npm run dev:landing
```

The landing page opens at `http://localhost:3001`; the existing desktop-app development server continues to use port `3000`. The page is informational: **Download for Windows** links straight to the latest installer, and there is no web login or waitlist. Download URLs live in `landing/lib/download.ts`:

- Latest installer: `https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-Setup.exe`
- All releases: `https://github.com/iamsouravmourya-jpg/ShadRox/releases`

The download link never changes between versions because every release publishes the same asset name (`build.artifactName` is `ShadRox-Setup.${ext}`) and `/releases/latest/` always resolves to the newest release. Bump `APP_VERSION` in `landing/lib/download.ts` when the page copy should name a new version.

Vercel deploys the static export from `landing/out` using the root `vercel.json`, while keeping the existing `api/` functions available. Keep the Vercel project connected to this repository's `main` branch and use the repository root as its Root Directory; the deployment config selects the landing build instead of the desktop Vite app. The landing page needs no Supabase keys today; if a web account surface is added later, add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to Vercel.

## What the installed app looks like

The Windows build is one unsigned NSIS installer, `ShadRox-Setup.exe`. It installs per-user, so there is no admin prompt, and it adds a Start-menu shortcut. Launching it does not drop you into an empty editor: a signed-out launch shows the sign-in screen, and a signed-in launch opens the Workspace Hub.

### Screen 0 — Sign in

```
┌──────────────────────────────────────────────────────────────────┐
│  ◆ ShadRox                              Desktop beta · Windows   │
│                                                                  │
│                    One account. One workspace.                   │
│        Continue with Google to start. Your project files         │
│        stay on this device; the account stores only your         │
│        email, name, and app version.                             │
│                                                                  │
│               [ G  Continue with Google ]                        │
│                                                                  │
│        Sign-in opens your browser and returns here.              │
│                                                                  │
│                        shadrox.cyou                              │
└──────────────────────────────────────────────────────────────────┘
```

- The first screen blocks the workspace until a session exists. **Continue with Google** opens the system browser and returns through the loopback callback; a failed attempt shows the reason instead of a blank window.
- The account chip in the hub and workspace titlebar shows the avatar and email; **Sign out** in Settings or the hub clears the encrypted session and returns to this screen.
- If the build has no `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, the screen states that sign-in is not configured. That is a build-time problem, not something the user can fix.

### Screen 1 — Workspace Hub

```
┌──────────────────────────────────────────────────────────────────┐
│  ◆ ShadRox                              Desktop beta · Windows   │
│                                                                  │
│                          ●  BETA                                 │
│                                                                  │
│                   Open a project. Start building.                │
│        Your project stays on this device. AI chat sends only     │
│        the prompt and code context you choose to your provider.  │
│                                                                  │
│            [ Add your API key to start chatting ]                │
│                                                                  │
│      ┌────────────────────┐      ┌────────────────────┐          │
│      │    Open Folder     │      │    Open Files      │          │
│      │  Mount workspace   │      │ Any file formats   │          │
│      └────────────────────┘      └────────────────────┘          │
│                                                                  │
│  Recently opened                                  Click to reopen│
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  my-app        folder   42 files                     ×     │  │
│  │  scratch.html  file      3 files                     ×     │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

- **Add your API key** opens Settings → Models & Keys. Until a Gemini or Groq key is saved, chat refuses to spend; the app never falls back to a ShadRox key during the beta.
- **Open Folder** is the normal path: the folder is mounted, read recursively (with size, binary, traversal and symlink guards), and every later save writes back into that same folder.
- **Open Files** mounts individual files without a project root.
- **Recently opened** reopens a workspace from its local snapshot in one click. In the browser build this is also where write permission is re-granted; in the desktop app the folder is re-opened directly.

### Screen 2 — Workspace

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ‹  ◆ my-app   42 files   2 unsaved     Save  Auto-save off   Code Preview ⚙│
├───────────────────────────────┬────────────────────────────────────────────┤
│  CHAT            Gemini ▾  ⚡ │ EXPLORER            ⌕ filter       + New    │
│  ╭ Code │ Plan │ Complex ╮    │ ▾ src                                      │
│  │                         │  │   ▾ components                             │
│  │ user: add validation    │  │     ChatPanel.tsx                          │
│  │ assistant: …            │  │     CodeEditor.tsx                         │
│  │ ┌─────────────────────┐ │  │   App.tsx                                  │
│  │ │ form.html  2 s/r    │ │  ├────────────────────────────────────────────┤
│  │ │ [Accept] [Skip]     │ │  │ App.tsx ×  ChatPanel.tsx ×                 │
│  │ └─────────────────────┘ │  ├────────────────────────────────────────────┤
│  │                         │  │  1  export function App() {                │
│  │ [ ask ShadRox…      ➤ ] │  │  2    const workspace = useWorkspace();    │
│  ╰─────────────────────────╯  │  …                                         │
│                               ├────────────────────────────────────────────┤
│                               │ TERMINAL  my-app  ▾   (collapsible)        │
└───────────────────────────────┴────────────────────────────────────────────┘
```

- **Titlebar** shows the back arrow to the hub, the workspace name, file count, an amber "unsaved" badge, **Save**, **Auto-save**, the **Code / Preview** switch and Settings. The window uses a custom titlebar, so the native frame does not double up with it.
- **Left pane (35%) — chat.** Model picker, Code / Plan / Complex mode, streamed replies with reasoning, resume after a dropped stream, checkpoint restore, and the patch-review cards. Accepted edits are written straight to disk and the card says **Saved to disk**; if a write cannot happen it says **Applied in editor** and tells you why.
- **Right pane — editor.** The Explorer sidebar lists the folder tree and can filter or create files; open files become tabs; the CodeMirror editor carries dirty markers, quick open and inline AI.
- **Preview** replaces the editor with the `shadrox-preview://` pane for static sites and supported Node projects, including a device-size selector and live logs.
- **Terminal** docks under the editor and runs inside the workspace folder; each command asks once for approval.
- **Settings** is a right-side drawer: signed-in account and sign-out, plan, BYOK keys, model list, automatic-update card, GitHub, appearance.

Keyboard: `Ctrl/⌘+S` save, `Ctrl/⌘+P` quick open, `Ctrl/⌘+Shift+F` search inside files, `Ctrl/⌘+K` inline AI edit on the selection.

## What it can do

- Open a folder or selected files from the desktop app.
- Browse folder contents on demand and load text files when selected. The desktop workspace applies size, generated-file, binary-file, path traversal, and symbolic-link safeguards.
- Edit source in a CodeMirror-based editor and save changes to the local project. AI-proposed changes can be reviewed and applied through the chat workflow; checkpoint/history features are also available in the app.
- Accept multi-file edits as SEARCH/REPLACE patches: each block is matched independently, applied right-to-left, and a block that does not match fails alone instead of blocking the rest of the reply. A block that matches more than one place is refused as ambiguous rather than silently editing the first hit, and the review UI shows why each block failed.
- Use inline AI in the editor: ghost-text completion at the caret (Tab to accept, Escape to dismiss) and a Ctrl+K quick edit that rewrites the selection, or the line under a bare caret.
- Resume an interrupted reply. A dropped stream keeps the partial text and survives a reload, and continuing re-sends it as context so the model picks up where it stopped instead of starting over. The persisted snapshot always describes the conversation on screen, so a regenerate, stop, or cleared chat can never restore a stale one over live work.
- Generate a commit message from the workspace's git status, diff, and recent subjects through a read-only git bridge; outside a git folder it falls back to the editor's unsaved-file list.
- Chat using Gemini or Groq through the app's local API handlers with your own key (BYOK). The shared operator key is compiled in but gated off, so a request without a key is refused rather than served from ShadRox's plan. The app supports a Code mode, a read-only Plan mode, and a Complex mode. Model availability depends on the provider and key. Each request is trimmed to the selected model's context window, in the renderer and again at the server route that spends the key.
- Preview static sites and supported Node-based web projects inside the desktop app.
- Open an interactive terminal in the workspace and view terminal output.
- Connect GitHub actions from Settings using a GitHub token, including validation, repository creation, and pushing a project, where configured.

## Plans and BYOK

ShadRox is free-first by design. The goal is a zero-cost acquisition surface that competes with other AI coding tools on the free tier.

- **Free (BYOK) — unlimited, ₹0.** Bring your own Gemini or Groq key. There is no message cap on the free tier. The user pays their AI provider directly for tokens, and ShadRox's marginal cost is ₹0, so an unlimited free tier costs ShadRox nothing. This is the acquisition surface: a genuinely useful, no-cap free tier that metered tools cannot match.
- **Pro (₹499/mo, 250 msgs) and Adv (₹1,099/mo, 500 msgs).** These tiers use ShadRox's shared provider key, so the subscriber never manages an API key, never sees a per-token bill, and gets fast/premium models at a flat, GST-inclusive price. The upgrade levers are convenience (no key management), premium model access, and flat predictable cost — not artificial scarcity on the free tier.
- **Enterprise (custom).** Higher quotas, SSO, audit log, secrets vault — listed in the UI but not yet implemented.

The Pro/Adv/Enterprise message caps are currently client-side only (tracked in `localStorage`) and are not yet enforced against the API. Server-side entitlement enforcement (Supabase session + per-user usage meter) is the gating work before the shared key is turned on for real testers — during the beta the shared key is switched off entirely (see **Beta scope**), so the point is moot until launch. The free BYOK tier needs none of it because it carries no ShadRox cost.

## Local project and AI data

ShadRox is designed around a local desktop workspace: opening, browsing, editing, and saving project files happens on the user's computer. The desktop app runs a local Express process for the UI and API routes; this local process is not a ShadRox-hosted account backend.

When the user sends a chat or prompt-refinement request, the prompt and the project context selected for that request are sent to the chosen Gemini or Groq provider via the app's API route. A provider API key is required for BYOK use. In the desktop app, provider keys are read from the OS-encrypted store (Electron `safeStorage`, so DPAPI on Windows) and held in memory for the session — they are not written back to `localStorage`, and any legacy plaintext copy left by an older build is deleted on startup. Non-secret settings keep using `localStorage` as before. Browser mode has no encrypted store available, so there the key does live in `localStorage`. ShadRox's own server never persists a user key: a BYOK request passes it through to the provider for that one call. A ShadRox shared provider key can optionally be supplied through environment variables by an operator; it is policy-gated (Pro-tier models only) and never stored server-side. Requests using that key are still sent to the selected AI provider.

GitHub operations send the token and requested repository data to GitHub through the app's API handlers. Review provider and GitHub terms before sending private code or credentials. The only centralized account service is Supabase Auth, and the only data it receives is the sign-in identity and the profile fields listed in **Accounts and sign-in**. There is still no ShadRox cloud project sync, and the API routes do not trust a Supabase session for AI spend because shared keys are disabled during the beta.

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

## Security model

The threat model is unusual for a desktop app: ShadRox opens an arbitrary folder chosen by the user and then runs that folder's code in a preview frame, while holding the user's provider API keys. These are the controls that keep the two apart.

- **Only the app's own main frame gets desktop powers.** Electron injects preload scripts into every frame, and preview content lives inside the main window's document, so `electron/desktop-security.cjs` accepts an IPC call only when it comes from the main window's main frame, on the pinned backend origin, and the preload exposes the bridge only when `window.top === window`. A previewed workspace's JavaScript therefore never sees `terminal:create`, `secure:*`, or `workspace:*`.
- **Read-only git, hardened against a hostile repository.** `git` is resolved once to an absolute path from trusted locations, and any candidate inside the opened workspace is rejected — a planted `git.exe` cannot be chosen. Every call runs with a minimal environment (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at the null device, `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`), a fixed argv with no shell, and `-c core.fsmonitor=false -c core.hooksPath=NUL -c diff.external=` plus `--no-textconv --no-ext-diff`. Repo-declared clean/smudge/process filter drivers are enumerated from the repository's own config chain and individually disarmed; if the config chain cannot be fully enumerated, status and diff return empty rather than risk executing a driver.
- **Workspace writes stay inside the workspace.** Path normalization plus `lstat`/`realpath` checks reject `..`, absolute, drive-letter, UNC and alternate-data-stream paths, and symlink or junction escapes.
- **Provider keys are never server-side.** BYOK requests pass the key straight through to the provider for that single call. The Vercel functions do not persist keys, and provider error text is sanitized before it reaches the renderer so a key or an outgoing URL cannot be echoed back.
- **Shared-key spend is policy-gated — and switched off for the beta.** One module decides which key a request may spend. `SHADROX_ALLOW_SHARED_KEY=1` is the master gate: while it is unset, an unkeyed request is refused *before* the operator key is looked up, so neither the UI nor a hand-crafted `fetch` in devtools can spend it. Turning the gate back on restores the previous policy — the caller's key always wins, and the shared key serves Pro-tier models only. Prompt refinement uses the same gate rather than reading an environment key directly. A best-effort per-IP token bucket limits shared-key requests only — BYOK traffic is never throttled because it costs the operator nothing. The bucket is per warm serverless container and trusts `x-forwarded-for`, so it is a cost brake, not an entitlement system; that still needs accounts.
- **Sandboxed renderer.** No Node integration, context isolation on, sandbox on, and navigation restricted to the app's own origin.
- **Sign-in is PKCE and loopback-only.** The desktop OAuth flow uses an S256 PKCE challenge and a random `state`, opens the provider URL in the system browser, and accepts the callback only on `127.0.0.1:51789/auth/callback`. The main process validates the URL shape and rejects a second concurrent sign-in; the renderer refuses a callback whose `state` does not match the stored verifier. Session tokens live in the encrypted store, and the renderer never receives the Google secret or the Supabase service key.
- **The profile API cannot read other users.** `public.profiles` has RLS with `auth.uid() = id` on select, insert, and update; the client uses only the public anon key with the signed-in user's access token.

## Architecture

| Area | Location | Responsibility |
| --- | --- | --- |
| React UI | `src/` | Sign-in screen, hub, chat, editor, preview, settings, and terminal interface. |
| Renderer helpers | `src/lib/`, `src/hooks/` | AI requests, provider metadata, context budgeting, the SEARCH/REPLACE patch engine, editor completion/quick-edit extensions, workspace state, persistence, retrieval, preview/UI logic, and the PKCE/auth client (`src/lib/authCore.ts`, `src/hooks/useAuth.ts`). |
| Electron main process | `electron/main.cjs` | Native dialogs, IPC handlers, the one-shot OAuth loopback listener, local preview protocol, managed preview and PTY lifecycle, single-instance handling, read-only git access, and desktop security settings. |
| Desktop trust + git hardening | `electron/desktop-security.cjs` | Testable predicates for which renderer frames may call IPC, the git executable lookup, the isolated git environment, and the argument set that disarms repo-controlled git hooks, external diffs, textconv, and filter drivers. |
| Automatic updates | `electron/updater.cjs` | electron-updater wiring for Windows/macOS: quiet startup and periodic checks, automatic download, one restart dialog, and a status channel for the Settings UI. Inactive in development and in the browser build. |
| Preload bridge | `electron/preload.cjs` | Narrow, named renderer-to-main API exposed with `contextBridge`; raw Node and Electron APIs are not exposed to the renderer. |
| Workspace layer | `electron/workspace.cjs` | Lazy directory listing, read-on-click, scoped file access, and guarded local writes. |
| Local API server | `server.ts`, `api/` | Express routes used for AI, key validation, prompt refinement, GitHub actions, and local frontend serving. |
| Desktop packaging | `scripts/package-desktop.js`, `package.json` | Builds the web renderer, derives the API layer's `src/lib` runtime dependency set by walking the import graph from `server.ts`, stages exactly that set, installs runtime dependencies, and invokes Electron Builder. |
| Account schema | `supabase/schema.sql` | `public.profiles`, owner-only RLS, and the triggers that create a profile on sign-up and stamp `updated_at`. |

The renderer is configured without Node integration and runs with context isolation and sandboxing; see **Security model** for how desktop capabilities are restricted to the app's own frame.

## Requirements

- Node.js compatible with the installed Vite/Electron toolchain (Node 22.12+ is recommended; the project has also been developed with a newer Node release).
- npm. Optional project previews may additionally need pnpm, Yarn, or Bun to match the opened project.
- Windows or macOS for the configured desktop packaging targets. The development UI can also run in a browser.
- A Gemini or Groq API key. The beta is BYOK-only: without a valid provider key, AI requests are refused.
- A Supabase project with Google auth enabled for anyone building or running the app from source. Without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` at build time, the app opens on "sign-in is not configured" and cannot be used.

Native dependencies such as `node-pty` may need platform build tools during installation. Windows native builds generally need Python, Visual Studio C++ Build Tools, and a Windows SDK. macOS native builds require the Apple command-line build tools. Package downloads require network access.

## Get started

Beta testers: download the installer from `https://shadrox.cyou` (or directly from `https://github.com/iamsouravmourya-jpg/ShadRox/releases/latest/download/ShadRox-Setup.exe`), accept the SmartScreen prompt ("More info" → "Run anyway"), launch ShadRox, continue with Google, open a folder, and paste a Gemini or Groq key in Settings → Models & Keys. Downloading requires no account; using the app does.

From the repository root, for development:

```sh
npm install
npm run dev:desktop
```

This starts the local API/Vite server and opens the Electron app. To run only the browser development server:

```sh
npm run dev
```

Copy `.env.example` to `.env` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` so sign-in works in development. Add the shared-key variables only if you are developing the gated operator path (`SHADROX_ALLOW_SHARED_KEY=1` alongside provider keys) or need to change the local server port. `VITE_*` values are compiled into the renderer at build time, so a desktop installer built without them will open on the unconfigured sign-in screen. Beta testers do not need a `.env`; they add their own provider key in the app. Keep `.env` private and never commit real keys.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local Express/Vite development server. |
| `npm run dev:desktop` | Start the server and Electron desktop shell together. |
| `npm run build` | Build the renderer into `dist/`; this does not create an installer. |
| `npm run typecheck` | Run TypeScript type checking. |
| `npm test` | Run the Node test suite (161 tests): workspace, preview and preview-runtime modules, desktop trust and git-hardening predicates, the updater lifecycle, the PKCE auth core, SSE decoding, context budgeting and system-context degradation, the patch engine including the whole-file rewrite guard, the stream-snapshot lifecycle, FIM postprocessing and cache behavior, quick edit, commit context, AI access policy including the shared-key lockdown, the provider adapters including Groq's OTPM/TPM retry path, and every desktop/preload boundary. |
| `npm run build:desktop` | Build and package the desktop app through the staging script. |
| `npm run dist:win` | Request a Windows NSIS installer (no publishing). |
| `npm run release:win` | Build the Windows installer and publish it plus `latest.yml` to GitHub Releases, which is what the in-app updater reads. Needs `GH_TOKEN` with `repo` scope. |
| `npm run dist:mac` | Request a macOS DMG. |

The packaging script stages the backend by walking the import graph from `server.ts`, so the API layer's `src/lib` runtime modules ship automatically; a 0.3.5 build shipped only one of them and the packaged app died at launch with `ERR_MODULE_NOT_FOUND`. Do not reintroduce a hand-maintained file list. Installer generation is still experimental and must be validated on the target OS before distributing it. A renderer build or passing unit tests alone does not prove that the packaged app installs, launches, updates, or works on a clean beta tester machine. The script uses `dist_staging/` and writes artifacts to `dist_desktop/`; do not assume an old artifact reflects the latest source.

## Beta scope

The beta is ten known testers on their own machines, not a public launch. Two decisions follow from that and are deliberate, not oversights:

- **BYOK-only.** Every AI feature requires a real provider key in Settings. `api/ai/_access.ts` refuses the shared-key fallback unless `SHADROX_ALLOW_SHARED_KEY=1` is set, `src/lib/sharedKeyPolicy.ts` locks the "Use ShadRox Shared Key" control, and `useByok` ignores any stale persisted flag — so a request crafted in devtools still cannot spend an operator key. The shared-key code, spend guard, and Pro-tier rules stay complete so the launch is a config flip, not a rewrite.
- **Sign-in is compulsory.** Every tester signs in with Google before the workspace appears. The account row is the smoke-test for the auth path, gives testers a stable identity for bug reports, and leaves room for entitlement enforcement later. It is not a paywall: there is no billing, and the Supabase free tier is enough for ten testers.
- **No code signing certificate.** Signing costs money the beta does not justify. Unsigned NSIS builds trigger Windows SmartScreen ("More info" → "Run anyway") and Electron's own updater cannot verify a publisher, so updates ship only to testers who already trust the source. Buying a certificate is a launch task, not a beta task.

## Automatic updates and releases

The packaged app checks `iamsouravmourya-jpg/ShadRox` GitHub Releases 15 seconds after launch and every six hours, downloads a newer build silently, and then asks once to restart. A failed check — offline, blocked network, API rate limit — is logged and never shown. Settings → Models & Keys has an "Automatic updates" card with the current state and a manual "Check now".

How a new version reaches testers without them downloading anything again:

1. Bump `version` in `package.json` (0.0.1 → 0.0.2) and update `APP_VERSION` in `landing/lib/download.ts` so the site names the new build.
2. Build and publish with `GH_TOKEN=<token with repo scope> npm run release:win`. This also uploads `latest.yml` next to `ShadRox-Setup.exe`; electron-updater reads both.
3. Existing installs see the newer `latest.yml`, download `ShadRox-Setup.exe` in the background, and install it on restart or quit. The landing page keeps working without a change because `/releases/latest/download/ShadRox-Setup.exe` always resolves to the newest release.
4. Testers who never installed before simply download from the landing page and get that same newest build.

`npm run dist:win` builds the same artifacts without publishing them, which is what you use to test an installer locally. Publishing a release makes the installer and `latest.yml` downloadable by anyone who knows the repository URL, which is the trade-off of using GitHub Releases as the update feed while the repository stays public.

The version reset is safe because no 0.3.x release was ever published. electron-updater refuses to downgrade, so a machine that had installed a published 0.3.8 could not move to 0.0.1; testers are installing 0.0.1 fresh. From 0.0.1 onward, normal increments apply.

## Configuration

### Environment variables

| Variable | Where it goes | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Local `.env` before any desktop build; CI/secret store if you build installers there | Supabase project URL used by the app's sign-in client. Compiled into the renderer at build time. |
| `VITE_SUPABASE_ANON_KEY` | Same as above | Public anon key used for Google OAuth and the profile request. Safe to ship; RLS protects the data. |
| `SHADROX_ALLOW_SHARED_KEY` | Vercel (and local `.env` for the Express server) | Master switch for the operator's shared AI key. Leave unset for the BYOK-only beta. |
| `GEMINI_API_KEY` / `GROQ_API_KEY` | Vercel (and local `.env`) | Optional operator-shared keys. Unused while the master switch is off. |
| `PORT` | Local `.env` only | Local Express/Vite port. |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel | Only needed if a web account surface is added to the landing page. The current landing page is informational and does not sign anyone in. |

Vercel therefore needs **no new variables for the current beta**: the landing page downloads are plain links and the desktop app talks to Supabase directly. Add the two `NEXT_PUBLIC_*` keys only when the website itself gets sign-in. Never put the Supabase `service_role` key in Vercel's public variables, the desktop app, or the landing page.

`.env.example` documents the shared-key master switch (`SHADROX_ALLOW_SHARED_KEY`), the optional server-side shared provider keys, the Supabase values, and `PORT`. Supported provider IDs are `gemini` and `groq`. For BYOK, users enter their own key in Settings. The app's available-model list is based on the provider response plus the local model catalog; actual model access and cost are controlled by the provider account.

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

Shared keys are off by default and gated behind `SHADROX_ALLOW_SHARED_KEY=1` (see **Beta scope**). Their use is not a user authentication system, and this codebase does not currently enforce account entitlements or billing for the UI's plan labels.

## Release notes

### 0.0.1 — accounts, Google sign-in, direct download

The beta now starts with an account and a real download link. Versioning restarts here as 0.0.1; every later release increments the last number.

- **Google sign-in on first launch.** A new first screen blocks the workspace until the user continues with Google. The app opens the system browser, completes the OAuth PKCE flow on a loopback listener, and returns with a session; no password is created.
- **Server-side profile.** Supabase stores the auth identity plus one `public.profiles` row per user (email, name, avatar URL, provider, app version, platform). RLS limits every read and write to the signed-in user. Provider API keys and project files never reach Supabase.
- **Encrypted session.** The refresh token and PKCE verifier live in the OS-encrypted store, not `localStorage`; sign-in state survives restarts, tokens refresh before expiry, and sign-out revokes the session.
- **Account UI.** The hub and Settings show the signed-in email/avatar with a sign-out action, so switching accounts does not require reinstalling.
- **Direct download.** `shadrox.cyou` now links to the latest GitHub release asset, `ShadRox-Setup.exe`, with no form or approval. The asset name is version-free, so the link is stable across releases.
- **Automatic updates from 0.0.1.** Every release publishes `latest.yml`; installed copies update in the background and apply on restart.

### 0.3.8 — chat actually edits your files

Four defects found on real testers' machines:

- **AI edits now reach disk.** Accepted/applied patches used to stop at the editor buffer; disk write-back was a separate opt-in auto-save, so a reply could be marked applied while the file never changed. Every apply and undo now flushes through `workspace.saveFiles()` and the review card reports **Saved to disk** or **Applied in editor** with the reason.
- **No more whole-file wipes.** The edit prompt used to demand the complete file, which small free models answered with a four-line fragment that replaced (and deleted) the rest. The prompt now requires SEARCH/REPLACE for existing files, and auto-apply refuses a rewrite that drops most of a file (`assessRewriteRisk`) — an explicit Accept still overrides it.
- **One permission prompt, at folder-open time.** The browser build now requests read-write access in the same gesture that opens or reopens the folder, and stores the folder handle, so saves never prompt mid-chat. In the desktop app, edits are saved immediately, which also removes the mid-session "unsaved changes" dialogs.
- **Groq free-tier limits are handled.** `Request too large … OTPM: Limit 1000, Requested 2048` and `TPM: Limit 2000, Requested 6837` came from Groq billing a model's default 2048-token output ceiling against a small per-minute quota. The adapter now reads the limit from the error, retries once with a smaller output ceiling and a trimmed prompt, and otherwise explains which model to pick instead of showing a raw upstream string.

## Current limitations and beta checklist

- Google sign-in is required, but there is still no billing, subscription enforcement, hosted AI spend for unentitled accounts, or cloud project sync. The Pro/Adv/Enterprise message caps are client-side only and not enforced against the API.
- Sign-in needs the loopback port `51789` to be free. If another program holds it, the app reports the conflict instead of hanging; close that program and retry.
- The profile table records the email and name from Google. Testers who want their row removed must ask the operator to delete the Supabase user.
- Browser mode has no OS credential store, so provider keys there sit in `localStorage`. The desktop build keeps them in the encrypted store and in memory only.
- AI features need internet access and send the request context to the chosen external provider.
- Free provider tiers (especially Groq) enforce per-minute token limits well below the model's context window; 0.3.8 shrinks and retries, but a very small limit can still refuse a long conversation.
- Preview support is limited to static sites and detected Node scripts; embedded-app restrictions can still prevent rendering.
- Interactive terminal commands run with the operating-system user's permissions.
- The installer is unsigned, so Windows SmartScreen shows "More info → Run anyway" on first launch.
- Before inviting external testers, test install/launch/uninstall on a clean machine, confirm terminal and preview permissions, check provider-key handling, and provide a channel for bug reports.

## License

This repository is source-visible under the proprietary terms in [`LICENSE`](LICENSE). Viewing the source does not grant permission to copy, modify, distribute, or use it to create derivative products. Third-party packages retain their own licenses.
